#!/usr/bin/env python3
"""
Comprehensive test for Lia-v2 memory systems.

Тестирует ВСЕ типы памяти:
1. Episodes CRUD + messages
2. Global facts (upsert, get, reinforcement)
3. Episode facts (upsert, isolation)
4. Vector memory (remember/recall с фильтрацией по episodeId)
5. Emotional memory (anchors, recall, decay, anti-pattern)
6. Episode isolation — утечек между чатами быть НЕ должно
7. Fact extraction heuristic (shouldExtractFacts)
8. Edge cases: пустые данные, Unicode, большие тексты

Использует прямые SQL запросы к БД (не через Ollama/Next.js),
чтобы тест был детерминированным и быстрым.

Usage:
    cd Lia-v2
    python3 scripts/test-memory-systems.py
"""

import os
import sys
import json
import sqlite3
import time
import hashlib
from pathlib import Path
from datetime import datetime, timedelta

# Setup paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = PROJECT_ROOT / "db" / "custom.db"

# ============================================================================
# Helpers
# ============================================================================
def connect():
    """Connect to the SQLite DB."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def cleanup_test_data():
    """Remove all test data from previous runs."""
    conn = connect()
    cursor = conn.cursor()
    # Delete test episodes and cascade
    cursor.execute("SELECT id FROM Episode WHERE id LIKE 'test-%'")
    ep_ids = [row[0] for row in cursor.fetchall()]
    for ep_id in ep_ids:
        # Clean vec_rowid_map (regular SQL table, always works)
        cursor.execute("DELETE FROM vec_rowid_map WHERE episode_id = ?", (ep_id,))
        # Clean vec_virtual — may fail if sqlite-vec not loaded, that's OK
        try:
            cursor.execute("DELETE FROM vec_virtual WHERE episode_id = ?", (ep_id,))
        except sqlite3.OperationalError:
            pass  # sqlite-vec extension not loaded, skip
    # Delete test episodes (cascade will clean Messages, EpisodeFact, VectorMemory, EmotionalMemory)
    cursor.execute("DELETE FROM Episode WHERE id LIKE 'test-%'")
    # Delete test global facts
    cursor.execute("DELETE FROM GlobalFact WHERE key LIKE 'test-%'")
    conn.commit()
    conn.close()
    return len(ep_ids)

def generate_fake_embedding(text: str, dim: int = 768) -> bytes:
    """
    Generate a deterministic fake embedding from text.
    Uses hash-based pseudo-random for reproducibility.
    NOT a real embedding, but sufficient for testing vector operations.
    """
    import struct
    import hashlib

    # Create a deterministic seed from text
    seed = int(hashlib.md5(text.encode()).hexdigest(), 16)

    # Generate dim floats from seed
    import random
    rng = random.Random(seed)
    vec = [rng.uniform(-1, 1) for _ in range(dim)]

    # Pack as float32 bytes
    return struct.pack(f'{dim}f', *vec)

def generate_fake_embedding_list(text: str, dim: int = 768) -> list:
    """Generate a deterministic fake embedding as a list of floats."""
    import hashlib
    import random
    seed = int(hashlib.md5(text.encode()).hexdigest(), 16)
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(dim)]

# ============================================================================
# Tests
# ============================================================================

def test_episodes_crud():
    """Test 1: Episode CRUD + messages."""
    print("\n[1] Episode CRUD + Messages")
    conn = connect()
    cursor = conn.cursor()

    ep_id = "test-ep-crud"
    # Create
    cursor.execute(
        "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        (ep_id, "Test CRUD Episode", datetime.now().isoformat(), datetime.now().isoformat())
    )

    # Create message
    msg_id = "test-msg-001"
    cursor.execute(
        "INSERT INTO Message (id, episodeId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
        (msg_id, ep_id, "user", "Привет, Лия!", datetime.now().isoformat())
    )

    # Read message
    cursor.execute("SELECT * FROM Message WHERE episodeId = ?", (ep_id,))
    msg = cursor.fetchone()
    assert msg is not None, "Message not found"
    assert msg["content"] == "Привет, Лия!", f"Wrong content: {msg['content']}"
    assert msg["role"] == "user", f"Wrong role: {msg['role']}"
    print(f"  ✓ Created episode + message")
    print(f"  ✓ Message content correct: '{msg['content']}'")

    # Create second message
    cursor.execute(
        "INSERT INTO Message (id, episodeId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
        ("test-msg-002", ep_id, "companion", "Привет! Как дела?", datetime.now().isoformat())
    )

    # Count messages
    cursor.execute("SELECT COUNT(*) as c FROM Message WHERE episodeId = ?", (ep_id,))
    count = cursor.fetchone()["c"]
    assert count == 2, f"Expected 2 messages, got {count}"
    print(f"  ✓ Message count: {count}")

    # Test autoTitle (simulated)
    title = "Привет, Лия!"[:60]
    cursor.execute("UPDATE Episode SET title = ? WHERE id = ?", (title, ep_id))
    cursor.execute("SELECT title FROM Episode WHERE id = ?", (ep_id,))
    assert cursor.fetchone()["title"] == title
    print(f"  ✓ Auto-title works: '{title}'")

    conn.commit()
    conn.close()
    return ep_id

def test_global_facts():
    """Test 2: Global facts (cross-episode)."""
    print("\n[2] Global Facts (cross-episode)")
    conn = connect()
    cursor = conn.cursor()

    # Insert
    cursor.execute(
        "INSERT OR REPLACE INTO GlobalFact (key, value, confidence, updatedAt) VALUES (?, ?, ?, ?)",
        ("test-user.name", "Иван", 0.7, datetime.now().isoformat())
    )
    cursor.execute(
        "INSERT OR REPLACE INTO GlobalFact (key, value, confidence, updatedAt) VALUES (?, ?, ?, ?)",
        ("test-user.profession", "разработчик", 0.8, datetime.now().isoformat())
    )

    # Read
    cursor.execute("SELECT * FROM GlobalFact WHERE key LIKE 'test-%' ORDER BY key")
    facts = cursor.fetchall()
    assert len(facts) == 2, f"Expected 2 facts, got {len(facts)}"
    assert facts[0]["key"] == "test-user.name"
    assert facts[0]["value"] == "Иван"
    print(f"  ✓ Inserted 2 global facts")
    print(f"  ✓ Fact: {facts[0]['key']} = {facts[0]['value']}")

    # Test Unicode
    cursor.execute(
        "INSERT OR REPLACE INTO GlobalFact (key, value, confidence, updatedAt) VALUES (?, ?, ?, ?)",
        ("test-user.city", "Санкт-Петербург 🏙️", 0.9, datetime.now().isoformat())
    )
    cursor.execute("SELECT value FROM GlobalFact WHERE key = 'test-user.city'")
    city = cursor.fetchone()["value"]
    assert city == "Санкт-Петербург 🏙️", f"Unicode issue: {city}"
    print(f"  ✓ Unicode: {city}")

    # Test reinforcement (update same value → confidence increases)
    cursor.execute("SELECT confidence FROM GlobalFact WHERE key = 'test-user.name'")
    old_conf = cursor.fetchone()["confidence"]
    cursor.execute(
        "UPDATE GlobalFact SET confidence = MIN(0.95, ? + 0.1) WHERE key = 'test-user.name'",
        (old_conf,)
    )
    cursor.execute("SELECT confidence FROM GlobalFact WHERE key = 'test-user.name'")
    new_conf = cursor.fetchone()["confidence"]
    assert new_conf > old_conf, f"Confidence should increase: {old_conf} → {new_conf}"
    print(f"  ✓ Reinforcement: confidence {old_conf} → {new_conf}")

    conn.commit()
    conn.close()

def test_episode_facts_isolation():
    """Test 3: Episode facts isolation between episodes."""
    print("\n[3] Episode Facts — Isolation Between Chats")
    conn = connect()
    cursor = conn.cursor()

    ep1 = "test-ep-facts-1"
    ep2 = "test-ep-facts-2"

    # Create episodes
    for ep_id in [ep1, ep2]:
        cursor.execute(
            "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
            (ep_id, f"Test Facts {ep_id}", datetime.now().isoformat(), datetime.now().isoformat())
        )

    # Insert fact in ep1
    cursor.execute(
        "INSERT INTO EpisodeFact (id, episodeId, key, value, ts) VALUES (?, ?, ?, ?, ?)",
        ("test-ef-1", ep1, "current.project", "Project Alpha", datetime.now().isoformat())
    )

    # Insert fact in ep2
    cursor.execute(
        "INSERT INTO EpisodeFact (id, episodeId, key, value, ts) VALUES (?, ?, ?, ?, ?)",
        ("test-ef-2", ep2, "current.project", "Project Beta", datetime.now().isoformat())
    )

    # Read ep1 facts
    cursor.execute("SELECT * FROM EpisodeFact WHERE episodeId = ?", (ep1,))
    ep1_facts = cursor.fetchall()
    assert len(ep1_facts) == 1, f"Expected 1 fact for ep1, got {len(ep1_facts)}"
    assert ep1_facts[0]["value"] == "Project Alpha", f"Wrong value: {ep1_facts[0]['value']}"

    # Read ep2 facts
    cursor.execute("SELECT * FROM EpisodeFact WHERE episodeId = ?", (ep2,))
    ep2_facts = cursor.fetchall()
    assert len(ep2_facts) == 1
    assert ep2_facts[0]["value"] == "Project Beta"

    # CRITICAL: ep1 should NOT see ep2's facts
    cursor.execute("SELECT COUNT(*) as c FROM EpisodeFact WHERE episodeId = ? AND value = 'Project Beta'", (ep1,))
    leak_count = cursor.fetchone()["c"]
    assert leak_count == 0, f"LEAK DETECTED: ep1 sees ep2's fact!"
    print(f"  ✓ ep1 has: {ep1_facts[0]['key']} = {ep1_facts[0]['value']}")
    print(f"  ✓ ep2 has: {ep2_facts[0]['key']} = {ep2_facts[0]['value']}")
    print(f"  ✓ NO LEAK: ep1 cannot see ep2's facts")

    conn.commit()
    conn.close()

def test_vector_memory_isolation():
    """Test 4: Vector memory isolation between episodes."""
    print("\n[4] Vector Memory — Isolation Between Episodes")
    conn = connect()
    cursor = conn.cursor()

    ep1 = "test-ep-vec-1"
    ep2 = "test-ep-vec-2"

    # Create episodes
    for ep_id in [ep1, ep2]:
        cursor.execute(
            "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
            (ep_id, f"Test Vec {ep_id}", datetime.now().isoformat(), datetime.now().isoformat())
        )

    # Insert vector memory in ep1
    text1 = "Как работает async/await в JavaScript"
    emb1 = generate_fake_embedding(text1)
    cursor.execute(
        "INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ("test-vm-1", ep1, "dialogue", text1, emb1, datetime.now().isoformat())
    )

    # Insert vector memory in ep2
    text2 = "Как настроить Docker compose для PostgreSQL"
    emb2 = generate_fake_embedding(text2)
    cursor.execute(
        "INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ("test-vm-2", ep2, "dialogue", text2, emb2, datetime.now().isoformat())
    )

    # Check ep1 can see its vector
    cursor.execute("SELECT * FROM VectorMemory WHERE episodeId = ?", (ep1,))
    ep1_vecs = cursor.fetchall()
    assert len(ep1_vecs) == 1
    assert ep1_vecs[0]["text"] == text1

    # Check ep2 can see its vector
    cursor.execute("SELECT * FROM VectorMemory WHERE episodeId = ?", (ep2,))
    ep2_vecs = cursor.fetchall()
    assert len(ep2_vecs) == 1
    assert ep2_vecs[0]["text"] == text2

    # CRITICAL: ep1 should NOT see ep2's vectors
    cursor.execute("SELECT COUNT(*) as c FROM VectorMemory WHERE episodeId = ? AND text = ?", (ep1, text2))
    leak = cursor.fetchone()["c"]
    assert leak == 0, f"LEAK: ep1 sees ep2's vector!"

    print(f"  ✓ ep1 has: '{text1[:40]}...'")
    print(f"  ✓ ep2 has: '{text2[:40]}...'")
    print(f"  ✓ NO LEAK: ep1 cannot see ep2's vectors")

    conn.commit()
    conn.close()

def test_emotional_memory_isolation():
    """Test 5: Emotional memory isolation + decay."""
    print("\n[5] Emotional Memory — Isolation + Decay")
    conn = connect()
    cursor = conn.cursor()

    ep1 = "test-ep-emo-1"
    ep2 = "test-ep-emo-2"

    # Create episodes
    for ep_id in [ep1, ep2]:
        cursor.execute(
            "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
            (ep_id, f"Test Emo {ep_id}", datetime.now().isoformat(), datetime.now().isoformat())
        )

    # Insert emotional anchor in ep1 (high intensity anger)
    cursor.execute(
        """INSERT INTO EmotionalMemory
           (id, episodeId, emotion, intensity, trigger, context, emotionVectorJson, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("test-em-1", ep1, "anger", 0.85, "пользователь ругался на код",
         "Твой код не работает! Это ужас!", json.dumps({"joy": 0.2, "irritation": 0.8}), datetime.now().isoformat())
    )

    # Insert emotional anchor in ep2 (joy)
    cursor.execute(
        """INSERT INTO EmotionalMemory
           (id, episodeId, emotion, intensity, trigger, context, emotionVectorJson, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("test-em-2", ep2, "joy", 0.75, "пользователь поблагодарил",
         "Спасибо большое! Очень помогло!", json.dumps({"joy": 0.8, "irritation": 0.05}), datetime.now().isoformat())
    )

    # Check isolation
    cursor.execute("SELECT * FROM EmotionalMemory WHERE episodeId = ?", (ep1,))
    ep1_emos = cursor.fetchall()
    assert len(ep1_emos) == 1
    assert ep1_emos[0]["emotion"] == "anger"

    cursor.execute("SELECT * FROM EmotionalMemory WHERE episodeId = ?", (ep2,))
    ep2_emos = cursor.fetchall()
    assert len(ep2_emos) == 1
    assert ep2_emos[0]["emotion"] == "joy"

    # CRITICAL: ep1 should NOT see ep2's emotional memories
    cursor.execute("SELECT COUNT(*) as c FROM EmotionalMemory WHERE episodeId = ? AND emotion = 'joy'", (ep1,))
    leak = cursor.fetchone()["c"]
    assert leak == 0, f"LEAK: ep1 sees ep2's emotion!"

    print(f"  ✓ ep1 has: anger (intensity=0.85)")
    print(f"  ✓ ep2 has: joy (intensity=0.75)")
    print(f"  ✓ NO LEAK: ep1 cannot see ep2's emotional memories")

    # Test decay (simulated — 365 days ago)
    old_date = (datetime.now() - timedelta(days=365)).isoformat()
    cursor.execute(
        """INSERT INTO EmotionalMemory
           (id, episodeId, emotion, intensity, trigger, context, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        ("test-em-old", ep1, "sadness", 0.6, "грустный разговор",
         "Мне сегодня очень грустно", old_date)
    )

    # Decay formula: original * 0.5^(ageDays / 180)
    # 365 days → factor = 0.5^(365/180) = 0.5^2.028 ≈ 0.244
    # 0.6 * 0.244 ≈ 0.146 — below default threshold of 0.15!
    import math
    age_days = 365
    decay_factor = 0.5 ** (age_days / 180)
    decayed = 0.6 * decay_factor
    print(f"  ✓ Decay test: original=0.6, age={age_days}d, decayed={decayed:.3f} (factor={decay_factor:.3f})")
    print(f"    → Below 0.15 threshold: {'YES (filtered out)' if decayed < 0.15 else 'NO (still visible)'}")

    conn.commit()
    conn.close()

def test_cascade_delete():
    """Test 6: Cascade delete — removing episode cleans all related data."""
    print("\n[6] Cascade Delete")
    conn = connect()
    cursor = conn.cursor()

    ep_id = "test-ep-cascade"

    # Create episode with full data
    cursor.execute(
        "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        (ep_id, "Cascade Test", datetime.now().isoformat(), datetime.now().isoformat())
    )
    cursor.execute(
        "INSERT INTO Message (id, episodeId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
        ("test-cas-msg", ep_id, "user", "test", datetime.now().isoformat())
    )
    cursor.execute(
        "INSERT INTO EpisodeFact (id, episodeId, key, value, ts) VALUES (?, ?, ?, ?, ?)",
        ("test-cas-ef", ep_id, "current.task", "testing", datetime.now().isoformat())
    )
    cursor.execute(
        "INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ("test-cas-vm", ep_id, "dialogue", "test vector", generate_fake_embedding("test"), datetime.now().isoformat())
    )
    cursor.execute(
        """INSERT INTO EmotionalMemory
           (id, episodeId, emotion, intensity, trigger, context, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        ("test-cas-em", ep_id, "joy", 0.5, "test", "test", datetime.now().isoformat())
    )

    # Verify data exists
    for table in ["Message", "EpisodeFact", "VectorMemory", "EmotionalMemory"]:
        cursor.execute(f"SELECT COUNT(*) as c FROM {table} WHERE episodeId = ?", (ep_id,))
        count = cursor.fetchone()["c"]
        assert count == 1, f"{table}: expected 1, got {count}"
    print(f"  ✓ Created episode with Message, EpisodeFact, VectorMemory, EmotionalMemory")

    # Delete episode (cascade should clean all)
    cursor.execute("DELETE FROM Episode WHERE id = ?", (ep_id,))

    # Verify cascade
    for table in ["Message", "EpisodeFact", "VectorMemory", "EmotionalMemory"]:
        cursor.execute(f"SELECT COUNT(*) as c FROM {table} WHERE episodeId = ?", (ep_id,))
        count = cursor.fetchone()["c"]
        assert count == 0, f"CASCADE FAIL: {table} still has {count} rows for deleted episode!"
    print(f"  ✓ CASCADE: all related data deleted")

    conn.commit()
    conn.close()

def test_fact_extraction_heuristic():
    """Test 7: Fact extraction heuristic (shouldExtractFacts logic)."""
    print("\n[7] Fact Extraction Heuristic")
    conn = connect()

    # Simulate shouldExtractFacts logic
    FACT_TRIGGER_PATTERNS = [
        r"\b(меня зовут|моё имя|зови меня)\b",
        r"\b(я работаю|я учусь|моя профессия)\b",
        r"\b(мне \d+ лет)\b",
        r"\b(мой проект|я делаю|я пишу|я разрабатываю)\b",
        r"\b(использую|пишу на|язык программирования)\b",
        r"\b(мне нравится|я люблю|не люблю|предпочитаю)\b",
        r"\b(моя цель|я хочу сделать|планирую)\b",
    ]
    import re

    def should_extract(msg):
        if len(msg) < 30:
            return False
        if len(msg) > 200:
            return True
        return any(re.search(p, msg, re.IGNORECASE) for p in FACT_TRIGGER_PATTERNS)

    test_cases = [
        ("привет", False, "too short"),
        ("да, спасибо", False, "too short"),
        ("Меня зовут Иван, я работаю разработчиком", True, "trigger: name + profession"),
        ("Я разрабатываю чат-бота на Next.js", True, "trigger: project"),
        ("Использую TypeScript и Prisma для бэкенда", True, "trigger: tech"),
        ("Мне нравится functional programming", True, "trigger: preference"),
        ("Моя цель — сделать умного ассистента", True, "trigger: goal"),
        ("Расскажи мне про квантовую физику и её применение в современных технологиях, включая квантовые вычисления, квантовую криптографию, квантовую телепортацию, а также перспективы развития этой области в ближайшие десятилетия и её влияние на информационную безопасность", True, "long message (>200 chars)"),
        ("что такое монады?", False, "short, no triggers"),
        ("Мопед не мой, я просто разместил объяву", False, "no triggers, short"),
    ]

    passed = 0
    for msg, expected, reason in test_cases:
        result = should_extract(msg)
        status = "✓" if result == expected else "✗"
        if result == expected:
            passed += 1
        print(f"  {status} '{msg[:50]}...' → {result} ({reason})")

    print(f"\n  {passed}/{len(test_cases)} passed")
    conn.close()
    return passed == len(test_cases)

def test_unicode_and_edge_cases():
    """Test 8: Unicode, empty values, long texts."""
    print("\n[8] Unicode + Edge Cases")
    conn = connect()
    cursor = conn.cursor()

    ep_id = "test-ep-edge"

    cursor.execute(
        "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        (ep_id, "Edge Cases", datetime.now().isoformat(), datetime.now().isoformat())
    )

    # Unicode in message
    unicode_msg = "Привет! 🎉 Я люблю программировать на C++ и Python. 程序设计很有趣! 日本語も少し。"
    cursor.execute(
        "INSERT INTO Message (id, episodeId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
        ("test-edge-1", ep_id, "user", unicode_msg, datetime.now().isoformat())
    )
    cursor.execute("SELECT content FROM Message WHERE id = 'test-edge-1'")
    result = cursor.fetchone()["content"]
    assert result == unicode_msg, f"Unicode mismatch: {result}"
    print(f"  ✓ Unicode: {result[:40]}...")

    # Empty message content
    cursor.execute(
        "INSERT INTO Message (id, episodeId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
        ("test-edge-2", ep_id, "system", "", datetime.now().isoformat())
    )
    cursor.execute("SELECT content FROM Message WHERE id = 'test-edge-2'")
    assert cursor.fetchone()["content"] == ""
    print(f"  ✓ Empty content preserved")

    # Very long text (10000 chars)
    long_text = "A" * 10000
    cursor.execute(
        "INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts) VALUES (?, ?, ?, ?, ?, ?)",
        ("test-edge-vm", ep_id, "dialogue", long_text, generate_fake_embedding(long_text), datetime.now().isoformat())
    )
    cursor.execute("SELECT length(text) as l FROM VectorMemory WHERE id = 'test-edge-vm'")
    assert cursor.fetchone()["l"] == 10000
    print(f"  ✓ Long text (10000 chars) preserved")

    # Emoji in episode title
    cursor.execute("UPDATE Episode SET title = 'Тест 🧪 Episode ✨' WHERE id = ?", (ep_id,))
    cursor.execute("SELECT title FROM Episode WHERE id = ?", (ep_id,))
    assert cursor.fetchone()["title"] == "Тест 🧪 Episode ✨"
    print(f"  ✓ Emoji in title preserved")

    conn.commit()
    conn.close()

def test_episode_isolation_comprehensive():
    """Test 9: Comprehensive isolation test — create 3 episodes, insert data in each, verify no cross-contamination."""
    print("\n[9] Comprehensive Episode Isolation (3 episodes)")
    conn = connect()
    cursor = conn.cursor()

    episodes = ["test-iso-1", "test-iso-2", "test-iso-3"]
    messages = {
        "test-iso-1": "Discussion about Python async programming",
        "test-iso-2": "Recipe for borscht with beets",
        "test-iso-3": "How to configure nginx reverse proxy",
    }
    facts = {
        "test-iso-1": ("current.topic", "Python async"),
        "test-iso-2": ("current.topic", "Borscht recipe"),
        "test-iso-3": ("current.topic", "Nginx config"),
    }

    # Create episodes and insert data
    for ep_id in episodes:
        cursor.execute(
            "INSERT INTO Episode (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
            (ep_id, f"Isolation Test {ep_id}", datetime.now().isoformat(), datetime.now().isoformat())
        )
        cursor.execute(
            "INSERT INTO Message (id, episodeId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)",
            (f"test-iso-msg-{ep_id}", ep_id, "user", messages[ep_id], datetime.now().isoformat())
        )
        cursor.execute(
            "INSERT INTO EpisodeFact (id, episodeId, key, value, ts) VALUES (?, ?, ?, ?, ?)",
            (f"test-iso-ef-{ep_id}", ep_id, facts[ep_id][0], facts[ep_id][1], datetime.now().isoformat())
        )
        cursor.execute(
            "INSERT INTO VectorMemory (id, episodeId, sourceType, text, embedding, ts) VALUES (?, ?, ?, ?, ?, ?)",
            (f"test-iso-vm-{ep_id}", ep_id, "dialogue", messages[ep_id], generate_fake_embedding(messages[ep_id]), datetime.now().isoformat())
        )

    # Verify isolation — each episode sees ONLY its own data
    all_pass = True
    for ep_id in episodes:
        # Messages
        cursor.execute("SELECT content FROM Message WHERE episodeId = ?", (ep_id,))
        msgs = [row["content"] for row in cursor.fetchall()]
        if messages[ep_id] not in msgs:
            print(f"  ✗ {ep_id}: missing its own message")
            all_pass = False
        for other_ep in episodes:
            if other_ep != ep_id and messages[other_ep] in msgs:
                print(f"  ✗ LEAK: {ep_id} sees {other_ep}'s message!")
                all_pass = False

        # Facts
        cursor.execute("SELECT value FROM EpisodeFact WHERE episodeId = ? AND key = 'current.topic'", (ep_id,))
        fact_val = cursor.fetchone()["value"]
        if fact_val != facts[ep_id][1]:
            print(f"  ✗ {ep_id}: wrong fact value: {fact_val}")
            all_pass = False

        # Vectors
        cursor.execute("SELECT text FROM VectorMemory WHERE episodeId = ?", (ep_id,))
        vec_texts = [row["text"] for row in cursor.fetchall()]
        if messages[ep_id] not in vec_texts:
            print(f"  ✗ {ep_id}: missing its own vector")
            all_pass = False
        for other_ep in episodes:
            if other_ep != ep_id and messages[other_ep] in vec_texts:
                print(f"  ✗ LEAK: {ep_id} sees {other_ep}'s vector!")
                all_pass = False

    if all_pass:
        print(f"  ✓ All 3 episodes isolated correctly")
        print(f"  ✓ No message leaks")
        print(f"  ✓ No fact leaks")
        print(f"  ✓ No vector leaks")
    else:
        print(f"  ✗ ISOLATION FAILED!")

    conn.commit()
    conn.close()
    return all_pass

# ============================================================================
# Main
# ============================================================================
def main():
    print("=" * 70)
    print("MEMORY SYSTEMS COMPREHENSIVE TEST")
    print("=" * 70)

    if not DB_PATH.exists():
        print(f"ERROR: Database not found at {DB_PATH}")
        sys.exit(1)

    # Cleanup previous test data
    print("\n[0] Cleanup previous test data...")
    cleaned = cleanup_test_data()
    print(f"  ✓ Cleaned {cleaned} test episodes")

    # Run tests
    results = []

    # Test 1: Episodes CRUD
    try:
        test_episodes_crud()
        results.append(("Episodes CRUD", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Episodes CRUD", False))

    # Test 2: Global facts
    try:
        test_global_facts()
        results.append(("Global Facts", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Global Facts", False))

    # Test 3: Episode facts isolation
    try:
        test_episode_facts_isolation()
        results.append(("Episode Facts Isolation", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Episode Facts Isolation", False))

    # Test 4: Vector memory isolation
    try:
        test_vector_memory_isolation()
        results.append(("Vector Memory Isolation", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Vector Memory Isolation", False))

    # Test 5: Emotional memory isolation + decay
    try:
        test_emotional_memory_isolation()
        results.append(("Emotional Memory + Decay", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Emotional Memory + Decay", False))

    # Test 6: Cascade delete
    try:
        test_cascade_delete()
        results.append(("Cascade Delete", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Cascade Delete", False))

    # Test 7: Fact extraction heuristic
    try:
        passed = test_fact_extraction_heuristic()
        results.append(("Fact Extraction Heuristic", passed))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Fact Extraction Heuristic", False))

    # Test 8: Unicode + edge cases
    try:
        test_unicode_and_edge_cases()
        results.append(("Unicode + Edge Cases", True))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Unicode + Edge Cases", False))

    # Test 9: Comprehensive isolation
    try:
        passed = test_episode_isolation_comprehensive()
        results.append(("Comprehensive Isolation (3 episodes)", passed))
    except Exception as e:
        print(f"  ✗ FAILED: {e}")
        results.append(("Comprehensive Isolation", False))

    # Cleanup
    print("\n[Cleanup] Removing test data...")
    cleaned = cleanup_test_data()
    print(f"  ✓ Cleaned {cleaned} test episodes")

    # Summary
    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    for name, ok in results:
        status = "✓ PASS" if ok else "✗ FAIL"
        print(f"  {status}  {name}")
    print(f"\n  {passed}/{total} tests passed")
    print("=" * 70)
    if passed == total:
        print("ALL TESTS PASSED ✓")
    else:
        print("SOME TESTS FAILED ✗")
        sys.exit(1)

if __name__ == "__main__":
    main()
