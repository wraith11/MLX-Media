/**
 * StudioPage.tsx
 *
 * Unified "Studio" workspace that merges generation, inpainting and the gallery
 * into one productive surface:
 *
 *   - LEFT   : generate a new image (prompt + size/count settings).
 *   - CENTER : the current image with masking tools (brush/lasso/eraser) on top.
 *   - RIGHT  : edit description. If a mask is set it is applied together with the
 *              text; if no mask is set, the backend locates the described object
 *              automatically (e.g. "den Hut durch eine Mütze ersetzen").
 *   - BELOW  : the gallery. Clicking an image loads it into the workspace.
 */
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  ImagePlus,
  Play,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import MaskEditor from "./MaskEditor";
import {
  base64ToDataUrl,
  dataUrlToBase64,
  fetchJob,
  isTerminal,
  maskFromText,
  submitGenerate,
  urlToDataUrl,
  type Job,
  type StoredImage,
} from "./mediaApi";

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="bar">
      <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Spinner() {
  return (
    <span className="spin" style={{ display: "inline-flex" }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" opacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" />
      </svg>
    </span>
  );
}

interface StudioPageProps {
  library: StoredImage[];
  onAddImage: (img: StoredImage) => void;
  onDeleteImage: (id: string) => void;
  onDeleteDay: (dayKey: string) => void;
  onToggleFavorite: (id: string) => void;
  notify: (msg: string) => void;
}

export default function StudioPage({
  library,
  onAddImage,
  onDeleteImage,
  onDeleteDay,
  onToggleFavorite,
  notify,
}: StudioPageProps) {
  // ── Generate state ──────────────────────────────────────────────
  const [genPrompt, setGenPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [numImages, setNumImages] = useState(1);
  const [genRunning, setGenRunning] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [genStage, setGenStage] = useState("");
  const genPollRef = useRef<number | null>(null);

  // ── Workspace (current image) state ─────────────────────────────
  const [current, setCurrent] = useState<string | null>(null);
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [mask, setMask] = useState<string | null>(null);
  // "manual" = user drew the mask; "auto" = system located the object via text.
  const [maskSource, setMaskSource] = useState<"manual" | "auto" | null>(null);

  // ── Generate advanced settings ──────────────────────────────────
  const [showGenAdvanced, setShowGenAdvanced] = useState(false);
  const [genSteps, setGenSteps] = useState<number | "">(4);
  const [genSeed, setGenSeed] = useState<number | "">("");
  const [genGuidance, setGenGuidance] = useState<number | "">(3.5);

  // ── Edit state ──────────────────────────────────────────────────
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editProgress, setEditProgress] = useState(0);
  const [editStage, setEditStage] = useState("");
  const [showEditAdvanced, setShowEditAdvanced] = useState(false);
  const [editSteps, setEditSteps] = useState<number | "">(4);
  const [editGuidance, setEditGuidance] = useState<number | "">("");
  const [editStrength, setEditStrength] = useState<number | "">(0.5);
  const editPollRef = useRef<number | null>(null);
  // Bump this to force the MaskEditor to remount and clear its painted mask.
  const [maskResetKey, setMaskResetKey] = useState(0);

  // Gallery UI state
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // Clear pollers on unmount.
  useEffect(() => {
    return () => {
      if (genPollRef.current !== null) window.clearInterval(genPollRef.current);
      if (editPollRef.current !== null) window.clearInterval(editPollRef.current);
    };
  }, []);

  const clearGenPoll = () => {
    if (genPollRef.current !== null) {
      window.clearInterval(genPollRef.current);
      genPollRef.current = null;
    }
  };
  const clearEditPoll = () => {
    if (editPollRef.current !== null) {
      window.clearInterval(editPollRef.current);
      editPollRef.current = null;
    }
  };

  /** Generate a brand new image and load it into the workspace. */
  const startGenerate = async () => {
    if (!genPrompt.trim() || genRunning) return;
    setGenRunning(true);
    setGenProgress(0);
    setGenStage("eingereiht…");
    try {
      const submitted = await submitGenerate({
        type: "txt2img",
        prompt: genPrompt.trim(),
        width,
        height,
        num_images: numImages,
        ...(genSteps !== "" ? { steps: genSteps } : {}),
        ...(genSeed !== "" ? { seed: genSeed } : {}),
        ...(genGuidance !== "" ? { guidance: genGuidance } : {}),
      });
      genPollRef.current = window.setInterval(async () => {
        let job: Job;
        try {
          job = await fetchJob(submitted.job_id);
        } catch {
          return;
        }
        setGenProgress(job.progress?.percent ?? 0);
        setGenStage(job.progress?.stage || job.status);
        if (isTerminal(job.status)) {
          clearGenPoll();
          setGenRunning(false);
          if (job.status === "completed" && job.result?.images?.length) {
            const out = base64ToDataUrl(job.result.images[0]);
            setCurrent(out);
            setCurrentPrompt(genPrompt.trim());
            setMask(null);
            setMaskSource(null);
            setMaskResetKey((k) => k + 1);
            onAddImage({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl: out,
              prompt: genPrompt.trim(),
              createdAt: Date.now(),
            });
            notify("Bild erzeugt.");
          } else {
            setGenStage(job.error?.message || "Fehlgeschlagen");
            notify(job.error?.message || "Generierung fehlgeschlagen.");
          }
        }
      }, 1000);
    } catch (err) {
      setGenRunning(false);
      setGenStage(err instanceof Error ? err.message : "Fehler");
      notify(err instanceof Error ? err.message : "Fehler");
    }
  };

  /** Apply an edit: manual mask + text, or auto-mask from text when none set. */
  const applyEdit = async () => {
    if (!current || editBusy) return;
    if (!editText.trim()) {
      notify("Bitte beschreibe die Änderung.");
      return;
    }
    setEditBusy(true);
    setEditProgress(0);
    setEditStage("eingereiht…");
    try {
      let effectiveMask = mask;
      if (!effectiveMask) {
        setEditStage("Suche Objekt…");
        try {
          const res = await maskFromText(current, editText.trim());
          effectiveMask = base64ToDataUrl(res.mask);
          setMask(effectiveMask);
          setMaskSource("auto");
        } catch {
          // Fall through: continue without mask (whole image).
          setMaskSource(null);
        }
      }
      const submitted = await submitGenerate({
        type: effectiveMask ? "inpaint" : "img2img",
        prompt: editText.trim(),
        init_images: [dataUrlToBase64(current)],
        ...(effectiveMask ? { mask: dataUrlToBase64(effectiveMask) } : {}),
        // img2img fallback (no mask) uses strength; inpaint (FLUX.1 Fill) uses guidance.
        ...(effectiveMask ? {} : { image_strength: editStrength !== "" ? editStrength : 0.5 }),
        ...(effectiveMask && editSteps === 4 ? {} : editSteps !== "" ? { steps: editSteps } : {}),
        ...(effectiveMask && editGuidance === "" ? { guidance: 30 } : editGuidance !== "" ? { guidance: editGuidance } : {}),
      });
      editPollRef.current = window.setInterval(async () => {
        let job: Job;
        try {
          job = await fetchJob(submitted.job_id);
        } catch {
          return;
        }
        setEditProgress(job.progress?.percent ?? 0);
        setEditStage(job.progress?.stage || job.status);
        if (isTerminal(job.status)) {
          clearEditPoll();
          setEditBusy(false);
          if (job.status === "completed" && job.result?.images?.length) {
            const out = base64ToDataUrl(job.result.images[0]);
            setCurrent(out);
            setCurrentPrompt(editText.trim());
            // Keep the mask so the user can iterate on further edits.
            onAddImage({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl: out,
              prompt: editText.trim(),
              createdAt: Date.now(),
            });
            notify("Bearbeitung fertig.");
          } else {
            setEditStage(job.error?.message || "Fehlgeschlagen");
            notify(job.error?.message || "Bearbeitung fehlgeschlagen.");
          }
        }
      }, 1200);
    } catch (err) {
      setEditBusy(false);
      setEditStage(err instanceof Error ? err.message : "Fehler");
      notify(err instanceof Error ? err.message : "Fehler");
    }
  };

  /** Load an image from the gallery into the workspace. */
  const loadFromGallery = async (item: StoredImage) => {
    let src = item.dataUrl;
    if (!src && item.url) {
      try {
        src = await urlToDataUrl(item.url);
      } catch {
        src = item.url;
      }
    }
    setCurrent(src || null);
    setCurrentPrompt(item.prompt);
    setMask(null);
    setMaskSource(null);
    setEditText("");
    setMaskResetKey((k) => k + 1);
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCurrent(String(reader.result));
      setCurrentPrompt("");
      setMask(null);
      setMaskSource(null);
      setEditText("");
      setMaskResetKey((k) => k + 1);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  /** User painted a mask manually -> mark it as manual so the UI/prompting is explicit. */
  const manualMaskChange = (m: string) => {
    // Determine if the mask is effectively empty (all black). The MaskEditor
    // fires onChange with an empty mask on mount/clear, which must NOT count as
    // a "manual mask".
    isMaskEmpty(m).then((empty) => {
      if (empty) {
        setMask(null);
        setMaskSource(null);
      } else {
        setMask(m);
        setMaskSource("manual");
      }
    });
  };

  /** Return true when a mask data URL has no (bright) painted pixels. */
  const isMaskEmpty = (dataUrl: string): Promise<boolean> =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(true);
          ctx.drawImage(img, 0, 0);
          // Sample a grid of pixels; if any is bright, the mask is not empty.
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < data.length; i += 40) {
            if (data[i] > 40) return resolve(false);
          }
          resolve(true);
        } catch {
          resolve(false);
        }
      };
      img.onerror = () => resolve(false);
      img.src = dataUrl;
    });

  const dayKey = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dayLabel = (key: string) => {
    const [y, m, dd] = key.split("-").map(Number);
    const date = new Date(y, m - 1, dd);
    return date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  };

  // Filter favorites and group by day (newest day first, newest image first within a day).
  const filtered = favoritesOnly ? library.filter((im) => im.favorite) : library;
  const grouped = filtered
    .slice()
    .reverse()
    .reduce<{ day: string; items: StoredImage[] }[]>((acc, item) => {
      const k = dayKey(item.createdAt);
      const last = acc[acc.length - 1];
      if (last && last.day === k) last.items.push(item);
      else acc.push({ day: k, items: [item] });
      return acc;
    }, []);

  return (
    <div className="page studio">
      <header className="page-head">
        <div>
          <span className="eyebrow">Image Studio</span>
          <h1>Bilder &amp; Bearbeitung</h1>
          <p>
            Neu generieren (links), Bereich markieren &amp; ändern (Mitte), Änderung
            beschreiben (rechts). Ohne Maske findet das System das Objekt automatisch.
          </p>
        </div>
      </header>

      <div className="studio-grid">
        {/* LEFT: generate */}
        <section className="panel studio-col studio-generate">
          <div className="section-title">Neu generieren</div>
          <div className="field">
            <span>Beschreibung</span>
            <textarea
              rows={6}
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="z.B. Eine Katze auf einem Berggipfel, goldenes Licht…"
            />
          </div>
          <div className="grid-2">
            <Field label="Breite">
              <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} min={256} max={2048} step={128} />
            </Field>
            <Field label="Höhe">
              <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} min={256} max={2048} step={128} />
            </Field>
          </div>
          <Field label="Anzahl">
            <input type="number" value={numImages} onChange={(e) => setNumImages(Math.max(1, Math.min(4, Number(e.target.value))))} min={1} max={4} />
          </Field>
          <button
            type="button"
            className="btn advanced-toggle"
            onClick={() => setShowGenAdvanced((v) => !v)}
          >
            Erweiterte Einstellungen {showGenAdvanced ? "▲" : "▼"}
          </button>
          {showGenAdvanced && (
            <div className="advanced-box">
              <div className="grid-2">
                <Field label={`Schritte: ${genSteps}`}>
                  <input type="number" value={genSteps} onChange={(e) => setGenSteps(e.target.value === "" ? 4 : Number(e.target.value))} min={1} max={50} />
                </Field>
                <Field label="Seed">
                  <input type="number" value={genSeed} onChange={(e) => setGenSeed(e.target.value === "" ? "" : Number(e.target.value))} min={0} placeholder="Zufällig" />
                </Field>
              </div>
              <Field label={`Guidance: ${genGuidance}`}>
                <input type="number" value={genGuidance} onChange={(e) => setGenGuidance(e.target.value === "" ? 3.5 : Number(e.target.value))} min={0} step={0.5} />
              </Field>
            </div>
          )}
          <div className="row-actions">
            <button className="btn btn-primary" onClick={startGenerate} disabled={genRunning || !genPrompt.trim()}>
              {genRunning ? <Spinner /> : <Play size={16} />} {genRunning ? "Generiere…" : "Generieren"}
            </button>
          </div>
          {genRunning && (
            <div className="progress-line">
              <ProgressBar percent={genProgress} />
              <span>{genStage}</span>
            </div>
          )}
        </section>

        {/* CENTER: current image + mask tools */}
        <section className="panel studio-col studio-canvas">
          <div className="studio-canvas-head">
            <div className="section-title">Aktuelles Bild</div>
          </div>

          {!current ? (
            <div className="empty-state" style={{ padding: 48 }}>
              <ImagePlus size={30} />
              <p>Generiere ein Bild oder wähle eines aus der Galerie.</p>
            </div>
          ) : (
            <div className="studio-canvas-inner">
              <div className="studio-mask-tools">
                <div className="studio-mask-head">
                  <span className="muted">Maske zeichnen:</span>
                  {maskSource === "manual" && <span className="mask-badge mask-badge-manual">Manuell</span>}
                  {maskSource === "auto" && <span className="mask-badge mask-badge-auto">Vom System</span>}
                </div>
                <MaskEditor key={maskResetKey} image={current} onChange={manualMaskChange} />
              </div>
              {currentPrompt && <div className="result-caption">{currentPrompt}</div>}
            </div>
          )}
        </section>

        {/* RIGHT: edit */}
        <section className="panel studio-col studio-edit">
          <div className="section-title">Ändern</div>
          <div className="field">
            <span>Was soll geändert werden?</span>
            <textarea
              rows={6}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder={
                mask
                  ? "z.B. eine Mütze, ein blauer Himmel…"
                  : "z.B. den Hut durch eine Mütze ersetzen, das Auto rot machen…"
              }
            />
          </div>
          <p className="mask-hint">
            {maskSource === "manual" && "Manuelle Maske gesetzt — nur der markierte Bereich wird neu gezeichnet."}
            {maskSource === "auto" && "Automatische Maske vom System — prüfe sie im Arbeitsbereich und passe sie bei Bedarf manuell an."}
            {!maskSource && "Keine Maske — das System versucht, das beschriebene Objekt zu finden. Wird nichts gefunden (z.B. „Setze dem Mann einen Hut auf“), wird das ganze Bild bearbeitet."}
          </p>
          <div className="row-actions">
            <button
              className="btn btn-primary"
              onClick={applyEdit}
              disabled={editBusy || !current || !editText.trim()}
            >
              {editBusy ? <Spinner /> : <Wand2 size={16} />}
              {editBusy ? "Bearbeite…" : "Anwenden"}
            </button>
            {mask && (
              <button className="btn" onClick={() => { setMask(null); setMaskSource(null); setMaskResetKey((k) => k + 1); }}>
                Maske löschen
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn advanced-toggle"
            onClick={() => setShowEditAdvanced((v) => !v)}
          >
            Erweiterte Einstellungen {showEditAdvanced ? "▲" : "▼"}
          </button>
          {showEditAdvanced && (
            <div className="advanced-box">
              <div className="grid-2">
                <Field label={`Schritte: ${editSteps}`}>
                  <input type="number" value={editSteps} onChange={(e) => setEditSteps(e.target.value === "" ? 4 : Number(e.target.value))} min={1} max={50} />
                </Field>
                <Field label={`Guidance: ${editGuidance}`}>
                  <input type="number" value={editGuidance} onChange={(e) => setEditGuidance(e.target.value === "" ? 30 : Number(e.target.value))} min={0} step={0.5} />
                </Field>
              </div>
              <Field label={`Stärke der Änderung: ${editStrength === "" ? "Standard" : `${Math.round(Number(editStrength) * 100)}%`}`}>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={editStrength === "" ? 0.5 : Number(editStrength)}
                  onChange={(e) => setEditStrength(Number(e.target.value))}
                />
              </Field>
              <p className="mask-hint">
                Maskiertes Inpainting nutzt FLUX.1-Fill (Guidance ~30). Die „Stärke der Änderung“
                gilt nur für die ganzflächige Bearbeitung ohne Maske.
              </p>
            </div>
          )}
          {editBusy && (
            <div className="progress-line">
              <ProgressBar percent={editProgress} />
              <span>{editStage}</span>
            </div>
          )}
        </section>
      </div>

      <label className="upload-tile">
        <Upload size={16} />
        <span>Bild hochladen (in den Arbeitsbereich)</span>
        <input type="file" accept="image/*" onChange={onUpload} />
      </label>
      {/* BELOW: gallery */}
      <section className="panel">
        <div className="gallery-head">
          <div className="section-title">Galerie · {filtered.length} Bild(er)</div>
          <label className="mask-toggle">
            <input type="checkbox" checked={favoritesOnly} onChange={(e) => setFavoritesOnly(e.target.checked)} />
            <span>★ Nur Favoriten</span>
          </label>
        </div>
        {filtered.length === 0 ? (
          <p className="muted">{favoritesOnly ? "Keine Favoriten markiert." : "Noch keine Bilder."}</p>
        ) : (
          <div className="studio-day-list">
            {grouped.map((group) => (
              <div className="studio-day" key={group.day}>
                <div className="studio-day-head">
                  <span className="studio-day-label">{dayLabel(group.day)}</span>
                  <button
                    className="btn btn-danger"
                    onClick={() => onDeleteDay(group.day)}
                    title="Alle Bilder dieses Tages löschen (Favoriten bleiben)"
                  >
                    <Trash2 size={13} /> Tag löschen
                  </button>
                </div>
                <div className="studio-gallery">
                  {group.items.map((item) => (
                    <div className={item.favorite ? "result-card is-fav" : "result-card"} key={item.id}>
                      <button className="gallery-img-btn" onClick={() => loadFromGallery(item)} title="In den Arbeitsbereich laden">
                        <img src={item.url ?? item.dataUrl} alt={item.prompt} />
                      </button>
                      <div className="gallery-star">
                        <button
                          className={item.favorite ? "star-btn is-active" : "star-btn"}
                          onClick={() => onToggleFavorite(item.id)}
                          title={item.favorite ? "Favorit — vor Löschen geschützt" : "Als Favorit markieren (schützt vor Löschen)"}
                        >
                          ★
                        </button>
                      </div>
                      <div className="result-actions">
                        <button className="btn" onClick={() => loadFromGallery(item)} title="Laden">
                          <Sparkles size={14} />
                        </button>
                        <a className="btn" href={item.url ?? item.dataUrl} download={`bild-${item.id}.png`} title="Speichern">
                          <Download size={14} />
                        </a>
                        <button
                          className="btn btn-danger"
                          onClick={() => onDeleteImage(item.id)}
                          disabled={item.favorite}
                          title={item.favorite ? "Favorit kann nicht gelöscht werden" : "Löschen"}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}