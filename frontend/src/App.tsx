/**
 * MLX Media — functional frontend (dev branch).
 *
 * Self-contained German UI. Talks to the local MLX backend through mediaApi.ts.
 * Features:
 *   - Bilder (create): prompt -> image with live progress
 *   - Bearbeiten (edit): edit an existing image via img2img ("entferne Hut")
 *   - Galerie (library): per-user generated images
 *   - Einstellungen (settings): model selection + backend status
 *   - Benutzer: lightweight per-user space stored in the browser
 *
 * No dependency on the old mock-only UI or the i18n dictionary, which keeps the
 * TypeScript build deterministic.
 */
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  ImagePlus,
  Images,
  LoaderCircle,
  Play,
  Plus,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  User,
  Users,
  Wand2,
  X,
} from "lucide-react";
import {
  base64ToDataUrl,
  dataUrlToBase64,
  downloadVlm,
  fetchJob,
  fetchModels,
  fetchSystem,
  fetchVlmStatus,
  isTerminal,
  maskFromText,
  submitGenerate,
  type Job,
  type ModelInfo,
  type SystemInfo,
  type VlmStatus,
} from "./mediaApi";
import MaskEditor from "./MaskEditor";

/* ── Per-user persistence ────────────────────────────────────────── */

const USERS_KEY = "mlx-media:users";
const ACTIVE_USER_KEY = "mlx-media:active-user";
const LIBRARY_PREFIX = "mlx-media:lib:";

function loadUsers(): string[] {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (!raw) return ["Standard"];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed.filter((u) => typeof u === "string") : ["Standard"];
  } catch {
    return ["Standard"];
  }
}

function saveUsers(users: string[]) {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch {
    /* ignore quota errors */
  }
}

interface StoredImage {
  id: string;
  dataUrl: string;
  prompt: string;
  createdAt: number;
}

function loadLibrary(user: string): StoredImage[] {
  try {
    const raw = localStorage.getItem(LIBRARY_PREFIX + user);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLibrary(user: string, items: StoredImage[]) {
  try {
    // Keep it small: drop oversized entries and cap the list.
    const pruned = items.slice(0, 40);
    localStorage.setItem(LIBRARY_PREFIX + user, JSON.stringify(pruned));
  } catch {
    /* ignore quota errors */
  }
}

/* ── Small UI helpers ────────────────────────────────────────────── */

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
  return <LoaderCircle className="spin" size={18} />;
}

/* ── Pages ───────────────────────────────────────────────────────── */

function CreatePage({
  onGenerated,
  notify,
}: {
  onGenerated: (img: StoredImage) => void;
  notify: (msg: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [numImages, setNumImages] = useState(1);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState<string[]>([]);
  const pollRef = useRef<number | null>(null);

  const clearPoll = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => clearPoll, []);

  const startGeneration = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setResult([]);
    setProgress(0);
    setStage("eingereiht…");

    try {
      const submitted = await submitGenerate({
        type: "txt2img",
        prompt: prompt.trim(),
        width,
        height,
        num_images: numImages,
        guidance: 3.5,
      });
      const jobId = submitted.job_id;
      setStage("warte auf Start…");

      pollRef.current = window.setInterval(async () => {
        let job: Job;
        try {
          job = await fetchJob(jobId);
        } catch {
          return; // keep polling
        }
        setProgress(job.progress?.percent ?? 0);
        setStage(job.progress?.stage || job.status);
        if (isTerminal(job.status)) {
          clearPoll();
          setRunning(false);
          if (job.status === "completed" && job.result?.images?.length) {
            const images = job.result.images.map((b64) => base64ToDataUrl(b64));
            setResult(images);
            const newest = images[images.length - 1];
            onGenerated({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl: newest,
              prompt: prompt.trim(),
              createdAt: Date.now(),
            });
            notify("Bild erzeugt.");
          } else {
            setStage(job.error?.message || "Fehlgeschlagen");
            notify(job.error?.message || "Generierung fehlgeschlagen.");
          }
        }
      }, 1000);
    } catch (err) {
      setRunning(false);
      setStage(err instanceof Error ? err.message : "Fehler");
      notify(err instanceof Error ? err.message : "Fehler");
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Bilder erzeugen</span>
          <h1>Neues Bild erstellen</h1>
          <p>Beschreibe, was du siehst — in ein paar Sekunden ist das Bild fertig.</p>
        </div>
      </header>

      <section className="panel">
        <div className="field">
          <span>Beschreibung</span>
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="z.B. Eine Katze auf einem Berggipfel, goldenes Licht, Foto-Stil…"
          />
        </div>

        <div className="grid-3">
          <Field label="Breite">
            <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} min={256} max={2048} step={128} />
          </Field>
          <Field label="Höhe">
            <input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} min={256} max={2048} step={128} />
          </Field>
          <Field label="Anzahl">
            <input type="number" value={numImages} onChange={(e) => setNumImages(Math.max(1, Math.min(4, Number(e.target.value))))} min={1} max={4} />
          </Field>
        </div>

        <div className="row-actions">
          <button className="btn btn-primary" onClick={startGeneration} disabled={running || !prompt.trim()}>
            {running ? <Spinner /> : <Play size={16} />} {running ? "Generiere…" : "Generieren"}
          </button>
          {running && (
            <div className="progress-line">
              <ProgressBar percent={progress} />
              <span>{stage}</span>
            </div>
          )}
        </div>
      </section>

      {result.length > 0 && (
        <section className="panel">
          <div className="section-title">Ergebnis</div>
          <div className="result-grid">
            {result.map((src, i) => (
              <div className="result-card" key={i}>
                <img src={src} alt={`Ergebnis ${i + 1}`} />
                <div className="result-actions">
                  <a className="btn" href={src} download={`bild-${i + 1}.png`}>
                    <Download size={15} /> Speichern
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EditPage({
  library,
  onGenerated,
  notify,
}: {
  library: StoredImage[];
  onGenerated: (img: StoredImage) => void;
  notify: (msg: string) => void;
}) {
  const [image, setImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [mask, setMask] = useState<string | null>(null);
  const [maskMode, setMaskMode] = useState<"manual" | "text">("manual");
  const [textTarget, setTextTarget] = useState("");
  const [maskBusy, setMaskBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    const id = pollRef.current;
    return () => {
      if (id !== null) window.clearInterval(id);
    };
  }, []);

  const pickImage = (dataUrl: string) => {
    setImage(dataUrl);
    setResult(null);
    setMask(null);
    setTextTarget("");
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImage(String(reader.result));
      setResult(null);
      setMask(null);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  /** Erzeuge eine Maske per Textbeschreibung über das Backend (VLM). */
  const generateMaskFromText = async () => {
    if (!image || !textTarget.trim() || maskBusy) return;
    setMaskBusy(true);
    try {
      const res = await maskFromText(image, textTarget.trim());
      setMask(base64ToDataUrl(res.mask));
      notify(
        res.model_used
          ? "Maske aus Text erzeugt."
          : "Kein VLM-Modell gefunden — Zentrum als Maske gesetzt. Maske manuell anpassen.",
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "Text-Maske fehlgeschlagen.");
    } finally {
      setMaskBusy(false);
    }
  };

  const startEdit = async () => {
    if (!image || !prompt.trim() || running) return;
    if (maskMode === "manual" && !mask) {
      notify("Bitte zuerst die Maske mit Pinsel oder Lasso zeichnen.");
      return;
    }
    setRunning(true);
    setResult(null);
    setProgress(0);
    setStage("eingereiht…");

    try {
      const submitted = await submitGenerate({
        type: "inpaint",
        prompt: prompt.trim(),
        init_images: [dataUrlToBase64(image)],
        mask: mask ? dataUrlToBase64(mask) : undefined,
        guidance: 30,
      });
      const jobId = submitted.job_id;

      pollRef.current = window.setInterval(async () => {
        let job: Job;
        try {
          job = await fetchJob(jobId);
        } catch {
          return;
        }
        setProgress(job.progress?.percent ?? 0);
        setStage(job.progress?.stage || job.status);
        if (isTerminal(job.status)) {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          setRunning(false);
          if (job.status === "completed" && job.result?.images?.length) {
            const out = base64ToDataUrl(job.result.images[0]);
            setResult(out);
            onGenerated({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl: out,
              prompt: prompt.trim(),
              createdAt: Date.now(),
            });
            notify("Bearbeitung fertig.");
          } else {
            setStage(job.error?.message || "Fehlgeschlagen");
            notify(job.error?.message || "Bearbeitung fehlgeschlagen.");
          }
        }
      }, 1000);
    } catch (err) {
      setRunning(false);
      setStage(err instanceof Error ? err.message : "Fehler");
      notify(err instanceof Error ? err.message : "Fehler");
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Bild bearbeiten</span>
          <h1>Inpainting — Bereich ändern</h1>
          <p>
            Wähle einen Bereich aus (per Pinsel/Lasso oder Textbeschreibung) und sag, was
            dort neu entstehen soll.
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="section-title">Ausgangsbild</div>
        <label className="upload-tile">
          <Upload size={18} />
          <span>Bild hochladen</span>
          <input type="file" accept="image/*" onChange={onUpload} />
        </label>
        {library.length > 0 && (
          <div className="edit-gallery">
            {library.slice(-12).map((item) => (
              <button
                key={item.id}
                className={image === item.dataUrl ? "thumb is-selected" : "thumb"}
                onClick={() => pickImage(item.dataUrl)}
              >
                <img src={item.dataUrl} alt="Galerie" />
              </button>
            ))}
          </div>
        )}
      </section>

      {image && (
        <>
          <section className="panel">
            <div className="section-title">Maske festlegen</div>
            <div className="mask-mode-tabs">
              <button
                className={maskMode === "manual" ? "is-active" : ""}
                onClick={() => setMaskMode("manual")}
              >
                Pinsel / Lasso
              </button>
              <button
                className={maskMode === "text" ? "is-active" : ""}
                onClick={() => setMaskMode("text")}
              >
                Per Text
              </button>
            </div>

            {maskMode === "manual" ? (
              <MaskEditor image={image} onChange={setMask} />
            ) : (
              <div className="text-mask-box">
                <div className="field">
                  <span>Was soll bearbeitet werden? (Objekt im Bild)</span>
                  <input
                    type="text"
                    value={textTarget}
                    onChange={(e) => setTextTarget(e.target.value)}
                    placeholder="z.B. den Hut, das Auto, die Person…"
                  />
                </div>
                <div className="row-actions">
                  <button
                    className="btn btn-primary"
                    onClick={generateMaskFromText}
                    disabled={maskBusy || !textTarget.trim()}
                  >
                    {maskBusy ? <Spinner /> : <Sparkles size={16} />}
                    {maskBusy ? "Suche…" : "Maske erzeugen"}
                  </button>
                  {mask && <span className="muted">Maske erzeugt — im Pinsel-Modus feinjustieren.</span>}
                </div>
                {mask && (
                  <div className="preview-image mask-preview">
                    <img src={mask} alt="Erzeugte Maske" />
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="section-title">Neu zeichnen</div>
            <div className="field">
              <span>Was soll im markierten Bereich entstehen?</span>
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="z.B. eine Mütze, ein blauer Himmel, eine Katze…"
              />
            </div>
            <div className="row-actions">
              <button
                className="btn btn-primary"
                onClick={startEdit}
                disabled={
                  running ||
                  !image ||
                  !prompt.trim() ||
                  (maskMode === "manual" && !mask)
                }
              >
                {running ? <Spinner /> : <Wand2 size={16} />} {running ? "Bearbeite…" : "Inpainting starten"}
              </button>
              {running && (
                <div className="progress-line">
                  <ProgressBar percent={progress} />
                  <span>{stage}</span>
                </div>
              )}
            </div>
            {result && (
              <div className="result-card">
                <img src={result} alt="Ergebnis" />
                <div className="result-actions">
                  <a className="btn" href={result} download="bearbeitet.png">
                    <Download size={15} /> Speichern
                  </a>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function LibraryPage({
  user,
  library,
  onDelete,
  notify,
}: {
  user: string;
  library: StoredImage[];
  onDelete: (id: string) => void;
  notify: (msg: string) => void;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Galerie</span>
          <h1>Meine Bilder</h1>
          <p>{library.length} Bild(er) im Bereich von „{user}“.</p>
        </div>
      </header>
      {library.length === 0 ? (
        <section className="panel empty-state">
          <ImagePlus size={28} />
          <p>Noch keine Bilder. Erzeuge dein erstes Bild im Bereich „Bilder erzeugen“.</p>
        </section>
      ) : (
        <section className="result-grid">
          {library
            .slice()
            .reverse()
            .map((item) => (
              <div className="result-card" key={item.id}>
                <img src={item.dataUrl} alt={item.prompt} />
                <div className="result-caption">{item.prompt}</div>
                <div className="result-actions">
                  <a className="btn" href={item.dataUrl} download={`bild-${item.id}.png`}>
                    <Download size={15} /> Speichern
                  </a>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      onDelete(item.id);
                      notify("Bild gelöscht.");
                    }}
                  >
                    <Trash2 size={15} /> Löschen
                  </button>
                </div>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

function SettingsPage({
  notify,
}: {
  notify: (msg: string) => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [vlm, setVlm] = useState<VlmStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [modelRes, sysRes, vlmRes] = await Promise.all([
        fetchModels(),
        fetchSystem(),
        fetchVlmStatus(),
      ]);
      setModels(modelRes.models ?? []);
      setSystem(sysRes);
      setVlm(vlmRes);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Backend nicht erreichbar.");
    } finally {
      setLoading(false);
    }
  };

  const installVlm = async (model: string) => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await downloadVlm(model);
      notify(`VLM installiert: ${res.model}`);
      setVlm((prev) =>
        prev ? { ...prev, installed: [...prev.installed, res.model], has_vlm: true } : prev
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : "VLM-Download fehlgeschlagen.");
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Einstellungen</span>
          <h1>Backend &amp; Modelle</h1>
          <p>Status des lokalen MLX-Backends.</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? <Spinner /> : null} Aktualisieren
        </button>
      </header>

      <section className="panel">
        <div className="section-title">System</div>
        <div className="info-row">
          <span>Aktives Modell</span>
          <strong>{system?.active_model ?? "—"}</strong>
        </div>
        <div className="info-row">
          <span>Warteschlange</span>
          <strong>{system?.queue_depth ?? "—"}</strong>
        </div>
        {system?.memory && (
          <div className="info-row">
            <span>MLX-Speicher</span>
            <strong>
              {Math.round(system.memory.active_mb)} MB aktiv / {Math.round(system.memory.peak_mb)} MB peak
            </strong>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-title">MLX-VLM für Text-Maske</div>
        <p className="muted">
          Zum Erzeugen einer Maske aus einer Textbeschreibung („den Hut") nutzt das Backend ein
          Vision-Language-Modell, das das Objekt im Bild findet. Ist keins installiert, wird es beim
          ersten Gebrauch automatisch geladen. Du kannst es hier auch vorab herunterladen.
        </p>
        {vlm?.has_vlm ? (
          <p className="muted" style={{ color: "var(--text)" }}>
            Installiert: {vlm.installed.join(", ")}
          </p>
        ) : (
          <p className="muted">Kein VLM installiert.</p>
        )}
        <div className="row-actions">
          {(vlm?.recommended ?? []).map((m) => {
            const installed = vlm?.installed.includes(m);
            return (
              <button
                key={m}
                className="btn"
                onClick={() => installVlm(m)}
                disabled={downloading || installed}
              >
                {downloading ? <Spinner /> : <Download size={15} />}
                {installed ? "Installiert" : `Installieren: ${m.split("/").pop()}`}
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="section-title">Verfügbare Modelle</div>
        {models.length === 0 ? (
          <p className="muted">Keine Modelle gefunden.</p>
        ) : (
          <div className="model-list">
            {models.map((m) => (
              <div className="info-row" key={m.name}>
                <span>{m.name}</span>
                <em>{m.capabilities?.join(", ") || "txt2img"}</em>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ── App shell ───────────────────────────────────────────────────── */

type PageId = "create" | "edit" | "library" | "settings";

const NAV: { id: PageId; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "create", label: "Bilder erzeugen", icon: Sparkles },
  { id: "edit", label: "Bild bearbeiten", icon: Wand2 },
  { id: "library", label: "Galerie", icon: Images },
  { id: "settings", label: "Einstellungen", icon: Settings },
];

export default function App() {
  const [users, setUsers] = useState<string[]>(() => loadUsers());
  const [activeUser, setActiveUser] = useState<string>(() => {
    const stored = localStorage.getItem(ACTIVE_USER_KEY);
    const all = loadUsers();
    return stored && all.includes(stored) ? stored : all[0];
  });
  const [library, setLibrary] = useState<StoredImage[]>(() => loadLibrary(loadUsers()[0]));
  const [page, setPage] = useState<PageId>("create");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [notice, setNotice] = useState("");

  // Keep library in sync with the active user.
  useEffect(() => {
    setLibrary(loadLibrary(activeUser));
  }, [activeUser]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);

  const notify = (msg: string) => setNotice(msg);

  const onGenerated = (img: StoredImage) => {
    const next = [...library, img];
    setLibrary(next);
    saveLibrary(activeUser, next);
  };

  const onDelete = (id: string) => {
    const next = library.filter((item) => item.id !== id);
    setLibrary(next);
    saveLibrary(activeUser, next);
  };

  const switchUser = (name: string) => {
    setActiveUser(name);
    localStorage.setItem(ACTIVE_USER_KEY, name);
    setUserMenuOpen(false);
  };

  const addUser = () => {
    const name = newUserName.trim();
    if (!name) return;
    const all = loadUsers();
    if (all.includes(name)) {
      switchUser(name);
      setNewUserName("");
      return;
    }
    const next = [...all, name];
    saveUsers(next);
    setUsers(next);
    switchUser(name);
    setNewUserName("");
  };

  const removeUser = (name: string) => {
    if (users.length <= 1) return;
    const next = users.filter((u) => u !== name);
    saveUsers(next);
    setUsers(next);
    localStorage.removeItem(LIBRARY_PREFIX + name);
    if (activeUser === name) {
      const fallback = next[0];
      setActiveUser(fallback);
      localStorage.setItem(ACTIVE_USER_KEY, fallback);
    }
  };

  const renderPage = () => {
    switch (page) {
      case "create":
        return <CreatePage onGenerated={onGenerated} notify={notify} />;
      case "edit":
        return <EditPage library={library} onGenerated={onGenerated} notify={notify} />;
      case "library":
        return <LibraryPage user={activeUser} library={library} onDelete={onDelete} notify={notify} />;
      case "settings":
        return <SettingsPage notify={notify} />;
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <ImagePlus size={22} />
          <span>
            <strong>MLX</strong> Media
          </span>
        </div>

        <nav className="primary-nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={page === item.id ? "is-active" : ""}
                onClick={() => setPage(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-box">
            <button className="user-trigger" onClick={() => setUserMenuOpen((o) => !o)}>
              <span className="avatar"><User size={16} /></span>
              <span>{activeUser}</span>
            </button>
            {userMenuOpen && (
              <div className="user-menu">
                <div className="user-menu-label">Benutzer</div>
                {users.map((name) => (
                  <div className="user-menu-row" key={name}>
                    <button className="user-menu-item" onClick={() => switchUser(name)}>
                      <Users size={15} /> {name}
                    </button>
                    {users.length > 1 && (
                      <button
                        className="user-menu-del"
                        aria-label={`${name} entfernen`}
                        onClick={() => removeUser(name)}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <div className="user-menu-add">
                  <input
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    placeholder="Neuer Benutzer…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addUser();
                    }}
                  />
                  <button onClick={addUser} aria-label="Benutzer anlegen">
                    <Plus size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="content">{renderPage()}</main>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}