# Лия v2 — Personal AI Companion

Тёплый собеседник и помощник с собственным характером. Local-first (Ollama), долгосрочная память без утечек между чатами, агентский режим для многошаговых задач, 3D VRM-аватар с эмоциями, обучаемый стиль общения.

> Rewrite of [LIA v1](https://github.com/redbleach5/LIA) — fixed architecture, not patched bugs.

## Возможности

- **Чат со стримингом** — один LLM-вызов с tool calling, markdown-рендеринг (react-markdown + GFM)
- **Эпизодическая память** — каждый чат изолирован, факты не протекают между чатами
- **Векторная память с sqlite-vec** — семантический поиск с pre-filter по episode_id + source_type
- **Агентский режим** — ReAct-loop с checkpointing (resume после restart), loop detection, ask_user, real-time SSE
- **3D VRM-аватар** — blendshapes для эмоций, дыхание, моргание, lip-sync, тонкая настройка
- **Live2D-стилизованный аватар** — PixiJS/WebGL, fallback для слабых устройств
- **Обучаемый стиль общения** — Python sidecar (PyTorch + PPO), ONNX export для inference
- **14 инструментов**: web_search, fetch_page, save_artifact, read_file, write_file, edit_file, list_dir, list_tree, file_search, http_request, code_run, ask_user, spawn_subagent, spawn_subagents
- **Тёплый лён UI** — светлая палитра, warm brown accent, Plus Jakarta Sans + JetBrains Mono

## Стек

| Слой | Технология |
|---|---|
| Framework | Next.js 16 (App Router, Server Components) |
| Runtime | Bun |
| БД | SQLite + `better-sqlite3` + `sqlite-vec` (vec0 virtual table) |
| ORM | Prisma + raw SQL через инкапсулированный vec-client |
| LLM | Ollama через `@ai-sdk/openai-compatible` |
| Streaming | Vercel AI SDK `streamText` + `AbortSignal.timeout` |
| 3D | three.js 0.160 + `@pixiv/three-vrm` + `@react-three/fiber` |
| 2D | PixiJS 6 + `pixi-live2d-display` |
| RL | Python + PyTorch + ONNX (sidecar, API key auth) |
| UI | React 19 + Tailwind 4 + shadcn/ui (Radix primitives) |
| State | Zustand (slices + devtools + persist) |
| Markdown | react-markdown + remark-gfm |
| Logging | Pino (JSON prod, pretty dev) |
| Validation | Zod (all API routes + tool inputs) |

## Быстрый старт

### 1. Установить зависимости

**macOS / Linux:**
```bash
bun install
```

**Windows (PowerShell):**
```powershell
bun install
# или если bun не установлен:
npm install
```

### 2. Установить и запустить Ollama

Скачай с https://ollama.com, затем:

**macOS / Linux:**
```bash
ollama serve          # в одном терминале
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

**Windows:**
```powershell
# Открой Ollama из Start Menu (Пуск → Ollama)
# Или в PowerShell:
ollama serve

# В другом окне PowerShell:
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

Модели можно выбрать и в настройках приложения (иконка ⚙️ в правом верхнем углу).

### 3. Настроить окружение

**macOS / Linux:**
```bash
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Отредактируй `.env` — обязательно задай `LIA_SIDECAR_API_KEY` (случайная строка для auth Python sidecar):
```bash
# Сгенерируй ключ:
openssl rand -hex 32
# Вставь в .env:
LIA_SIDECAR_API_KEY=<твой-ключ>
```

### 4. Инициализировать БД

**macOS / Linux:**
```bash
bun run db:push
```

**Windows:**
```powershell
bun run db:push:win
```

### 5. Запустить dev-сервер

**macOS / Linux:**
```bash
bun run dev
```

**Windows:**
```powershell
bun run dev:win
```

Открой http://localhost:3000

### 6. (Опционально) Скачать VRM-модель для 3D-аватара

В настройках приложения: **Настройки → Внешний вид → Скачать готовую** (одной кнопкой).

Без этого автоматически переключится на Live2D-стилизованный аватар.

### 7. (Опционально) Запустить движок обучения

Для обучаемого стиля общения (Python sidecar):

```bash
cd python-sidecar
python -m venv .venv
source .venv/bin/activate    # Linux/macOS
# .venv\Scripts\activate     # Windows
pip install -r requirements.txt
python main.py
```

Или через UI: **Настройки → Обучение → Запустить**.

> **Важно:** `LIA_SIDECAR_API_KEY` в `.env` и в Python sidecar env должны совпадать.
> Sidecar отказывается запускаться без ключа (fail-closed).

## Архитектура

Подробная схема — в [ARCHITECTURE.md](./ARCHITECTURE.md). Threat model — в [SECURITY.md](./SECURITY.md).

```
src/
├── app/
│   ├── page.tsx                    # Server Component — 3-колонный layout
│   ├── layout.tsx                  # fonts, Toaster (light theme)
│   ├── error.tsx                   # global error boundary
│   ├── loading.tsx                 # loading state
│   └── api/                        # thin routes (zod validation → services)
│       ├── chat/route.ts           # → lib/chat/pipeline.ts
│       ├── episodes/               # CRUD + cursor pagination
│       ├── agent/                  # CRUD + start + stream (SSE) + input + cancel + workspace
│       ├── rl/                     # train, stats, activate, start-engine
│       └── settings/               # Ollama, avatar, VRM upload/download
├── components/
│   ├── lia/
│   │   ├── chat/                   # (future split)
│   │   ├── settings/               # 4 tab components + shared helpers
│   │   ├── vrm/                    # constants, background, platform, blendshapes
│   │   ├── chat-panel.tsx          # IntersectionObserver auto-scroll
│   │   ├── chat-message.tsx        # MarkdownRenderer (react-markdown)
│   │   ├── chat-input.tsx          # DropdownMenu (Radix)
│   │   ├── episodes-sidebar.tsx    # AlertDialog for delete
│   │   ├── vrm-avatar.tsx          # 3D VRM (split into vrm/ submodules)
│   │   ├── settings-dialog.tsx     # thin wrapper → settings/ tabs
│   │   ├── settings-dialog-lazy.tsx # code-split (dynamic import)
│   │   ├── panel-error-boundary.tsx # error isolation per panel
│   │   └── markdown-renderer.tsx   # react-markdown + remark-gfm
│   └── ui/                         # shadcn primitives (Radix)
├── hooks/
│   ├── use-chat.ts                 # streaming chat + agent task creation
│   ├── use-episodes.ts             # CRUD + auto-create first
│   ├── use-agent.ts                # SSE подписка на active task
│   └── use-health.ts               # periodic Ollama health check
├── lib/
│   ├── chat/                       # ChatPipeline, deliberate, self-check, is-repeated
│   ├── agent/                      # runner, task, tools, events, loop-detector, templates, fs-scope
│   ├── memory/                     # episodes, facts, vector, emotional, fact-extraction
│   ├── rl/                         # types, inference, recorder, actions
│   ├── tools/                      # web-search, save-artifact, code-run (AST sandbox)
│   ├── infra/                      # ssrf, api-validation (zod)
│   ├── ollama.ts                   # AI SDK provider + embed + health
│   ├── db.ts                       # Prisma client (singleton)
│   ├── db-vec.ts                   # vec0 ops (encapsulated, no direct vecDb export)
│   ├── logger.ts                   # Pino wrapper (JSON prod, pretty dev)
│   ├── paths.ts                    # cross-platform path resolution
│   └── system-prompt.ts            # static prefix + dynamic suffix (KV-cache friendly)
├── stores/
│   ├── chat-store.ts               # Zustand: 4 slices + devtools + persist
│   └── slices/                     # episodes, messages, agent, health, types
└── prisma/
    └── schema.prisma               # Episode, Message, GlobalFact, EpisodeFact,
                                    # VectorMemory, EmotionalMemory, AgentTask,
                                    # RLExperience (composite index), RlModelVersion, Setting

python-sidecar/                     # отдельный процесс для обучения (API key auth)
├── main.py                         # FastAPI server (port 8765, X-Sidecar-Key)
├── rl/
│   ├── model.py                    # PyTorch policy network + ONNX export (weights_only=True)
│   ├── train.py                    # PPO trainer (GAE with episode boundaries)
│   ├── reward.py                   # EDITABLE — reward function (single source of truth)
│   └── db.py                       # SQLite reader (busy_timeout, ASC order)
├── models/                         # saved .pt + .onnx (atomic write, gitignored)
└── requirements.txt
```

## Ключевые архитектурные решения

### 1. Один LLM-вызов на сообщение

Вместо цепочки `perceive → decideTool → deliberate → speak → consolidate` (3-5 LLM-вызовов в LIA v1) — один `streamText` с tools. Модель сама решает нужен ли инструмент и вызывает его.

### 2. Память привязана к episode_id + source_type

```sql
SELECT v.rowid, v.distance, m.vector_id
FROM vec_virtual v
JOIN vec_rowid_map m ON v.rowid = m.rowid
WHERE m.episode_id = ?        -- PRE-FILTER на SQL уровне
  AND v.source_type = ?       -- 'dialogue' | 'emotional' — no cross-contamination
  AND v.embedding MATCH vec_f32(?)
ORDER BY v.distance LIMIT ?
```

Утечек между чатами нет архитектурно. Dialogue recall не возвращает emotional anchors и наоборот.

### 3. Agent resume через checkpoint

После каждого шага сохраняется `checkpointJson = { plan, steps, savedAt }`. При restart сервера sweeper сбрасывает executing+checkpoint задачи в pending — runner пропускает PLAN и продолжает с `steps.length`.

### 4. RL reward — Python single source of truth

Python `train.py` вычисляет reward из raw signals через `compute_reward(Transition(...))`. TS сторона хранит только signals, не computed reward. Пользователь редактирует `reward.py` → изменения применяются при следующем training без правок TS кода.

### 5. Pino logging + Zod validation

Все API routes валидируются через Zod schemas (`parseBody` helper). Логирование через Pino — JSON в production (parser-friendly), pretty в development.

### 6. SSRF + sandbox + path traversal protection

- `lib/infra/ssrf.ts` — `assertSafeUrl` для всех URL от LLM (блокирует private IP, CGNAT, link-local)
- `lib/tools/code-run.ts` — Python AST analysis + `resource.setrlimit` (CPU, memory, file, nproc)
- `lib/agent/fs-scope.ts` — `safePathWithinScope` с realpath для symlink protection

### 7. Кросс-платформенные пути

Все пути резолвятся через `src/lib/paths.ts` — `PROJECT_ROOT` из `LIA_ROOT` env или `process.cwd()`. Работает на macOS, Windows, Linux. `DATABASE_URL` в `.env` — относительная (`file:./db/custom.db`).

## Настройка через UI

Все повседневные настройки доступны в диалоге **Настройки** (иконка ⚙️):

1. **Модель** — выбор модели Ollama для разговора + модель для памяти (embed, с опцией Авто)
2. **Внешний вид** — Live2D / 3D VRM, загрузка и выбор VRM-моделей, тонкая настройка аватара
3. **Обучение** — запуск движка обучения, создание новых стилей общения, переключение версий
4. **О Лии** — описание и краткая информация о технологиях

Через терминал нужно только:
- Установить Ollama (один раз, системная утилита)
- Скачать модели в Ollama (`ollama pull ...`) — Ollama API не поддерживает pull программно
- Установить Python-зависимости для sidecar (один раз, `pip install -r requirements.txt`)
- Задать `LIA_SIDECAR_API_KEY` в `.env`

Всё остальное — через UI.

## Roadmap

- [x] MVP — chat, episodes, инструменты, 2D аватар
- [x] Agent runner — ReAct-loop с SSE
- [x] VRM 3D avatar — blendshapes, breathing, blink, lip-sync
- [x] Live2D-стилизованный 2D аватар (PixiJS/WebGL)
- [x] RL sidecar — Python + PyTorch + ONNX (обучаемый стиль общения)
- [x] Settings UI — все настройки в одном диалоге
- [x] Sub-agents — параллельные подзадачи через spawn_subagent/subagents
- [x] Resume after restart — checkpoint после каждого шага, восстановление при перезапуске
- [ ] Tauri desktop packaging

## Документация

- **README.md** (этот файл) — quickstart, архитектура, roadmap
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — слоистая архитектура, flow диаграммы chat/agent/RL
- **[SECURITY.md](./SECURITY.md)** — threat model для local-first, mitigations
- **python-sidecar/README.md** — документация RL sidecar
- **prisma/schema.prisma** — комментарии к каждой таблице

## Диагностика проблем

Если что-то не работает — запусти скрипт полной диагностики:

### macOS / Linux

```bash
bun run diagnose
# или
bash scripts/diagnose.sh
```

### Windows (PowerShell нативно, без WSL)

```powershell
bun run diagnose:win
# Или напрямую:
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1
# С детализацией:
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1 -Verbose
```

Лог сохраняется в `diagnose-YYYYMMDD-HHMMSS.log` — приложи его к сообщению об ошибке.

## Команды для Windows

| Действие | macOS/Linux | Windows (PowerShell) |
|---|---|---|
| Dev-сервер | `bun run dev` | `bun run dev:win` |
| Сборка | `bun run build` | `bun run build:win` |
| Инициализация БД | `bun run db:push` | `bun run db:push:win` |
| Диагностика | `bun run diagnose` | `bun run diagnose:win` |
| Логи real-time | `bun run logs:tail` | `bun run logs:tail:win` |
| Логи агента | `bun run logs:agent` | `bun run logs:agent:win` |
| Логи ошибок | `bun run logs:errors` | `bun run logs:errors:win` |

## Отправка баг-репорта

При проблемах приложи:
1. **Лог диагностики**: `diagnose-*.log`
2. **Dev-лог**: `dev.log`
3. **GPU информация** (Windows): `nvidia-smi`
4. **Модели Ollama**: `ollama list`
5. **Шаги воспроизведения**: что делал, что ожидал, что получилось

## Лицензия

Приватный проект. © 2026
