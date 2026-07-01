import 'server-only';

// Tools registry — what Lia can do.
//
// AI SDK native tool calling: model decides in one LLM call whether to use a tool
// and which one. No separate "decideTool" LLM call like in LIA v1.

import { tool } from 'ai';
import { z } from 'zod';
import { webSearch } from './web-search';
import { fetchPage } from './web-search';
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
// fetch_page — чтение содержимого веб-страницы
// ============================================================================
// ВАЖНО: этот инструмент критичен для ответов на новостные/фактологические
// запросы. web_search возвращает только короткие snippets (~150 символов),
// которых недостаточно для конкретного ответа. Без fetch_page модель видит
// только заголовки и краткие выдержки — и отвечает общими фразами или
// отказом ("я не могу дать точную информацию").
//
// С fetch_page модель может:
//   1) web_search "GTA 6 новости" → получить 10 ссылок
//   2) fetch_page на топ-2 ссылки → прочитать полный текст статьи
//   3) Сформировать конкретный ответ с датами, цифрами, фактами
const fetchPageTool = tool({
  description: 'Загрузить веб-страницу и извлечь читаемый текст. Используй ПОСЛЕ web_search чтобы прочитать содержимое конкретной страницы из результатов поиска. Возвращает текст (до 5000 символов) без HTML-тегов. Нужен для конкретных новостей, документации API, туториалов — web_search даёт только короткие snippets.',
  inputSchema: z.object({
    url: z.string().min(1).describe('Полный URL страницы для чтения (из результата web_search)'),
    maxChars: z.number().optional().describe('Максимум символов текста (по умолчанию 5000)'),
  }),
  execute: async ({ url, maxChars }) => {
    return await fetchPage(url, maxChars);
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
// Chat mode: web_search + fetch_page + save_artifact (3 инструмента).
// Agent mode: дополнительно read_file/write_file/edit_file/list_dir/code_run/
//             http_request/spawn_subagent — настраивается в lib/agent/tools.ts
export const tools = {
  web_search: webSearchTool,
  fetch_page: fetchPageTool,
  save_artifact: saveArtifactTool,
};
