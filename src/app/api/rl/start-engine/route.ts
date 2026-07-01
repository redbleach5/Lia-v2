// POST /api/rl/start-engine — запустить движок обучения (Python sidecar)
//
// Запускает python-sidecar/main.py как дочерний процесс.
// Process персистится до завершения работы Next.js или ручной остановки.
//
// В production (Tauri/desktop) это должно запускаться автоматически при старте.
// В dev-режиме пользователь может запустить из UI.
//
// Phase 5.1: передаёт LIA_SIDECAR_API_KEY в env child process.
// Без ключа sidecar откажется запускаться (fail-closed в main.py).

import { NextResponse } from 'next/server';
import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { PATHS } from '@/lib/paths';
import { existsSync } from 'fs';
import path from 'path';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Singleton — переживает HMR
const globalKey = '__lia_rl_engine__';
const g = globalThis as unknown as { [globalKey]?: ChildProcess };

function isRunning(): boolean {
  const proc = g[globalKey];
  if (!proc) return false;
  try {
    process.kill(proc.pid!, 0);
    return true;
  } catch {
    g[globalKey] = undefined;
    return false;
  }
}

/**
 * Найти python binary кросс-платформенно.
 * На Windows нет `which` — используем `where` или просто пробуем python3/python.
 */
async function findPythonBinary(): Promise<string | null> {
  // Сначала проверяем venv (предпочтительный)
  const venvPython = path.join(PATHS.root, 'python-sidecar', '.venv', 'bin', 'python');
  const venvPythonWin = path.join(PATHS.root, 'python-sidecar', '.venv', 'Scripts', 'python.exe');
  if (existsSync(venvPython)) return venvPython;
  if (existsSync(venvPythonWin)) return venvPythonWin;

  // Пробуем python3, затем python
  for (const bin of ['python3', 'python']) {
    try {
      await execFileAsync(bin, ['--version']);
      return bin;
    } catch {
      // пробуем следующий
    }
  }
  return null;
}

async function start(): Promise<{ ok: boolean; pid?: number; error?: string; warning?: string }> {
  if (isRunning()) {
    return { ok: true, pid: g[globalKey]?.pid };
  }

  const sidecarDir = path.join(PATHS.root, 'python-sidecar');
  const mainPy = path.join(sidecarDir, 'main.py');

  if (!existsSync(mainPy)) {
    return { ok: false, error: 'python-sidecar/main.py не найден. Убедись, что проект скачан полностью.' };
  }

  // Phase 5.1: проверяем что LIA_SIDECAR_API_KEY задан — без него sidecar не запустится.
  const sidecarApiKey = process.env.LIA_SIDECAR_API_KEY;
  if (!sidecarApiKey) {
    return {
      ok: false,
      error: 'LIA_SIDECAR_API_KEY не задан в .env. Добавь случайную строку и перезапусти Next.js.',
    };
  }

  const pythonBin = await findPythonBinary();
  if (!pythonBin) {
    return {
      ok: false,
      error: 'Python не найден. Установи Python 3.10+ и убедись, что он в PATH.',
    };
  }

  // Check which dependencies are installed.
  // uvicorn + fastapi — required for sidecar to start at all.
  // torch + onnx — required only for /train endpoint. Without them sidecar
  // starts, /health and /stats work, but /train returns 500. This lets users
  // see sidecar is alive and understand they need to install torch separately.
  // (torch is ~700MB, so we don't fail start just because it's missing.)
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  try {
    execFileSync(pythonBin, ['-c', 'import uvicorn, fastapi'], { stdio: 'ignore' });
  } catch {
    missingRequired.push('uvicorn', 'fastapi');
  }
  try {
    execFileSync(pythonBin, ['-c', 'import torch, onnx'], { stdio: 'ignore' });
  } catch {
    missingOptional.push('torch', 'onnx');
  }

  if (missingRequired.length > 0) {
    return {
      ok: false,
      error: `Не установлены обязательные Python-зависимости (${missingRequired.join(', ')}). ` +
        'Открой терминал в папке python-sidecar и выполни: pip install -r requirements.txt',
    };
  }

  const warning = missingOptional.length > 0
    ? `Движок запущен, но обучение недоступно: не установлены ${missingOptional.join(', ')}. ` +
      'Для обучения выполни: pip install -r requirements.txt (torch ~700MB, установка может занять несколько минут).'
    : undefined;

  try {
    const proc = spawn(pythonBin, [mainPy], {
      cwd: sidecarDir,
      stdio: 'pipe',
      detached: false,
      env: {
        ...process.env,
        // Pass DATABASE_URL so sidecar finds the same SQLite
        DATABASE_URL: process.env.DATABASE_URL || `file:${path.join(PATHS.db, 'custom.db')}`,
        // Phase 5.1: явно передаём API key (хотя он уже в process.env, это для надёжности)
        LIA_SIDECAR_API_KEY: sidecarApiKey,
      },
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.info('rl', `sidecar stdout: ${msg}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn('rl', `sidecar stderr: ${msg}`);
    });
    proc.on('exit', (code) => {
      logger.info('rl', `sidecar exited with code ${code}`);
      g[globalKey] = undefined;
    });
    proc.on('error', (err) => {
      logger.error('rl', 'sidecar failed to start', {}, err);
      g[globalKey] = undefined;
    });

    g[globalKey] = proc;
    return { ok: true, pid: proc.pid, warning };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function POST() {
  try {
    if (isRunning()) {
      return NextResponse.json({
        ok: true,
        already_running: true,
        pid: g[globalKey]?.pid,
      });
    }

    const result = await start();
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 400 },
      );
    }

    // Give it 2 seconds to start
    await new Promise(r => setTimeout(r, 2000));

    return NextResponse.json({
      ok: true,
      pid: result.pid,
      message: 'Движок обучения запущен',
      warning: result.warning,
    });
  } catch (e) {
    logger.error('rl', 'failed', {}, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
