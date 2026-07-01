"""
FastAPI server for Lia RL sidecar.

Endpoints:
    GET  /health           — basic health check
    GET  /stats            — transition count, model versions
    GET  /models           — list saved policy versions
    POST /train            — train a new policy version (blocking, ~30 sec)

The Next.js side calls /train to schedule training and uses the exported ONNX
file for runtime inference (via onnxruntime-node) — no HTTP roundtrip per
action.

Security: endpoints защищены API key (X-Sidecar-Key header).
Ключ задаётся через env LIA_SIDECAR_API_KEY на обеих сторонах.
Если env не установлен — sidecar отказывается запускаться (fail-closed).
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from rl.db import count_transitions, load_transitions, resolve_db_path
from rl.model import LiaPolicyNetwork, load_model
from rl.train import TrainConfig, train, TrainResult


# ============================================================================
# App setup
# ============================================================================
app = FastAPI(
    title="Lia RL Sidecar",
    description="Training + inference for Lia's RL policy",
    version="1.0.0",
)

# ============================================================================
# Auth — API key via X-Sidecar-Key header.
# Ключ задаётся через env LIA_SIDECAR_API_KEY на обеих сторонах (sidecar + Next.js).
# Если env не установлен — fail-closed (запрещаем запуск).
# ============================================================================
SIDECAR_API_KEY = os.environ.get("LIA_SIDECAR_API_KEY")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Проверка X-Sidecar-Key на всех endpoint'ах кроме /health.

    /health остаётся открытым — он нужен для liveness probe без auth.
    """
    if request.url.path == "/health":
        return await call_next(request)

    if not SIDECAR_API_KEY:
        # Fail-closed: если ключ не задан, sidecor непригоден.
        return JSONResponse(
            status_code=503,
            content={"detail": "LIA_SIDECAR_API_KEY not set — sidecar misconfigured"},
        )

    provided = request.headers.get("X-Sidecar-Key", "")
    if provided != SIDECAR_API_KEY:
        return JSONResponse(
            status_code=401,
            content={"detail": "invalid or missing X-Sidecar-Key"},
        )

    return await call_next(request)


# CORS — allow the Next.js side (localhost:3000) to call us
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Models dir — relative to this file (python-sidecar/)
# ============================================================================
MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)


# ============================================================================
# Request / response schemas
# ============================================================================
class TrainRequest(BaseModel):
    """Trigger a training run."""
    n_epochs: int = 10
    learning_rate: float = 3e-4
    batch_size: int = 64
    parent_version: Optional[int] = None
    db_path: Optional[str] = None


class PredictRequest(BaseModel):
    """Run inference (debug only — production uses ONNX in Next.js)."""
    state: list[float]
    version: Optional[int] = None  # None = latest


class PredictResponse(BaseModel):
    action: int
    action_name: str
    confidence: float
    value: float
    version: int


class ModelInfo(BaseModel):
    version: int
    pt_path: str
    onnx_path: str
    size_pt_kb: float
    size_onnx_kb: float
    created_at: float


class StatsResponse(BaseModel):
    transitions_count: int
    model_versions: list[ModelInfo]
    active_version: Optional[int]
    db_path: str


# ============================================================================
# Routes
# ============================================================================
@app.get("/health")
async def health():
    return {"ok": True, "service": "lia-rl-sidecar"}


@app.get("/stats", response_model=StatsResponse)
async def stats():
    db_path = resolve_db_path()
    transitions = count_transitions()
    models = list_models()
    active = get_active_version()
    return StatsResponse(
        transitions_count=transitions,
        model_versions=models,
        active_version=active,
        db_path=db_path,
    )


@app.get("/models", response_model=list[ModelInfo])
async def models():
    return list_models()


@app.post("/train", response_model=TrainResult)
async def train_endpoint(req: TrainRequest):
    try:
        config = TrainConfig(
            n_epochs=req.n_epochs,
            learning_rate=req.learning_rate,
            batch_size=req.batch_size,
            output_dir=str(MODELS_DIR),
        )
        result = train(
            config=config,
            db_path=req.db_path,
            parent_version=req.parent_version,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Training failed: {e}")


@app.post("/predict", response_model=PredictResponse, include_in_schema=False)
async def predict(req: PredictRequest):
    """Debug inference endpoint. Production uses ONNX in Next.js.

    Endpoint оставлен для отладки, но скрыт из OpenAPI schema.
    Защищён тем же X-Sidecar-Key, что и остальные endpoint'ы.
    """
    if not req.state:
        raise HTTPException(status_code=400, detail="state required")

    # Find the model
    version = req.version or get_active_version() or get_latest_version()
    if version is None:
        raise HTTPException(status_code=404, detail="No trained models found")

    pt_path = MODELS_DIR / f"policy_v{version}.pt"
    if not pt_path.exists():
        raise HTTPException(status_code=404, detail=f"Model v{version} not found")

    import torch
    model = load_model(str(pt_path))
    state_tensor = torch.tensor(req.state, dtype=torch.float32)
    action, confidence = model.predict(state_tensor)

    # Get value too — value head of the policy network.
    value = 0.0
    with contextlib.suppress(Exception):
        _, value_tensor = model(state_tensor.unsqueeze(0))
        value = float(value_tensor.item())

    from rl.model import DEFAULT_ACTIONS
    return PredictResponse(
        action=action,
        action_name=DEFAULT_ACTIONS[action] if action < len(DEFAULT_ACTIONS) else f"ACTION_{action}",
        confidence=confidence,
        value=value,
        version=version,
    )


# ============================================================================
# Helpers
# ============================================================================
def list_models() -> list[ModelInfo]:
    """List all saved policy versions."""
    models = []
    for f in MODELS_DIR.glob("policy_v*.pt"):
        # Parse version from filename
        try:
            version = int(f.stem.split("_v")[1])
        except (IndexError, ValueError):
            continue

        onnx_path = MODELS_DIR / f"policy_v{version}.onnx"
        pt_stat = f.stat()
        onnx_stat = onnx_path.stat() if onnx_path.exists() else None

        models.append(ModelInfo(
            version=version,
            pt_path=str(f),
            onnx_path=str(onnx_path) if onnx_path.exists() else "",
            size_pt_kb=pt_stat.st_size / 1024,
            size_onnx_kb=onnx_stat.st_size / 1024 if onnx_stat else 0,
            created_at=pt_stat.st_mtime,
        ))

    models.sort(key=lambda m: m.version)
    return models


def get_latest_version() -> Optional[int]:
    """Get the latest model version number."""
    models = list_models()
    return models[-1].version if models else None


def get_active_version() -> Optional[int]:
    """
    Get the active model version — stored in the Setting table as
    'rl_active_version'. Falls back to latest if not set.

    Phase 5.1: PRAGMA busy_timeout для консистентности с rl/db.py.
    """
    import sqlite3
    db_path = resolve_db_path()
    if not os.path.exists(db_path):
        return None
    try:
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA busy_timeout = 5000")
        try:
            cursor = conn.execute(
                "SELECT value FROM Setting WHERE key = 'rl_active_version'"
            )
            row = cursor.fetchone()
            return int(row[0]) if row else None
        finally:
            conn.close()
    except Exception:
        return None


# ============================================================================
# Main
# ============================================================================
if __name__ == "__main__":
    if not SIDECAR_API_KEY:
        # Fail-closed: без ключа sidecar бесполезен и небезопасен.
        raise SystemExit(
            "LIA_SIDECAR_API_KEY env var is required. "
            "Set it to a random string and configure the same value on the Next.js side."
        )
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8765,
        reload=False,  # disable reload in production
    )
