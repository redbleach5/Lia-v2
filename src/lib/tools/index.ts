// Tools registry — what Lia can do.
//
// AI SDK native tool calling: model decides in one LLM call whether to use a tool
// and which one. No separate "decideTool" LLM call like in LIA v1.

import { tool } from 'ai';
import { z } from 'zod';
import { webSearch } from './web-search';
import { saveArtifact } from './save-artifact';

// ============================================================================
// web_search — поиск в интернете через DuckDuckGo HTML
// ============================================================================
const webSearchTool = tool({
  description: 'Поиск в интернете для актуальной/фактологической информации. Возвращает топ-10 результатов: title, url, snippet. Используй когда: версии библиотек, свежие события, документация, ошибки с кодами. НЕ используй для философии, личных советов, математики.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Поисковый запрос (русский или английский)'),
  }),
  execute: async ({ query }) => {
    return await webSearch(query);
  },
});

// ============================================================================
// save_artifact — сохранить артефакт как файл для пользователя
// ============================================================================
const saveArtifactTool = tool({
  description: 'Сохранить артефакт (SVG, HTML, код, текст) как файл для пользователя. Используй когда сгенерировала SVG-логотип, HTML-страницу, скрипт, конфиг и т.п. Пользователь увидит карточку с превью и кнопкой "Скачать".',
  inputSchema: z.object({
    filename: z.string().min(1).describe('Имя файла, например "logo.svg" или "script.py"'),
    content: z.string().min(1).describe('Полное содержимое файла'),
    // .default() вместо .optional() — даёт корректный вывод типа для AI SDK v7
    // и одновременно обеспечивает дефолтное значение, если модель его не передаст.
    mime: z.string().default('text/plain').describe('MIME-тип, например "image/svg+xml" или "text/plain"'),
  }),
  execute: async ({ filename, content, mime }) => {
    return await saveArtifact({ filename, content, mime });
  },
});

// ============================================================================
// Registry — экспортируем объект для передачи в streamText
// ============================================================================
export const tools = {
  web_search: webSearchTool,
  save_artifact: saveArtifactTool,
};

export type ToolName = keyof typeof tools;

/**
 * Возвращает краткое описание вызова для UI.
 */
export function describeToolCall(name: string, input: unknown): string {
  if (name === 'web_search') {
    const q = (input as { query?: string })?.query ?? '';
    return `Поиск: "${q}"`;
  }
  if (name === 'save_artifact') {
    const f = (input as { filename?: string })?.filename ?? '';
    return `Сохранение: ${f}`;
  }
  return name;
}
