// Agent-specific tools — используются только в agent mode.
//
// Это расширяет базовый tools registry (web_search, save_artifact) инструментами
// для полноценной автономной работы: чтение/запись файлов, HTTP, ask_user, sub-agents.
//
// Все FS-операции ограничены fsScope задачи (path prefix). Без fsScope — отказ.

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'fs/promises';
import { join, resolve, relative, isAbsolute } from 'path';
import { saveArtifact } from '../tools/save-artifact';
import { webSearch } from '../tools/web-search';
import type { AgentTask } from './task';
import {
  emitAgentEvent,
  setWaiting,
  isCancelled,
  signalCancellation,
} from './events';

// ============================================================================
// Helpers — безопасная работа с путями внутри fsScope
// ============================================================================
async function safePathWithinScope(path: string, scope: string | null): Promise<string | null> {
  if (!scope) return null;
  const base = resolve(scope);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);

  // Use realpath to resolve symlinks — prevents path traversal via symlink attacks.
  // If target doesn't exist yet (write_file creating new), check parent exists.
  try {
    const realBase = await realpath(base);
    const realTarget = await realpath(target);
    const rel = relative(realBase, realTarget);
    if (rel.startsWith('..') || isAbsolute(rel)) return null; // escape attempt
    return realTarget;
  } catch {
    // File doesn't exist yet — check the parent directory
    try {
      const realBase = await realpath(base);
      const parentDir = resolve(target, '..');
      const realParent = await realpath(parentDir);
      const rel = relative(realBase, realParent);
      if (rel.startsWith('..') || isAbsolute(rel)) return null;
      return target; // Return non-realpath'd target for writing
    } catch {
      return null;
    }
  }
}

// ============================================================================
// read_file — чтение файла внутри fsScope
// ============================================================================
function makeReadFileTool(task: AgentTask) {
  return tool({
    description: 'Прочитать содержимое файла внутри рабочей директории задачи. Возвращает текст (для текстовых файлов) или base64 (для бинарных).',
    inputSchema: z.object({
      path: z.string().min(1).describe('Путь относительно рабочей директории'),
      maxBytes: z.number().optional().default(50_000).describe('Лимит байт (по умолчанию 50000)'),
    }),
    execute: async ({ path, maxBytes }) => {
      if (!task.fsScope) {
        return { error: 'У задачи нет рабочей директории (fsScope). Чтение файлов запрещено.' };
      }
      const fullPath = await safePathWithinScope(path, task.fsScope);
      if (!fullPath) {
        return { error: `Путь "${path}" выходит за пределы рабочей директории` };
      }
      try {
        const s = await stat(fullPath);
        if (s.size > maxBytes) {
          return { error: `Файл слишком большой: ${s.size} байт (лимит ${maxBytes})` };
        }
        const content = await readFile(fullPath, 'utf8');
        return { path, size: s.size, content };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ============================================================================
// write_file — запись файла внутри fsScope
// ============================================================================
function makeWriteFileTool(task: AgentTask) {
  return tool({
    description: 'Записать файл внутри рабочей директории задачи. Создаёт промежуточные директории. Перезаписывает существующие файлы.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Путь относительно рабочей директории'),
      content: z.string().min(0).describe('Содержимое файла (текст)'),
    }),
    execute: async ({ path, content }) => {
      if (!task.fsScope) {
        return { error: 'У задачи нет рабочей директории (fsScope). Запись файлов запрещена.' };
      }
      const fullPath = await safePathWithinScope(path, task.fsScope);
      if (!fullPath) {
        return { error: `Путь "${path}" выходит за пределы рабочей директории` };
      }
      try {
        await mkdir(join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, content, 'utf8');
        return { path, size: content.length, written: true };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ============================================================================
// list_dir — листинг директории
// ============================================================================
function makeListDirTool(task: AgentTask) {
  return tool({
    description: 'Получить список файлов и поддиректорий в указанной директории. Без аргументов — корень рабочей директории.',
    inputSchema: z.object({
      path: z.string().optional().default('.').describe('Путь относительно рабочей директории (по умолчанию ".")'),
    }),
    execute: async ({ path }) => {
      if (!task.fsScope) {
        return { error: 'У задачи нет рабочей директории' };
      }
      const fullPath = await safePathWithinScope(path, task.fsScope);
      if (!fullPath) {
        return { error: `Путь "${path}" выходит за пределы рабочей директории` };
      }
      try {
        const entries = await readdir(fullPath, { withFileTypes: true });
        const items = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
        }));
        return { path, items };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ============================================================================
// http_request — HTTP с SSRF-защитой
// ============================================================================
// SSRF protection: resolves hostname to IP via DNS, checks ALL resolved IPs
// against blocklist. Prevents DNS-rebinding attacks where hostname resolves
// to public IP at check time but private IP at fetch time.
//
// Also follows redirects MANUALLY — checks each redirect target.

import { lookup } from 'dns/promises';
import { isIP } from 'net';

const BLOCKED_IP_PATTERNS = [
  /^127\./,                           // loopback
  /^10\./,                            // private class A
  /^192\.168\./,                      // private class C
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // private class B
  /^169\.254\./,                      // link-local
  /^0\./,                             // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^::1$/,                            // IPv6 loopback
  /^fc00::/,                          // IPv6 ULA
  /^fe80::/,                          // IPv6 link-local
  /^::ffff:/,                         // IPv4-mapped IPv6 (check inner)
];

function isPrivateIp(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) {
    return isPrivateIp(mappedMatch[1]);
  }
  return BLOCKED_IP_PATTERNS.some(re => re.test(ip));
}

/**
 * Resolve hostname and check ALL resolved IPs against blocklist.
 * Throws if any IP is private/blocked.
 */
async function assertSafeHost(hostname: string): Promise<void> {
  // If hostname is already an IP, check directly
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`blocked IP: ${hostname}`);
    }
    return;
  }

  // localhost check
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('blocked: localhost');
  }

  // DNS resolve
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new Error(`no DNS records for ${hostname}`);
  }

  // Check ALL resolved IPs
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`blocked IP ${address} for ${hostname}`);
    }
  }
}

function makeHttpRequestTool() {
  return tool({
    description: 'Выполнить HTTP GET-запрос к указанному URL. Возвращает статус, заголовки, тело (до 10000 символов). Блокирует private/internal IP (SSRF protection).',
    inputSchema: z.object({
      url: z.string().url().describe('Полный URL включая схему (http/https)'),
    }),
    execute: async ({ url }) => {
      try {
        const u = new URL(url);

        // SSRF check: resolve DNS and verify all IPs are public
        await assertSafeHost(u.hostname);

        // Manual redirect following — check each redirect target
        let currentUrl = url;
        let redirectCount = 0;
        const MAX_REDIRECTS = 5;

        while (redirectCount < MAX_REDIRECTS) {
          const res = await fetch(currentUrl, {
            headers: { 'User-Agent': 'Lia-Agent/2.0' },
            signal: AbortSignal.timeout(20_000),
            redirect: 'manual',  // we handle redirects ourselves
          });

          // Check for redirect
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) break;

            // Resolve relative redirects
            const redirectUrl = new URL(location, currentUrl);
            redirectCount++;

            // SSRF check on redirect target
            await assertSafeHost(redirectUrl.hostname);
            currentUrl = redirectUrl.toString();
            continue;
          }

          // Not a redirect — return response
          const text = await res.text();
          return {
            status: res.status,
            statusText: res.statusText,
            contentType: res.headers.get('content-type'),
            body: text.slice(0, 10_000),
            truncated: text.length > 10_000,
            finalUrl: redirectCount > 0 ? currentUrl : undefined,
          };
        }

        return { error: `too many redirects (max ${MAX_REDIRECTS})` };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ============================================================================
// ask_user — приостановить задачу и спросить пользователя
// ============================================================================
function makeAskUserTool(task: AgentTask) {
  return tool({
    description: 'Задать уточняющий вопрос пользователю и приостановить задачу до получения ответа. Используй когда: неточно понятно требование, нужно подтвердить опасное действие, не хватает информации для продолжения.',
    inputSchema: z.object({
      question: z.string().min(1).describe('Чёткий вопрос пользователю'),
    }),
    execute: async ({ question }) => {
      // Pause the task and wait for user input via /api/agent/[id]/input
      emitAgentEvent({ type: 'task_waiting_input', taskId: task.id, question, ts: Date.now() });

      const answer = await new Promise<string>((resolve, reject) => {
        setWaiting(task.id, { question, resolve, reject });

        // Also poll for cancellation
        const interval = setInterval(() => {
          if (isCancelled(task.id)) {
            clearInterval(interval);
            reject(new Error('cancelled'));
          }
        }, 500);
      }).catch((e) => {
        throw e instanceof Error ? e : new Error(String(e));
      });

      return { question, answer };
    },
  });
}

// ============================================================================
// file_search — поиск файлов по содержимому внутри fsScope.
//
// Рекурсивно обходит директории, читает текстовые файлы (до 50KB),
// ищет подстроку (case-insensitive). Возвращает список совпадений
// с путём, строкой и контекстом.
// ============================================================================
function makeFileSearchTool(task: AgentTask) {
  return tool({
    description: 'Найти файлы по содержимому внутри рабочей директории. Рекурсивно обходит поддиректории, ищет подстроку (case-insensitive) в текстовых файлах. Возвращает до 20 совпадений с путём, номером строки и контекстом. Используй когда нужно найти где упоминается функция/класс/переменная.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Подстрока для поиска (case-insensitive)'),
      maxResults: z.number().default(20).describe('Максимум результатов (по умолчанию 20)'),
      filePattern: z.string().default('').describe('Фильтр по расширению, например "ts" или "py" (пусто = все)'),
    }),
    execute: async ({ query, maxResults, filePattern }) => {
      if (!task.fsScope) {
        return { error: 'У задачи нет рабочей директории (fsScope). Поиск файлов запрещён.' };
      }

      const scopePath = await safePathWithinScope('.', task.fsScope);
      if (!scopePath) {
        return { error: 'Не удалось определить рабочую директорию' };
      }

      try {
        const results: Array<{ path: string; line: number; context: string }> = [];
        const queryLower = query.toLowerCase();

        // Рекурсивный обход директорий
        const walkDir = async (dirPath: string, relativePath: string) => {
          if (results.length >= maxResults) return;

          const entries = await readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxResults) return;

            // Пропускаем служебные директории
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
              continue;
            }

            const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            const entryPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
              await walkDir(entryPath, entryRelative);
            } else if (entry.isFile()) {
              // Фильтр по расширению (пустая строка = все файлы)
              if (filePattern) {
                const ext = entry.name.split('.').pop()?.toLowerCase();
                if (ext !== filePattern.toLowerCase()) continue;
              }

              // Только текстовые файлы (по расширению)
              const textExts = ['ts', 'tsx', 'js', 'jsx', 'py', 'json', 'md', 'txt', 'yaml', 'yml', 'sh', 'css', 'html', 'sql', 'prisma'];
              const ext = entry.name.split('.').pop()?.toLowerCase();
              if (!ext || !textExts.includes(ext)) continue;

              try {
                const statResult = await stat(entryPath);
                if (statResult.size > 50_000) continue; // пропускаем большие файлы

                const content = await readFile(entryPath, 'utf8');
                const lines = content.split('\n');

                for (let i = 0; i < lines.length; i++) {
                  if (results.length >= maxResults) break;
                  if (lines[i].toLowerCase().includes(queryLower)) {
                    const contextStart = Math.max(0, i - 1);
                    const contextEnd = Math.min(lines.length, i + 2);
                    const context = lines.slice(contextStart, contextEnd).join('\n');
                    results.push({
                      path: entryRelative,
                      line: i + 1,
                      context: context.slice(0, 300),
                    });
                  }
                }
              } catch {
                // пропускаем файлы которые не удалось прочитать
              }
            }
          }
        };

        await walkDir(scopePath, '');

        return {
          query,
          results,
          count: results.length,
          truncated: results.length >= maxResults,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ============================================================================
// spawn_subagent — породить подзадачу и дождаться её результата.
//
// Реализация: создаёт дочернюю AgentTask с parentTaskId, запускает
// runAgentTask (синхронно ждёт завершения), возвращает resultSummary.
//
// Ограничения:
//   - Под-агент выполняется последовательно (не параллельно) — текущий шаг
//     блокируется до завершения под-агента.
//   - Под-агент наследует episodeId и fsScope от родителя.
//   - maxSteps для под-агента = 8 (меньше, чем у корневого, чтобы избежать
//     бесконечной рекурсии).
//   - Глубина рекурсии ограничена 2 (под-агент не может породить под-агента).
// ============================================================================
function makeSpawnSubagentTool(task: AgentTask) {
  return tool({
    description: 'Породить под-агента для автономной подзадачи. Под-агент выполнит задачу самостоятельно и вернёт результат. Используй когда подзадача требует нескольких шагов (поиск + анализ, чтение нескольких файлов и т.п.). НЕ используй для простых действий — делай их сам.',
    inputSchema: z.object({
      goal: z.string().min(1).describe('Чёткая формулировка подзадачи для под-агента'),
      tools: z.array(z.string()).default([]).describe('Список инструментов для под-агента (по умолчанию все)'),
    }),
    execute: async ({ goal, tools: toolWhitelist }) => {
      // Проверяем глубину рекурсии — под-агент не может породить под-агента.
      // Это предотвращает бесконечную рекурсию.
      if (task.parentTaskId !== null) {
        return {
          error: 'Достигнута максимальная глубина под-агентов (1 уровень). Выполняйте подзадачу последовательно в рамках текущего агента.',
          goal,
        };
      }

      try {
        // Импортируем здесь чтобы избежать circular dependency
        // (runner.ts импортирует tools.ts через buildAgentTools)
        const { createAgentTask } = await import('./task');
        const { runAgentTask } = await import('./runner');
        const { getAgentTask } = await import('./task');

        // Создаём дочернюю задачу
        const subTask = await createAgentTask({
          episodeId: task.episodeId,
          goal,
          parentTaskId: task.id,
          toolsWhitelist: toolWhitelist && toolWhitelist.length > 0 ? toolWhitelist : null,
          fsScope: task.fsScope,
          maxSteps: 8,  // меньше, чем у корневого
          maxDurationSec: Math.min(300, task.maxDurationSec),  // максимум 5 мин
        });

        // Запускаем sub-agent с timeout — если sub-agent входит в waiting_input
        // (задаёт вопрос пользователю), родитель не должен блокировать навсегда.
        // Таймаут = maxDurationSec под-агента + 30 сек запас.
        const subTimeoutMs = Math.min(300, task.maxDurationSec) * 1000 + 30_000;
        let timedOut = false;

        await Promise.race([
          runAgentTask(subTask.id),
          new Promise<void>((_, reject) =>
            setTimeout(() => {
              timedOut = true;
              reject(new Error(`Под-агент превысил лимит времени (${subTimeoutMs / 1000} сек)`));
            }, subTimeoutMs),
          ),
        ]).catch(e => {
          if (!timedOut) throw e;  // реальная ошибка, не таймаут
          console.warn(`[spawn_subagent] timed out after ${subTimeoutMs}ms`);
        });

        // Получаем результат
        const completed = await getAgentTask(subTask.id);

        if (!completed) {
          return { error: 'Под-агент завершился без результата', goal, subTaskId: subTask.id };
        }

        // Если таймаут — задача может быть ещё в transient-статусе
        if (timedOut && ['planning', 'executing', 'waiting_input', 'synthesizing'].includes(completed.status)) {
          // Помечаем как failed чтобы не висела
          const { cancelAgentTask } = await import('./task');
          await cancelAgentTask(subTask.id);
          return {
            error: `Под-агент не уложился в ${subTimeoutMs / 1000} сек. Возможно, он ждал ввода от пользователя. Задача отменена.`,
            goal,
            subTaskId: subTask.id,
          };
        }

        if (completed.status === 'failed') {
          return {
            error: `Под-агент не смог выполнить задачу: ${completed.error ?? 'неизвестная ошибка'}`,
            goal,
            subTaskId: subTask.id,
          };
        }

        if (completed.status === 'cancelled') {
          return {
            error: 'Под-агент был отменён',
            goal,
            subTaskId: subTask.id,
          };
        }

        return {
          goal,
          subTaskId: subTask.id,
          status: completed.status,
          result: completed.resultSummary ?? '(под-агент не вернул результат)',
          stepsCount: completed.currentStep,
        };
      } catch (e) {
        return {
          error: `Не удалось запустить под-агента: ${e instanceof Error ? e.message : String(e)}`,
          goal,
        };
      }
    },
  });
}

// ============================================================================
// Build tool registry for a specific task
// ============================================================================
export function buildAgentTools(task: AgentTask): ToolSet {
  const tools: ToolSet = {
    web_search: tool({
      description: 'Поиск в интернете (DuckDuckGo). Возвращает топ-10 результатов: title, url, snippet.',
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => await webSearch(query),
    }),
    save_artifact: tool({
      description: 'Сохранить артефакт (SVG, HTML, код, текст) как файл для пользователя.',
      inputSchema: z.object({
        filename: z.string().min(1),
        content: z.string().min(1),
        mime: z.string().optional().default('text/plain'),
      }),
      execute: async ({ filename, content, mime }) => {
        const result = await saveArtifact({ filename, content, mime });
        emitAgentEvent({
          type: 'artifact_saved',
          taskId: task.id,
          step: task.currentStep,
          filename: result.filename,
          url: result.url,
          ts: Date.now(),
        });
        return result;
      },
    }),
    read_file: makeReadFileTool(task),
    write_file: makeWriteFileTool(task),
    list_dir: makeListDirTool(task),
    file_search: makeFileSearchTool(task),
    http_request: makeHttpRequestTool(),
    ask_user: makeAskUserTool(task),
    spawn_subagent: makeSpawnSubagentTool(task),
  };

  // Apply whitelist if set
  if (task.toolsWhitelist) {
    let whitelist: string[] = [];
    try {
      whitelist = JSON.parse(task.toolsWhitelist);
    } catch { /* ignore — give all tools */ }
    if (Array.isArray(whitelist) && whitelist.length > 0) {
      const filtered: ToolSet = {};
      for (const name of whitelist) {
        if (name in tools) filtered[name] = tools[name];
      }
      return filtered;
    }
  }

  return tools;
}

/**
 * Format tool list for the system prompt (so the model knows what's available).
 *
 * Выводит имя + описание + краткий список параметров с типами.
 * Это используется в PLAN-промпте (где tools не передаются в streamText,
 * поэтому planner не видит JSON-схем нативно) и в EXECUTE-промпте.
 *
 * Формат:
 *   - web_search: Поиск в интернете (DuckDuckGo)...
 *       query (string, required): Поисковый запрос
 *   - save_artifact: Сохранить артефакт...
 *       filename (string, required): Имя файла
 *       content (string, required): Полное содержимое
 *       mime (string, optional): MIME-тип
 */
export function describeTools(tools: ToolSet): string {
  return Object.entries(tools)
    .map(([name, toolDef]) => {
      const lines: string[] = [`- ${name}`];

      // Description
      const desc = typeof toolDef?.description === 'string' ? toolDef.description : '';
      if (desc) {
        lines.push(`    ${desc.slice(0, 200)}`);
      }

      // Parameters — извлекаем из Zod-схемы через _def.shape или _def.schema
      const params = extractZodParams(toolDef?.inputSchema);
      if (params.length > 0) {
        for (const p of params) {
          const reqStr = p.required ? 'required' : 'optional';
          lines.push(`    ${p.name} (${p.type}, ${reqStr})${p.description ? ': ' + p.description : ''}`);
        }
      }

      return lines.join('\n');
    })
    .join('\n');
}

// ============================================================================
// Helper: извлечь параметры из Zod-схемы.
//
// Zod v4 internal API (проверено на zod@4.3.5):
//   - schema._def.shape — ОБЪЕКТ (не функция, как в v3), содержит поля
//   - field._def.type — строка: 'string', 'number', 'default', 'optional', etc.
//   - field.description — описание (на самом поле, не на _def)
//   - field._def.innerType — обёрнутый тип (для default/optional wrappers)
//
// Для default/optional нужно развернуть (unwrap) до базового типа.
// ============================================================================
type ZodParam = { name: string; type: string; required: boolean; description?: string };

function extractZodParams(schema: unknown): ZodParam[] {
  try {
    const s = schema as { _def?: { shape?: Record<string, unknown> } };
    if (!s?._def?.shape) return [];

    // Zod v4: _def.shape — это объект, не функция
    const shape = s._def.shape;
    const params: ZodParam[] = [];

    for (const [name, field] of Object.entries(shape)) {
      const f = field as {
        _def?: { type?: string; innerType?: unknown };
        description?: string;
        isOptional?: () => boolean;
      };

      // Разворачиваем default/optional wrappers до базового типа
      let inner = f;
      let hasDefault = false;
      let hasOptional = false;

      while (inner?._def && (inner._def.type === 'default' || inner._def.type === 'optional')) {
        if (inner._def.type === 'default') hasDefault = true;
        if (inner._def.type === 'optional') hasOptional = true;
        inner = inner._def.innerType as typeof inner;
      }

      const baseType = inner?._def?.type ?? 'unknown';
      const type = zodTypeToSimple(baseType);

      // required = нет default И нет optional.
      // default означает "модель может не передать — подставится дефолт",
      // поэтому с точки зрения tool-calling это optional.
      const required = !hasDefault && !hasOptional;

      // description — на самом поле, не на _def (Zod v4)
      const description = f.description;

      params.push({ name, type, required, description });
    }

    return params;
  } catch {
    return [];
  }
}

function zodTypeToSimple(typeName: string): string {
  if (typeName.includes('string')) return 'string';
  if (typeName.includes('number')) return 'number';
  if (typeName.includes('boolean')) return 'boolean';
  if (typeName.includes('array')) return 'array';
  if (typeName.includes('object')) return 'object';
  return 'string';
}
