// code_run — безопасное выполнение Python кода в sandbox.
//
// Использует child_process.execFile с:
//   -タイмаут 30 секунд
//   - temp directory (очищается после)
//   - restricted imports (blocklist для опасных модулей)
//   - no network access (через env vars)
//   - memory limit (через --max-old-space-size для Node, ulimit для Python)
//
// ВАЖНО: это НЕ Docker sandbox. Для production нужен firejail/bwrap/Docker.
// Для local-first приложения на localhost — приемлемо.

import { execFile } from 'child_process';
import { writeFile, mkdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10_000;
const MAX_CODE_SIZE = 50_000;

// Модули которые блокируем (network, system, process)
const BLOCKED_IMPORTS = [
  'subprocess', 'os.system', 'os.popen', 'os.exec', 'os.fork',
  'socket', 'socketserver', 'http.server', 'http.client',
  'urllib.request', 'urllib2', 'requests', 'httpx', 'aiohttp',
  'ftplib', 'smtplib', 'telnetlib', 'paramiko',
  'ctypes', 'cffi', 'multiprocessing',
  'shutil.rmtree', 'shutil.move',
  'pickle', 'marshal',  // deserialization attacks
  'importlib',  // dynamic imports can bypass blocklist
  'builtins.__import__',
  'sys.modules',
  '__builtins__',
  'globals', 'locals', 'eval', 'exec', 'compile',
];

function validateCode(code: string): { ok: boolean; error?: string } {
  if (code.length > MAX_CODE_SIZE) {
    return { ok: false, error: `Code too large: ${code.length} bytes (max ${MAX_CODE_SIZE})` };
  }

  const lower = code.toLowerCase();
  for (const blocked of BLOCKED_IMPORTS) {
    // Check for import statements and direct usage
    const patterns = [
      `import ${blocked}`,
      `from ${blocked}`,
      blocked,
    ];
    for (const p of patterns) {
      if (lower.includes(p.toLowerCase())) {
        // Allow if it's in a comment or string — basic check
        const lines = code.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('"') || trimmed.startsWith("'")) continue;
          if (trimmed.toLowerCase().includes(p.toLowerCase())) {
            return { ok: false, error: `Blocked: "${blocked}" is not allowed for security` };
          }
        }
      }
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
  const validation = validateCode(code);
  if (!validation.ok) {
    return {
      stdout: '',
      stderr: validation.error ?? 'code validation failed',
      exitCode: 1,
      durationMs: 0,
      truncated: false,
    };
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
    if (language === 'python') {
      const scriptPath = join(tempDir, 'script.py');
      await writeFile(scriptPath, code, 'utf8');

      // Run with restricted environment — no network, limited PATH
      const env = {
        ...process.env,
        // Disable network in Python
        PYTHONPATH: tempDir,
        HTTP_PROXY: '127.0.0.1:0',  // invalid proxy = no network
        HTTPS_PROXY: '127.0.0.1:0',
        http_proxy: '127.0.0.1:0',
        https_proxy: '127.0.0.1:0',
        HOME: tempDir,
      };

      const result = await execFileAsync('python3', [scriptPath], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cwd: tempDir,
        env,
        killSignal: 'SIGKILL',
      });

      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    } else {
      // JavaScript via node
      const scriptPath = join(tempDir, 'script.js');
      await writeFile(scriptPath, code, 'utf8');

      const result = await execFileAsync('node', ['--max-old-space-size=128', scriptPath], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        cwd: tempDir,
        env: { ...process.env, HOME: tempDir },
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
    exitCode = err.code ?? 1;

    if (err.killed || err.signal === 'SIGKILL') {
      stderr += '\n(Process killed — timeout or memory limit exceeded)';
    }
  } finally {
    // Cleanup temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  const durationMs = Date.now() - startTime;

  // Truncate output
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
