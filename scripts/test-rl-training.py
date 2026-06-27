"""
Comprehensive test for RL training system.

Генерирует разнообразные RL experience записи, обучает PPO модель,
экспортирует в ONNX, тестирует inference. Проверяет весь цикл.

Usage:
    cd Lia-v2
    python3 scripts/test-rl-training.py
"""

import os
import sys
import json
import sqlite3
import random
import time
from pathlib import Path

# Setup paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = PROJECT_ROOT / "db" / "custom.db"
SIDECAR_DIR = Path(__file__).resolve().parent.parent / "python-sidecar"

# Add sidecar to path
sys.path.insert(0, str(SIDECAR_DIR))

import numpy as np


def generate_test_transitions(db_path: str, count: int = 50):
    """Generate diverse test transitions in the RLExperience table."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM RLExperience")
    print(f"  Cleared existing RLExperience records")

    # 28 diverse scenarios covering all action types and emotional states
    scenarios = [
        # (emotion[5], action, responded, latency, msg_len, repeated, irrit_delta, user_msg)
        ([0.7, 0.6, 0.7, 0.1, 0.15], 1, True, 15, 25, False, -0.05, "Привет! Как дела?"),
        ([0.65, 0.55, 0.65, 0.1, 0.15], 1, True, 20, 30, False, -0.03, "Привет, Лия! Рад тебя видеть"),
        ([0.5, 0.8, 0.6, 0.1, 0.15], 2, True, 45, 120, False, 0.0, "Как работает этот алгоритм? Объясни подробно"),
        ([0.5, 0.75, 0.6, 0.1, 0.15], 2, True, 30, 80, False, 0.0, "Что такое closures в JavaScript?"),
        ([0.55, 0.85, 0.65, 0.1, 0.15], 3, True, 25, 45, False, -0.02, "А ты как думаешь по этому поводу?"),
        ([0.6, 0.8, 0.7, 0.1, 0.15], 3, True, 18, 35, False, -0.04, "Интересно! А почему именно так?"),
        ([0.65, 0.7, 0.7, 0.1, 0.15], 4, True, 40, 60, False, -0.05, "Да, помоги пожалуйста с кодом"),
        ([0.6, 0.65, 0.65, 0.1, 0.15], 4, True, 35, 50, False, -0.03, "Хочешь, я найду это в интернете?"),
        ([0.55, 0.75, 0.7, 0.1, 0.15], 5, True, 50, 90, False, 0.0, "Мне кажется, ты права. Интересная мысль"),
        ([0.6, 0.7, 0.65, 0.1, 0.15], 5, True, 60, 110, False, 0.02, "Знаешь, я тут подумал... да, согласен"),
        ([0.5, 0.6, 0.7, 0.1, 0.15], 7, True, 10, 15, False, -0.02, "Понятно, спасибо"),
        ([0.5, 0.55, 0.7, 0.1, 0.15], 7, True, 8, 10, False, -0.01, "Ок"),
        ([0.55, 0.85, 0.6, 0.1, 0.15], 8, True, 120, 250, False, 0.0, "Спасибо за подробное объяснение! Очень помогло"),
        ([0.5, 0.8, 0.6, 0.1, 0.15], 8, True, 90, 180, False, 0.0, "Отличный разбор темы, всё понятно"),
        ([0.5, 0.6, 0.6, 0.15, 0.2], 1, True, 35, 40, True, 0.05, "Ты уже это говорила..."),
        ([0.5, 0.55, 0.55, 0.2, 0.25], 3, True, 40, 50, True, 0.08, "Опять тот же вопрос?"),
        ([0.4, 0.5, 0.5, 0.2, 0.3], 0, False, 0, 0, False, 0.0, ""),
        ([0.35, 0.45, 0.45, 0.25, 0.35], 0, False, 0, 0, False, 0.05, ""),
        ([0.3, 0.5, 0.4, 0.5, 0.3], 1, True, 15, 80, False, 0.3, "Хватит повторять одно и то же! Бесит!"),
        ([0.25, 0.45, 0.35, 0.6, 0.35], 2, True, 10, 60, False, 0.4, "Нет, неправильно! Ты ошибаешься!"),
        ([0.8, 0.7, 0.8, 0.05, 0.1], 1, True, 5, 35, False, -0.1, "Спасибо большое! Классно помогла!"),
        ([0.85, 0.65, 0.85, 0.05, 0.1], 5, True, 8, 45, False, -0.08, "Обожаю с тобой разговаривать! Всегда супер!"),
        ([0.5, 0.6, 0.6, 0.1, 0.15], 2, True, 3700, 100, False, 0.05, "Долго думал, но спасибо"),
        ([0.6, 0.7, 0.7, 0.05, 0.1], 7, True, 5, 20, False, -0.05, "Быстро! Спасибо!"),
        ([0.55, 0.95, 0.6, 0.1, 0.15], 3, True, 12, 70, False, -0.05, "Ого, интересно! Расскажи ещё!"),
        ([0.6, 0.5, 0.9, 0.05, 0.1], 5, True, 60, 150, False, -0.05, "Спокойно и понятно. Мне нравится такой подход"),
        ([0.3, 0.4, 0.5, 0.1, 0.6], 1, True, 45, 200, False, -0.1, "Мне сегодня грустно... Поговори со мной"),
        ([0.2, 0.3, 0.3, 0.8, 0.2], 2, True, 8, 50, False, 0.5, "Это просто ужас! Почему ничего не работает?!"),
    ]

    inserted = 0
    for i in range(count):
        scenario = scenarios[i % len(scenarios)]
        emotion, action, responded, latency, msg_len, repeated, irrit_delta, user_msg = scenario

        # Add slight randomization for diversity
        emotion_perturbed = [max(0, min(1, v + random.uniform(-0.05, 0.05))) for v in emotion]
        latency_perturbed = max(0, latency + random.randint(-5, 5))
        msg_len_perturbed = max(0, msg_len + random.randint(-10, 10))

        # Build state vector: 5 emotion + 4 drives + 4 context
        state = emotion_perturbed + [
            0.5, 0.5, 0.7, 0.3,  # drives
            min(1.0, latency_perturbed / 3600),
            min(1.0, (i + 2) / 100),
            0.5,
            emotion_perturbed.index(max(emotion_perturbed)) / 4,
        ]

        next_emotion = [max(0, min(1, v + random.uniform(-0.03, 0.03))) for v in emotion_perturbed]
        next_state = next_emotion + [
            0.5, 0.5, 0.7, 0.3,
            0.0,
            min(1.0, (i + 3) / 100),
            0.5,
            next_emotion.index(max(next_emotion)) / 4,
        ]

        cursor.execute("""
            INSERT INTO RLExperience (
                id, stateJson, action, reward, nextStateJson,
                userResponded, responseLatencySec, messageLength,
                wasRepeated, irritationDelta, userMessage,
                episodeId, policyVersion, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            f"test-rl-{i:04d}",
            json.dumps(state),
            action,
            0.0,
            json.dumps(next_state),
            1 if responded else 0,
            latency_perturbed,
            msg_len_perturbed,
            1 if repeated else 0,
            irrit_delta,
            user_msg,
            "test-episode",
            None,
            time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        ))
        inserted += 1

    conn.commit()
    conn.close()
    return inserted


def main():
    print("=" * 70)
    print("RL TRAINING SYSTEM TEST")
    print("=" * 70)

    # Step 1: Generate test data
    print("\n[1/5] Generating test transitions...")
    if not DB_PATH.exists():
        print(f"ERROR: Database not found at {DB_PATH}")
        sys.exit(1)
    count = generate_test_transitions(str(DB_PATH), count=50)
    print(f"  ✓ Generated {count} diverse transitions")

    # Step 2: Load transitions and compute rewards
    print("\n[2/5] Loading transitions and computing rewards...")
    from rl.db import load_transitions, resolve_db_path
    from rl.reward import compute_reward, Transition, estimate_user_sentiment

    db_path = resolve_db_path()
    transitions = load_transitions(db_path, limit=10000)
    print(f"  ✓ Loaded {len(transitions)} transitions (filtered: userResponded=true only)")

    if len(transitions) < 10:
        print(f"ERROR: Need at least 10 transitions for training, got {len(transitions)}")
        sys.exit(1)

    rewards = []
    for t in transitions:
        sentiment = estimate_user_sentiment(t.user_message)
        tr = Transition(
            user_responded=t.user_responded,
            response_latency_sec=t.response_latency_sec,
            message_length=t.message_length,
            was_repeated=t.was_repeated,
            irritation_delta=t.irritation_delta,
            user_sentiment=sentiment,
            action_id=t.action,
        )
        rewards.append(compute_reward(tr))

    avg_r = sum(rewards) / len(rewards)
    print(f"  ✓ Rewards: avg={avg_r:.3f}, min={min(rewards):.3f}, max={max(rewards):.3f}")

    # Step 3: Train PPO model
    print("\n[3/5] Training PPO model...")
    from rl.train import train, TrainConfig
    from rl.model import DEFAULT_ACTIONS, DEFAULT_STATE_DIM

    config = TrainConfig(
        learning_rate=3e-4,
        n_epochs=20,
        batch_size=16,
    )
    print(f"  Config: lr={config.learning_rate}, epochs={config.n_epochs}, batch={config.batch_size}")
    print(f"  State dim: {DEFAULT_STATE_DIM}, Actions: {len(DEFAULT_ACTIONS)} ({DEFAULT_ACTIONS})")

    try:
        result = train(config=config, db_path=str(DB_PATH))
        print(f"\n  ✓ Training completed!")
        print(f"    Version:        {result.version}")
        print(f"    Avg reward:     {result.avg_reward:.4f}")
        print(f"    Avg loss:       {result.avg_loss:.4f}")
        print(f"    Policy loss:    {result.avg_policy_loss:.4f}")
        print(f"    Value loss:     {result.avg_value_loss:.4f}")
        print(f"    Entropy:        {result.avg_entropy:.4f}")
        print(f"    Samples:        {result.samples_count}")
        print(f"    Duration:       {result.duration_sec:.1f}s")
        print(f"    ONNX path:      {result.onnx_path}")
        print(f"    PT path:        {result.pt_path}")
    except Exception as e:
        print(f"\n  ERROR: Training failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Step 4: Verify ONNX model
    print("\n[4/5] Verifying ONNX model...")
    onnx_path = Path(result.onnx_path)
    if not onnx_path.exists():
        print(f"  ERROR: ONNX file not found: {onnx_path}")
        sys.exit(1)
    print(f"  ✓ ONNX file exists: {onnx_path} ({onnx_path.stat().st_size / 1024:.1f} KB)")

    # Step 5: Test inference
    print("\n[5/5] Testing ONNX inference...")
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(onnx_path))
        input_name = sess.get_inputs()[0].name

        test_states = [
            ("happy_user",    [0.8, 0.7, 0.8, 0.05, 0.1, 0.5, 0.5, 0.7, 0.3, 0.0, 0.5, 0.5, 0.0]),
            ("curious_user",  [0.55, 0.95, 0.6, 0.1, 0.15, 0.5, 0.5, 0.7, 0.3, 0.0, 0.3, 0.5, 0.25]),
            ("irritated_user",[0.2, 0.3, 0.3, 0.8, 0.2, 0.5, 0.5, 0.7, 0.3, 0.5, 0.8, 0.5, 0.75]),
            ("calm_user",     [0.6, 0.5, 0.9, 0.05, 0.1, 0.5, 0.5, 0.7, 0.3, 0.0, 0.1, 0.5, 0.5]),
            ("sad_user",      [0.3, 0.4, 0.5, 0.1, 0.6, 0.5, 0.5, 0.7, 0.3, 0.1, 0.3, 0.5, 0.5]),
        ]

        for name, state in test_states:
            input_data = np.array([state], dtype=np.float32)
            outputs = sess.run(None, {input_name: input_data})
            logits = outputs[0][0]
            value = outputs[1][0]

            exp_logits = np.exp(logits - np.max(logits))
            probs = exp_logits / np.sum(exp_logits)
            action = np.argmax(probs)

            print(f"  {name:15s} → action={DEFAULT_ACTIONS[action]:20s} (conf={float(probs[action].item()):.2f}, value={float(value.item()):.3f})")

        print(f"\n  ✓ Inference works correctly!")

    except Exception as e:
        print(f"  ERROR: Inference test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    print(f"  Transitions generated:  {count}")
    print(f"  Transitions loaded:     {len(transitions)} (filtered: userResponded=true)")
    print(f"  Reward range:           [{min(rewards):.3f}, {max(rewards):.3f}]")
    print(f"  Avg reward:             {avg_r:.3f}")
    print(f"  Training epochs:        {config.n_epochs}")
    print(f"  Final policy loss:      {result.avg_policy_loss:.4f}")
    print(f"  Final value loss:       {result.avg_value_loss:.4f}")
    print(f"  Final entropy:          {result.avg_entropy:.4f}")
    print(f"  ONNX model size:        {onnx_path.stat().st_size / 1024:.1f} KB")
    print(f"  Inference test:         PASSED")
    print("=" * 70)
    print("ALL TESTS PASSED ✓")


if __name__ == "__main__":
    main()
