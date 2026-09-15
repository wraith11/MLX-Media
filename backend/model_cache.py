"""
model_cache.py
==============

Optional in-memory cache for loaded MLX models so the web UI does not have to
re-download/re-load a model on every job.

Design:
  - Models are kept in a small dict keyed by a canonical cache key.
  - Every access refreshes the ``last_used`` timestamp (LRU-ish).
  - A background thread unloads idle models once they exceed the configured
    timeout. ``timeout_minutes == 0`` means "keep loaded" (never auto-unload).
  - Before (re)loading a model we check available unified memory and refuse to
    load if there is not enough headroom (avoids OOM thrash).
  - The cache is fully optional: if ``enabled`` is False, the old behaviour
    (fresh instance + immediate cleanup per job) is preserved.
"""

from __future__ import annotations

import gc
import threading
import time
from typing import Any, Optional

from backend.mlx_utils import force_mlx_cleanup, print_memory_usage

# Defaults (can be overridden via env / API).
DEFAULT_ENABLED = False
DEFAULT_TIMEOUT_MINUTES = 10  # 0 = keep loaded forever
# Minimum free headroom (bytes) before we refuse to load another model.
MIN_FREE_HEADROOM_BYTES = 2 * 1024**3  # 2 GiB
# Rough per-model reservation when we cannot know the real size ahead of time.
UNKNOWN_MODEL_RESERVE_BYTES = 4 * 1024**3  # 4 GiB

_ENABLED = DEFAULT_ENABLED
_TIMEOUT_MINUTES = DEFAULT_TIMEOUT_MINUTES
_LOCK = threading.Lock()
_CACHE: dict[str, dict[str, Any]] = {}
_THREAD_STARTED = False


def _now() -> float:
    return time.time()


def get_config() -> dict:
    with _LOCK:
        return {
            "enabled": _ENABLED,
            "timeout_minutes": _TIMEOUT_MINUTES,
            "keep_loaded": _TIMEOUT_MINUTES == 0,
            "cached_models": [
                {
                    "key": k,
                    "model": v.get("model"),
                    "loaded_at": v.get("loaded_at"),
                    "last_used": v.get("last_used"),
                    "idle_minutes": round((_now() - v.get("last_used", _now())) / 60.0, 2),
                }
                for k, v in _CACHE.items()
            ],
        }


def set_config(*, enabled: Optional[bool] = None, timeout_minutes: Optional[int] = None) -> dict:
    global _ENABLED, _TIMEOUT_MINUTES
    with _LOCK:
        if enabled is not None:
            _ENABLED = bool(enabled)
            if not _ENABLED:
                _unload_all_locked()
        if timeout_minutes is not None:
            _TIMEOUT_MINUTES = max(0, int(timeout_minutes))
    _ensure_thread()
    return get_config()


def set_timeout_minutes(minutes: int) -> dict:
    return set_config(timeout_minutes=minutes)


def is_enabled() -> bool:
    return _ENABLED


def get_timeout_minutes() -> int:
    return _TIMEOUT_MINUTES


def _ensure_thread() -> None:
    global _THREAD_STARTED
    with _LOCK:
        if _THREAD_STARTED:
            return
        _THREAD_STARTED = True
    threading.Thread(target=_unload_loop, daemon=True).start()


def _unload_loop() -> None:
    while True:
        time.sleep(30)
        try:
            _unload_idle()
        except Exception:
            pass


def _unload_idle() -> None:
    with _LOCK:
        timeout = _TIMEOUT_MINUTES
        if timeout <= 0:
            return
        cutoff = _now() - timeout * 60
        stale = [k for k, v in _CACHE.items() if v.get("last_used", 0) < cutoff]
        for k in stale:
            _CACHE.pop(k, None)
    if stale:
        gc.collect()
        force_mlx_cleanup()
        print_memory_usage("After idle model unload")


def _unload_all_locked() -> None:
    _CACHE.clear()
    gc.collect()
    force_mlx_cleanup()


def unload_all() -> dict:
    with _LOCK:
        _unload_all_locked()
    return get_config()


def unload_key(key: str) -> dict:
    with _LOCK:
        _CACHE.pop(key, None)
    gc.collect()
    force_mlx_cleanup()
    return get_config()


def cache_key(*, model: str, quantize: Any, lora_key: str = "") -> str:
    return f"{model}::q{quantize}::lora:{lora_key}"


def get(model_key: str) -> Any:
    """Return a cached instance or None, refreshing its idle timer."""
    with _LOCK:
        entry = _CACHE.get(model_key)
        if entry is not None:
            entry["last_used"] = _now()
            return entry["instance"]
    return None


def put(model_key: str, instance: Any) -> Any:
    with _LOCK:
        _CACHE[model_key] = {
            "instance": instance,
            "model": model_key.split("::")[0],
            "loaded_at": _now(),
            "last_used": _now(),
        }
    _ensure_thread()
    return instance


def available_memory_bytes() -> Optional[int]:
    """Return free unified memory in bytes, or None if it cannot be read."""
    try:
        import mlx.core as mx

        get_mem = getattr(mx, "get_memory_info", None)
        if get_mem is not None:
            info = get_mem()
            free = info.get("free", info.get("available"))
            if free:
                return int(free)
    except Exception:
        pass
    return None


def enough_memory(required_bytes: Optional[int] = None) -> bool:
    """Check whether there is enough free unified memory to load a model."""
    required = required_bytes or UNKNOWN_MODEL_RESERVE_BYTES
    free = available_memory_bytes()
    if free is None:
        return True  # cannot measure -> allow (fail later with a clear message)
    return free >= required + MIN_FREE_HEADROOM_BYTES


def memory_status() -> dict:
    free = available_memory_bytes()
    return {
        "free_bytes": free,
        "free_gb": round(free / 1e9, 2) if free else None,
        "enough_for_new_model": enough_memory(),
        "required_reserve_gb": round((UNKNOWN_MODEL_RESERVE_BYTES + MIN_FREE_HEADROOM_BYTES) / 1e9, 2),
        "cached_models": len(_CACHE),
    }


# Start the unload thread lazily (it is harmless even when the cache is off).
_ensure_thread()