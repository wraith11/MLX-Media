/**
 * MLX Media — functional frontend (dev branch).
 *
 * Self-contained German UI. Talks to the local MLX backend through mediaApi.ts.
 * Features:
 *   - Studio: unified workspace (generate + mask + edit + gallery)
 *   - Video: text-to-video via the isolated Wan runner
 *   - Einstellungen: model selection, download/delete, MLX-VLM
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
  LoaderCircle,
  Play,
  Plus,
  Settings,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import {
  deleteModel,
  downloadModel,
  downloadVlm,
  fetchJob,
  fetchModels,
  fetchSystem,
  fetchVideoSetupStatus,
  fetchVideoStatus,
  fetchVlmStatus,
  isTerminal,
  selectModel,
  startVideoSetup,
  submitVideo,
  type Job,
  type ModelInfo,
  type StoredImage,
  type SystemInfo,
  type VideoSetupStatus,
  type VideoStatus,
  type VlmStatus,
} from "./mediaApi";
import MaskEditor from "./MaskEditor";
import StudioPage from "./StudioPage";

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


function VideoPage({
  notify,
}: {
  notify: (msg: string) => void;
}) {
  const [status, setStatus] = useState<VideoStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [frames, setFrames] = useState(25);
  const [steps, setSteps] = useState(10);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [setup, setSetup] = useState<VideoSetupStatus | null>(null);
  const pollRef = useRef<number | null>(null);
  const setupPollRef = useRef<number | null>(null);

  const refresh = async () => {
    try {
      setStatus(await fetchVideoStatus());
    } catch (err) {
      notify(err instanceof Error ? err.message : "Video-Status nicht erreichbar.");
    }
  };

  useEffect(() => {
    void refresh();
    const id = pollRef.current;
    const sid = setupPollRef.current;
    return () => {
      if (id !== null) window.clearInterval(id);
      if (sid !== null) window.clearInterval(sid);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start provisioning from the UI and poll its progress. */
  const startSetup = async () => {
    try {
      await startVideoSetup();
      setSetup({ running: true, done: false, error: null, tail: [], started_at: Date.now() });
      notify("Video-Runner-Einrichtung gestartet (kann lange dauern).");
      setupPollRef.current = window.setInterval(async () => {
        let s: VideoSetupStatus;
        try {
          s = await fetchVideoSetupStatus();
        } catch {
          return;
        }
        setSetup(s);
        if (!s.running && (s.done || s.error)) {
          if (setupPollRef.current !== null) window.clearInterval(setupPollRef.current);
          setupPollRef.current = null;
          notify(s.error ? `Video-Einrichtung fehlgeschlagen: ${s.error}` : "Video-Runner bereit.");
          void refresh();
        }
      }, 2000);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Video-Einrichtung konnte nicht gestartet werden.");
    }
  };

  const startVideo = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setVideoUrl(null);
    setProgress(0);
    setStage("eingereiht…");
    try {
      const submitted = await submitVideo({
        prompt: prompt.trim(),
        num_frames: frames,
        steps,
      });
      const id = submitted.job_id;
      setJobId(id);

      pollRef.current = window.setInterval(async () => {
        let job: Job;
        try {
          job = await fetchJob(id);
        } catch {
          return;
        }
        setProgress(job.progress?.percent ?? 0);
        setStage(job.progress?.stage || job.status);
        if (isTerminal(job.status)) {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          setRunning(false);
          if (job.status === "completed") {
            const url = job.result?.artifact_urls?.video;
            if (url) {
              setVideoUrl(url);
              notify("Video fertig.");
            } else {
              setStage("Video fertig, aber kein Artefakt gefunden.");
              notify("Video fertig, aber kein Artefakt gefunden.");
            }
          } else {
            setStage(job.error?.message || "Fehlgeschlagen");
            notify(job.error?.message || "Videogenerierung fehlgeschlagen.");
          }
        }
      }, 1500);
    } catch (err) {
      setRunning(false);
      setStage(err instanceof Error ? err.message : "Fehler");
      notify(err instanceof Error ? err.message : "Fehler");
    }
  };

  const framesValid = frames >= 5 && frames <= 81 && (frames - 1) % 4 === 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Video</span>
          <h1>Text zu Video</h1>
          <p>Wan 2.1 T2V 1.3B — lokal, isoliert, 832×480 @ 16 fps.</p>
        </div>
        <button className="btn" onClick={refresh}>
          Status aktualisieren
        </button>
      </header>

      {status && !status.ready && (
        <section className="panel">
          <div className="section-title">Einrichtung erforderlich</div>
          <p className="muted">
            Der isolierte Video-Runner ist noch nicht bereit. Starte die Einrichtung per
            Button unten — das lädt die Engine und das Wan-Modell und konvertiert sie
            (mehrere GiB, kann je nach Internet lange dauern).
          </p>
          <div className="row-actions">
            <button
              className="btn btn-primary"
              onClick={startSetup}
              disabled={setup?.running}
            >
              {setup?.running ? <Spinner /> : <Download size={16} />}
              {setup?.running ? "Einrichtung läuft…" : "Video-Runner einrichten"}
            </button>
          </div>
          {status.reasons && status.reasons.length > 0 && (
            <ul className="setup-reasons">
              {status.reasons.map((r) => (
                <li key={r.code}>{r.message}</li>
              ))}
            </ul>
          )}
          {setup && setup.tail.length > 0 && (
            <pre className="setup-log">
              {setup.tail.slice(-40).join("\n")}
            </pre>
          )}
          {setup?.error && <p className="muted" style={{ color: "var(--danger)" }}>Fehler: {setup.error}</p>}
        </section>
      )}

      {status?.ready && (
        <section className="panel">
          <div className="section-title">Neues Video</div>
          <div className="field">
            <span>Beschreibung (was soll passieren?)</span>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="z.B. Eine Drohne fliegt über eine Bergkette bei Sonnenuntergang…"
            />
          </div>
          <div className="grid-2">
            <div className="field">
              <span>Frames ({frames}) — 4n+1, 5–81</span>
              <input
                type="range"
                min={5}
                max={81}
                step={4}
                value={frames}
                onChange={(e) => setFrames(Number(e.target.value))}
              />
              {!framesValid && <span className="muted">Muss der 4n+1-Regel folgen.</span>}
            </div>
            <div className="field">
              <span>Schritte ({steps}) — 1–50</span>
              <input
                type="range"
                min={1}
                max={50}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="row-actions">
            <button
              className="btn btn-primary"
              onClick={startVideo}
              disabled={running || !prompt.trim() || !framesValid}
            >
              {running ? <Spinner /> : <Play size={16} />} {running ? "Generiere…" : "Video generieren"}
            </button>
            {running && (
              <div className="progress-line">
                <ProgressBar percent={progress} />
                <span>{stage}</span>
              </div>
            )}
          </div>
          {videoUrl && (
            <div className="video-result">
              <video src={videoUrl} controls style={{ width: "100%", borderRadius: 12 }} />
              <div className="result-actions">
                <a className="btn" href={videoUrl} download="video.mp4">
                  <Download size={15} /> MP4 speichern
                </a>
              </div>
            </div>
          )}
        </section>
      )}

      {status?.ready && running && jobId && (
        <section className="panel">
          <div className="section-title">Job</div>
          <div className="info-row">
            <span>Job-ID</span>
            <strong>{jobId}</strong>
          </div>
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
  const [active, setActive] = useState<string>("");
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [vlm, setVlm] = useState<VlmStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
      setActive(modelRes.active ?? sysRes.active_model ?? "");
      setSystem(sysRes);
      setVlm(vlmRes);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Backend nicht erreichbar.");
    } finally {
      setLoading(false);
    }
  };

  const select = async (m: string) => {
    try {
      const r = await selectModel(m);
      setActive(r.active);
      notify(`Aktives Modell: ${r.active}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Modell-Auswahl fehlgeschlagen.");
    }
  };

  const download = async (m: string) => {
    setBusy(`dl:${m}`);
    try {
      await downloadModel(m);
      notify(`Modell geladen: ${m}`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : `Download fehlgeschlagen: ${m}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (m: string) => {
    setBusy(`del:${m}`);
    try {
      const r = await deleteModel(m);
      notify(r.removed ? `Modell gelöscht: ${m}` : `Kein lokales Modell: ${m}`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : `Löschen fehlgeschlagen: ${m}`);
    } finally {
      setBusy(null);
    }
  };

  const installVlm = async (m: string) => {
    setBusy(`vlm:${m}`);
    try {
      const res = await downloadVlm(m);
      notify(`VLM installiert: ${res.model}`);
      await refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "VLM-Download fehlgeschlagen.");
    } finally {
      setBusy(null);
    }
  };

  const fmtSize = (bytes: number) => {
    if (!bytes) return "—";
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
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
          <p>Systemstatus, Modellverwaltung und MLX-VLM.</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? <Spinner /> : null} Aktualisieren
        </button>
      </header>

      <section className="panel">
        <div className="section-title">System</div>
        <div className="info-row">
          <span>Aktives Modell</span>
          <strong>{active || "—"}</strong>
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
        <div className="section-title">Modell wählen &amp; verwalten</div>
        <p className="muted">
          Das aktive Modell wird für „Bilder erzeugen“ verwendet. Nicht heruntergeladene
          Modelle werden bei der ersten Nutzung automatisch geladen — du kannst sie hier
          auch vorab herunterladen oder von der Platte löschen.
        </p>
        {models.length === 0 ? (
          <p className="muted">Keine Modelle gefunden.</p>
        ) : (
          <div className="model-manage-list">
            {models.map((m) => {
              const isActive = m.name === active;
              const dlBusy = busy === `dl:${m.name}`;
              const delBusy = busy === `del:${m.name}`;
              return (
                <div className={isActive ? "model-manage-row is-active" : "model-manage-row"} key={m.name}>
                  <div className="model-manage-info">
                    <strong>{m.name}</strong>
                    <span className="muted">
                      {m.capabilities?.join(", ") || "txt2img"}
                      {m.downloaded ? ` · lokal · ${fmtSize(m.size_bytes ?? 0)}` : " · nicht lokal"}
                    </span>
                  </div>
                  <div className="model-manage-actions">
                    <button
                      className="btn"
                      onClick={() => select(m.name)}
                      disabled={isActive}
                    >
                      {isActive ? "Aktiv" : "Wählen"}
                    </button>
                    {!m.downloaded && (
                      <button className="btn" onClick={() => download(m.name)} disabled={dlBusy || busy !== null}>
                        {dlBusy ? <Spinner /> : <Download size={15} />} Herunterladen
                      </button>
                    )}
                    {m.downloaded && (
                      <button className="btn btn-danger" onClick={() => remove(m.name)} disabled={delBusy || busy !== null}>
                        {delBusy ? <Spinner /> : <Trash2 size={15} />} Löschen
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-title">MLX-VLM für Text-Maske</div>
        <p className="muted">
          Zum Erzeugen einer Maske aus Text („den Hut“) lokalisiert das Backend das Objekt mit
          einem Vision-Language-Modell. Standard: <code>{vlm?.default ?? "…"}</code> — wird beim
          ersten Gebrauch automatisch geladen, falls nichts installiert ist.
        </p>
        {vlm && vlm.installed.length > 0 ? (
          <div className="vlm-installed">
            <span className="muted">Installiert:</span>
            {vlm.installed.map((name) => (
              <span key={name} className="vlm-chip">{name}</span>
            ))}
          </div>
        ) : (
          <p className="muted">Kein VLM installiert.</p>
        )}
        <div className="row-actions">
          {(vlm?.recommended ?? []).map((m) => {
            const installed = vlm?.installed.includes(m);
            const vlmBusy = busy === `vlm:${m}`;
            return (
              <button
                key={m}
                className="btn"
                onClick={() => installVlm(m)}
                disabled={busy !== null || installed}
              >
                {vlmBusy ? <Spinner /> : installed ? <Sparkles size={15} /> : <Download size={15} />}
                {installed ? `✓ ${m.split("/").pop()}` : `Installieren: ${m.split("/").pop()}`}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ── App shell ───────────────────────────────────────────────────── */

type PageId = "studio" | "video" | "settings";

const NAV: { id: PageId; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "studio", label: "Studio", icon: Sparkles },
  { id: "video", label: "Video", icon: Play },
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
  const [page, setPage] = useState<PageId>("studio");
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
      case "studio":
        return (
          <StudioPage
            user={activeUser}
            library={library}
            onAddImage={onGenerated}
            onDeleteImage={onDelete}
            notify={notify}
          />
        );
      case "video":
        return <VideoPage notify={notify} />;
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