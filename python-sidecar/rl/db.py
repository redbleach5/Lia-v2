"""
SQLite reader for RL training data.

Reads from the same DB as the Next.js side (db/custom.db).
The RLExperience table is written by the Next.js side via Prisma.

Schema (Prisma):
    model RLExperience {
        id           String   @id @default(cuid())
        stateJson    String   // JSON array of floats
        action       Int      // 0..N-1
        reward       Float
        nextStateJson String  // JSON array of floats
        userResponded Boolean @default(false)
        responseLatencySec Float @default(0)
        messageLength Int     @default(0)
        wasRepeated  Boolean  @default(false)
        irritationDelta Float @default(0)
        userMessage  String   @default("")
        episodeId    String?
        policyVersion Int?
        createdAt    DateTime @default(now())
    }

The table is created by Prisma on `bun run db:push`. This module gracefully
handles the table-not-found case (returns empty list / 0 count).
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from typing import Optional


@dataclass
class TransitionRecord:
    """One RL transition, loaded from DB."""
    state: list[float]
    action: int
    reward: float
    next_state: list[float]
    user_responded: bool
    response_latency_sec: float
    message_length: int
    was_repeated: bool
    irritation_delta: float
    user_message: str


def resolve_db_path(db_url: Optional[str] = None) -> str:
    """
    Resolve the SQLite path from DATABASE_URL env or explicit argument.
    Mirrors the logic in src/lib/paths.ts.
    """
    raw = db_url or os.environ.get("DATABASE_URL", "")
    # Strip 'file:' prefix
    if raw.startswith("file:"):
        raw = raw[5:]
    if not raw:
        raw = "db/custom.db"
    # Resolve relative to project root (parent of python-sidecar/)
    if not os.path.isabs(raw):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        raw = os.path.join(project_root, raw)
    return raw


def load_transitions(db_path: Optional[str] = None, limit: int = 10000) -> list[TransitionRecord]:
    """
    Load all RL transitions from the DB.

    Args:
        db_path: path to SQLite DB (default: resolved from DATABASE_URL)
        limit: max number of transitions to load

    Returns:
        list of TransitionRecord
    """
    path = resolve_db_path(db_path)
    if not os.path.exists(path):
        raise FileNotFoundError(f"Database not found: {path}")

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        # Check if RLExperience table exists
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='RLExperience'"
        )
        if cursor.fetchone() is None:
            raise ValueError(
                "RLExperience table not found. Run the Next.js side first to "
                "create the schema (bun run db:push)."
            )

        cursor = conn.execute(
            """
            SELECT stateJson, action, reward, nextStateJson,
                   userResponded, responseLatencySec, messageLength,
                   wasRepeated, irritationDelta, userMessage
            FROM RLExperience
            WHERE userResponded = 1
            ORDER BY createdAt DESC
            LIMIT ?
            """,
            (limit,),
        )

        transitions = []
        for row in cursor:
            try:
                state = json.loads(row["stateJson"])
                next_state = json.loads(row["nextStateJson"])
            except (json.JSONDecodeError, TypeError):
                continue  # skip malformed rows

            transitions.append(TransitionRecord(
                state=state,
                action=row["action"],
                reward=row["reward"],
                next_state=next_state,
                user_responded=bool(row["userResponded"]),
                response_latency_sec=float(row["responseLatencySec"] or 0),
                message_length=int(row["messageLength"] or 0),
                was_repeated=bool(row["wasRepeated"]),
                irritation_delta=float(row["irritationDelta"] or 0),
                user_message=row["userMessage"] or "",
            ))

        return transitions
    finally:
        conn.close()


def count_transitions(db_path: Optional[str] = None) -> int:
    """Count RL transitions in the DB."""
    path = resolve_db_path(db_path)
    if not os.path.exists(path):
        return 0

    conn = sqlite3.connect(path)
    try:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='RLExperience'"
        )
        if cursor.fetchone() is None:
            return 0
        cursor = conn.execute("SELECT COUNT(*) FROM RLExperience")
        return cursor.fetchone()[0]
    finally:
        conn.close()
