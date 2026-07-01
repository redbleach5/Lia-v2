import 'server-only';

// Agent-specific tools — используются только в agent mode.
//
// Это расширяет базовый tools registry (web_search, save_artifact) инструментами
// для полноценной автономной работы: чтение/запись файлов, HTTP, ask_user, sub-agents,
// выполнение кода, чтение веб-страниц.
//
// Все FS-операции ограничены fsScope задачи (path prefix). Без fsScope — отказ.

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { join } from 'path';
import { saveArtifact } from '../tools/save-artifact';
import { webSearch, fetchPage } from '../tools/web-search';
import { runCode } from '../tools/code-run';
import { safePathWithinScope } from './fs-scope';
import type { AgentTask } from './task';
import { getTemplate, type AgentTemplateName } from './templates';
import {
  emitAgentEvent,
  setWaiting,
  isCancelled,
  signalCancellation,
} from './events';

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
      path: z.string().default('.').describe('Путь относительно рабочей директории (по умолчанию ".")'),
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
// list_tree — рекурсивное дерево проекта (для агента)
// ============================================================================
function makeListTreeTool(task: AgentTask) {
  return tool({
    description: 'Получить рекурсивное дерево файлов рабочей директории (до 3 уровней вложенности). Показывает директории, файлы и их размеры. Полезно для обзора структуры проекта.',
    inputSchema: z.object({
      maxDepth: z.number().default(3).describe('Максимальная глубина вложенности (по умолч 3)'),
    }),
    execute: async ({ maxDepth }) => {
      if (!task.fsScope) {
        return { error: 'У задачи нет рабочей директории' };
      }
      const fullPath = await safePathWithinScope('.', task.fsScope);
      if (!fullPath) {
        return { error: 'Не удалось определить рабочую директорию' };
      }

      type TreeNode = { name: string; type: string; size?: number; children?: TreeNode[] };

      async function buildTree(dirPath: string, depth: number): Promise<TreeNode[]> {
        if (depth >= maxDepth) return [];
        const entries = await readdir(dirPath, { withFileTypes: true });
        const nodes: TreeNode[] = [];

        for (const entry of entries) {
          // Skip hidden/node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

          const entryPath = join(dirPath, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(entryPath, depth + 1).catch(() => []);
            nodes.push({ name: entry.name, type: 'dir', children });
          } else if (entry.isFile()) {
            const s = await stat(entryPath).catch(() => null);
            nodes.push({ name: entry.name, type: 'file', size: s?.size });
          }
        }
        return nodes;
      }

      try {
        const tree = await buildTree(fullPath, 0);
        return { tree };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

// ============================================================================
// edit_file — partial edit (замена строк, вставка, удаление)
// ============================================================================
// Это КРИТИЧЕСКИ важный инструмент для итеративной разработки.
// Вместо перезаписи всего файла (write_file) агент может точечно изменить
// нужные строки — экономит токены и время.
//
// Режимы:
//   range  — заменить строки с startLine по endLine (включительно, 1-indexed)
//   insert — вставить текст после указанной строки (lineNumber, 0 = в начало)
//   delete — удалить строки с startLine по endLine
//   regex  — заменить все совпадения regex-паттерна на replacement
//
// Возвращает diff (unified format) + полный контекст изменённой области.
function makeEditFileTool(task: AgentTask) {
  return tool({
    description: 'Точечно изменить файл: заменить строки, вставить текст, удалить строки, или заменить по regex. НЕ перезаписывает весь файл — меняет только указанную часть. Экономит токены и время. Используй вместо write_file когда нужно изменить часть существующего файла. Возвращает diff изменений.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Путь к файлу относительно рабочей директории'),
      mode: z.enum(['range', 'insert', 'delete', 'regex']).describe('range: заменить строки startLine-endLine; insert: вставить после lineNumber; delete: удалить startLine-endLine; regex: заменить по паттерну'),
      content: z.string().default('').describe('Новый текст (для range и insert) или replacement (для regex). Игнорируется для delete.'),
      startLine: z.number().optional().describe('Начальная строка (1-indexed, включительно). Для mode=range и mode=delete.'),
      endLine: z.number().optional().describe('Конечная строка (1-indexed, включительно). Для mode=range и mode=delete.'),
      lineNumber: z.number().optional().describe('Строка после которой вставить (0 = в начало файла). Для mode=insert.'),
      pattern: z.string().optional().describe('Regex паттерн для поиска. Для mode=regex.'),
    }),
    execute: async ({ path, mode, content, startLine, endLine, lineNumber, pattern }) => {
      if (!task.fsScope) {
        return { error: 'У задачи нет рабочей директории (fsScope). Редактирование файлов запрещено.' };
      }
      const fullPath = await safePathWithinScope(path, task.fsScope);
      if (!fullPath) {
        return { error: `Путь "${path}" выходит за пределы рабочей директории` };
      }

      try {
        // Read current content
        const oldContent = await readFile(fullPath, 'utf8');
        const oldLines = oldContent.split('\n');

        let newLines: string[];
        let diffBefore: string[];
        let diffAfter: string[];

        if (mode === 'range') {
          if (!startLine || !endLine || startLine < 1 || endLine < startLine || endLine > oldLines.length) {
            return { error: `Invalid line range: start=${startLine}, end=${endLine}, file has ${oldLines.length} lines` };
          }
          const contentLines = content.split('\n');
          newLines = [
            ...oldLines.slice(0, startLine - 1),
            ...contentLines,
            ...oldLines.slice(endLine),
          ];
          const ctxStart = Math.max(0, startLine - 3);
          const ctxEnd = Math.min(oldLines.length, endLine + 3);
          diffBefore = oldLines.slice(ctxStart, ctxEnd).map((l, i) => `  ${ctxStart + i + 1}: ${l}`);
          diffAfter = newLines.slice(ctxStart, ctxStart + contentLines.length + 6).map((l, i) => {
            const lineNum = ctxStart + i + 1;
            const isChanged = lineNum >= startLine && lineNum <= startLine + contentLines.length - 1;
            return `${isChanged ? '+' : ' '} ${lineNum}: ${l}`;
          });

        } else if (mode === 'insert') {
          const lineNum = lineNumber ?? 0;
          if (lineNum < 0 || lineNum > oldLines.length) {
            return { error: `Invalid lineNumber: ${lineNum}, file has ${oldLines.length} lines` };
          }
          const contentLines = content.split('\n');
          newLines = [
            ...oldLines.slice(0, lineNum),
            ...contentLines,
            ...oldLines.slice(lineNum),
          ];
          const ctxStart = Math.max(0, lineNum - 2);
          const ctxEnd = Math.min(newLines.length, lineNum + contentLines.length + 2);
          diffBefore = oldLines.slice(ctxStart, Math.min(oldLines.length, lineNum + 2)).map((l, i) => `  ${ctxStart + i + 1}: ${l}`);
          diffAfter = newLines.slice(ctxStart, ctxEnd).map((l, i) => {
            const ln = ctxStart + i + 1;
            const isInserted = ln > lineNum && ln <= lineNum + contentLines.length;
            return `${isInserted ? '+' : ' '} ${ln}: ${l}`;
          });

        } else if (mode === 'delete') {
          if (!startLine || !endLine || startLine < 1 || endLine < startLine || endLine > oldLines.length) {
            return { error: `Invalid line range: start=${startLine}, end=${endLine}, file has ${oldLines.length} lines` };
          }
          newLines = [
            ...oldLines.slice(0, startLine - 1),
            ...oldLines.slice(endLine),
          ];
          const ctxStart = Math.max(0, startLine - 3);
          const ctxEnd = Math.min(oldLines.length, endLine + 3);
          diffBefore = oldLines.slice(ctxStart, ctxEnd).map((l, i) => `  ${ctxStart + i + 1}: ${l}`);
          diffAfter = newLines.slice(ctxStart, Math.min(newLines.length, ctxStart + (endLine - startLine + 1) + 3)).map((l, i) => `- ${ctxStart + i + 1}: [deleted]`);

        } else if (mode === 'regex') {
          if (!pattern) {
            return { error: 'pattern is required for regex mode' };
          }
          const regex = new RegExp(pattern, 'g');
          const newContent = oldContent.replace(regex, content);
          if (newContent === oldContent) {
            return { error: 'No matches found for pattern' };
          }
          newLines = newContent.split('\n');
          // Find first changed line for diff
          let firstChange = 0;
          for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
            if (oldLines[i] !== newLines[i]) { firstChange = i; break; }
          }
          const ctxStart = Math.max(0, firstChange - 2);
          diffBefore = oldLines.slice(ctxStart, ctxStart + 5).map((l, i) => `  ${ctxStart + i + 1}: ${l}`);
          diffAfter = newLines.slice(ctxStart, ctxStart + 5).map((l, i) => {
            const isChanged = oldLines[ctxStart + i] !== l;
            return `${isChanged ? '+' : ' '} ${ctxStart + i + 1}: ${l}`;
          });

        } else {
          return { error: `Unknown mode: ${mode}` };
        }

        // Write new content
        await writeFile(fullPath, newLines.join('\n'), 'utf8');

        // Emit event for workspace UI
        emitAgentEvent({
          type: 'tool_end',
          taskId: task.id,
          step: task.currentStep,
          tool: 'edit_file',
          success: true,
          output: { path, mode, linesChanged: oldLines.length - newLines.length },
          ts: Date.now(),
        });

        return {
          path,
          mode,
          oldLineCount: oldLines.length,
          newLineCount: newLines.length,
          diff: [...diffBefore, '---', ...diffAfter].join('\n'),
          success: true,
        };
      } catch (e) {
        // File doesn't exist — for range/insert/regex modes, can't edit non-existent file
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return { error: `File not found: ${path}. Use write_file to create new files.` };
        }
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

import { assertSafeHost } from '@/lib/infra/ssrf';

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

      // Pattern: setInterval опрашивает isCancelled, но очищается в finally —
      // это гарантирует cleanup при resolve (ответ получен), reject (cancel) и throw.
      let interval: ReturnType<typeof setInterval> | undefined;
      try {
        const answer = await new Promise<string>((resolve, reject) => {
          setWaiting(task.id, { question, resolve, reject });

          // Poll for cancellation (resolveWaiting в input/route.ts вызовет resolve).
          interval = setInterval(() => {
            if (isCancelled(task.id)) {
              reject(new Error('cancelled'));
            }
          }, 500);
        });
        return { question, answer };
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      } finally {
        // Гарантированная очистка интервала — независимо от того,
        // завершился Promise через resolve, reject или throw.
        if (interval) clearInterval(interval);
      }
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
// spawn_subagent — породить подзадачу с шаблоном и дождаться результата.
//
// Параметр template определяет роль под-агента (researcher, coder, etc.):
//   - systemPrompt из шаблона заменяет стандартный промпт runner'а
//   - toolWhitelist из шаблона ограничивает доступные инструменты
//   - maxSteps / maxDurationSec из шаблона
//
// Глубина рекурсии:
//   Level 0 (root) → может spawn
//   Level 1 (specialist) → НЕ может spawn (ограничение рекурсии)
//   Phase 4.3: canSpawnSubagents флаг удалён — проверка через parentTaskId !== null.
// ============================================================================
function makeSpawnSubagentTool(task: AgentTask) {
  return tool({
    description: 'Породить под-агента для автономной подзадачи. Под-агент выполнит задачу самостоятельно и вернёт результат. Выбери подходящий template: researcher (поиск информации), coder (написание кода), reviewer (проверка кода), tester (тестирование), writer (документация), planner (делегирование). Используй spawn_subagents для параллельных задач.',
    inputSchema: z.object({
      goal: z.string().min(1).describe('Чёткая формулировка подзадачи для под-агента'),
      template: z.enum(['general', 'planner', 'researcher', 'coder', 'reviewer', 'tester', 'writer']).default('general').describe('Роль под-агента (определяет промпт, инструменты и лимиты)'),
    }),
    execute: async ({ goal, template: templateName }) => {
      const template = getTemplate(templateName);

      // Проверяем глубину рекурсии
      if (task.parentTaskId !== null) {
        return {
          error: 'Достигнута максимальная глубина под-агентов (2 уровня). Выполняйте подзадачу последовательно.',
          goal,
        };
      }

      try {
        const { createAgentTask } = await import('./task');
        const { runAgentTask } = await import('./runner');
        const { getAgentTask, cancelAgentTask } = await import('./task');

        const subTask = await createAgentTask({
          episodeId: task.episodeId,
          goal: template.systemPrompt
            ? `${template.systemPrompt}\n\n## ЗАДАЧА\n${goal}`
            : goal,
          parentTaskId: task.id,
          toolsWhitelist: template.toolWhitelist,
          fsScope: task.fsScope,
          maxSteps: Math.min(template.maxSteps, task.maxSteps),
          maxDurationSec: Math.min(template.maxDurationSec, task.maxDurationSec),
        });

        // Timeout
        const subTimeoutMs = template.maxDurationSec * 1000 + 30_000;
        let timedOut = false;

        await Promise.race([
          runAgentTask(subTask.id),
          new Promise<void>((_, reject) =>
            setTimeout(() => {
              timedOut = true;
              reject(new Error(`timeout: ${subTimeoutMs / 1000}s`));
            }, subTimeoutMs).unref?.(),
          ),
        ]).catch(e => {
          if (!timedOut) throw e;
        });

        const completed = await getAgentTask(subTask.id);

        if (!completed) {
          return { error: 'Под-агент завершился без результата', goal, subTaskId: subTask.id };
        }

        if (timedOut && ['planning', 'executing', 'waiting_input', 'synthesizing'].includes(completed.status)) {
          await cancelAgentTask(subTask.id);
          return {
            error: `Под-агент не уложился в ${subTimeoutMs / 1000} сек. Задача отменена.`,
            goal, subTaskId: subTask.id, template: template.name,
          };
        }

        if (completed.status === 'failed') {
          return {
            error: `Под-агент (${template.label}) не смог выполнить задачу: ${completed.error ?? 'неизвестная ошибка'}`,
            goal, subTaskId: subTask.id, template: template.name,
          };
        }

        if (completed.status === 'cancelled') {
          return { error: 'Под-агент был отменён', goal, subTaskId: subTask.id, template: template.name };
        }

        return {
          goal,
          subTaskId: subTask.id,
          template: template.name,
          templateLabel: template.label,
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
// spawn_subagents — параллельный запуск нескольких под-агентов.
//
// Создаёт N дочерних задач, запускает их ОДНОВРЕМЕННО через Promise.all,
// ждёт завершения всех, возвращает массив результатов.
//
// Используется planner'ом для независимых подзадач:
//   "Изучи ЮKassa API" + "Изучи Telegram API" → параллельно (2x быстрее)
// ============================================================================
function makeSpawnSubagentsTool(task: AgentTask) {
  return tool({
    description: 'Запустить НЕСКОЛЬКО под-агентов ПАРАЛЛЕЛЬНО. Каждый выполнит свою задачу одновременно с другими. Возвращает массив результатов. Используй для независимых подзадач (например: изучить два разных API параллельно). НЕ используй если задачи зависят друг от друга — тогда используй spawn_subagent последовательно.',
    inputSchema: z.object({
      tasks: z.array(z.object({
        goal: z.string().min(1).describe('Чёткая формулировка подзадачи'),
        template: z.enum(['general', 'planner', 'researcher', 'coder', 'reviewer', 'tester', 'writer']).default('general').describe('Роль под-агента'),
      })).min(1).max(5).describe('Массив подзадач (максимум 5 для параллельного выполнения)'),
    }),
    execute: async ({ tasks: subtasks }) => {
      // Проверяем глубину рекурсии
      if (task.parentTaskId !== null) {
        return {
          error: 'Достигнута максимальная глубина под-агентов (2 уровня).',
          tasks: subtasks,
        };
      }

      // Лимит параллельности — не более 5 одновременно
      const limited = subtasks.slice(0, 5);

      try {
        const { createAgentTask } = await import('./task');
        const { runAgentTask } = await import('./runner');
        const { getAgentTask, cancelAgentTask } = await import('./task');

        // Создаём все дочерние задачи
        const createdTasks = await Promise.all(
          limited.map(async (sub) => {
            const template = getTemplate(sub.template);
            const subTask = await createAgentTask({
              episodeId: task.episodeId,
              goal: template.systemPrompt
                ? `${template.systemPrompt}\n\n## ЗАДАЧА\n${sub.goal}`
                : sub.goal,
              parentTaskId: task.id,
              toolsWhitelist: template.toolWhitelist,
              fsScope: task.fsScope,
              maxSteps: Math.min(template.maxSteps, task.maxSteps),
              maxDurationSec: Math.min(template.maxDurationSec, task.maxDurationSec),
            });
            return { subTask, template, originalGoal: sub.goal };
          }),
        );

        // Запускаем ВСЕ параллельно с общим таймаутом
        const maxTimeout = Math.max(...createdTasks.map(c => c.template.maxDurationSec)) * 1000 + 30_000;
        let timedOut = false;

        const results = await Promise.allSettled(
          createdTasks.map(async ({ subTask }) => {
            return Promise.race([
              runAgentTask(subTask.id),
              new Promise<void>((_, reject) =>
                setTimeout(() => {
                  timedOut = true;
                  reject(new Error(`timeout: ${maxTimeout / 1000}s`));
                }, maxTimeout).unref?.(),
              ),
            ]).catch(e => {
              if (!timedOut) throw e;
            });
          }),
        );

        // Собираем результаты
        const summaries = await Promise.all(
          createdTasks.map(async ({ subTask, template, originalGoal }, i) => {
            const completed = await getAgentTask(subTask.id);

            // Если таймаут — отменяем
            if (timedOut && completed && ['planning', 'executing', 'waiting_input', 'synthesizing'].includes(completed.status)) {
              await cancelAgentTask(subTask.id).catch(() => null);
              return {
                goal: originalGoal,
                template: template.name,
                subTaskId: subTask.id,
                status: 'timeout',
                result: `Под-агент не уложился в ${maxTimeout / 1000} сек`,
              };
            }

            if (!completed) {
              return { goal: originalGoal, template: template.name, subTaskId: subTask.id, status: 'error', result: 'Нет результата' };
            }

            return {
              goal: originalGoal,
              template: template.name,
              templateLabel: template.label,
              subTaskId: subTask.id,
              status: completed.status,
              result: completed.resultSummary ?? '(нет результата)',
              error: completed.error,
              stepsCount: completed.currentStep,
            };
          }),
        );

        return {
          totalTasks: limited.length,
          completed: summaries.filter(s => s.status === 'done').length,
          failed: summaries.filter(s => s.status !== 'done').length,
          results: summaries,
        };
      } catch (e) {
        return {
          error: `Параллельный запуск не удался: ${e instanceof Error ? e.message : String(e)}`,
          tasks: limited,
        };
      }
    },
  });
}

// ============================================================================
// code_run — выполнение кода в sandbox (Python/JavaScript)
// ============================================================================
function makeCodeRunTool() {
  return tool({
    description: 'Выполнить код (Python или JavaScript) в sandbox. Полезно для: проверки кода перед сохранением, вычислений, тестирования гипотез, парсинга данных. Код выполняется с таймаутом 30 сек, без сетевого доступа, в изолированной temp-директории. Возвращает stdout + stderr.',
    inputSchema: z.object({
      language: z.enum(['python', 'javascript']).default('python').describe('Язык программирования'),
      code: z.string().min(1).describe('Код для выполнения'),
    }),
    execute: async ({ language, code }) => {
      const result = await runCode(code, language);
      return {
        language,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated,
        success: result.exitCode === 0,
      };
    },
  });
}

// ============================================================================
// fetch_page — чтение содержимого веб-страницы
// ============================================================================
function makeFetchPageTool() {
  return tool({
    description: 'Загрузить веб-страницу и извлечь читаемый текст (API-документация, туториалы, примеры кода). Удаляет HTML-теги, скрипты, навигацию. Возвращает до 5000 символов чистого текста с сохранением структуры (заголовки, параграфы, блоки кода). Используй ПОСЛЕ web_search для чтения конкретных страниц из результатов.',
    inputSchema: z.object({
      url: z.string().url().describe('Полный URL страницы для чтения'),
      maxChars: z.number().default(5000).describe('Максимум символов текста (по умолч 5000)'),
    }),
    execute: async ({ url, maxChars }) => {
      const result = await fetchPage(url, maxChars);
      return result;
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
    edit_file: makeEditFileTool(task),
    list_dir: makeListDirTool(task),
    list_tree: makeListTreeTool(task),
    file_search: makeFileSearchTool(task),
    http_request: makeHttpRequestTool(),
    fetch_page: makeFetchPageTool(),
    code_run: makeCodeRunTool(),
    ask_user: makeAskUserTool(task),
    spawn_subagent: makeSpawnSubagentTool(task),
    spawn_subagents: makeSpawnSubagentsTool(task),
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
//
// ВАЖНО: это приватное API Zod. При апгрейде Zod может сломаться.
// try/catch обеспечивает fallback — описания не выводятся, но tools работают.
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
