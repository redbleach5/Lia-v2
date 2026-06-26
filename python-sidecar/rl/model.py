"""
Lia RL policy network.

Architecture: MLP with 2 hidden layers.
- Input: state vector (emotion 5 + drives 4 + context 4 = 13 dims by default)
- Output: action probabilities (softmax over N actions)
- Value head: scalar state value (for PPO critic)

The model is small (~50 KB) — fast to train on CPU, fast to export to ONNX,
fast to inference via onnxruntime-node in the Next.js side.
"""

from __future__ import annotations

from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


# ============================================================================
# Default action space — must match src/lib/rl/types.ts on the TS side
# ============================================================================
DEFAULT_ACTIONS = [
    "WAIT",                # 0 — no action
    "WARM_RESPONSE",       # 1 — tёплый тон
    "BUSINESS_RESPONSE",   # 2 — деловой тон
    "ASK_QUESTION",        # 3 — задать встречный вопрос
    "OFFER_HELP",          # 4 — предложить помощь
    "SHARE_THOUGHT",       # 5 — поделиться мыслью
    "CRACK_JOKE",          # 6 — лёгкий юмор
    "BE_CONCISE",          # 7 — короткий ответ
    "BE_DETAILED",         # 8 — развёрнутый ответ
]
NUM_ACTIONS = len(DEFAULT_ACTIONS)

# Default state dimension — must match buildRLState in TS
DEFAULT_STATE_DIM = 13


class LiaPolicyNetwork(nn.Module):
    """
    Shared trunk → policy head (action logits) + value head (state value).

    Why shared trunk:
    - Smaller model (~50 KB vs ~150 KB for separate networks)
    - Faster training (gradients flow through shared layers)
    - Standard PPO architecture (cf. Stable Baselines3)
    """

    def __init__(
        self,
        state_dim: int = DEFAULT_STATE_DIM,
        num_actions: int = NUM_ACTIONS,
        hidden_dim: int = 64,
    ) -> None:
        super().__init__()
        self.state_dim = state_dim
        self.num_actions = num_actions

        # Shared feature trunk
        self.trunk = nn.Sequential(
            nn.Linear(state_dim, hidden_dim),
            nn.Tanh(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.Tanh(),
        )

        # Policy head
        self.policy_head = nn.Linear(hidden_dim, num_actions)

        # Value head
        self.value_head = nn.Linear(hidden_dim, 1)

    def forward(self, state: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            state: (batch, state_dim) float tensor
        Returns:
            logits: (batch, num_actions)
            value: (batch, 1)
        """
        features = self.trunk(state)
        logits = self.policy_head(features)
        value = self.value_head(features)
        return logits, value

    def act(self, state: torch.Tensor) -> tuple[int, float, float]:
        """
        Sample an action from the policy. Returns (action, log_prob, value).

        Used during training rollouts.
        """
        with torch.no_grad():
            logits, value = self.forward(state.unsqueeze(0))
            probs = F.softmax(logits, dim=-1)
            dist = torch.distributions.Categorical(probs)
            action = dist.sample()
            log_prob = dist.log_prob(action)
            return action.item(), log_prob.item(), value.item()

    def predict(self, state: torch.Tensor) -> tuple[int, float]:
        """
        Greedy action selection (argmax). Returns (action, confidence).

        Used during inference (in production, the ONNX-exported version is
        used instead — this is for testing in Python).
        """
        with torch.no_grad():
            logits, _ = self.forward(state.unsqueeze(0))
            probs = F.softmax(logits, dim=-1)
            confidence, action = probs.max(dim=-1)
            return action.item(), confidence.item()


# ============================================================================
# Model save / load
# ============================================================================
def save_model(model: LiaPolicyNetwork, path: str) -> None:
    """Save the model as a PyTorch state_dict (.pt)."""
    torch.save({
        "state_dict": model.state_dict(),
        "state_dim": model.state_dim,
        "num_actions": model.num_actions,
        "hidden_dim": model.trunk[0].out_features,
    }, path)


def load_model(path: str) -> LiaPolicyNetwork:
    """Load a model from a .pt file."""
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    model = LiaPolicyNetwork(
        state_dim=checkpoint["state_dim"],
        num_actions=checkpoint["num_actions"],
        hidden_dim=checkpoint["hidden_dim"],
    )
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model


# ============================================================================
# ONNX export — for inference in Next.js via onnxruntime-node
# ============================================================================
def export_to_onnx(model: LiaPolicyNetwork, onnx_path: str) -> None:
    """
    Export the model to ONNX format.

    The exported model takes a (1, state_dim) float32 tensor as input and
    returns two outputs:
      - action_logits: (1, num_actions) float32
      - state_value: (1, 1) float32

    Inference in TS:
      const session = await ort.InferenceSession.create(modelPath);
      const input = new ort.Tensor('float32', stateArray, [1, stateDim]);
      const output = await session.run({ input });
      const logits = Array.from(output.action_logits.data);
      const action = logits.indexOf(Math.max(...logits));
    """
    model.eval()

    # Create a dummy input for tracing
    dummy_input = torch.zeros(1, model.state_dim, dtype=torch.float32)

    # PyTorch 2.x by default splits weights > 1KB into external .onnx.data file.
    # onnxruntime-node can't load external data from a buffer (only from file path).
    # We force all weights into the single .onnx file by using the legacy exporter
    # (dynamo=False) which doesn't use external data.
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=["state"],
        output_names=["action_logits", "state_value"],
        dynamic_axes={
            "state": {0: "batch"},
            "action_logits": {0: "batch"},
            "state_value": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,  # use legacy exporter — embeds weights in single file
    )
