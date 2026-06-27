"""
Reward function for Lia RL agent.

THIS FILE IS USER-EDITABLE — users can tune the reward to shape Lia's behavior
without touching the rest of the system. The sidecar reloads this module on
each training run, so changes take effect immediately.

Inputs (Transition):
    user_responded: bool — did the user reply after Lia's action?
    response_latency_sec: float — seconds between Lia's action and user's reply
    message_length: int — length of user's reply in chars
    was_repeated: bool — did Lia repeat the same action as last turn?
    irritation_delta: float — change in Lia's irritation emotion (-1..1)
    user_sentiment: float — rule-based sentiment of user's reply (-1..1)
    action_id: int — which action Lia took (0=WAIT, 1=WARM_RESPONSE, ...)

Output:
    reward: float — typically in [-2, 2] range
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Transition:
    """One (state, action, next_state) transition with reward signals."""
    user_responded: bool = False
    response_latency_sec: float = 0.0
    message_length: int = 0
    was_repeated: bool = False
    irritation_delta: float = 0.0
    user_sentiment: float = 0.0
    action_id: int = 0


def compute_reward(t: Transition) -> float:
    """
    Default reward function — balances engagement, brevity, emotional health.

    Feel free to edit. The function should return a float, typically in [-2, 2].
    Positive rewards reinforce the behavior; negative rewards discourage it.
    """
    reward = 0.0

    # ── Engagement: user replied at all ──
    if t.user_responded:
        reward += 0.3
    else:
        reward -= 0.5  # silence is bad — Lia should keep the conversation going

    # ── Response latency: faster is better, but not too fast ──
    if t.user_responded:
        if t.response_latency_sec < 60:
            reward += 0.2  # quick reply = Lia said something engaging
        elif t.response_latency_sec > 3600:
            reward -= 0.1  # very slow reply = maybe Lia was boring or confusing

    # ── Message length: user engaged enough to write a real reply ──
    if t.message_length > 10:
        reward += 0.1
    if t.message_length > 100:
        reward += 0.1  # long reply = high engagement
    if t.message_length > 500:
        reward -= 0.1  # but extremely long might mean user is frustrated/venting

    # ── Repetition penalty: don't repeat the same action twice in a row ──
    if t.was_repeated:
        reward -= 0.2

    # ── Emotional health: irritation is bad ──
    if t.irritation_delta > 0:
        reward -= 0.5 * t.irritation_delta  # irritation went up — penalize
    elif t.irritation_delta < 0:
        reward += 0.2 * abs(t.irritation_delta)  # irritation went down — reward

    # ── User sentiment: positive sentiment is good ──
    reward += 0.3 * t.user_sentiment  # -0.3 to +0.3

    # ── Action-specific shaping (mild biases) ──
    # These are starting points — the RL agent will learn to deviate when
    # the context demands it.
    if t.action_id == 0:  # WAIT — usually bad, conversation stalls
        reward -= 0.1
    elif t.action_id == 3:  # ASK_QUESTION — good for engagement, but not always
        if t.user_responded and t.message_length > 20:
            reward += 0.1
    elif t.action_id == 7:  # BE_CONCISE — good when user is busy
        if t.response_latency_sec < 30 and t.user_responded:
            reward += 0.05

    return reward


# ============================================================================
# Rule-based user sentiment — used by the reward function
# ============================================================================
POSITIVE_WORDS = {
    # Russian
    "спасибо", "благодарю", "класс", "супер", "круто", "отлично", "хорошо",
    "обожаю", "потрясающе", "шикарно", "да", "конечно", "согласен", "согласна",
    # English
    "thanks", "great", "awesome", "perfect", "yes", "agree", "love",
}
NEGATIVE_WORDS = {
    # Russian
    "нет", "не", "плохо", "ужасно", "бесит", "раздражает", "надоел", "хватит",
    "отстань", "не хочу", "не буду", "скучно", "ерунда", "чушь", "бред",
    # English
    "no", "bad", "terrible", "boring", "stop", "enough", "stupid",
}


def estimate_user_sentiment(text: str) -> float:
    """
    Simple rule-based sentiment: -1 (negative) to +1 (positive).

    This is intentionally simple — the RL agent learns from the reward signal,
    not from this sentiment directly. For better sentiment, swap this for
    a real sentiment model (e.g., rubert-tiny sentiment).
    """
    if not text:
        return 0.0

    text_lower = text.lower()
    words = set(text_lower.replace(",", " ").replace(".", " ").split())

    pos = len(words & POSITIVE_WORDS)
    neg = len(words & NEGATIVE_WORDS)

    if pos + neg == 0:
        return 0.0

    return (pos - neg) / (pos + neg)
