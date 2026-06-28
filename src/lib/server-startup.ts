// Server startup logging — запускается один раз при первом импорте.
//
// Логирует версию, окружение, ключевые пути — чтобы при отладке «зависшего» лога
// сразу было видно: какая версия, какие настройки, какие модели доступны.
//
// Защита от повторного вызова: globalThis flag переживает HMR в dev-режиме.
// Защита от клиентского вызова: проверка typeof window.

import { logger } from './logger';

// Глобальный flag — переживает HMR в dev-режиме.
const globalKey = '__lia_startup_logged__';
const g = globalThis as unknown as { [key: string]: unknown };

export async function logServerStartup(): Promise<void> {
  // На клиенте — ничего не делаем.
  if (typeof window !== 'undefined') return;
  if (g[globalKey]) return;
  g[globalKey] = true;

  // Динамический импорт серверных модулей — чтобы не тащить их в клиентский бандл.
  const [{ PROJECT_ROOT }, { checkOllamaHealth, getOllamaSettings }] = await Promise.all([
    import('./paths'),
    import('./ollama'),
  ]);

  logger.info('system', '═══════════════════════════════════════════════════════════');
  logger.info('system', 'Лия v2 — server starting', {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    env: process.env.NODE_ENV ?? 'development',
    projectRoot: PROJECT_ROOT,
    logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    llmTimeoutMs: process.env.LIA_LLM_TIMEOUT_MS ?? '180000 (default)',
    synthesisTimeoutMs: process.env.LIA_LLM_SYNTHESIS_TIMEOUT_MS ?? '240000 (default)',
  });

  try {
    const settings = await getOllamaSettings();
    logger.info('system', 'Ollama configuration', {
      baseUrl: settings.baseUrl,
      model: settings.model,
      embedModel: settings.embedModel || 'auto',
    });
  } catch (e) {
    logger.warn('system', 'Failed to read Ollama settings on startup', {}, e);
  }

  try {
    const health = await checkOllamaHealth();
    if (health.ok) {
      logger.info('system', `Ollama is UP`, { modelsCount: health.models.length, models: health.models.slice(0, 5) });
    } else {
      logger.warn('system', `Ollama is DOWN`, { error: health.error });
    }
  } catch (e) {
    logger.warn('system', 'Ollama health check failed on startup', {}, e);
  }

  logger.info('system', '═══════════════════════════════════════════════════════════');
}
