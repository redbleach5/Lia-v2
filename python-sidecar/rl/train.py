"""
PPO (Proximal Policy Optimization) trainer for Lia policy network.

This is a minimal but correct PPO implementation. For production-scale RL,
consider using Stable Baselines3 or CleanRL — but for a personal companion
with ~1000 transitions in the DB, this is more than enough.

Training loop:
  1. Load all transitions from SQLite (RLExperience table)
  2. Compute advantages with GAE (Generalized Advantage Estimation)
  3. For N epochs:
     - Sample mini-batches
     - Compute new log probs + values
     - PPO clipped loss + value loss + entropy bonus
     - Update policy

After training:
  - Save .pt checkpoint
  - Export to ONNX
  - Register in DB (RlModelVersion table)
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import Adam

from .model import LiaPolicyNetwork, save_model, export_to_onnx, NUM_ACTIONS, DEFAULT_STATE_DIM
from .reward import Transition, compute_reward, estimate_user_sentiment
from .db import load_transitions, TransitionRecord


# ============================================================================
# Training config
# ============================================================================
@dataclass
class TrainConfig:
    # Optimization
    learning_rate: float = 3e-4
    n_epochs: int = 10
    batch_size: int = 64
    clip_ratio: float = 0.2  # PPO epsilon

    # PPO hyperparams
    gamma: float = 0.99       # discount factor
    gae_lambda: float = 0.95  # GAE lambda
    entropy_coef: float = 0.01  # encourage exploration
    value_coef: float = 0.5     # value loss weight
    max_grad_norm: float = 0.5  # gradient clipping

    # Model architecture (must match inference)
    state_dim: int = DEFAULT_STATE_DIM
    num_actions: int = NUM_ACTIONS
    hidden_dim: int = 64

    # Output paths
    output_dir: str = "models"


@dataclass
class TrainResult:
    version: int
    avg_reward: float
    avg_loss: float
    avg_value_loss: float
    avg_policy_loss: float
    avg_entropy: float
    samples_count: int
    duration_sec: float
    onnx_path: str
    pt_path: str


# ============================================================================
# Main training function
# ============================================================================
def train(
    config: Optional[TrainConfig] = None,
    db_path: Optional[str] = None,
    parent_version: Optional[int] = None,
) -> TrainResult:
    """
    Train a new policy version.

    Args:
        config: training hyperparams (default: TrainConfig())
        db_path: path to SQLite DB with RLExperience table (default: env DATABASE_URL)
        parent_version: previous policy version to start from (default: from scratch)

    Returns:
        TrainResult with metrics + paths to saved model
    """
    config = config or TrainConfig()
    start_time = time.time()

    # ── 1. Load transitions from DB ──
    transitions = load_transitions(db_path)
    if len(transitions) < 10:
        raise ValueError(
            f"Need at least 10 transitions to train, got {len(transitions)}. "
            f"Use Lia more — every conversation generates RLExperience rows."
        )

    print(f"[train] loaded {len(transitions)} transitions")

    # ── 2. Convert to tensors ──
    states = torch.tensor(
        np.array([t.state for t in transitions]),
        dtype=torch.float32,
    )
    actions = torch.tensor(
        [t.action for t in transitions],
        dtype=torch.long,
    )
    next_states = torch.tensor(
        np.array([t.next_state for t in transitions]),
        dtype=torch.float32,
    )

    # Compute rewards (re-evaluate from raw signals, in case reward.py was edited)
    rewards = torch.tensor(
        [compute_reward(Transition(
            user_responded=t.user_responded,
            response_latency_sec=t.response_latency_sec,
            message_length=t.message_length,
            was_repeated=t.was_repeated,
            irritation_delta=t.irritation_delta,
            user_sentiment=estimate_user_sentiment(t.user_message),
            action_id=t.action,
        )) for t in transitions],
        dtype=torch.float32,
    )

    print(f"[train] avg reward: {rewards.mean().item():.3f}, "
          f"min: {rewards.min().item():.3f}, max: {rewards.max().item():.3f}")

    # ── 3. Initialize model (from parent or scratch) ──
    model = LiaPolicyNetwork(
        state_dim=config.state_dim,
        num_actions=config.num_actions,
        hidden_dim=config.hidden_dim,
    )

    if parent_version is not None:
        parent_path = os.path.join(config.output_dir, f"policy_v{parent_version}.pt")
        if os.path.exists(parent_path):
            checkpoint = torch.load(parent_path, map_location="cpu", weights_only=False)
            model.load_state_dict(checkpoint["state_dict"])
            print(f"[train] resumed from parent v{parent_version}")
        else:
            print(f"[train] parent v{parent_version} not found, training from scratch")

    optimizer = Adam(model.parameters(), lr=config.learning_rate)

    # ── 4. Compute GAE advantages ──
    with torch.no_grad():
        # Get values for all states
        _, values = model(states)
        values = values.squeeze(-1)
        _, next_values = model(next_states)
        next_values = next_values.squeeze(-1)

        # GAE with episode-boundary reset.
        # Phase 1 fix: last_gae должен сбрасываться в 0 при смене episode_id,
        # иначе advantage из конца эпизода A "утекает" в начало эпизода B.
        # Также: если next_state принадлежит другому эпизоду, используем 0
        # как bootstrap value (т.к. эпизод закончился).
        advantages = torch.zeros_like(rewards)
        last_gae = 0.0
        prev_episode_id = None
        for t in reversed(range(len(transitions))):
            current_episode_id = transitions[t].episode_id
            # Reset GAE на границе эпизодов
            if prev_episode_id is not None and current_episode_id != prev_episode_id:
                last_gae = 0.0
            # Если следующий transition из другого эпизода — bootstrap = 0
            # (текущий transition — последний в своём эпизоде)
            is_last_in_episode = (
                t == len(transitions) - 1
                or transitions[t + 1].episode_id != current_episode_id
            )
            bootstrap = 0.0 if is_last_in_episode else next_values[t].item()
            delta = rewards[t] + config.gamma * bootstrap - values[t]
            last_gae = delta + config.gamma * config.gae_lambda * last_gae
            advantages[t] = last_gae
            prev_episode_id = current_episode_id

        returns = advantages + values

    # Normalize advantages (stabilizes training)
    advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

    # ── 5. Training loop ──
    n_samples = len(transitions)
    n_batches = max(1, n_samples // config.batch_size)

    # old_log_probs вычисляются внутри loop (см. ниже) — каждый epoch заново.

    total_loss_sum = 0.0
    total_value_loss_sum = 0.0
    total_policy_loss_sum = 0.0
    total_entropy_sum = 0.0
    update_count = 0

    model.train()
    for epoch in range(config.n_epochs):
        # Phase 1 fix: пересчитываем old_log_probs каждый epoch.
        # Раньше они вычислялись один раз перед loop — это "PPO with stale old_log_probs",
        # приближение, которое работает но не строго корректно. После обновления весов
        # в epoch N-1, "old" policy для epoch N должна быть текущей моделью.
        with torch.no_grad():
            old_logits, _ = model(states)
            old_log_probs = F.log_softmax(old_logits, dim=-1).gather(1, actions.unsqueeze(1)).squeeze(1)

        # Shuffle indices
        perm = torch.randperm(n_samples)

        for batch_idx in range(n_batches):
            batch_indices = perm[batch_idx * config.batch_size:(batch_idx + 1) * config.batch_size]
            if len(batch_indices) == 0:
                continue

            batch_states = states[batch_indices]
            batch_actions = actions[batch_indices]
            batch_old_log_probs = old_log_probs[batch_indices]
            batch_advantages = advantages[batch_indices]
            batch_returns = returns[batch_indices]

            # Forward pass
            logits, values = model(batch_states)
            values = values.squeeze(-1)

            # New log probs
            log_probs = F.log_softmax(logits, dim=-1).gather(1, batch_actions.unsqueeze(1)).squeeze(1)

            # PPO ratio
            ratio = torch.exp(log_probs - batch_old_log_probs)

            # Clipped surrogate loss
            surr1 = ratio * batch_advantages
            surr2 = torch.clamp(ratio, 1 - config.clip_ratio, 1 + config.clip_ratio) * batch_advantages
            policy_loss = -torch.min(surr1, surr2).mean()

            # Value loss (MSE)
            value_loss = F.mse_loss(values, batch_returns)

            # Entropy bonus (encourage exploration)
            probs = F.softmax(logits, dim=-1)
            entropy = -(probs * F.log_softmax(logits, dim=-1)).sum(dim=-1).mean()

            # Total loss
            loss = policy_loss + config.value_coef * value_loss - config.entropy_coef * entropy

            # Backward
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), config.max_grad_norm)
            optimizer.step()

            total_loss_sum += loss.item()
            total_value_loss_sum += value_loss.item()
            total_policy_loss_sum += policy_loss.item()
            total_entropy_sum += entropy.item()
            update_count += 1

        # Log per-epoch
        if (epoch + 1) % 2 == 0 or epoch == 0:
            print(f"[train] epoch {epoch + 1}/{config.n_epochs}: "
                  f"loss={total_loss_sum / max(1, update_count):.4f}")

    # ── 6. Save model ──
    os.makedirs(config.output_dir, exist_ok=True)

    # Determine version number
    existing_versions = [
        int(f.split("_v")[1].split(".")[0])
        for f in os.listdir(config.output_dir)
        if f.startswith("policy_v") and f.endswith(".pt")
    ]
    new_version = max(existing_versions, default=0) + 1

    pt_path = os.path.join(config.output_dir, f"policy_v{new_version}.pt")
    onnx_path = os.path.join(config.output_dir, f"policy_v{new_version}.onnx")

    # Phase 1 fix: atomic write для ONNX через .tmp + rename.
    # Раньше export_to_onnx писал напрямую в policy_v{N}.onnx — если Next.js
    # вызывал reloadModel() сразу после train, onnxruntime-node мог прочитать
    # partially-written файл. Теперь: пишем в .tmp, затем atomic rename.
    save_model(model, pt_path)

    onnx_tmp_path = onnx_path + ".tmp"
    export_to_onnx(model, onnx_tmp_path)
    os.replace(onnx_tmp_path, onnx_path)  # atomic on POSIX

    print(f"[train] saved v{new_version}: {pt_path}, {onnx_path}")

    duration = time.time() - start_time
    return TrainResult(
        version=new_version,
        avg_reward=float(rewards.mean().item()),
        avg_loss=total_loss_sum / max(1, update_count),
        avg_value_loss=total_value_loss_sum / max(1, update_count),
        avg_policy_loss=total_policy_loss_sum / max(1, update_count),
        avg_entropy=total_entropy_sum / max(1, update_count),
        samples_count=len(transitions),
        duration_sec=duration,
        onnx_path=onnx_path,
        pt_path=pt_path,
    )
