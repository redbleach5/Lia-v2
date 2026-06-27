# Lia v2 — Design Doc

> Personal AI companion: warm friend, not assistant. Local-first (Ollama). Long-term memory that doesn't leak between chats. Agent mode for multi-step tasks. Trainable personality via RL. VRM avatar with emotions.

---

## 1. Принципы

1. **Один LLM-вызов на сообщение** в standard-режиме. Никаких perceive → decideTool → deliberate → speak → consolidate цепочек.
2. **Память привязана к эпизоду** — кроме глобального профиля пользователя. Утечек между чатами нет архитектурно, не фильтрами.
3. **Личность в коде, не в промпте.** RL-политика модулирует тон/длину/стиль, но ядро личности — константа.
4. **Агентский режим — первоклассная сущность.** Background tasks с checkpointing, resume, observability. Не «одна из 4 cognitive depth».
5. **Промпт — статический prefix + динамический suffix.** Ollama кэширует prefix, следующие вызовы в 3–5× быстрее.
6. **Эмоции без LLM.** Rule-based classify + sentiment словарь. LLM только для речи.
7. **Batch consolidation.** Факты извлекаются раз в 5 минут из накопленных сообщений, не на каждое.

---

## 2. Стек

| Слой | Технология |
|---|---|
| Framework | Next.js 16 App Router |
| Runtime | Bun |
| БД | SQLite + `better-sqlite3` + `sqlite-vec` (нативное векторное расширение) |
| ORM | Prisma (для schema migration) + raw `better-sqlite3` для vector ops |
| LLM | Ollama (local) через `@ai-sdk/openai-compatible` |
| Streaming | Vercel AI SDK v5 `streamText` |
| Tools | AI SDK native tool calling |
| Frontend | React 19 + Tailwind 4 + shadcn/ui (New York) |
| State | Zustand + TanStack Query |
| Icons | lucide-react |
| Markdown | react-markdown + rehype-sanitize |

### Что выкинули из LIA v1

- Cognitive cycle (perceive → decide → deliberate → speak → consolidate) → один `streamText`
- 13 YAML-промпт-ролей → один system prompt + tool definitions
- Template engine с DB overrides → git-версионирование
- HNSW + brute-force fallback → `sqlite-vec`
- LLM-классификация эмоций → rule-based
- `deliberate`, `spar`, `extract` (per-message) роли → удалены
- RL-агент на TypeScript → Python sidecar (фаза 6, не в MVP)
- Sleep coordinator с dream cycle → простой batch-consolidation cron

---

## 3. Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│ Browser (React)                                             │
│                                                             │
│  ┌─────────────┐  ┌──────────────────────────────────────┐ │
│  │ Avatar 2D   │  │ Chat panel                           │ │
│  │ + эмоции    │  │  - episode list (sidebar)            │ │
│  │ + lip-sync  │  │  - messages (markdown)               │ │
│  │             │  │  - input (mode toggle)               │ │
│  └─────────────┘  │  - agent task panel (right drawer)   │ │
│                   └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          │ SSE + fetch
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Next.js API routes (Node.js runtime)                        │
│                                                             │
│  POST /api/chat        — streaming chat with tools          │
│  GET  /api/episodes    — list                              │
│  POST /api/episodes    — create                            │
│  POST /api/episodes/[id]/switch                            │
│  DELETE /api/episodes/[id]                                  │
│  GET  /api/agent       — list tasks                        │
│  POST /api/agent       — start task                        │
│  GET  /api/agent/[id]  — task detail + steps               │
│  POST /api/agent/[id]/cancel                               │
│  GET  /api/agent/stream — SSE for active task              │
│  GET  /api/artifacts/[id] — download                       │
│  GET  /api/health      — Ollama check                      │
└─────────────────────────────────────────────────────────────┘
                          │
              ┌───────────┼────────────┐
              ▼           ▼            ▼
        ┌──────────┐ ┌─────────┐ ┌──────────┐
        │ SQLite   │ │ Ollama  │ │ FS       │
        │ +sqlite- │ │ (chat + │ │ (artifacts│
        │  vec     │ │  embed) │ │  dir)    │
        └──────────┘ └─────────┘ └──────────┘
```

### Память — два scope

```sql
-- Глобальный профиль пользователя (переживает смену чата)
facts_global(key TEXT PRIMARY KEY, value TEXT, confidence REAL, updated_at INTEGER)
-- Примеры: user.name, user.profession, user.favorite_language

-- Эпизод-локальная память
facts_episode(episode_id TEXT, key TEXT, value TEXT, ts INTEGER)

-- Векторная память (всегда привязана к эпизоду)
vector_memory(
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,        -- ВСЕГДА заполняется
  source_type TEXT,                -- 'dialogue' | 'summary' | 'fact'
  text TEXT,
  embedding BLOB,                  -- 768-dim float32 for nomic-embed-text
  ts INTEGER
)
-- Поиск с pre-filter по episode_id через sqlite-vec
```

**Правило:** всё, что Lia вспоминает в чате, привязано к этому чату. Глобально — только базовый профиль.

---

## 4. Схема БД

```prisma
// prisma/schema.prisma

model Episode {
  id        String   @id @default(cuid())
  title     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  endedAt   DateTime?
  messages  Message[]
  facts     EpisodeFact[]
  vectors   VectorMemory[]
  agentTasks AgentTask[]
  summary   String?
}

model Message {
  id          String   @id @default(cuid())
  episodeId   String
  episode     Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  role        String   // 'user' | 'companion' | 'tool' | 'system'
  content     String
  emotionJson String?  // JSON snapshot of EmotionVector
  toolCalls   String?  // JSON: [{name, input, output}]
  tokensIn    Int?
  tokensOut   Int?
  durationMs  Int?
  createdAt   DateTime @default(now())
}

model GlobalFact {
  key        String   @id
  value      String
  confidence Float    @default(0.6)
  updatedAt  DateTime @updatedAt
}

model EpisodeFact {
  id        String   @id @default(cuid())
  episodeId String
  episode   Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  key       String
  value     String
  ts        DateTime @default(now())
  @@unique([episodeId, key])
}

model VectorMemory {
  id         String   @id @default(cuid())
  episodeId  String
  episode    Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  sourceType String   // 'dialogue' | 'summary' | 'fact'
  text       String
  embedding  Bytes    // 768-dim float32
  ts         DateTime @default(now())
  @@index([episodeId])
}

model AgentTask {
  id            String   @id @default(cuid())
  episodeId     String
  episode       Episode @relation(fields: [episodeId], references: [id], onDelete: Cascade)
  goal          String
  status        String   @default("pending") // pending|planning|executing|waiting_input|done|failed|cancelled
  planJson      String?
  currentStep   Int      @default(0)
  stepsJson     String   @default("[]")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  startedAt     DateTime?
  completedAt   DateTime?
  error         String?
  maxSteps      Int      @default(15)
  maxDurationSec Int     @default(600)
  toolsWhitelist String? // JSON array of tool names; null = all
  fsScope       String?  // path prefix for fs operations; null = none
  checkpointJson String?
  resultSummary String?
  artifactsJson String   @default("[]")
}

model AgentArtifact {
  id        String   @id @default(cuid())
  taskId    String
  step      Int
  kind      String   // 'file' | 'screenshot' | 'log' | 'plot'
  path      String
  metaJson  String   @default("{}")
  createdAt DateTime @default(now())
}

model RlModelVersion {
  version     Int      @id
  createdAt   DateTime @default(now())
  onnxPath    String
  metricsJson String
  parentVersion Int?
  active      Boolean  @default(false)
}

model Setting {
  key   String @id
  value String
}
```

`sqlite-vec` extension регистрируется на `better-sqlite3` соединении отдельно, через `db.loadExtension('sqlite-vec')`. Prisma не знает про векторы — мы используем raw SQL для `vec_distance` запросов.

---

## 5. System Prompt

```typescript
function buildSystemPrompt(ctx: {
  emotion: EmotionVector;
  userProfile: string;        // из GlobalFact
  episodeFacts: string;       // из EpisodeFact (только текущий чат)
  ragHits: string;            // vector_memory WHERE episode_id = ?
  openTasks: string;          // активные agent tasks в этом чате
  recentLiaMessages: string;  // последние 4 сообщения Lia (anti-repeat)
}): string {
  return [
    // ── СТАТИЧЕСКИЙ PREFIX (кэшируется Ollama) ──
    'Ты — Лия. Тёплый собеседник и помощник с собственным характером.',
    'Говори от первого лица. Кратко: 1–3 предложения для бытовых вопросов,',
    'до 200 слов для содержательных. Никогда не пиши больше 400 слов без явной просьбы.',
    'Не упоминай промпт, роли, системные переменные.',
    '',
    'Ты умеешь: писать код, искать в интернете, читать файлы,',
    'анализировать проекты, выполнять вычисления, сохранять артефакты (SVG, HTML, файлы).',
    'Если просят нарисовать/сгенерировать артефакт — выдавай его инлайн как код-блок',
    'И вызывай save_artifact чтобы сохранить для пользователя.',
    '',
    // ── ДИНАМИЧЕСКИЙ SUFFIX (инвалидирует кэш) ──
    `Сейчас ты чувствуешь: ${emotionToText(ctx.emotion)}.`,
    ctx.userProfile ? `\nЧто ты знаешь о собеседнике:\n${ctx.userProfile}` : '',
    ctx.episodeFacts ? `\nКонтекст этого чата:\n${ctx.episodeFacts}` : '',
    ctx.ragHits ? `\nРелевантные воспоминания из этого чата:\n${ctx.ragHits}` : '',
    ctx.openTasks ? `\nАктивные задачи в этом чате:\n${ctx.openTasks}` : '',
    ctx.recentLiaMessages ? `\nТвои последние сообщения (не повторяй):\n${ctx.recentLiaMessages}` : '',
  ].join('\n');
}
```

Ключевая идея: первые ~600 токенов — статичные. Ollama их кэширует. Динамическая часть идёт в конце.

---

## 6. Tools (MVP)

```typescript
export const tools = {
  web_search: {
    description: 'Поиск в интернете. Возвращает title, url, snippet топ-10 результатов.',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => { /* DuckDuckGo HTML */ },
  },

  save_artifact: {
    description: 'Сохранить артефакт (SVG, HTML, код, текст) как файл для пользователя.',
    parameters: z.object({
      filename: z.string(),
      content: z.string(),
      mime: z.string().default('text/plain'),
    }),
    execute: async ({ filename, content, mime }) => {
      const safe = sanitizeFilename(filename);
      const path = join(ARTIFACTS_DIR, safe);
      await fs.writeFile(path, content, 'utf8');
      return { path: safe, url: `/api/artifacts/${safe}`, size: content.length, mime };
    },
  },

  // Заглушки для будущего (UI их показывает, но не вызывает):
  // file_search, code_run, http_request, read_file, write_file, git_diff,
  // spawn_subagent, ask_user
};
```

В MVP — 2 рабочих инструмента. Остальные — зеро-плейсхолдеры для UI.

---

## 7. Агентский режим (скелет в MVP)

В MVP мы реализуем таблицу + API + UI, но не сам runner. Это «скелет», на который потом навесим Inngest-оркестрацию.

**Жизненный цикл задачи:**

```
[pending] → [planning] → [executing] ⇄ [waiting_input] → [done]
                ↓             ↓               ↓
            [failed]     [cancelled]     [cancelled]
                              ↓
                         [resumable checkpoint]
```

**API в MVP:**
- `GET /api/agent` — список задач пользователя (по текущему эпизоду)
- `POST /api/agent` — создать задачу (тело: `{goal, toolsWhitelist?, fsScope?, maxSteps?, maxDurationSec?}`)
- `GET /api/agent/[id]` — детали задачи + шаги
- `POST /api/agent/[id]/cancel` — отмена
- `GET /api/agent/stream` — SSE для active task (пока заглушка, эмитит heartbeat)

Сам runner (`runAgentCycle`) будет в следующей фазе. UI показывает «Агентский режим скоро будет».

---

## 8. UI/UX дизайн

### Референс: Linear

- Тёмный фон #08090A, акцент violet #8B5CF6
- Тонкие границы (#1F1F23), без скруглений больше 8px
- Плотная, но просторная типографика
- Минимум хрома, максимум контента
- Анимации — только там, где они что-то сообщают

### Палитра

```css
--background: #08090A;
--surface:    #0E0F11;
--surface-2:  #15171A;
--border:     #1F1F23;
--border-hover: #2A2B30;
--text:       #E8E8F0;
--text-muted: #8A8F98;
--text-dim:   #565861;
--accent:     #8B5CF6;    /* violet-500 */
--accent-hover: #7C3AED;
--accent-soft: #8B5CF622;
--success:    #10B981;
--warning:    #F59E0B;
--danger:     #EF4444;
```

### Типографика

- Sans: Inter (15px body, 13px UI, 11px meta)
- Mono: JetBrains Mono (для кода, артефактов, ID задач)
- Heading: Inter 600 weight
- line-height: 1.5 для UI, 1.65 для чата

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ Top bar (h=44px)                                                 │
│  [logo] Lia                  [search] [settings] [theme]         │
├──────────────────────────────────────────────────────────────────┤
│           │                                       │              │
│ Episodes  │  Chat panel                           │  Avatar      │
│ sidebar   │                                       │  column      │
│ (w=240)   │  (flex-1, max-w-720)                  │  (w=320)     │
│           │                                       │              │
│ + new     │  ┌─────────────────────────────────┐  │  ┌────────┐ │
│           │  │ user: привет                    │  │  │ SVG    │ │
│ ▸ Сегодня │  │ lia:  привет! как ты?           │  │  │ avatar │ │
│   чат 1   │  │                                 │  │  │        │ │
│   чат 2   │  │ user: нарисуй лого              │  │  │ эмоции │ │
│ ▸ Вчера   │  │ lia: [генерирует SVG]           │  │  │        │ │
│   ...     │  │     [save_artifact called]     │  │  └────────┘ │
│           │  │     вот лого:                   │  │              │
│           │  │     <svg>...</svg>              │  │  Emotion     │
│           │  │     [Скачать logo.svg]          │  │  joy 0.62    │
│           │  └─────────────────────────────────┘  │  curi 0.78   │
│           │                                       │  calm 0.70   │
│           │  ┌─────────────────────────────────┐  │              │
│           │  │ [mode: standard ▾] [input...]   │  │  Tasks       │
│           │  │                          [send] │  │  0 active    │
│           │  └─────────────────────────────────┘  │              │
└──────────────────────────────────────────────────────────────────┘
```

**Три колонки** на десктопе (≥1280px). На планшете (768–1280px) — две (episodes скрыты в drawer). На мобильном (<768px) — одна (chat), avatar доступен через таб-бар внизу.

### Chat bubble стиль

- Сообщения пользователя: выравнивание вправо, фон `--accent-soft`, текст `--text`, скругление 12px (но угол к правому краю — 4px)
- Сообщения Lia: выравнивание влево, без фона (просто текст), markdown-рендеринг, моноширинные блоки кода с тонкой рамкой
- Tool calls — inline-виджет: иконка + имя инструмента + краткий результат (раскрывается по клику)
- Артефакты — карточка с превью, именем файла, кнопкой «Скачать»
- Метаданные (время, токены) — мелким шрифтом под сообщением, `text-dim`

### Mode toggle (в input bar)

```
┌─────────────────────────────────────────────┐
│ [● Standard ▾]  [напиши Лие...    ] [send] │
└─────────────────────────────────────────────┘
```

Режимы:
- **Быстрый** — 1 LLM-вызов, без tools. Для бытовых вопросов.
- **Стандарт** — 1 LLM-вызов + tools. По умолчанию.
- **Агент** — создаёт AgentTask, открывает правую панель с прогрессом.

### Avatar column

```
┌──────────────────┐
│     [SVG avatar] │  ← 240x240, эмоции морфируют
│                  │
│  ── Эмоции ──    │
│  joy       ▓▓▓░  │  ← прогресс-бары, violet
│  curiosity ▓▓▓▓  │
│  calm      ▓▓▓░  │
│  irritation ░    │
│  sadness   ░     │
│                  │
│  ── Активность ──│
│  ● idle          │
│                  │
│  ── Задачи ──    │
│  Нет активных    │
│                  │
│  ── Мысли ──     │  ← recent thoughts (будущее)
│  (пока пусто)    │
└──────────────────┘
```

### 2D SVG avatar

Простой SVG с:
- Голова (круг или стилизованная форма)
- 2 глаза (могут моргать — анимация SVG path)
- Рот (морфируется по эмоциям: smile/frown/neutral)
- Брови (поднимаются при curiosity, опускаются при irritation)
- Лёгкое дыхание (SVG animate transform)
- Во время speaking — амплитуда рта

Эмоции — 5-осевые, маппятся в blendshapes:
- joy → mouth curve up
- sadness → mouth curve down + eyes half-closed
- irritation → brows down + mouth flat
- curiosity → brows up + eyes wide
- calm → neutral + slow breathing

Цвет аватара — gradient от violet до soft-pink, фон — прозрачный.

### Agent panel (правый drawer при активной задаче)

```
┌─ Агент: "Изучить структуру проекта" ─────┐
│ Статус: executing · Шаг 4/15 · 3:12      │
│                                          │
│ ▼ План                                   │
│   1. Найти entry point                   │
│   2. Изучить структуру директорий        │
│   3. Проанализировать ключевые файлы     │
│   4. Сформировать отчёт                  │
│                                          │
│ ▼ Шаги                                   │
│ ✓ 1. project_search("entry point")       │
│   → src/main.ts найден (sim 0.92)        │
│ ✓ 2. read_file("src/main.ts")            │
│   → 47 строк, импортирует App            │
│ ⟳ 3. project_search("routing")           │
│   → 3 файла...                           │
│                                          │
│ [Пауза] [Отменить] [Артефакты: 0]        │
└──────────────────────────────────────────┘
```

### Создание задачи

При выборе режима «Агент» input превращается в:

```
┌─────────────────────────────────────────────┐
│ Опиши задачу для Лии-агента:                │
│ [_______________________________________]   │
│                                             │
│ Инструменты:                                │
│ ☑ web_search  ☑ file_search  ☐ code_run    │
│ ☐ http_request ☐ read_file  ☐ write_file   │
│                                             │
│ Лимиты:                                     │
│ Max steps: [15]  Max duration: [600] сек    │
│                                             │
│                       [Отмена] [Запустить]  │
└─────────────────────────────────────────────┘
```

### Episodes sidebar

```
┌─ Чаты ────────────┐
│ [+ Новый чат]     │
│                   │
│ Сегодня           │
│ ▸ Привет!         │  ← текущий (violet bar слева)
│   14:32 · 5 сообщ.│
│                   │
│ Вчера             │
│   Проект X        │
│   18:01 · 23 сооб.│
│                   │
│   Код-ревью       │
│   12:15 · 8 сооб. │
│                   │
│ На этой неделе    │
│   ...             │
└───────────────────┘
```

Группировка по периодам (Сегодня / Вчера / На этой неделе / Раньше). Текущий чат — violet-bar слева + лёгкий фон. Hover — фон чуть светлее. Правый клик — меню (переименовать, удалить, закрепить).

### Empty states

- Нет чатов: «Привет! Я Лия. Напиши мне что-нибудь — и начнём.»
- Чат пустой: лёгкая подсказка в input «Напиши Лие…»
- Ollama не отвечает: баннер сверху «Не удалось подключиться к Ollama. Проверь, что ollama serve запущен. [Открыть настройки] [Повторить]»

### Микро-анимации

- Streaming-текст: курсор-бликкер в конце растущего текста (violet, 1Hz blink)
- Tool call: spinner при выполнении, чекмарк при завершении
- Episode switch: fade-in новых сообщений (150ms)
- Mode toggle: dropdown с лёгким scale-in
- Avatar emotion change: 400ms ease-out morph

---

## 9. MVP scope

| Включено в MVP | Отложено |
|---|---|
| Chat с streaming + tools (web_search, save_artifact) | VRM avatar (только 2D SVG) |
| Episodes CRUD + switch | Agent runner (только таблица + UI) |
| 2D SVG avatar с эмоциями | RL sidecar (только stub) |
| Linear-style dark UI | Batch consolidation cron |
| Global facts (имя пользователя) | Vector memory search (только stub) |
| Mode toggle (fast/standard/agent) | Settings panel |
| Agent task skeleton | File upload / KB |
| Artifacts download | Voice TTS/STT |
| Ollama health check | Tauri wrapping |

---

## 10. Файловая структура

```
src/
├── app/
│   ├── layout.tsx              ← root layout, dark theme, fonts
│   ├── page.tsx                ← main 3-column layout
│   ├── globals.css             ← design tokens
│   └── api/
│       ├── chat/route.ts       ← streaming chat
│       ├── episodes/
│       │   ├── route.ts        ← GET list, POST create
│       │   └── [id]/
│       │       ├── route.ts    ← DELETE, PATCH (rename)
│       │       └── switch/route.ts
│       ├── agent/
│       │   ├── route.ts        ← GET list, POST create
│       │   └── [id]/
│       │       ├── route.ts    ← GET detail
│       │       └── cancel/route.ts
│       ├── artifacts/[filename]/route.ts
│       └── health/route.ts
├── components/
│   ├── ui/                     ← shadcn primitives (existing)
│   └── lia/
│       ├── avatar-svg.tsx      ← 2D SVG avatar
│       ├── chat-panel.tsx
│       ├── chat-message.tsx
│       ├── chat-input.tsx
│       ├── mode-toggle.tsx
│       ├── episodes-sidebar.tsx
│       ├── avatar-column.tsx
│       ├── emotion-bars.tsx
│       ├── agent-panel.tsx
│       ├── agent-creator.tsx
│       ├── artifact-card.tsx
│       ├── tool-call-card.tsx
│       └── ollama-banner.tsx
├── hooks/
│   ├── use-chat.ts             ← streaming + tools
│   ├── use-episodes.ts
│   ├── use-agent.ts
│   └── use-emotion.ts
├── lib/
│   ├── db.ts                   ← Prisma client
│   ├── db-vec.ts               ← better-sqlite3 + sqlite-vec for vector ops
│   ├── ollama.ts               ← AI SDK provider
│   ├── system-prompt.ts        ← builder with prefix/suffix split
│   ├── emotion.ts              ← 5-axis model + rule-based perceive
│   ├── personality.ts          ← Лия identity constants
│   ├── tools/
│   │   ├── index.ts            ← registry
│   │   ├── web-search.ts
│   │   └── save-artifact.ts
│   ├── memory/
│   │   ├── episodes.ts
│   │   ├── facts.ts            ← global + episode-scoped
│   │   └── vector.ts           ← sqlite-vec search
│   └── agent/
│       └── task.ts             ← AgentTask class (skeleton)
├── stores/
│   └── chat-store.ts           ← Zustand
└── types/
    └── index.ts
```

---

## 11. Метрики успеха MVP

- [ ] Ответ на простое сообщение за <5 сек (на qwen2.5:7b)
- [ ] Стриминг начинается за <1 сек
- [ ] Переключение чатов — мгновенное, без «вспышек» чужого контекста
- [ ] SVG-логотип сохраняется через save_artifact и скачивается
- [ ] Agent task создаётся через UI, появляется в списке, отменяется
- [ ] Lint проходит без ошибок
- [ ] Agent-browser verification: чат работает, episode switch работает, artifact download работает
