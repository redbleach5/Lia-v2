// POST /api/rl/start-engine — запустить движок обучения (Python sidecar)
//
// Запускает python-sidecar/main.py как дочерний процесс.
// Process персистится до завершения работы Next.js или ручной остановки.
//
// В production (Tauri/desktop) это должно запускаться автоматически при старте.
// В dev-режиме пользователь может запустить из UI.

import { NextResponse } from 'next/server';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { PATHS } from '@/lib/paths';
import { existsSync } from 'fs';
import path from 'path';

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

function start(): { ok: boolean; pid?: number; error?: string } {
  if (isRunning()) {
    return { ok: true, pid: g[globalKey]?.pid };
  }

  const sidecarDir = path.join(PATHS.root, 'python-sidecar');
  const mainPy = path.join(sidecarDir, 'main.py');

  if (!existsSync(mainPy)) {
    return { ok: false, error: 'python-sidecar/main.py не найден. Убедись, что проект скачан полностью.' };
  }

  // Find python binary — try python3 first, then python
  let pythonBin = 'python3';
  try {
    execFileSync('which', ['python3'], { stdio: 'ignore' });
  } catch {
    pythonBin = 'python';
  }

  // Check if venv exists — prefer it
  const venvPython = path.join(sidecarDir, '.venv', 'bin', 'python');
  if (existsSync(venvPython)) {
    pythonBin = venvPython;
  }

  // Check if dependencies are installed (uvicorn is the key one)
  try {
    execFileSync(pythonBin, ['-c', 'import uvicorn, torch, fastapi'], { stdio: 'ignore' });
  } catch {
    return {
      ok: false,
      error: 'Не установлены Python-зависимости. Открой терминал в папке python-sidecar и выполни: pip install -r requirements.txt',
    };
  }

  try {
    const proc = spawn(pythonBin, [mainPy], {
      cwd: sidecarDir,
      stdio: 'pipe', // capture stdout/stderr but don't pipe to console
      detached: false,
      env: {
        ...process.env,
        // Pass DATABASE_URL so sidecar finds the same SQLite
        DATABASE_URL: process.env.DATABASE_URL || `file:${path.join(PATHS.db, 'custom.db')}`,
      },
    });

    proc.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log('[rl-engine]', msg);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.warn('[rl-engine]', msg);
    });
    proc.on('exit', (code) => {
      console.log(`[rl-engine] exited with code ${code}`);
      g[globalKey] = undefined;
    });
    proc.on('error', (err) => {
      console.error('[rl-engine] failed to start:', err);
      g[globalKey] = undefined;
    });

    g[globalKey] = proc;
    return { ok: true, pid: proc.pid };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function POST() {
  try {
    // Wait a moment if already starting (in case of double-click)
    if (isRunning()) {
      return NextResponse.json({
        ok: true,
        already_running: true,
        pid: g[globalKey]?.pid,
      });
    }

    const result = start();
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
    });
  } catch (e) {
    console.error('[api/rl/start-engine] failed:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
