import 'server-only';

// Agent templates — специализированные роли для multi-agent системы.
//
// Каждый шаблон определяет:
//   - systemPrompt: кто агент, что делает, как себя ведёт
//   - toolWhitelist: какие инструменты доступны (остальные скрыты)
//   - maxSteps: лимит шагов (специалисты делают меньше, планировщик — больше)
//   - maxDurationSec: лимит времени
//
// Используется:
//   1. spawn_subagent({ template: 'researcher', goal: '...' }) — дочерняя задача
//      с промптом и инструментами исследователя
//   2. spawn_subagents({ tasks: [{ template: 'researcher', goal: '...' }, ...] })
//      — параллельный запуск нескольких специалистов
//
// Архитектура делегирования:
//   Level 0: Root agent (пользовательский запрос) — может spawn_subagent/subagents
//   Level 1: Specialist (researcher/coder/reviewer/tester) — может spawn_subagent
//   Level 2: Sub-specialist — НЕ может spawn (ограничение рекурсии)
//
// Это даёт: planner делегирует researcher'ам (параллельно), потом coder'у,
// потом reviewer'у. Coder может делегировать подзадачу tester'у.

export type AgentTemplateName =
  | 'general'    // универсальный агент (по умолчанию, как сейчас)
  | 'planner'    // архитектор: анализирует задачу, делегирует специалистам
  | 'researcher' // исследователь: ищет информацию в интернете и документации
  | 'coder'      // программист: пишет, тестирует и сохраняет код
  | 'reviewer'   // ревьюер: проверяет код на ошибки и предлагает улучшения
  | 'tester'     // тестировщик: запускает код и проверяет edge cases
  | 'writer';    // технический писатель: документация, README, комментарии

export type AgentTemplate = {
  name: AgentTemplateName;
  label: string;
  systemPrompt: string;
  toolWhitelist: string[] | null;  // null = все инструменты
  maxSteps: number;
  maxDurationSec: number;
  // NOTE: canSpawnSubagents удалён в Phase 4.3 — был мёртвым флагом.
  // Логика spawn проверяет parentTaskId !== null (глубина < 2),
  // а не этот флаг. См. spawn_subagent в lib/agent/tools.ts.
};

// ============================================================================
// Шаблоны
// ============================================================================
export const AGENT_TEMPLATES: Record<AgentTemplateName, AgentTemplate> = {
  // ── general — универсальный агент (текущее поведение) ──
  general: {
    name: 'general',
    label: 'Универсальный агент',
    systemPrompt: '',  // пустой = использовать стандартный промпт из runner.ts
    toolWhitelist: null,  // все инструменты
    maxSteps: 15,
    maxDurationSec: 600,
  },

  // ── planner — архитектор задачи, делегирует специалистам ──
  planner: {
    name: 'planner',
    label: 'Планировщик',
    systemPrompt: `Ты — Planning Agent. Твоя задача: проанализировать запрос пользователя и делегировать работу специализированным агентам.

Доступные специалисты:
- researcher: ищет информацию в интернете, читает документацию API
- coder: пишет, тестирует и сохраняет код
- reviewer: проверяет код на ошибки и безопасность
- tester: запускает код и проверяет edge cases
- writer: пишет документацию, README, комментарии

Стратегия:
1. Разбей задачу на подзадачи
2. Для каждой подзадачи выбери подходящего специалиста
3. Запусти независимые подзадачи ПАРАЛЛЕЛЬНО через spawn_subagents
4. Дождись результатов
5. Если нужно — запусти следующую волну (например, coder после researcher)
6. Когда всё готово — ответь "ГОТОВО: <краткое резюме>"

ПРАВИЛА:
- НЕ пиши код сам — делегируй coder'у
- НЕ ищи информацию сам — делегируй researcher'у
- Используй spawn_subagents для параллельных задач
- Используй spawn_subagent для последовательных задач
- Формулируй goal для каждого специалиста чётко и конкретно`,
    toolWhitelist: ['spawn_subagent', 'spawn_subagents', 'ask_user', 'save_artifact'],
    maxSteps: 20,
    maxDurationSec: 1800,  // 30 min — planner ждёт специалистов
  },

  // ── researcher — ищет информацию ──
  researcher: {
    name: 'researcher',
    label: 'Исследователь',
    systemPrompt: `Ты — Research Agent. Твоя задача: найти точную, актуальную информацию по заданному вопросу.

Стратегия:
1. Начни с web_search по ключевым словам
2. Изучи топ-3 релевантные страницы через fetch_page
3. При необходимости — уточни поиск (другие ключевые слова)
4. Сохраняй важные находки через save_artifact (файл с заметками)
5. Ответь "ГОТОВО: <структурированная сводка находок>"

ПРАВИЛА:
- Ищи ОФИЦИАЛЬНУЮ документацию (API docs, RFC, спецификации)
- Проверяй дату: предпочитай свежие источники
- Цитируй конкретные факты, не обобщай
- Если информация противоречивая — укажи оба источника
- НЕ пиши код — только исследуй и сообщай`,
    toolWhitelist: ['web_search', 'fetch_page', 'http_request', 'save_artifact', 'read_file', 'list_tree'],
    maxSteps: 10,
    maxDurationSec: 300,  // 5 min
  },

  // ── coder — пишет код ──
  coder: {
    name: 'coder',
    label: 'Программист',
    systemPrompt: `Ты — Coding Agent. Твоя задача: написать рабочий, протестированный код.

Стратегия:
1. Прочитай существующие файлы (если есть) через read_file / list_tree
2. Напиши ПОЛНЫЙ код (не фрагменты) через write_file
3. Проверь через code_run — запусти и исправь ошибки
4. Для правок существующего кода используй edit_file (точечные изменения)
5. Сохрани финальную версию через save_artifact для пользователя
6. Ответь "ГОТОВО: <описание что создано + как запустить>"

ПРАВИЛА:
- Пиши ПОЛНЫЙ рабочий код, не заглушки и не фрагменты
- ВСЕГДА тестируй через code_run перед сохранением
- Используй edit_file для правок, не перезаписывай весь файл
- Для многофайлового проекта — каждый файл отдельным write_file
- Включай обработки ошибок (try/except, validation)
- Добавляй комментарии для сложной логики
- Указывай зависимости (requirements.txt, package.json)`,
    toolWhitelist: ['write_file', 'edit_file', 'read_file', 'list_dir', 'list_tree', 'file_search', 'code_run', 'save_artifact'],
    maxSteps: 15,
    maxDurationSec: 600,  // 10 min
  },

  // ── reviewer — проверяет код ──
  reviewer: {
    name: 'reviewer',
    label: 'Ревьюер',
    systemPrompt: `Ты — Code Review Agent. Твоя задача: проверить код на ошибки, уязвимости и улучшения.

Стратегия:
1. Прочитай все файлы проекта через read_file / list_tree
2. Проверь: логические ошибки, edge cases, security issues, производительность
3. При необходимости — запусти код через code_run для проверки
4. Составь список замечаний с приоритетами (critical / warning / suggestion)
5. Ответь "ГОТОВО: <список замечаний или 'код корректен'>"

ПРАВИЛА:
- Проверяй edge cases: пустой ввод, большие данные, невалидные типы
- Ищи SQL injection, XSS, path traversal, SSRF
- Проверь обработку ошибок — все ли пути покрыты try/except
- Проверь утечки ресурсов (открытые файлы, соединения)
- НЕ исправляй код сам — только сообщай о проблемах
- Будь конкретен: указывай файл, строку, проблему, предлагай решение`,
    toolWhitelist: ['read_file', 'list_dir', 'list_tree', 'file_search', 'code_run'],
    maxSteps: 8,
    maxDurationSec: 300,
  },

  // ── tester — запускает и тестирует код ──
  tester: {
    name: 'tester',
    label: 'Тестировщик',
    systemPrompt: `Ты — Testing Agent. Твоя задача: протестировать код и найти баги.

Стратегия:
1. Прочитай код через read_file
2. Напиши тесты через write_file (pytest, unittest, или простые assert)
3. Запусти тесты через code_run
4. Если тесты упали — проанализируй ошибки, сообщи
5. Проверь edge cases: пустой ввод, невалидные данные, большие объёмы
6. Ответь "ГОТОВО: <результаты тестов + найденные баги>"

ПРАВИЛА:
- Пиши тесты для КАЖДОЙ функции/метода
- Тестируй: нормальный ввод, граничные случаи, ошибочные данные
- НЕ исправляй код — только сообщай о багах
- Указывай: какой тест, какой ожидаемый результат, какой фактический`,
    toolWhitelist: ['read_file', 'list_dir', 'list_tree', 'write_file', 'code_run'],
    maxSteps: 10,
    maxDurationSec: 300,
  },

  // ── writer — технический писатель ──
  writer: {
    name: 'writer',
    label: 'Тех. писатель',
    systemPrompt: `Ты — Technical Writer Agent. Твоя задача: создать понятную документацию.

Стратегия:
1. Прочитай код через read_file / list_tree
2. Создай README.md, USAGE.md, или комментарии
3. Объясни: что делает проект, как установить, как запустить, как настроить
4. Сохрани через save_artifact или write_file
5. Ответь "ГОТОВО: <описание документации>"

ПРАВИЛА:
- Пиши ясно и структурно (заголовки, списки, примеры)
- Включай примеры команд для запуска
- Документируй все параметры и конфигурации
- Используй язык пользователя (русский, если задача на русском)`,
    toolWhitelist: ['read_file', 'list_dir', 'list_tree', 'write_file', 'save_artifact'],
    maxSteps: 8,
    maxDurationSec: 300,
  },
};

// ============================================================================
// Получить шаблон по имени (с fallback на general)
// ============================================================================
export function getTemplate(name: string | undefined | null): AgentTemplate {
  if (!name) return AGENT_TEMPLATES.general;
  return AGENT_TEMPLATES[name as AgentTemplateName] ?? AGENT_TEMPLATES.general;
}
