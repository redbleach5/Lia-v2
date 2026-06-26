# Lia RL Sidecar

Python-сервис для обучения RL-политики личности Лии. Запускается как отдельный
процесс рядом с Next.js. Сама inference в production идёт через ONNX в Next.js
(через `onnxruntime-node`) — sidecar нужен только для обучения.

## Установка

```bash
cd python-sidecar
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# или: .venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

## Запуск

```bash
cd python-sidecar
python main.py
# или: uvicorn main:app --host 127.0.0.1 --port 8765
```

Сервер слушает на `http://127.0.0.1:8765`.

## API

| Endpoint | Method | Описание |
|---|---|---|
| `/health` | GET | Health check |
| `/stats` | GET | Кол-во transitions + список моделей |
| `/models` | GET | Список сохранённых версий политик |
| `/train` | POST | Запустить обучение (блокирующий, ~30 сек) |
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

- TensorBoard logging для метрик обучения
- Stable Baselines3 для серьёзных экспериментов (если захочется сложнее PPO)
- Real sentiment model (rubert-tiny) вместо rule-based
- Curriculum learning — обучать на свежих transitions больше, чем на старых
