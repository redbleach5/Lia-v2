import 'server-only';

// code_run — безопасное выполнение Python/JavaScript кода в sandbox.
//
// Подход (Phase 1 — усиление sandbox):
//   1. AST-анализ Python-кода через отдельный `python3 -c ast.parse` вызов:
//      - Запрещены Import/ImportFrom модулей из BLOCKED_PYTHON_MODULES
//      - Запрещены Call к eval/exec/compile/__import__/globals/locals
//      - Запрещён доступ к __builtins__, __import__, os.system, os.popen, subprocess.* и т.п.
//      Это надёжнее substring-блоклиста: не срабатывает на комментарии/строки/имена переменных.
//   2. Python: преамбула-обёртка ставит resource.setrlimit (CPU, heap, file size, no fork).
//   3. env очищен: нет PATH-утечки, нет HTTP_PROXY-tricks (raw socket их игнорирует),
//      но зато нет и обратного — переменные окружения хоста не утекают в sandbox.
//   4. Timeout 30s, max output 10KB, max code 50KB.
//
// Что НЕ покрывается (принимаемо для local-first single-user):
//   - Raw socket.create_connection в Python игнорирует proxy env vars.
//     Но: AST-анализ блокирует `import socket`, так что сети не будет.
//   - Filesystem read outside tempDir (например /etc/passwd).
//     Решение для production: firejail/bwrap/Docker с read-only rootfs.
//   - Side-channel атаки (CPU cache, fork bombs через multiprocessing — последний в blocklist).

import { execFile } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10_000;
const MAX_CODE_SIZE = 50_000;
// Python: heap limit 256MB, file size 1MB, CPU 10s (timeout 30s даст margin).
const PY_RLIMIT_AS = 256 * 1024 * 1024;       // RLIMIT_AS — address space
const PY_RLIMIT_FSIZE = 1 * 1024 * 1024;      // RLIMIT_FSIZE — max file write
const PY_RLIMIT_CPU = 10;                     // RLIMIT_CPU — seconds
const PY_RLIMIT_NPROC = 0;                    // RLIMIT_NPROC — 0 = no child processes

// Модули и функции, блокируемые AST-анализом для Python.
// AST-анализ ловит `import X`, `from X import ...`, `__import__('X')`, `getattr(os, 'system')` и т.п.
const BLOCKED_PYTHON_MODULES = new Set([
  'subprocess', 'multiprocessing', 'ctypes', 'cffi',
  'socket', 'socketserver', 'http.server', 'http.client',
  'urllib.request', 'urllib2', 'requests', 'httpx', 'aiohttp',
  'ftplib', 'smtplib', 'telnetlib', 'paramiko',
  'pickle', 'marshal', 'shelve',
  'importlib',
]);

// Опасные call-targets — блокируем на уровне AST Call node.
const BLOCKED_PYTHON_CALLS = new Set([
  'eval', 'exec', 'compile',
  '__import__',
  'globals', 'locals',
  'getattr', 'setattr', 'delattr',  // обход static-анализа через getattr(os, 'system')
  'vars',
]);

// Опасные attribute access — блокируем на уровне AST Attribute node.
const BLOCKED_PYTHON_ATTRS = new Set([
  '__builtins__',
  '__subclasses__',  // классическая атака: ().class__.__bases__[0].__subclasses__()
  '__globals__',
  '__code__',         // функция.__code__ = malicious_code_object
  'system', 'popen', 'exec', 'fork',  // os.system, os.popen, os.exec*, os.fork
  'rmtree', 'move',  // shutil.rmtree, shutil.move
]);

// Python AST-анализатор. Запускается как отдельный `python3 -c` процесс.
// Возвращает JSON: { ok: true } | { ok: false, error: string }
const PYTHON_AST_VALIDATOR = `
import ast, json, sys

BLOCKED_MODULES = ${JSON.stringify([...BLOCKED_PYTHON_MODULES])}
BLOCKED_CALLS = ${JSON.stringify([...BLOCKED_PYTHON_CALLS])}
BLOCKED_ATTRS = ${JSON.stringify([...BLOCKED_PYTHON_ATTRS])}

def check(code):
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {"ok": False, "error": f"SyntaxError: {e.msg} (line {e.lineno})"}

    for node in ast.walk(tree):
        # import X / from X import Y
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split('.')[0]
                if top in BLOCKED_MODULES or alias.name in BLOCKED_MODULES:
                    return {"ok": False, "error": f"blocked import: {alias.name}"}
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or '').split('.')[0]
            if top in BLOCKED_MODULES or (node.module or '') in BLOCKED_MODULES:
                return {"ok": False, "error": f"blocked from-import: {node.module}"}
        # Call to eval/exec/__import__/getattr/etc.
        elif isinstance(node, ast.Call):
            fn = node.func
            name = None
            if isinstance(fn, ast.Name):
                name = fn.id
            elif isinstance(fn, ast.Attribute):
                name = fn.attr
            if name in BLOCKED_CALLS:
                return {"ok": False, "error": f"blocked call: {name}"}
        # Attribute access to __subclasses__ / __globals__ / system / etc.
        elif isinstance(node, ast.Attribute):
            if node.attr in BLOCKED_ATTRS:
                return {"ok": False, "error": f"blocked attribute: {node.attr}"}

    return {"ok": True}

if __name__ == '__main__':
    # Читаем код из файла, путь передан как argv[1].
    # Это безопаснее чем stdin: promisify(execFile) не поддерживает input option.
    code_path = sys.argv[1]
    with open(code_path, 'r', encoding='utf-8') as f:
        code = f.read()
    print(json.dumps(check(code)))
`;

// Префикс для Python-скрипта — ставит resource limits перед выполнением user code.
const PYTHON_RESOURCE_PREFIX = `
import resource
resource.setrlimit(resource.RLIMIT_AS, (${PY_RLIMIT_AS}, ${PY_RLIMIT_AS}))
resource.setrlimit(resource.RLIMIT_FSIZE, (${PY_RLIMIT_FSIZE}, ${PY_RLIMIT_FSIZE}))
resource.setrlimit(resource.RLIMIT_CPU, (${PY_RLIMIT_CPU}, ${PY_RLIMIT_CPU}))
try:
    resource.setrlimit(resource.RLIMIT_NPROC, (${PY_RLIMIT_NPROC}, ${PY_RLIMIT_NPROC}))
except (ValueError, OSError):
    pass  # RLIMIT_NPROC не везде поддерживается (macOS)
`;

/**
 * AST-анализ Python-кода. Записывает код во временный файл, запускает python3 -c ast_validator с путём к файлу как argv[1].
 * Возвращает { ok: true } или { ok: false, error: string }.
 */
async function validatePythonCodeAst(code: string): Promise<{ ok: boolean; error?: string }> {
  const astDir = join(tmpdir(), `lia-ast-${randomUUID()}`);
  await mkdir(astDir, { recursive: true });
  const codePath = join(astDir, 'user_code.py');
  try {
    await writeFile(codePath, code, 'utf8');
    const result = await execFileAsync('python3', ['-c', PYTHON_AST_VALIDATOR, codePath], {
      timeout: 5_000,
      maxBuffer: 10_000,
    });
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: string };
    return parsed;
  } catch (e) {
    // python3 не установлен / упал — не позволяем выполнять unchecked код
    logger.warn('tools', 'code_run: AST validation failed (python3 missing?)', {}, e);
    return { ok: false, error: 'Python AST validation unavailable — refusing to run' };
  } finally {
    try { await rm(astDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/**
 * JavaScript: substring-блоклист + env-изоляция.
 * В Node.js нет встроенного AST-анализа без сторонних deps,
 * поэтому оставляем эвристический подход.
 */
const BLOCKED_JS_PATTERNS = [
  /\brequire\s*\(\s*['"]child_process['"]/,
  /\brequire\s*\(\s*['"]fs['"]\s*\)/,
  /\bprocess\.binding\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bprocess\.exit\b/,
  /\bsetInterval\b/,  // fork-bomb-like
  /\b__proto__\b/,
];

function validateJsCode(code: string): { ok: boolean; error?: string } {
  for (const pattern of BLOCKED_JS_PATTERNS) {
    const match = code.match(pattern);
    if (match) {
      return { ok: false, error: `blocked JS pattern: ${match[0]}` };
    }
  }
  return { ok: true };
}

export type CodeRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
};

export async function runCode(code: string, language: 'python' | 'javascript' = 'python'): Promise<CodeRunResult> {
  if (code.length > MAX_CODE_SIZE) {
    return {
      stdout: '',
      stderr: `Code too large: ${code.length} bytes (max ${MAX_CODE_SIZE})`,
      exitCode: 1,
      durationMs: 0,
      truncated: false,
    };
  }

  // AST / pattern validation
  if (language === 'python') {
    const ast = await validatePythonCodeAst(code);
    if (!ast.ok) {
      return {
        stdout: '',
        stderr: ast.error ?? 'code validation failed',
        exitCode: 1,
        durationMs: 0,
        truncated: false,
      };
    }
  } else {
    const v = validateJsCode(code);
    if (!v.ok) {
      return {
        stdout: '',
        stderr: v.error ?? 'code validation failed',
        exitCode: 1,
        durationMs: 0,
        truncated: false,
      };
    }
  }

  const sessionId = randomUUID();
  const tempDir = join(tmpdir(), `lia-code-${sessionId}`);
  await mkdir(tempDir, { recursive: true });

  const startTime = Date.now();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  let truncated = false;

  try {
    // Минимальный env — никаких HTTP_PROXY-tricks (raw socket их игнорирует),
    // никаких утечек окружения хоста (DATABASE_URL, LIA_* и т.п.).
    const safeEnv: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? 'development',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: tempDir,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      // Python-specific
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONHASHSEED: 'random',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      // Node-specific
      NODE_OPTIONS: '',  // запретить --require, --experimental-* и т.п.
    };

    if (language === 'python') {
      const scriptPath = join(tempDir, 'script.py');
      // Префикс ставит resource limits, затем выполняет user code.
      const fullCode = `${PYTHON_RESOURCE_PREFIX}\n${code}`;
      await writeFile(scriptPath, fullCode, 'utf8');

      const result = await execFileAsync('python3', ['-I', scriptPath], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cwd: tempDir,
        env: safeEnv,
        killSignal: 'SIGKILL',
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    } else {
      const scriptPath = join(tempDir, 'script.js');
      await writeFile(scriptPath, code, 'utf8');

      const result = await execFileAsync('node', [
        '--max-old-space-size=128',
        '--max-semi-space-size=16',
        '--no-warnings',
        scriptPath,
      ], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cwd: tempDir,
        env: safeEnv,
        killSignal: 'SIGKILL',
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number; signal?: string; killed?: boolean };
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
    exitCode = typeof err.code === 'number' ? err.code : 1;

    if (err.killed || err.signal === 'SIGKILL') {
      stderr += '\n(Process killed — timeout or memory/CPU limit exceeded)';
    }
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  const durationMs = Date.now() - startTime;

  if (stdout.length > MAX_OUTPUT_BYTES) {
    stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
    truncated = true;
  }
  if (stderr.length > MAX_OUTPUT_BYTES) {
    stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    truncated = true;
  }

  return { stdout, stderr, exitCode, durationMs, truncated };
}
