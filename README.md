# Лия v2 — Personal AI Companion

Тёплый собеседник и помощник с собственным характером. Local-first (Ollama), долгосрочная память без утечек между чатами, агентский режим для многошаговых задач, 3D VRM-аватар с эмоциями, обучаемый стиль общения.

> Rewrite of [LIA v1](https://github.com/redbleach5/LIA) — fixed architecture, not patched bugs.

## Возможности

- **Чат со стримингом** — один LLM-вызов с tool calling (вместо 3-5 как в v1)
- **Эпизодическая память** — каждый чат изолирован, факты не протекают между чатами
- **Векторная память с sqlite-vec** — семантический поиск с pre-filter по episode_id
- **Агентский режим** — ReAct-loop с checkpointing, loop detection, ask_user, real-time SSE
- **3D VRM-аватар** — blendshapes для эмоций, дыхание, моргание, lip-sync
- **Live2D-стилизованный аватар** — PixiJS/WebGL, плавнее SVG (fallback для слабых устройств)
- **Обучаемый стиль общения** — Python sidecar (PyTorch + PPO), ONNX export для inference
- **Инструменты**: web_search, save_artifact, read_file, write_file, list_dir, http_request, ask_user
- **Linear-style dark UI** — violet accent, Inter + JetBrains Mono

## Стек

| Слой | Технология |
|---|---|
| Framework | Next.js 16 (App Router, webpack) |
| Runtime | Bun |
| БД | SQLite + `better-sqlite3` + `sqlite-vec` |
| ORM | Prisma (миграции) + raw SQL (vector ops) |
| LLM | Ollama через `@ai-sdk/openai-compatible` |
| Streaming | Vercel AI SDK v5 `streamText` |
| 3D | three.js 0.160 + `@pixiv/three-vrm` + `@react-three/fiber` |
| 2D | PixiJS 6 + `pixi-live2d-display` |
| RL | Python + PyTorch + ONNX (sidecar) |
| UI | React 19 + Tailwind 4 + shadcn/ui |
| State | Zustand |

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

По умолчанию `.env` использует относительные пути — работает на macOS, Windows, Linux без правок.

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
# или без логирования в файл:
npx next dev -p 3000 --webpack
```

Открой http://localhost:3000

### 6. (Опционально) Скачать VRM-модель для 3D-аватара

В настройках приложения: **Настройки → Внешний вид → Скачать готовую** (одной кнопкой).

Или через терминал:

```bash
bash scripts/download-vrm.sh
```

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
│       ├── rl/                     # train, stats, activate, start-engine
│       ├── health/                 # Ollama check
│       └── settings/               # Ollama URL/model, avatar, upload-vrm, download-vrm
├── components/lia/
│   ├── vrm-avatar.tsx              # 3D VRM с эмоциями
│   ├── live2d-avatar.tsx           # Live2D-стилизованный 2D (PixiJS)
│   ├── avatar-svg.tsx              # EmotionBars (используется в обоих режимах)
│   ├── avatar-column.tsx           # правая колонка (avatar + emotions + agent + RL)
│   ├── chat-panel.tsx              # центральная колонка
│   ├── chat-message.tsx            # рендер сообщения с code blocks
│   ├── chat-input.tsx              # mode toggle (fast/standard/agent)
│   ├── episodes-sidebar.tsx        # левая колонка
│   ├── agent-panel.tsx             # real-time agent task view
│   ├── rl-panel.tsx                # обучаемый стиль общения (статус, кнопки, версии)
│   ├── tool-call-card.tsx          # web_search results / save_artifact download
│   ├── settings-dialog.tsx         # все настройки в одном окне
│   ├── empty-state.tsx             # привет + подсказки
│   └── ollama-banner.tsx           # warning если Ollama не отвечает
├── hooks/
│   ├── use-chat.ts                 # streaming chat + agent task creation
│   ├── use-episodes.ts             # CRUD + auto-create first
│   ├── use-agent.ts                # SSE подписка на active task
│   └── use-health.ts               # periodic Ollama health check
├── lib/
│   ├── ollama.ts                   # AI SDK provider + embed (auto-detect) + health
│   ├── db.ts                       # Prisma client
│   ├── db-vec.ts                   # better-sqlite3 + sqlite-vec (vec0 virtual table)
│   ├── paths.ts                    # cross-platform path resolution
│   ├── system-prompt.ts            # static prefix + dynamic suffix (KV-cache friendly)
│   ├── emotion.ts                  # 5-axis model, rule-based perceive, decay
│   ├── personality.ts              # Лия identity (constant)
│   ├── tools/                      # web_search, save_artifact
│   ├── memory/
│   │   ├── episodes.ts             # CRUD + messages
│   │   ├── facts.ts                # global + episode-scoped
│   │   └── vector.ts               # semantic search WITHIN episode
│   ├── agent/
│   │   ├── task.ts                 # AgentTask model + persistence
│   │   ├── runner.ts               # PLAN → EXECUTE → SYNTHESIZE ReAct loop
│   │   ├── tools.ts                # read_file, write_file, list_dir, http_request, ask_user
│   │   ├── events.ts               # EventEmitter singleton for SSE
│   │   └── loop-detector.ts        # pattern + empty + semantic loop detection
│   └── rl/
│       ├── types.ts                # action space, state builder
│       ├── inference.ts            # ONNX runtime (onnxruntime-node)
│       └── recorder.ts             # RLExperience persistence
├── stores/
│   └── chat-store.ts               # Zustand: episodes, messages, emotion, agent tasks
└── prisma/
    └── schema.prisma               # Episode, Message, GlobalFact, EpisodeFact,
                                    # VectorMemory, AgentTask, AgentArtifact,
                                    # RLExperience, RlModelVersion, Setting

python-sidecar/                     # отдельный процесс для обучения
├── main.py                         # FastAPI server (port 8765)
├── rl/
│   ├── model.py                    # PyTorch policy network + ONNX export
│   ├── train.py                    # PPO trainer
│   ├── reward.py                   # EDITABLE — reward function
│   └── db.py                       # SQLite reader for RLExperience
├── models/                         # saved .pt + .onnx (gitignored)
└── requirements.txt
```

## Ключевые архитектурные решения

### 1. Один LLM-вызов на сообщение

Вместо цепочки `perceive → decideTool → deliberate → speak → consolidate` (3-5 LLM-вызовов в LIA v1) — один `streamText` с tools. Модель сама решает нужен ли инструмент и вызывает его.

### 2. Память привязана к episode_id

```sql
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

### 6. Обучаемый стиль общения (RL)

Python sidecar (FastAPI + PyTorch) обучает policy network через PPO на основе записей разговоров. Inference — через ONNX в Next.js (`onnxruntime-node`), без HTTP-раундтрипов. Reward-функция редактируется пользователем в `python-sidecar/rl/reward.py`.

### 7. Кросс-платформенные пути

Все пути резолвятся через `src/lib/paths.ts` — `PROJECT_ROOT` из `LIA_ROOT` env или `process.cwd()`. Работает на macOS, Windows, Linux. `DATABASE_URL` в `.env` — относительная (`file:./db/custom.db`).

## Настройка через UI

Все повседневные настройки доступны в диалоге **Настройки** (иконка ⚙️):

1. **Модель** — выбор модели Ollama для разговора + модель для памяти (embed, с опцией Авто)
2. **Внешний вид** — Live2D / 3D VRM, загрузка и выбор VRM-моделей
3. **Обучение** — запуск движка обучения, создание новых стилей общения, переключение версий
4. **О Лии** — описание и краткая информация о технологиях

Через терминал нужно только:
- Установить Ollama (один раз, системная утилита)
- Скачать модели в Ollama (`ollama pull ...`) — Ollama API не поддерживает pull программно
- Установить Python-зависимости для sidecar (один раз, `pip install -r requirements.txt`)

Всё остальное — через UI.

## Roadmap

- [x] MVP — chat, episodes, инструменты, 2D аватар
- [x] Agent runner — ReAct-loop с SSE
- [x] VRM 3D avatar — blendshapes, breathing, blink, lip-sync
- [x] Live2D-стилизованный 2D аватар (PixiJS/WebGL)
- [x] RL sidecar — Python + PyTorch + ONNX (обучаемый стиль общения)
- [x] Settings UI — все настройки в одном диалоге
- [ ] Batch consolidation — извлечение фактов раз в 5 мин вместо per-message
- [ ] Resume after restart — persistent queue через Inngest
- [ ] Sub-agents — параллельные подзадачи через spawn_subagent
- [ ] Tauri desktop packaging

## Документация

- **README.md** (этот файл) — quickstart, архитектура, roadmap
- **download/lia-v2-design.md** — полный design doc с обоснованием решений
- **download/LIA_diagnosis.md** — анализ багов LIA v1 (почему переписывали)
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
# В PowerShell:
bun run diagnose:win

# Или напрямую:
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1

# С детализацией:
powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1 -Verbose
```

Если PowerShell блокирует запуск скрипта:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\diagnose.ps1
```

Скрипт проверяет:
1. Окружение (Node, Bun, Ollama, Python, git, curl)
2. GPU (NVIDIA карта, VRAM, драйвер) — **Windows версия дополнительно**
3. Ollama (доступность, модели, время отклика)
4. LLM генерацию (тестовый промпт, скорость токенов/сек)
5. Embedding (размерность, скорость)
6. БД (Prisma, sqlite-vec, права на запись)
7. Сборку проекта
8. Dev-сервер и ключевые API endpoints
9. Chat API (стриминг, время ответа)
10. Agent API (создание задачи, выполнение, SSE)
11. VRM аватар (файлы, доступность)

Лог сохраняется в `diagnose-YYYYMMDD-HHMMSS.log` — приложи его к сообщению
об ошибке для быстрой диагностики.

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
1. **Лог диагностики**: `diagnose-*.log` (из последнего запуска `bun run diagnose` или `bun run diagnose:win`)
2. **Dev-лог**: `dev.log` (или `diagnose-dev.log`)
3. **GPU информация** (Windows): `nvidia-smi`
4. **Модели Ollama**: `ollama list`
5. **Шаги воспроизведения**: что делал, что ожидал, что получилось

## Лицензия

Приватный проект. © 2026
