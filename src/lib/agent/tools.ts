// Agent-specific tools — используются только в agent mode.
//
// Это расширяет базовый tools registry (web_search, save_artifact) инструментами
// для полноценной автономной работы: чтение/запись файлов, HTTP, ask_user, sub-agents.
//
// Все FS-операции ограничены fsScope задачи (path prefix). Без fsScope — отказ.

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
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
function safePathWithinScope(path: string, scope: string | null): string | null {
  if (!scope) return null;
  // Normalize: resolve relative to scope, prevent .. escapes
  const base = resolve(scope);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // escape attempt
  return target;
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
      const fullPath = safePathWithinScope(path, task.fsScope);
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
      const fullPath = safePathWithinScope(path, task.fsScope);
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
      const fullPath = safePathWithinScope(path, task.fsScope);
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
const BLOCKED_HOSTS = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./, /^::1$/, /^fc00::/, /^fe80::/,
  /^localhost$/i,
];

function isPrivateHost(hostname: string): boolean {
  return BLOCKED_HOSTS.some(re => re.test(hostname));
}

function makeHttpRequestTool() {
  return tool({
    description: 'Выполнить HTTP GET-запрос к указанному URL. Возвращает статус, заголовки, тело (до 10000 символов). Блокирует private/internal IP.',
    inputSchema: z.object({
      url: z.string().url().describe('Полный URL включая схему (http/https)'),
    }),
    execute: async ({ url }) => {
      try {
        const u = new URL(url);
        if (isPrivateHost(u.hostname)) {
          return { error: `Хост "${u.hostname}" заблокирован (private/internal IP)` };
        }
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Lia-Agent/2.0' },
          signal: AbortSignal.timeout(20_000),
          redirect: 'follow',
        });
        const text = await res.text();
        return {
          status: res.status,
          statusText: res.statusText,
          contentType: res.headers.get('content-type'),
          body: text.slice(0, 10_000),
          truncated: text.length > 10_000,
        };
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
// spawn_subagent — породить подзадачу
// ============================================================================
// MVP: заглушка — возвращает ошибку, что sub-agents пока не поддерживаются.
// Полноценная реализация требует очереди задач и зависимостей.
function makeSpawnSubagentTool() {
  return tool({
    description: 'Породить под-агента для параллельной подзадачи. ВНИМАНИЕ: в текущей версии не поддерживается — используйте последовательные шаги.',
    inputSchema: z.object({
      goal: z.string().min(1),
      tools: z.array(z.string()).optional(),
    }),
    execute: async ({ goal }) => {
      return {
        error: 'Sub-agents не поддерживаются в текущей версии. Выполняйте подзадачи последовательно в рамках текущего агента.',
        goal,
      };
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
    http_request: makeHttpRequestTool(),
    ask_user: makeAskUserTool(task),
    spawn_subagent: makeSpawnSubagentTool(),
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
 */
export function describeTools(tools: ToolSet): string {
  return Object.entries(tools)
    .map(([name]) => `- ${name}`)
    .join('\n');
}
