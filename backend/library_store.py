"""
library_store.py
=================

Durable, quota-free storage for generated/edited images.

Images are written as real files under ``output/library/<user>/`` and served
back by URL from the API. Only light metadata (id, prompt, timestamp, favorite)
is kept in a small JSON index per user. No base64 in the browser, no 5 MB
localStorage quota — images live on disk.

The directory layout is deliberately simple and per-user:
    output/library/<user>/index.json
    output/library/<user>/<id>.png
"""

from __future__ import annotations

import base64
import json
import time
import uuid
from pathlib import Path

_ROOT = Path("output") / "library"


def _user_dir(user: str) -> Path:
    safe = "".join(c for c in (user or "default") if c.isalnum() or c in "-_").strip() or "default"
    d = _ROOT / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def _index_path(user: str) -> Path:
    return _user_dir(user) / "index.json"


def _load_index(user: str) -> list[dict]:
    p = _index_path(user)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def _save_index(user: str, items: list[dict]) -> None:
    _index_path(user).write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")


def day_key_of(ts_ms: float) -> str:
    import datetime
    dt = datetime.datetime.fromtimestamp(ts_ms / 1000.0)
    return dt.strftime("%Y-%m-%d")


def _strip_data_prefix(data_url: str) -> str:
    if "," in data_url:
        return data_url.split(",", 1)[1]
    return data_url


def save_image(user: str, image_b64: str, prompt: str = "", favorite: bool = False) -> dict:
    """Persist an image (base64/data URL) to disk and return its record."""
    items = _load_index(user)
    img_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    try:
        raw = base64.b64decode(_strip_data_prefix(image_b64))
    except Exception as exc:
        raise ValueError(f"Invalid image data: {exc}") from exc

    file = _user_dir(user) / f"{img_id}.png"
    file.write_bytes(raw)

    now_ms = int(time.time() * 1000)
    rec = {
        "id": img_id,
        "prompt": prompt or "",
        "createdAt": now_ms,
        "favorite": bool(favorite),
        "url": f"/api/v1/library/file/{user}/{img_id}.png",
    }
    items.append(rec)
    # Cap the index (files stay on disk; only the visible list is bounded).
    _save_index(user, items[-300:])
    return rec


def list_images(user: str) -> list[dict]:
    return _load_index(user)


def get_image_path(user: str, img_id: str) -> Path | None:
    file = _user_dir(user) / f"{img_id}.png"
    if file.is_file():
        return file
    return None


def delete_image(user: str, img_id: str) -> bool:
    items = _load_index(user)
    before = len(items)
    items = [it for it in items if it["id"] != img_id]
    _save_index(user, items)
    file = _user_dir(user) / f"{img_id}.png"
    if file.exists():
        file.unlink()
    return len(items) != before


def set_favorite(user: str, img_id: str, favorite: bool) -> list[dict]:
    items = _load_index(user)
    for it in items:
        if it["id"] == img_id:
            it["favorite"] = bool(favorite)
    _save_index(user, items)
    return items


def delete_day(user: str, day_key: str) -> list[dict]:
    """Delete all images of a day, skipping favorites."""
    items = _load_index(user)
    keep = []
    removed_ids = []
    for it in items:
        if day_key_of(it.get("createdAt", 0)) == day_key and not it.get("favorite"):
            removed_ids.append(it["id"])
        else:
            keep.append(it)
    _save_index(user, keep)
    for img_id in removed_ids:
        file = _user_dir(user) / f"{img_id}.png"
        if file.exists():
            file.unlink()
    return keep