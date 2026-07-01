# Lia RL Sidecar (Движок обучения)

Python-сервис для обучения стиля общения Лии. Запускается как отдельный процесс
рядом с Next.js. Inference в production идёт через ONNX в Next.js
(через `onnxruntime-node`) — sidecar нужен только для обучения.

## Установка

### 1. Создать виртуальное окружение

```bash
cd python-sidecar
python3 -m venv .venv
source .venv/bin/activate    # Linux/macOS
# или: .venv\Scripts\activate  # Windows
```

### 2. Установить зависимости

```bash
pip install -r requirements.txt
```

Зависимости:
- **fastapi + uvicorn** — HTTP сервер (порт 8765)
- **torch** — PyTorch для обучения (PPO)
- **onnx** — экспорт обученной модели в формат ONNX
- **onnxscript** — требуется PyTorch 2.x для `torch.onnx.export`
- **numpy** — тензоры для обучения
- **pydantic** — валидация запросов/ответов

Размер: ~750 МБ (большая часть — PyTorch).

### 3. Проверить установку

```bash
python -c "import uvicorn, torch, fastapi, onnx, onnxscript; print('OK')"
```

Должно вывести `OK`.

## Запуск

### Через терминал

```bash
cd python-sidecar
source .venv/bin/activate
python main.py
# или: uvicorn main:app --host 127.0.0.1 --port 8765
```

### Через UI

В приложении: **Настройки → Обучение → Запустить**.

UI вызовет `POST /api/rl/start-engine`, который:
1. Найдёт Python (python3 → python)
2. Предпочтёт `.venv` если существует
3. Проверит что установлены `uvicorn, torch, fastapi`
4. Запустит процесс с передачей `DATABASE_URL`

## API

| Endpoint | Method | Описание |
|---|---|---|
| `/health` | GET | Health check |
| `/stats` | GET | Кол-во transitions + список версий |
| `/models` | GET | Список сохранённых версий |
| `/train` | POST | Запустить обучение (блокирующий, ~5-30 сек) |
| `/predict` | POST | Inference для дебага (production использует ONNX в Next.js) |

### Train

```bash
curl -X POST http://127.0.0.1:8765/train \
  -H "Content-Type: application/json" \
  -d '{"n_epochs": 10, "parent_version": 2}'
```

Response:
```json
{
  "version": 3,
  "avg_reward": 0.42,
  "avg_loss": 0.012,
  "samples_count": 1247,
  "duration_sec": 8.3,
  "onnx_path": "models/policy_v3.onnx",
  "pt_path": "models/policy_v3.pt"
}
```

## Архитектура

```
python-sidecar/
├── main.py                  # FastAPI server
├── requirements.txt
├── rl/
│   ├── __init__.py
│   ├── model.py             # PyTorch policy network + ONNX export
│   ├── train.py             # PPO trainer
│   ├── reward.py            # EDITABLE — user-tunable reward function
│   └── db.py                # SQLite reader for RLExperience
├── models/                  # saved .pt + .onnx files (gitignored)
└── data/                    # training logs, metrics
```

## Как это работает

1. **Next.js сторона** пишет `(state, action, reward, next_state)` в таблицу
   `RLExperience` при каждом сообщении пользователя
2. **Sidecar** читает эти transitions, обучает policy network через PPO,
   сохраняет `.pt` (PyTorch checkpoint) + `.onnx` (для inference в Next.js)
3. **Next.js сторона** загружает активную ONNX-модель через `onnxruntime-node`,
   использует её для выбора действия (тон/длина/стиль ответа) в реальном времени

## Reward function

`rl/reward.py` — редактируется пользователем. Sidecar перезагружает его при
каждом обучении, так что изменения применяются сразу.

Текущая reward балансирует:
- **Engagement** — пользователь ответил (+0.3)
- **Latency** — быстрый ответ лучше (+0.2 если < 60 сек)
- **Length** — развёрнутый ответ (+0.1 за > 100 символов)
- **Variety** — штраф за повторение (-0.2)
- **Emotional health** — раздражение плохо (-0.5 × delta)
- **User sentiment** — позитивный тон пользователя (+0.3 × sentiment)

## Что добавить в будущем

- Real sentiment model (rubert-tiny) вместо rule-based
- Off-policy correction через importance sampling (сейчас PPO approx)

NOTE (Phase 4.3): TensorBoard, Stable Baselines3, Curriculum learning удалены из roadmap —
не нужны для personal companion. PPO + rule-based reward достаточно.

