// Server startup logging — запускается один раз при первом импорте в server-компоненте.
//
// Логирует версию, окружение, ключевые пути — чтобы при отладке «зависшего» лога
// сразу было видно: какая версия, какие настройки, какие модели доступны.

import { logger } from './logger';
import { PROJECT_ROOT } from './paths';
import { checkOllamaHealth, getOllamaSettings } from './ollama';

let startupLogged = false;

export async function logServerStartup(): Promise<void> {
  if (startupLogged) return;
  startupLogged = true;

  logger.info('system', '═══════════════════════════════════════════════════════════');
  logger.info('system', 'Лия v2 — server starting', {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    env: process.env.NODE_ENV ?? 'development',
    projectRoot: PROJECT_ROOT,
    logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
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
