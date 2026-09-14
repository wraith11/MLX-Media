"""
Lightweight API server for MFLUX-WEBUI (SD WebUI-style + async job API).
Endpoints:
- POST /sdapi/v1/txt2img
- POST /sdapi/v1/img2img
- POST /sdapi/v1/controlnet
- POST /api/upscale             (simple factor-based upscaling)
- POST /api/v1/generate         (async job submission)
- GET  /api/v1/jobs             (list jobs)
- GET  /api/v1/jobs/{id}        (job status)
- GET  /api/v1/jobs/{id}/stream (SSE stream)
- DELETE /api/v1/jobs/{id}      (cancel job)
- GET  /api/v1/health
- GET  /api/v1/models
- GET  /api/v1/photo-imports/config
- POST /api/v1/photo-imports/inventory
- POST /api/v1/photo-batches/plan
- GET  /api/v1/video/capabilities
- GET  /api/v1/video/status
- GET  /api/v1/system
- GET  /api/v1/queue
- GET  /api/v1/stats

Launch: python -m backend.api_server [host] [port]
Default: host=127.0.0.1, port=7861
"""

import base64
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import os
import mimetypes
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = 7861
DEFAULT_MODEL = "flux2-klein-4b"
_CURRENT_MODEL = None
WEBUI_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
_MAX_JSON_BODY_BYTES = 64 * 1024 * 1024

# Regex patterns for path-parameter routes
_RE_JOB_STREAM = re.compile(r"^/api/v1/jobs/([a-f0-9]+)/stream$")
_RE_JOB_DETAIL = re.compile(r"^/api/v1/jobs/([a-f0-9]+)$")
_RE_VIDEO_ARTIFACT = re.compile(
_RE_BYTE_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")

# State for the one-time video runner provisioning (triggered from the UI).
_VIDEO_SETUP_STATE = {
    "running": False,
    "done": False,
    "error": None,
    "tail": [],
    "started_at": None,
}
_VIDEO_SETUP_LOCK = threading.Lock()
    r"^/api/v1/video/artifacts/([a-f0-9]+)/([A-Za-z0-9][A-Za-z0-9._-]*)$"
)
_RE_BYTE_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _current_model():
    """Return the currently selected model, falling back to the first available."""
    global _CURRENT_MODEL
    if _CURRENT_MODEL:
        return _CURRENT_MODEL
    try:
        from backend.model_manager import get_updated_models

        available = get_updated_models()
        if DEFAULT_MODEL in available:
            _CURRENT_MODEL = DEFAULT_MODEL
        elif available:
            _CURRENT_MODEL = available[0]
        else:
            _CURRENT_MODEL = DEFAULT_MODEL
    except Exception:
        _CURRENT_MODEL = DEFAULT_MODEL
    return _CURRENT_MODEL


def _set_current_model(model_name: str | None):
    global _CURRENT_MODEL
    if not model_name:
        return
    _CURRENT_MODEL = model_name


def _resolve_model_from_payload(data: dict) -> str:
    """
    Open WebUI may send either `model` or the SD-WebUI compatible
    `sd_model_checkpoint`, sometimes nested in override_settings. Prefer
    explicit request and fall back to the selected model.
    """
    requested = data.get("model") or data.get("sd_model_checkpoint")
    override_settings = data.get("override_settings") or {}
    requested = requested or override_settings.get("sd_model_checkpoint")
    if isinstance(requested, str) and requested.strip():
        return requested.strip()
    return _current_model()


def _list_models_payload():
    """
    Return SD WebUI style model descriptors for available aliases.
    """
    models = []
    try:
        from backend.model_manager import get_custom_model_config, get_updated_models

        aliases = get_updated_models()
    except Exception:
        aliases = [DEFAULT_MODEL]

    for alias in aliases:
        try:
            cfg = get_custom_model_config(alias)
            model_name = cfg.model_name
            base_arch = cfg.base_arch
        except Exception:
            model_name = alias
            base_arch = ""
        models.append(
            {
                "title": alias,
                "model_name": model_name,
                "hash": "",
                "sha256": "",
                "filename": alias,
                "config": base_arch,
            }
        )
    return models


def _bad_request(handler, message, status=400):
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": message}).encode("utf-8"))
    except BrokenPipeError:
        pass


def _json_response(handler, payload, status=200):
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.end_headers()
        handler.wfile.write(json.dumps(payload, default=str).encode("utf-8"))
    except BrokenPipeError:
        pass


def _photo_import_access_allowed(handler) -> bool:
    """Control access to private photo/video routes.

    By default these stay loopback-only to protect local metadata. Set the
    environment variable ``MFLUX_ALLOW_LAN=1`` (which ``setup.sh`` enables when
    the host is reachable on the network) to allow access from other devices on
    the LAN.
    """
    if os.environ.get("MFLUX_ALLOW_LAN", "0") == "1":
        return True

    try:
        address = str(handler.client_address[0]).split("%", 1)[0]
        if not ipaddress.ip_address(address).is_loopback:
            return False
    except (ValueError, IndexError, TypeError):
        return False

    host = handler.headers.get("Host")
    if not host:
        return False
    parsed_host = urlparse(f"//{host}")
    if parsed_host.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return False

    origin = handler.headers.get("Origin")
    if not origin:
        return True
    parsed = urlparse(origin)
    return parsed.scheme in {"http", "https"} and parsed.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }


def _photo_json_response(handler, payload, status=200):
    """JSON response that never grants cross-origin access to non-local sites."""
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        origin = handler.headers.get("Origin")
        if origin and _photo_import_access_allowed(handler):
            handler.send_header("Access-Control-Allow-Origin", origin)
            handler.send_header("Vary", "Origin")
        handler.end_headers()
        handler.wfile.write(json.dumps(payload, default=str).encode("utf-8"))
    except BrokenPipeError:
        pass


def _encode_pil_to_base64(image):
    buff = BytesIO()
    image.save(buff, format="PNG")
    return base64.b64encode(buff.getvalue()).decode("utf-8")


def _decode_base64_image(data_b64):
    from PIL import Image

    if data_b64 is None:
        raise ValueError("No image provided")
    if "," in data_b64:
        data_b64 = data_b64.split(",", 1)[1]
    raw = base64.b64decode(data_b64)
    return Image.open(BytesIO(raw)).convert("RGB")


def _save_temp_image(img) -> str:
    fd, path = tempfile.mkstemp(suffix=".png")
    with os.fdopen(fd, "wb") as f:
        img.save(f, format="PNG")
    return path


class APIServer(BaseHTTPRequestHandler):

    def handle(self):
        """Override to suppress BrokenPipeError tracebacks from disconnected clients."""
        try:
            super().handle()
        except BrokenPipeError:
            pass

    # ── CORS ────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        path = urlparse(self.path).path
        if path.startswith(("/api/v1/photo-imports", "/api/v1/photo-batches", "/api/v1/video")):
            if not _photo_import_access_allowed(self):
                return _photo_json_response(self, {"error": "Local access only."}, status=403)
            self.send_response(204)
            origin = self.headers.get("Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    # ── GET routing ─────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if not path.startswith("/api/") and not path.startswith("/sdapi/"):
            return self.handle_webui(path)

        # Existing SD WebUI endpoints
        if path == "/sdapi/v1/options":
            return self.handle_options()
        if path == "/sdapi/v1/sd-models":
            return self.handle_models()

        # New v1 endpoints
        if path == "/api/v1/health":
            return self.handle_health()
        if path == "/api/v1/models":
            return self.handle_v1_models()
        if path == "/api/v1/vlm/status":
            return self.handle_vlm_status()
        if path == "/api/v1/video/setup/status":
            return self.handle_video_setup_status()
        if path == "/api/v1/photo-imports/config":
            return self.handle_photo_import_config()
        if path == "/api/v1/video/capabilities":
            return self.handle_video_capabilities()
        if path == "/api/v1/video/status":
            return self.handle_video_status()
        if path == "/api/v1/system":
            return self.handle_system()
        if path == "/api/v1/providers/nativ":
            return self.handle_nativ_status()
        if path == "/api/v1/queue":
            return self.handle_queue()
        if path == "/api/v1/stats":
            return self.handle_stats()
        if path == "/api/v1/jobs":
            return self.handle_list_jobs()

        # Path-parameter routes
        m = _RE_JOB_STREAM.match(path)
        if m:
            return self.handle_job_stream(m.group(1))
        m = _RE_JOB_DETAIL.match(path)
        if m:
            return self.handle_get_job(m.group(1))
        m = _RE_VIDEO_ARTIFACT.match(path)
        if m:
            return self.handle_video_artifact(m.group(1), m.group(2))

        return _bad_request(self, "Unknown endpoint", status=404)

    def handle_webui(self, path: str):
        """Serve the built React studio, falling back to its SPA entrypoint."""
        if not WEBUI_DIST.exists():
            return _json_response(self, {
                "status": "studio-not-built",
                "message": "Build frontend with npm run build in frontend/."
            }, status=503)
        candidate = (WEBUI_DIST / path.lstrip("/")).resolve()
        if not str(candidate).startswith(str(WEBUI_DIST.resolve())) or not candidate.is_file():
            candidate = WEBUI_DIST / "index.html"
        content_type, _ = mimetypes.guess_type(candidate.name)
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Cache-Control", "no-cache" if candidate.name == "index.html" else "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(candidate.read_bytes())
        except (OSError, BrokenPipeError):
            return

    # ── POST routing ────────────────────────────────────────────────

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        legacy_media_handlers = {
            "/sdapi/v1/txt2img": self.handle_txt2img,
            "/sdapi/v1/img2img": self.handle_img2img,
            "/sdapi/v1/inpaint": self.handle_inpaint,
            "/sdapi/v1/controlnet": self.handle_controlnet,
            "/api/upscale": self.handle_upscale,
        }
        legacy_handler = legacy_media_handlers.get(path)
        if legacy_handler is not None:
            from backend.job_manager import get_media_generation_lock

            with get_media_generation_lock():
                return legacy_handler()
        if path == "/sdapi/v1/options":
            return self.handle_options_update()
        if path == "/api/v1/generate":
            return self.handle_generate()
        if path == "/api/v1/mask-from-text":
            return self.handle_mask_from_text()
        if path == "/api/v1/vlm/download":
            return self.handle_vlm_download()
        if path == "/api/v1/video/setup":
            return self.handle_video_setup()
        if path == "/api/v1/photo-imports/inventory":
            return self.handle_photo_import_inventory()
        if path == "/api/v1/photo-batches/plan":
            return self.handle_photo_batch_plan()

        return _bad_request(self, "Unknown endpoint", status=404)

    # ── DELETE routing ──────────────────────────────────────────────

    def do_DELETE(self):
        parsed = urlparse(self.path)
        m = _RE_JOB_DETAIL.match(parsed.path)
        if m:
            return self.handle_cancel_job(m.group(1))
        return _bad_request(self, "Unknown endpoint", status=404)

    # ── Shared helpers ──────────────────────────────────────────────

    def _read_json(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length < 0 or content_length > _MAX_JSON_BODY_BYTES:
                raise ValueError("JSON request body is too large")
            body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            return json.loads(body.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Invalid JSON: {exc}") from exc

    # ── Existing SD WebUI handlers (unchanged) ──────────────────────

    def handle_txt2img(self):
        from backend.flux_manager import generate_image_gradio

        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        prompt = data.get("prompt")
        if not prompt:
            return _bad_request(self, "prompt is required")

        model = _resolve_model_from_payload(data)
        seed = data.get("seed")
        width = int(data.get("width", 576))
        height = int(data.get("height", 1024))
        # Accept common aliases.
        steps = str(data.get("steps") or data.get("num_inference_steps") or "")  # blank => default per model
        guidance = float(data.get("guidance") or data.get("guidance_scale") or 3.5)
        num_images = int(data.get("num_images", 1))
        auto_seeds = bool(data.get("auto_seeds", False))
        lora_files = data.get("lora_files") or None
        lora_scales = data.get("lora_scales") or []
        if lora_scales is None:
            lora_scales = []
        if not isinstance(lora_scales, list):
            lora_scales = [lora_scales]
        low_ram = bool(data.get("low_ram", False))

        try:
            images, info, used_prompt = generate_image_gradio(
                prompt,
                model,
                None,
                seed,
                width,
                height,
                steps,
                guidance,
                lora_files,
                False,
                None,
                None,
                None,
                None,
                None,
                False,
                1,
                *lora_scales,
                num_images=num_images,
                low_ram=low_ram,
                auto_seeds=auto_seeds,
            )
        except Exception as exc:  # noqa: BLE001
            return _bad_request(self, f"Generation failed: {exc}", status=500)

        if not images:
            return _bad_request(self, info or "No images were generated successfully", status=500)

        encoded_images = [_encode_pil_to_base64(img) for img in images]
        response = {
            "images": encoded_images,
            "parameters": data,
            "info": info or "",
            "prompt": used_prompt,
        }
        return _json_response(self, response)

    def handle_img2img(self):
        from backend.flux_manager import generate_image_i2i_gradio

        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        prompt = data.get("prompt")
        init_images = data.get("init_images") or data.get("images") or []
        if not prompt or not init_images:
            return _bad_request(self, "prompt and init_images are required")
        try:
            init_img = _decode_base64_image(init_images[0])
        except Exception as exc:
            return _bad_request(self, f"Invalid init image: {exc}")

        model = _resolve_model_from_payload(data)
        seed = data.get("seed")
        width = int(data.get("width", init_img.width))
        height = int(data.get("height", init_img.height))
        steps = str(data.get("steps") or data.get("num_inference_steps") or "")
        guidance = float(data.get("guidance") or data.get("guidance_scale") or 3.5)
        num_images = int(data.get("num_images", 1))
        auto_seeds = bool(data.get("auto_seeds", False))
        image_strength = float(data.get("image_strength") or data.get("denoising_strength") or 0.4)
        lora_files = data.get("lora_files") or None
        lora_scales = data.get("lora_scales") or []
        if lora_scales is None:
            lora_scales = []
        if not isinstance(lora_scales, list):
            lora_scales = [lora_scales]
        low_ram = bool(data.get("low_ram", False))

        try:
            images, info, used_prompt = generate_image_i2i_gradio(
                prompt,
                init_img,
                model,
                None,
                seed,
                height,
                width,
                steps,
                guidance,
                image_strength,
                lora_files,
                False,
                None,
                None,
                None,
                False,
                1,
                *lora_scales,
                num_images=num_images,
                low_ram=low_ram,
            )
        except Exception as exc:  # noqa: BLE001
            return _bad_request(self, f"Img2Img failed: {exc}", status=500)

        if not images:
            return _bad_request(self, info or "No images were generated successfully", status=500)

        encoded_images = [_encode_pil_to_base64(img) for img in images]
        response = {
            "images": encoded_images,
            "parameters": data,
            "info": info or "",
            "prompt": used_prompt,
        }
        return _json_response(self, response)

    def handle_inpaint(self):
        from backend.fill_manager import generate_fill_gradio

        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        prompt = data.get("prompt")
        init_images = data.get("init_images") or data.get("images") or []
        mask_b64 = data.get("mask") or data.get("mask_image") or data.get("masks")
        if not prompt or not init_images:
            return _bad_request(self, "prompt and init_images are required")
        if not mask_b64:
            return _bad_request(self, "mask is required (white = regenerate region)")
        try:
            init_img = _decode_base64_image(init_images[0])
            mask_img = _decode_base64_image(mask_b64).convert("L")
        except Exception as exc:
            return _bad_request(self, f"Invalid image or mask: {exc}")

        width = int(data.get("width", init_img.width))
        height = int(data.get("height", init_img.height))
        steps = data.get("steps") or data.get("num_inference_steps") or 25
        guidance = float(data.get("guidance") or data.get("guidance_scale") or 30.0)
        num_images = int(data.get("num_images", 1))
        low_ram = bool(data.get("low_ram", False))
        seed = data.get("seed")
        if seed is None:
            seed = "random"
        elif not isinstance(seed, str):
            seed = str(seed)

        try:
            images, info, used_prompt = generate_fill_gradio(
                prompt,
                init_img,
                mask_img,
                None,
                seed,
                height,
                width,
                steps,
                guidance,
                False,
                num_images=num_images,
                low_ram=low_ram,
            )
        except Exception as exc:  # noqa: BLE001
            return _bad_request(self, f"Inpaint failed: {exc}", status=500)

        if not images:
            return _bad_request(self, info or "No images were generated successfully", status=500)

        encoded_images = [_encode_pil_to_base64(img) for img in images]
        response = {
            "images": encoded_images,
            "parameters": data,
            "info": info or "",
            "prompt": used_prompt,
        }
        return _json_response(self, response)
    def handle_controlnet(self):
        from backend.flux_manager import generate_image_controlnet_gradio

        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        prompt = data.get("prompt")
        cn_images = data.get("controlnet_image") or data.get("controlnet_images") or data.get("init_images")
        if not prompt or not cn_images:
            return _bad_request(self, "prompt and controlnet_image are required")
        try:
            controlnet_img = _decode_base64_image(cn_images[0])
        except Exception as exc:
            return _bad_request(self, f"Invalid controlnet image: {exc}")

        model = _resolve_model_from_payload(data)
        seed = data.get("seed")
        width = int(data.get("width", controlnet_img.width))
        height = int(data.get("height", controlnet_img.height))
        steps = str(data.get("steps") or data.get("num_inference_steps") or "")
        guidance = float(data.get("guidance") or data.get("guidance_scale") or 3.5)
        controlnet_strength = float(data.get("controlnet_strength", 0.4))
        lora_files = data.get("lora_files") or None
        lora_scales = data.get("lora_scales") or []
        if lora_scales is None:
            lora_scales = []
        if not isinstance(lora_scales, list):
            lora_scales = [lora_scales]
        low_ram = bool(data.get("low_ram", False))

        try:
            images, info, used_prompt = generate_image_controlnet_gradio(
                prompt,
                controlnet_img,
                model,
                None,
                seed,
                height,
                width,
                steps,
                guidance,
                controlnet_strength,
                lora_files,
                False,  # metadata
                False,  # save_canny
                None,
                None,
                None,
                False,
                1,
                *lora_scales,
                num_images=1,
                low_ram=low_ram,
            )
        except Exception as exc:  # noqa: BLE001
            return _bad_request(self, f"ControlNet failed: {exc}", status=500)

        if not images:
            return _bad_request(self, info or "No images were generated successfully", status=500)

        encoded_images = [_encode_pil_to_base64(img) for img in images]
        response = {
            "images": encoded_images,
            "parameters": data,
            "info": info or "",
            "prompt": used_prompt,
        }
        return _json_response(self, response)

    def handle_upscale(self):
        from backend import upscale_manager

        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        image_b64 = data.get("image")
        if not image_b64:
            return _bad_request(self, "image is required (base64)")
        try:
            img = _decode_base64_image(image_b64)
        except Exception as exc:
            return _bad_request(self, f"Invalid image: {exc}")

        factor = data.get("upscale_factor", 2)
        output_format = data.get("output_format", "PNG").upper()
        metadata = bool(data.get("metadata", False))

        try:
            temp_path = _save_temp_image(img)
            upscaled, status = upscale_manager.upscale_image_gradio(
                input_image=temp_path,
                upscale_factor=factor,
                output_format=output_format,
                metadata=metadata,
            )
        except Exception as exc:  # noqa: BLE001
            return _bad_request(self, f"Upscale failed: {exc}", status=500)

        if upscaled is None:
            return _bad_request(self, status or "Upscale failed", status=500)

        encoded_image = _encode_pil_to_base64(upscaled)
        response = {
            "images": [encoded_image],
            "info": status or "",
            "parameters": data,
        }
        return _json_response(self, response)

    def handle_options(self):
        """
        Minimal SD WebUI-compatible options endpoint so clients like Open WebUI
        can validate connectivity.
        """
        options = {
            "sd_model_checkpoint": _current_model(),
            "sd_model_checkpoint_hash": "",
            "sd_vae": "auto",
            "CLIP_stop_at_last_layers": 2,
            "inpainting_fill": 1,
        }
        return _json_response(self, options)

    def handle_nativ_status(self):
        """Expose only a local provider health/model summary to the studio."""
        from backend.nativ_provider import status
        return _json_response(self, status())

    def handle_options_update(self):
        """
        Accept SD WebUI-style options updates (primarily model selection).
        """
        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        requested_model = data.get("sd_model_checkpoint")
        if requested_model:
            _set_current_model(str(requested_model))

        # Return updated options snapshot
        return self.handle_options()

    def handle_models(self):
        """
        Minimal model list endpoint for compatibility.
        """
        return _json_response(self, _list_models_payload())

    # ── New async job endpoints ─────────────────────────────────────

    def handle_generate(self):
        """POST /api/v1/generate - submit an async generation job."""
        from backend.api_models import APIError, JobType
        from backend.job_manager import get_job_manager

        try:
            data = self._read_json()
        except Exception as exc:
            return _json_response(self, {
                "error": APIError(
                    code=APIError.INVALID_JSON,
                    message=str(exc),
                ).to_dict()
            }, status=400)

        if not isinstance(data, dict):
            return _json_response(self, {
                "error": APIError(
                    code=APIError.INVALID_JSON,
                    message="JSON body must be an object.",
                ).to_dict()
            }, status=400)

        raw_type = data.get("type", "txt2img")
        try:
            job_type = JobType(raw_type)
        except ValueError:
            return _json_response(self, {
                "error": APIError(
                    code=APIError.INVALID_PARAM,
                    message=f"Unknown job type: {raw_type}",
                ).to_dict()
            }, status=400)

        prompt = data.get("prompt", "")
        if job_type in (JobType.txt2img, JobType.img2img, JobType.controlnet, JobType.inpaint) and not prompt:
            return _json_response(self, {
                "error": APIError(
                    code=APIError.MISSING_PARAM,
                    message="prompt is required",
                ).to_dict()
            }, status=400)

        response = _json_response
        if job_type == JobType.photo_batch:
            if not _photo_import_access_allowed(self):
                return _photo_json_response(self, {"error": "Local access only."}, status=403)
            from backend.photo_batch import PhotoBatchValidationError, prepare_photo_batch

            try:
                plan = prepare_photo_batch(data)
            except (PhotoBatchValidationError, ValueError) as exc:
                return _photo_json_response(self, {"error": str(exc)}, status=400)
            data = dict(data)
            data["_photo_batch_plan"] = plan
            data["num_images"] = plan["num_images"]
            response = _photo_json_response
        elif job_type == JobType.video:
            if not _photo_import_access_allowed(self):
                return _photo_json_response(self, {"error": "Local access only."}, status=403)
            from backend.video_runner import VideoValidationError, prepare_video_request

            try:
                plan = prepare_video_request(data)
            except (VideoValidationError, ValueError) as exc:
                return _photo_json_response(self, {"error": str(exc)}, status=400)
            data = dict(data)
            data["_video_plan"] = plan
            data["num_images"] = 1
            response = _photo_json_response

        mgr = get_job_manager()
        job = mgr.submit_job(job_type, data)
        payload = {
            "job_id": job.id,
            "status": job.status.value,
            "type": job.job_type.value,
        }
        if job_type == JobType.photo_batch:
            payload.update({
                "batch_id": plan["batch_id"],
                "output_relative_directory": plan["output_relative_directory"],
            })
        elif job_type == JobType.video:
            payload.update({
                "capability_id": plan["capability_id"],
                "operation": plan["operation"],
            })
        return response(self, payload, status=202)

    def handle_mask_from_text(self):
        """
        POST /api/v1/mask-from-text
        Body: { "image": "<base64>", "text": "<Objektbeschreibung>", "model": "<vlm>" }
        Uses an MLX vision-language model to locate the described object and
        returns a mask image (white bbox region on black) plus the detected box.
        Falls back to a centered ellipse guess if no VLM is available.
        """
        from backend.api_server import _decode_base64_image, _encode_pil_to_base64

        try:
            data = self._read_json()
        except Exception as exc:
            return _bad_request(self, str(exc))

        image_b64 = data.get("image")
        text = (data.get("text") or data.get("prompt") or "").strip()
        if not image_b64:
            return _bad_request(self, "image is required (base64)")
        if not text:
            return _bad_request(self, "text is required (object to locate)")

        from PIL import Image, ImageDraw

        try:
            img = _decode_base64_image(image_b64)
        except Exception as exc:
            return _bad_request(self, f"Invalid image: {exc}")

        w, h = img.size
        box = None
        used_model = None

        try:
            from backend import mlx_vlm_manager as vlm

            model_name = data.get("model") or ""
            if not model_name:
                available = vlm.get_available_mlx_vlm_models()
                model_name = available[0] if available else vlm.DEFAULT_VLM

            if model_name:
                used_model = model_name
                # Auto-download if not already in the local HF cache.
                if not vlm.vlm_is_installed(model_name):
                    print(f"Mask-from-text: downloading VLM {model_name} …")
                    vlm.download_vlm(model_name)
                model, processor, config = vlm.load_mlx_model(model_name)
                if model is not None and processor is not None:
                    prompt = (
                        f"Locate the object: \"{text}\". "
                        "Answer with ONLY four numbers separated by commas: "
                        "x1,y1,x2,y2 as normalized coordinates 0..1 bounding box "
                        "around that object in the image."
                    )
                    out = vlm.generate_with_model(
                        model=model,
                        processor=processor,
                        config=config,
                        prompt=prompt,
                        images=[image_b64],
                        max_tokens=64,
                        temperature=0.0,
                    )
                    box = self._parse_bbox(out)
        except Exception as exc:  # noqa: BLE001
            print(f"Mask-from-text VLM failed, using fallback: {exc}")
            box = None

        if not box:
            # Fallback: centered ellipse covering ~70% of the image.
            cx, cy = w / 2.0, h / 2.0
            rx, ry = w * 0.35, h * 0.35
            box_px = (cx - rx, cy - ry, cx + rx, cy + ry)
        else:
            # _parse_bbox returns normalized 0..1 coords -> scale to pixels.
            box_px = (box[0] * w, box[1] * h, box[2] * w, box[3] * h)

        # Build mask: white ellipse inside the box on a black canvas.
        mask = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse([box_px[0], box_px[1], box_px[2], box_px[3]], fill=255)

        return _json_response(self, {
            "mask": _encode_pil_to_base64(mask),
            "box": [float(b) for b in box_px],
            "width": w,
            "height": h,
            "model_used": used_model,
        })

    @staticmethod
    def _parse_bbox(text: str):
        """Best-effort parse of 'x1,y1,x2,y2' (normalized 0..1) from VLM output."""
        if not text:
            return None
        import re

        # Collect all numbers, prefer four in a row (possibly with decimals).
        nums = re.findall(r"-?\d*\.?\d+", text)
        if len(nums) < 4:
            return None
        try:
            vals = [float(n) for n in nums[:4]]
        except ValueError:
            return None
        x1, y1, x2, y2 = vals
        if not (0.0 <= x1 <= 1.0 and 0.0 <= y1 <= 1.0) or not (0.0 <= x2 <= 1.0 and 0.0 <= y2 <= 1.0):
            return None
        return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
    def handle_vlm_status(self):
        """GET /api/v1/vlm/status - which (if any) MLX VLM is installed."""
        from backend import mlx_vlm_manager as vlm
        return _json_response(self, vlm.vlm_status())

    def handle_vlm_download(self):
        """POST /api/v1/vlm/download - download a recommended MLX VLM."""
        from backend import mlx_vlm_manager as vlm

        try:
            data = self._read_json()
        except Exception:
            data = {}
        model = (data.get("model") or "").strip() or vlm.DEFAULT_VLM

        try:
            result = vlm.download_vlm(model)
        except Exception as exc:  # noqa: BLE001
            return _bad_request(self, f"VLM download failed: {exc}", status=500)
        return _json_response(self, result)

    def _video_setup_runner(self):
        """Run the pinned provisioner in the background and record its output."""
        from backend import video_runner

        repo_root = Path(__file__).resolve().parents[1]
        script = repo_root / "scripts" / "setup_mlx_video_runner.py"
        command = [sys.executable, str(script), "provision"]
        env = dict(os.environ)
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(repo_root),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            for line in proc.stdout:
                with _VIDEO_SETUP_LOCK:
                    _VIDEO_SETUP_STATE["tail"].append(line.rstrip("\n"))
                    if len(_VIDEO_SETUP_STATE["tail"]) > 500:
                        _VIDEO_SETUP_STATE["tail"] = _VIDEO_SETUP_STATE["tail"][-500:]
            code = proc.wait()
            with _VIDEO_SETUP_LOCK:
                _VIDEO_SETUP_STATE["running"] = False
                _VIDEO_SETUP_STATE["done"] = code == 0
                if code != 0:
                    _VIDEO_SETUP_STATE["error"] = f"Provisioner exited with code {code}."
        except Exception as exc:  # noqa: BLE001
            with _VIDEO_SETUP_LOCK:
                _VIDEO_SETUP_STATE["running"] = False
                _VIDEO_SETUP_STATE["done"] = True
                _VIDEO_SETUP_STATE["error"] = str(exc)

    def handle_video_setup(self):
        """POST /api/v1/video/setup - start the one-time video runner provisioning."""
        from backend.api_models import APIError

        with _VIDEO_SETUP_LOCK:
            if _VIDEO_SETUP_STATE["running"]:
                return _json_response(self, {
                    "error": APIError(
                        code="VIDEO_SETUP_BUSY",
                        message="Video provisioning is already running.",
                    ).to_dict()
                }, status=409)
            _VIDEO_SETUP_STATE.update(
                running=True, done=False, error=None, tail=[], started_at=time.time()
            )
        threading.Thread(target=self._video_setup_runner, daemon=True).start()
        return _json_response(self, {
            "status": "started",
            "running": True,
        }, status=202)

    def handle_video_setup_status(self):
        """GET /api/v1/video/setup/status - poll provisioning progress."""
        with _VIDEO_SETUP_LOCK:
            state = dict(_VIDEO_SETUP_STATE)
        return _json_response(self, state)

    def handle_get_job(self, job_id: str):
        """GET /api/v1/jobs/{id} - get job status."""
        from backend.api_models import APIError
        from backend.job_manager import get_job_manager

        mgr = get_job_manager()
        job = mgr.get_job(job_id)
        if job is None:
            return _json_response(self, {
                "error": APIError(
                    code=APIError.JOB_NOT_FOUND,
                    message=f"Job {job_id} not found",
                ).to_dict()
            }, status=404)
        if job.job_type.value in {"photo_batch", "video"} and not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)
        responder = _photo_json_response if job.job_type.value in {"photo_batch", "video"} else _json_response
        return responder(self, job.to_dict())

    def handle_job_stream(self, job_id: str):
        """GET /api/v1/jobs/{id}/stream - SSE event stream."""
        from backend.api_models import APIError
        from backend.job_manager import get_job_manager
        from backend.sse_handler import stream_job_events

        mgr = get_job_manager()
        job = mgr.get_job(job_id)
        if job is None:
            return _json_response(self, {
                "error": APIError(
                    code=APIError.JOB_NOT_FOUND,
                    message=f"Job {job_id} not found",
                ).to_dict()
            }, status=404)
        if job.job_type.value in {"photo_batch", "video"} and not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)
        stream_job_events(self, job)

    def handle_cancel_job(self, job_id: str):
        """DELETE /api/v1/jobs/{id} - cancel a job."""
        from backend.api_models import APIError
        from backend.job_manager import get_job_manager

        mgr = get_job_manager()
        existing = mgr.get_job(job_id)
        if existing is not None and existing.job_type.value in {"photo_batch", "video"}:
            if not _photo_import_access_allowed(self):
                return _photo_json_response(self, {"error": "Local access only."}, status=403)
        job = mgr.cancel_job(job_id)
        if job is None:
            return _json_response(self, {
                "error": APIError(
                    code=APIError.JOB_NOT_FOUND,
                    message=f"Job {job_id} not found",
                ).to_dict()
            }, status=404)
        responder = _photo_json_response if job.job_type.value in {"photo_batch", "video"} else _json_response
        return responder(self, {
            "job_id": job.id,
            "status": job.status.value,
        })

    def handle_list_jobs(self):
        """GET /api/v1/jobs - list all jobs."""
        from backend.job_manager import get_job_manager

        mgr = get_job_manager()
        jobs = mgr.list_jobs()
        if not _photo_import_access_allowed(self):
            jobs = [job for job in jobs if job.job_type.value not in {"photo_batch", "video"}]
        return _json_response(self, {
            "jobs": [j.to_dict() for j in jobs],
        })

    # ── System info endpoints ───────────────────────────────────────

    def handle_health(self):
        """GET /api/v1/health"""
        return _json_response(self, {
            "status": "ok",
            "timestamp": time.time(),
        })

    def handle_photo_import_config(self):
        """GET local photo-import limits and privacy defaults."""
        if not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)

        from backend.photo_imports import get_photo_import_config

        return _photo_json_response(self, get_photo_import_config())

    def handle_photo_import_inventory(self):
        """POST a local directory inventory without altering source photos."""
        if not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)

        from backend.photo_imports import PhotoImportValidationError, inventory_photos

        try:
            data = self._read_json()
            if not isinstance(data, dict):
                raise PhotoImportValidationError("JSON body must be an object.")
            result = inventory_photos(
                data.get("directory"),
                recursive=data.get("recursive", True),
                gps_mode=data.get("gps_mode", "suggest"),
                location_overrides=data.get("location_overrides"),
            )
        except (PhotoImportValidationError, ValueError) as exc:
            return _photo_json_response(self, {"error": str(exc)}, status=400)
        return _photo_json_response(self, result)

    def handle_photo_batch_plan(self):
        """Validate and preview a deterministic local SeedVR2 batch."""
        if not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)

        from backend.photo_batch import (
            PhotoBatchValidationError,
            prepare_photo_batch,
            public_photo_batch_plan,
        )

        try:
            data = self._read_json()
            if not isinstance(data, dict):
                raise PhotoBatchValidationError("JSON body must be an object.")
            result = public_photo_batch_plan(prepare_photo_batch(data))
        except (PhotoBatchValidationError, ValueError) as exc:
            return _photo_json_response(self, {"error": str(exc)}, status=400)
        return _photo_json_response(self, result)

    def handle_video_capabilities(self):
        """GET the exact locally-supported video capability registry."""
        if not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)

        from backend.video_runner import get_video_capabilities

        return _photo_json_response(self, get_video_capabilities())

    def handle_video_status(self):
        """GET isolated video runner readiness and the active serialized media job."""
        if not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)

        from backend.api_models import JobStatus
        from backend.job_manager import get_job_manager
        from backend.video_runner import get_video_runtime_status

        active = next(
            (
                {"id": job.id, "type": job.job_type.value}
                for job in get_job_manager().list_jobs()
                if job.status == JobStatus.running
                and job.job_type.value in {"photo_batch", "video"}
            ),
            None,
        )
        return _photo_json_response(self, get_video_runtime_status(active_media_job=active))

    def handle_video_artifact(self, job_id: str, filename: str):
        """Serve one validated local video artifact without exposing filesystem paths."""
        if not _photo_import_access_allowed(self):
            return _photo_json_response(self, {"error": "Local access only."}, status=403)

        from backend.video_runner import VideoValidationError, resolve_video_artifact

        try:
            artifact = resolve_video_artifact(job_id, filename)
            size = artifact.stat().st_size
        except (VideoValidationError, FileNotFoundError, OSError) as exc:
            return _photo_json_response(self, {"error": str(exc)}, status=404)

        content_type, _ = mimetypes.guess_type(artifact.name)
        start = 0
        end = size - 1
        response_status = 200
        requested_range = self.headers.get("Range")
        if requested_range:
            match = _RE_BYTE_RANGE.fullmatch(requested_range.strip())
            if not match or "," in requested_range:
                return self._video_range_not_satisfiable(size)
            first, last = match.groups()
            if not first and not last:
                return self._video_range_not_satisfiable(size)
            try:
                if not first:
                    suffix_length = int(last)
                    if suffix_length <= 0:
                        return self._video_range_not_satisfiable(size)
                    start = max(0, size - suffix_length)
                else:
                    start = int(first)
                    if last:
                        end = min(int(last), size - 1)
                if start < 0 or start >= size or end < start:
                    return self._video_range_not_satisfiable(size)
            except ValueError:
                return self._video_range_not_satisfiable(size)
            response_status = 206

        content_length = end - start + 1
        try:
            self.send_response(response_status)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Length", str(content_length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Accept-Ranges", "bytes")
            if response_status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            origin = self.headers.get("Origin")
            if origin and _photo_import_access_allowed(self):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            with artifact.open("rb") as source:
                source.seek(start)
                remaining = content_length
                while remaining > 0 and (chunk := source.read(min(1024 * 1024, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, OSError):
            pass

    def _video_range_not_satisfiable(self, size: int):
        self.send_response(416)
        self.send_header("Content-Range", f"bytes */{size}")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def handle_v1_models(self):
        """GET /api/v1/models - models with capabilities."""
        from backend.model_manager import get_custom_model_config, get_updated_models

        models = []
        try:
            aliases = get_updated_models()
        except Exception:
            aliases = [DEFAULT_MODEL]

        for alias in aliases:
            entry = {"name": alias, "capabilities": ["txt2img"]}
            try:
                cfg = get_custom_model_config(alias)
                entry["base_arch"] = cfg.base_arch
                entry["hf_name"] = cfg.model_name
                if cfg.base_arch not in ("flux2",):
                    entry["capabilities"].append("img2img")
                    entry["capabilities"].append("controlnet")
            except Exception:
                pass
            models.append(entry)
        return _json_response(self, {"models": models})

    def handle_system(self):
        """GET /api/v1/system - memory, active model, queue depth."""
        from backend.job_manager import get_job_manager

        info = {
            "active_model": _current_model(),
            "queue_depth": get_job_manager().queue_depth(),
        }
        try:
            import mlx.core as mx
            get_active = getattr(mx, "get_active_memory", None) or mx.metal.get_active_memory
            get_peak = getattr(mx, "get_peak_memory", None) or mx.metal.get_peak_memory
            info["memory"] = {
                "active_mb": round(get_active() / 1e6, 2),
                "peak_mb": round(get_peak() / 1e6, 2),
            }
        except Exception:
            info["memory"] = None
        return _json_response(self, info)

    def handle_queue(self):
        """GET /api/v1/queue"""
        from backend.job_manager import get_job_manager
        from backend.api_models import JobStatus

        mgr = get_job_manager()
        jobs = mgr.list_jobs()
        if not _photo_import_access_allowed(self):
            jobs = [job for job in jobs if job.job_type.value not in {"photo_batch", "video"}]
        pending = [j.to_dict() for j in jobs if j.status == JobStatus.queued]
        running = [j.to_dict() for j in jobs if j.status == JobStatus.running]
        return _json_response(self, {
            "pending": pending,
            "pending_count": len(pending),
            "running": running,
            "running_count": len(running),
        })

    def handle_stats(self):
        """GET /api/v1/stats"""
        from backend.job_manager import get_job_manager

        return _json_response(self, get_job_manager().get_stats())


def run_server(host: str = HOST, port: int = PORT):
    server = ThreadingHTTPServer((host, port), APIServer)
    print(f"API server running on http://{host}:{port} (txt2img/img2img/controlnet/upscale + async /api/v1)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down API server...")
        server.server_close()


if __name__ == "__main__":
    host = HOST
    port = PORT
    if len(sys.argv) >= 2:
        host = sys.argv[1]
    if len(sys.argv) >= 3:
        port = int(sys.argv[2])
    run_server(host, port)
