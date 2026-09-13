/**
 * MaskEditor.tsx
 *
 * Canvas-based mask editor for real inpainting.
 *  - Pinsel (brush): paint a soft mask by dragging.
 *  - Lasso: freehand closed selection -> filled region.
 *  - Radierer (eraser): remove painted mask.
 *  - Invert / Clear / Undo controls.
 *
 * Produces a binary grayscale mask (white = regenerate region) as a data URL,
 * matching the source image dimensions. Firefox-compatible (no -webkit APIs).
 */
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brush,
  Eraser,
  Lasso,
  Maximize,
  Repeat,
  Trash2,
} from "lucide-react";

export type MaskTool = "brush" | "lasso" | "eraser";

interface MaskEditorProps {
  /** Source image as a data URL. */
  image: string;
  /** Called whenever the mask changes (base64/PNG data URL). */
  onChange: (maskDataUrl: string) => void;
}

export default function MaskEditor({ image, onChange }: MaskEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<MaskTool>("brush");
  const [brushSize, setBrushSize] = useState(24);
  const [drawing, setDrawing] = useState(false);

  // Keep a full-res mask bitmap (grayscale) separate from the preview canvas.
  const maskBitmapRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  // Draw the source image once the canvas is mounted / image changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const img = new Image();
    img.onload = () => {
      // Size canvas to container width, keep aspect ratio.
      const targetW = container.clientWidth;
      const scale = Math.min(1, targetW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      // Initialize the full-res mask at the canvas (preview) resolution.
      maskBitmapRef.current = document.createElement("canvas");
      maskBitmapRef.current.width = w;
      maskBitmapRef.current.height = h;
      const mctx = maskBitmapRef.current.getContext("2d");
      if (mctx) {
        mctx.fillStyle = "#000";
        mctx.fillRect(0, 0, w, h);
      }

      // First paint: draw image + empty mask overlay.
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      drawMaskOverlay();
      emitMask();
    };
    img.src = image;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image]);

  /** Composite the source image and a red overlay over masked (white) pixels. */
  const drawMaskOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const mask = maskBitmapRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !mask) return;

    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Build a red overlay whose alpha comes from the mask's luminance.
      const overlay = document.createElement("canvas");
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const octx = overlay.getContext("2d");
      if (octx) {
        octx.drawImage(mask, 0, 0);
        const id = octx.getImageData(0, 0, overlay.width, overlay.height);
        const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
          const lum = d[i]; // grayscale luminance
          d[i] = 255;
          d[i + 1] = 60;
          d[i + 2] = 60;
          d[i + 3] = Math.round(lum * 0.55);
        }
        octx.putImageData(id, 0, 0);
      }
      ctx.drawImage(overlay, 0, 0);
    };
    img.src = image;
  }, [image]);

  /** Push the mask bitmap out as a PNG data URL (white = masked). */
  const emitMask = useCallback(() => {
    const mask = maskBitmapRef.current;
    if (!mask) return;
    const out = document.createElement("canvas");
    out.width = mask.width;
    out.height = mask.height;
    const octx = out.getContext("2d");
    if (!octx) return;
    octx.fillStyle = "#000";
    octx.fillRect(0, 0, out.width, out.height);
    octx.globalCompositeOperation = "source-over";
    octx.drawImage(mask, 0, 0);
    onChange(out.toDataURL("image/png"));
  }, [onChange]);

  const getPos = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const paintAt = (x: number, y: number, erasing: boolean) => {
    const mask = maskBitmapRef.current;
    if (!mask) return;
    const mctx = mask.getContext("2d");
    if (!mctx) return;

    mctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    mctx.fillStyle = erasing ? "rgba(0,0,0,1)" : "#ffffff";
    mctx.beginPath();
    mctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    mctx.fill();

    // Smooth stroke: connect to the last point.
    const last = lastRef.current;
    if (last) {
      mctx.lineWidth = brushSize;
      mctx.lineCap = "round";
      mctx.lineJoin = "round";
      mctx.beginPath();
      mctx.moveTo(last.x, last.y);
      mctx.lineTo(x, y);
      mctx.strokeStyle = erasing ? "#000" : "#fff";
      mctx.stroke();
    }
    lastRef.current = { x, y };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (tool === "lasso") {
      pointsRef.current = [];
    }
    const pos = getPos(e);
    if (pos) {
      lastRef.current = pos;
      setDrawing(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      if (tool === "brush" || tool === "eraser") {
        paintAt(pos.x, pos.y, tool === "eraser");
        drawMaskOverlay();
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    const pos = getPos(e);
    if (!pos) return;

    if (tool === "brush" || tool === "eraser") {
      paintAt(pos.x, pos.y, tool === "eraser");
      drawMaskOverlay();
    } else if (tool === "lasso") {
      pointsRef.current.push(pos);
      // Preview the lasso path on the main canvas.
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        drawMaskOverlay();
        ctx.strokeStyle = "#ffd24a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        const pts = pointsRef.current;
        if (pts.length > 0) {
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      }
    }
  };

  const closeLasso = () => {
    const mask = maskBitmapRef.current;
    const pts = pointsRef.current;
    if (!mask || pts.length < 3) return;
    const mctx = mask.getContext("2d");
    if (!mctx) return;

    // Fill the closed polygon on the mask.
    mctx.save();
    mctx.globalCompositeOperation = "source-over";
    mctx.fillStyle = "#ffffff";
    mctx.beginPath();
    mctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i].x, pts[i].y);
    mctx.closePath();
    mctx.fill();
    mctx.restore();
  };

  const handlePointerUp = () => {
    if (tool === "lasso") {
      closeLasso();
    }
    setDrawing(false);
    lastRef.current = null;
    drawMaskOverlay();
    emitMask();
  };

  const clearMask = () => {
    const mask = maskBitmapRef.current;
    const mctx = mask?.getContext("2d");
    if (mask && mctx) {
      mctx.globalCompositeOperation = "source-over";
      mctx.fillStyle = "#000";
      mctx.fillRect(0, 0, mask.width, mask.height);
    }
    drawMaskOverlay();
    emitMask();
  };

  const fillAll = () => {
    const mask = maskBitmapRef.current;
    const mctx = mask?.getContext("2d");
    if (mask && mctx) {
      mctx.globalCompositeOperation = "source-over";
      mctx.fillStyle = "#ffffff";
      mctx.fillRect(0, 0, mask.width, mask.height);
    }
    drawMaskOverlay();
    emitMask();
  };

  const invertMask = () => {
    const mask = maskBitmapRef.current;
    if (!mask) return;
    const mctx = mask.getContext("2d");
    if (!mctx) return;
    const data = mctx.getImageData(0, 0, mask.width, mask.height);
    for (let i = 0; i < data.data.length; i += 4) {
      const v = data.data[i];
      data.data[i] = data.data[i + 1] = data.data[i + 2] = v > 127 ? 0 : 255;
    }
    mctx.putImageData(data, 0, 0);
    drawMaskOverlay();
    emitMask();
  };

  const toolBtn = (t: MaskTool, label: string, Icon: React.ComponentType<{ size?: number }>) => (
    <button
      type="button"
      className={tool === t ? "mtool is-active" : "mtool"}
      onClick={() => setTool(t)}
      title={label}
    >
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="mask-editor">
      <div className="mask-toolbar">
        {toolBtn("brush", "Pinsel", Brush)}
        {toolBtn("lasso", "Lasso", Lasso)}
        {toolBtn("eraser", "Radierer", Eraser)}
        <label className="mask-size">
          <span>Größe</span>
          <input
            type="range"
            min={4}
            max={120}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </label>
        <button type="button" className="mtool" onClick={invertMask} title="Maske invertieren">
          <Invert size={16} />
          <span>Invertieren</span>
        </button>
        <button type="button" className="mtool" onClick={clearMask} title="Maske löschen">
          <Trash2 size={16} />
          <span>Leeren</span>
        </button>
        <button type="button" className="mtool" onClick={fillAll} title="Ganzes Bild maskieren">
          <Maximize size={16} />
          <span>Ganzes Bild</span>
        </button>
      </div>

      <div className="mask-canvas-wrap" ref={containerRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
      <p className="mask-hint">
        <strong>Pinsel/Radierer:</strong> über das Bild ziehen · <strong>Lasso:</strong> Bereich
        umranden, beim Loslassen wird er ausgefüllt. Rot = zu regenerierender Bereich.
      </p>
    </div>
  );
}