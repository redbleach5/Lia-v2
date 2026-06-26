# Лия v2 — Personal AI Companion

Тёплый собеседник и помощник с собственным характером. Local-first (Ollama), долгосрочная память без утечек между чатами, агентский режим для многошаговых задач, 3D VRM-аватар с эмоциями.

> Rewrite of [LIA v1](https://github.com/redbleach5/LIA) — fixed architecture, not patched bugs.

## Возможности

- **Чат со стримингом** — один LLM-вызов с tool calling (вместо 3-5 как в v1)
- **Эпизодическая память** — каждый чат изолирован, факты не протекают между чатами
- **Векторная память с sqlite-vec** — семантический поиск с pre-filter по episode_id
- **Агентский режим** — ReAct-loop с checkpointing, loop detection, ask_user, real-time SSE
- **3D VRM-аватар** — blendshapes для эмоций, дыхание, моргание, lip-sync
- **2D SVG fallback** — для слабых устройств
- **Инструменты**: web_search, save_artifact, read_file, write_file, list_dir, http_request, ask_user
- **Линейный dark UI** — violet accent, Inter + JetBrains Mono

## Стек

| Слой | Технология |
|---|---|
| Framework | Next.js 16 (App Router, webpack) |
| Runtime | Bun |
| БД | SQLite + `better-sqlite3` + `sqlite-vec` |
| ORM | Prisma (миграции) + raw SQL (vector ops) |
| LLM | Ollama через `@ai-sdk/openai-compatible` |
| Streaming | Vercel AI SDK v5 `streamText` |
| 3D | three.js + `@pixiv/three-vrm` + `@react-three/fiber` |
| UI | React 19 + Tailwind 4 + shadcn/ui |
| State | Zustand |

## Быстрый старт

### 1. Установить зависимости

```bash
bun install
```

### 2. Запустить Ollama

```bash
# Install: https://ollama.com
ollama serve

# В другом терминале — скачать модели
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

### 3. Скачать VRM-модель (для 3D-аватара)

```bash
bash scripts/download-vrm.sh
```

Без этого автоматически переключится на 2D SVG-аватар.

### 4. Настроить окружение

```bash
cp .env.example .env
# Отредактируй .env если Ollama на другом адресе или нужна другая модель
```

### 5. Инициализировать БД

```bash
bun run db:push
```

### 6. Запустить dev-сервер

```bash
bun run dev
```

Открой http://localhost:3000

## Архитектура

```
src/
├── app/
│   ├── page.tsx                    # 3-колонный layout (episodes | chat | avatar)
│   ├── layout.tsx                  # dark theme, Inter/JetBrains Mono
│   └── api/
│       ├── chat/route.ts           # streaming chat с tools
│       ├── episodes/               # CRUD эпизодов
│       ├── agent/                  # CRUD + start + stream (SSE) + input + cancel
│       ├── artifacts/[filename]/   # download сохранённых файлов
│       ├── health/                 # Ollama check
│       └── settings/               # Ollama URL/model
├── components/lia/
│   ├── vrm-avatar.tsx              # 3D VRM с эмоциями
│   ├── avatar-svg.tsx              # 2D SVG fallback
│   ├── avatar-column.tsx           # правая колонка (avatar + emotions + agent)
│   ├── chat-panel.tsx              # центральная колонка
│   ├── chat-message.tsx            # рендер сообщения с code blocks
│   ├── chat-input.tsx              # mode toggle (fast/standard/agent)
│   ├── episodes-sidebar.tsx        # левая колонка
│   ├── agent-panel.tsx             # real-time agent task view
│   ├── tool-call-card.tsx          # web_search results / save_artifact download
│   ├── empty-state.tsx             # привет + подсказки
│   └── ollama-banner.tsx           # warning если Ollama не отвечает
├── hooks/
│   ├── use-chat.ts                 # streaming chat + agent task creation
│   ├── use-episodes.ts             # CRUD + auto-create first
│   ├── use-agent.ts                # SSE подписка на active task
│   └── use-health.ts               # periodic Ollama health check
├── lib/
│   ├── ollama.ts                   # AI SDK provider + embed + health
│   ├── db.ts                       # Prisma client
│   ├── db-vec.ts                   # better-sqlite3 + sqlite-vec (vec0 virtual table)
│   ├── system-prompt.ts            # static prefix + dynamic suffix (KV-cache friendly)
│   ├── emotion.ts                  # 5-axis model, rule-based perceive, decay
│   ├── personality.ts              # Лия identity (constant)
│   ├── tools/                      # web_search, save_artifact
│   ├── memory/
│   │   ├── episodes.ts             # CRUD + messages
│   │   ├── facts.ts                # global + episode-scoped
│   │   └── vector.ts               # semantic search WITHIN episode
│   └── agent/
│       ├── task.ts                 # AgentTask model + persistence
│       ├── runner.ts               # PLAN → EXECUTE → SYNTHESIZE ReAct loop
│       ├── tools.ts                # read_file, write_file, list_dir, http_request, ask_user
│       ├── events.ts               # EventEmitter singleton for SSE
│       └── loop-detector.ts        # pattern + empty + semantic loop detection
├── stores/
│   └── chat-store.ts               # Zustand: episodes, messages, emotion, agent tasks
└── prisma/
    └── schema.prisma               # Episode, Message, GlobalFact, EpisodeFact,
                                    # VectorMemory, AgentTask, AgentArtifact,
                                    # RlModelVersion, Setting
```

## Ключевые архитектурные решения

### 1. Один LLM-вызов на сообщение

Вместо цепочки `perceive → decideTool → deliberate → speak → consolidate` (3-5 LLM-вызовов в LIA v1) — один `streamText` с tools. Модель сама решает нужен ли инструмент и вызывает его.

### 2. Память привязана к episode_id

```sql
-- VectorMemory всегда с episode_id
SELECT ... FROM vec_virtual v
JOIN vec_rowid_map m ON v.rowid = m.rowid
WHERE m.episode_id = ?    -- PRE-FILTER на SQL уровне
  AND v.embedding MATCH vec_f32(?)
ORDER BY v.distance LIMIT ?
```

Утечек между чатами нет архитектурно — вектор из чата #1 физически не может попасть в контекст чата #5.

### 3. Static prefix + dynamic suffix в промпте

Первые ~600 токенов системного промпта — статичные (личность, правила, инструменты). Ollama кэширует KV-prefix, следующие вызовы в 3-5× быстрее.

### 4. Эмоции без LLM

Rule-based perceive (Cyrillic-safe regex triggers) + экспоненциальный decay к baseline. Никаких ошибочных «купи молоко = rudeness» как в v1.

### 5. Агентский режим — первоклассная сущность

`AgentTask` в БД с `status`, `planJson`, `stepsJson`, `checkpointJson`, `maxSteps`, `maxDurationSec`, `toolsWhitelist`, `fsScope`. Реальный ReAct-loop с:
- Планом (LLM генерирует JSON)
- Loop detection (3 сигнала: pattern, empty, semantic)
- `ask_user` для паузы и уточнения
- SSE для real-time обновлений UI
- Cancellation через signal flag

## Roadmap

- [x] MVP — chat, episodes, 2D avatar, tools
- [x] Agent runner — ReAct-loop с SSE
- [x] VRM 3D avatar — blendshapes, breathing, blink, lip-sync
- [ ] RL sidecar — Python + PyTorch + ONNX export (обучаемая личность)
- [ ] Batch consolidation — извлечение фактов раз в 5 мин вместо per-message
- [ ] Resume after restart — persistent queue через Inngest
- [ ] Sub-agents — параллельные подзадачи через spawn_subagent

## Лицензия

Приватный проект. © 2026
