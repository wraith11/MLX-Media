/**
 * mediaApi.ts
 * Clean typed client for the MLX-Media backend (image generation + editing).
 * Uses relative paths so it works both in dev (Vite proxy) and in production
 * (served from the backend on the same origin).
 */

export type JobStatusValue =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type JobTypeValue =
  | "txt2img"
  | "img2img"
  | "inpaint"
  | "controlnet"
  | "upscale"
  | "video";

export interface JobProgress {
  current_image: number;
  total_images: number;
  percent: number;
  stage: string;
}

export interface JobResult {
  images?: string[];
  info?: string;
  prompt?: string;
  status?: string;
  // Video jobs return artifact URLs instead of base64 images.
  artifact_urls?: {
    video?: string;
    provenance?: string;
    request?: string;
  };
  output?: { container: string; sha256: string; size_bytes: number };
}

export interface Job {
  job_id: string;
  type: string;
  status: JobStatusValue;
  progress: JobProgress;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result?: JobResult;
  error?: { code: string; message: string };
}

export interface ModelInfo {
  name: string;
  capabilities: string[];
  base_arch?: string;
  hf_name?: string;
}

export interface SystemInfo {
  active_model: string;
  queue_depth: number;
  memory?: { active_mb: number; peak_mb: number };
}

export interface QueueInfo {
  pending: Job[];
  pending_count: number;
  running: Job[];
  running_count: number;
}

export interface GenerateParams {
  type: JobTypeValue;
  prompt: string;
  seed?: number | null;
  width?: number;
  height?: number;
  steps?: number | null;
  guidance?: number;
  num_images?: number;
  init_images?: string[]; // base64, for img2img
  image_strength?: number; // denoising strength
  mask?: string; // base64 mask (white = regenerate), for inpaint
  upscale_factor?: number; // for upscale
}

export interface MaskFromTextResult {
  mask: string; // base64 (white = region)
  box: number[];
  width: number;
  height: number;
  model_used: string | null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  let body: unknown = null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  }

  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } })?.error?.message ??
      (body as { error?: string })?.error ??
      `HTTP ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

export async function fetchHealth(): Promise<{ status: string }> {
  return requestJson<{ status: string }>("/api/v1/health");
}

export async function fetchModels(): Promise<{ models: ModelInfo[] }> {
  return requestJson<{ models: ModelInfo[] }>("/api/v1/models");
}

export async function fetchSystem(): Promise<SystemInfo> {
  return requestJson<SystemInfo>("/api/v1/system");
}

export async function fetchQueue(): Promise<QueueInfo> {
  return requestJson<QueueInfo>("/api/v1/queue");
}

export async function submitGenerate(
  params: GenerateParams,
): Promise<{ job_id: string; status: string; type: string }> {
  return requestJson("/api/v1/generate", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function fetchJob(jobId: string): Promise<Job> {
  return requestJson<Job>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchJobs(): Promise<{ jobs: Job[] }> {
  return requestJson<{ jobs: Job[] }>("/api/v1/jobs");
}

export async function cancelJob(jobId: string): Promise<{ status: string }> {
  return requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export function isTerminal(status: JobStatusValue): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

export function base64ToDataUrl(base64: string, mime = "image/png"): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * Ask the backend to locate an object described by `text` and return a mask.
 * Falls back to a centered ellipse on the server when no VLM is available.
 */
export async function maskFromText(
  imageDataUrl: string,
  text: string,
): Promise<MaskFromTextResult> {
  return requestJson<MaskFromTextResult>("/api/v1/mask-from-text", {
    method: "POST",
    body: JSON.stringify({
      image: dataUrlToBase64(imageDataUrl),
      text,
    }),
  });
}

export interface VlmStatus {
  default: string;
  recommended: string[];
  installed: string[];
  has_vlm: boolean;
}

export interface VlmDownloadResult {
  model: string;
  local_path: string;
  installed: boolean;
}

/** Current MLX VLM status (what is / isn't installed). */
export async function fetchVlmStatus(): Promise<VlmStatus> {
  return requestJson<VlmStatus>("/api/v1/vlm/status");
}

/** Trigger a download of an MLX VLM model (blocks until done). */
export async function downloadVlm(model?: string): Promise<VlmDownloadResult> {
  return requestJson<VlmDownloadResult>("/api/v1/vlm/download", {
    method: "POST",
    body: JSON.stringify({ model: model ?? "" }),
  });
}

export interface VideoCapability {
  id: string;
  label: string;
  type: string;
  operations: string[];
  availability: string;
  availability_reason: string;
  engine: { source: string; revision: string; license: string; tested: boolean };
  model: {
    source: string;
    revision: string;
    license: string;
    converted_local: boolean;
    configured: boolean;
    cached: boolean;
    smoke_tested: boolean;
  };
  parameters: {
    prompt: { min_length: number; max_length: number };
    width: { fixed: number };
    height: { fixed: number };
    num_frames: { minimum: number; maximum: number; rule: string };
    fps: { fixed: number };
    steps: { minimum: number; maximum: number; default: number };
    scheduler: { fixed: string };
    tiling: { allowed: string[]; default: string };
    seed: { minimum: number; maximum: number; optional: boolean };
  };
  output: { container: string; audio: string };
  isolation: string;
  concurrency: string;
  cancel_mode: string;
}

export interface VideoStatus {
  schema_version: number;
  state: string;
  ready: boolean;
  apple_silicon: boolean;
  engine: { configured: boolean; available: boolean; tested: boolean };
  model: {
    configured: boolean;
    cached: boolean;
    converted: boolean;
    smoke_tested: boolean;
  };
  reasons: { code: string; message: string }[];
  active_media_job?: { id: string; type: string };
}

export interface VideoJobResult {
  status: string;
  job_id: string;
  capability_id: string;
  artifact_urls: {
    video?: string;
    provenance?: string;
    request?: string;
  };
  output?: { container: string; sha256: string; size_bytes: number };
}

/** Fetch the exact locally-supported video capability registry. */
export async function fetchVideoCapabilities(): Promise<VideoCapability> {
  return requestJson<VideoCapability>("/api/v1/video/capabilities");
}

/** Fetch isolated video runner readiness. */
export async function fetchVideoStatus(): Promise<VideoStatus> {
  return requestJson<VideoStatus>("/api/v1/video/status");
}

/**
 * Submit a text-to-video job. Builds the exact payload the audited runner
 * requires (fixed 832x480@16fps, 4n+1 frames, unipc scheduler).
 */
export async function submitVideo(params: {
  prompt: string;
  num_frames: number;
  steps: number;
  tiling?: string;
  seed?: number | null;
}): Promise<{ job_id: string; status: string; type: string }> {
  const payload = {
    schema_version: 1,
    type: "video",
    operation: "text-to-video",
    capability_id: "wan-2.1-t2v-1.3b",
    prompt: params.prompt,
    output: {
      width: 832,
      height: 480,
      num_frames: params.num_frames,
      fps: 16,
      container: "mp4",
    },
    sampling: {
      steps: params.steps,
      scheduler: "unipc",
      tiling: params.tiling ?? "auto",
      ...(params.seed != null ? { seed: params.seed } : {}),
    },
  };
  return requestJson("/api/v1/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}