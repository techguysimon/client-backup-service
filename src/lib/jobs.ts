// Jobs lib — in-memory job store with SSE support
import { nanoid } from "nanoid";

export type JobStatus = "preparing" | "downloading_r2" | "archiving" | "cancelling" | "ready" | "error" | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: number;
  zipPath?: string;
  error?: string;
  cancelRequested: boolean;
  _abortController: AbortController;
  // SSE controllers for live updates
  _sseControllers: Set<ReadableStreamDefaultController>;
}

const JOBS: Map<string, Job> = new Map();
const ACTIVE_BACKUP_STATUSES: JobStatus[] = [
  "preparing",
  "downloading_r2",
  "archiving",
  "cancelling",
];
const SSE_KEEPALIVE = 25_000; // 25s keepalive to prevent connection timeouts

// Cleanup old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 3_600_000;
  for (const [id, job] of Array.from(JOBS.entries())) {
    if (job.createdAt < now - ONE_HOUR) {
      cleanupJob(id);
    }
  }
}, 10 * 60_000);

export function createJob(): Job {
  const job: Job = {
    id: nanoid(12),
    status: "preparing",
    progress: 0,
    message: "Starting backup...",
    createdAt: Date.now(),
    cancelRequested: false,
    _abortController: new AbortController(),
    _sseControllers: new Set(),
  };
  JOBS.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return JOBS.get(id);
}

export function getActiveBackupJob(): Job | undefined {
  return Array.from(JOBS.values()).find((job) => ACTIVE_BACKUP_STATUSES.includes(job.status));
}

export function hasActiveBackupJob(): boolean {
  return getActiveBackupJob() !== undefined;
}

export function requestJobCancellation(id: string, message = "Cancelling backup..."): boolean {
  const job = JOBS.get(id);
  if (!job || job.cancelRequested) return false;

  job.cancelRequested = true;
  try {
    job._abortController.abort(new Error("Backup cancelled"));
  } catch {
    // ignore abort errors from repeated calls
  }
  updateJob(id, { status: "cancelling", message });
  return true;
}

export function isJobCancellationRequested(id: string): boolean {
  return JOBS.get(id)?.cancelRequested ?? false;
}

export function getJobAbortSignal(id: string): AbortSignal | undefined {
  return JOBS.get(id)?._abortController.signal;
}

export function updateJob(id: string, update: Partial<Pick<Job, "status" | "progress" | "message" | "zipPath" | "error">>) {
  const job = JOBS.get(id);
  if (!job) return;
  if (update.status !== undefined) job.status = update.status;
  if (update.progress !== undefined) job.progress = update.progress;
  if (update.message !== undefined) job.message = update.message;
  if (update.zipPath !== undefined) job.zipPath = update.zipPath;
  if (update.error !== undefined) job.error = update.error;
  // Broadcast to all SSE watchers
  for (const ctrl of Array.from(job._sseControllers)) {
    try {
      const data = JSON.stringify({ status: job.status, progress: job.progress, message: job.message });
      ctrl.enqueue(`event: message\ndata: ${data}\n\n`);
    } catch {
      // Controller closed, remove it
      job._sseControllers.delete(ctrl);
    }
  }
}

export function addSSEController(id: string, ctrl: ReadableStreamDefaultController) {
  const job = JOBS.get(id);
  if (!job) return false;
  job._sseControllers.add(ctrl);
  // Send initial state
  try {
    const data = JSON.stringify({ status: job.status, progress: job.progress, message: job.message });
    ctrl.enqueue(`event: message\ndata: ${data}\n\n`);
  } catch {
    job._sseControllers.delete(ctrl);
  }
  return true;
}

export function removeSSEController(id: string, ctrl: ReadableStreamDefaultController) {
  const job = JOBS.get(id);
  if (job) job._sseControllers.delete(ctrl);
}

export function broadcastDone(id: string, downloadPath: string) {
  const job = JOBS.get(id);
  if (!job) return;
  for (const ctrl of Array.from(job._sseControllers)) {
    try {
      const data = JSON.stringify({ status: "ready", progress: 100, message: "Backup ready!", download_url: `/api/backup/${id}/download` });
      ctrl.enqueue(`event: done\ndata: ${data}\n\n`);
    } catch {
      job._sseControllers.delete(ctrl);
    }
  }
}

export function broadcastError(id: string, error: string) {
  const job = JOBS.get(id);
  if (!job) return;
  job.status = "error";
  job.error = error;
  for (const ctrl of Array.from(job._sseControllers)) {
    try {
      const data = JSON.stringify({ status: "error", progress: job.progress, message: error });
      ctrl.enqueue(`event: error\ndata: ${data}\n\n`);
    } catch {
      job._sseControllers.delete(ctrl);
    }
  }
}

export async function cleanupJob(id: string) {
  const job = JOBS.get(id);
  if (!job) return;
  job.cancelRequested = true;
  try {
    job._abortController.abort(new Error("Backup cancelled"));
  } catch {
    // ignore abort errors from repeated cleanup calls
  }
  job.status = "cancelled";
  for (const ctrl of Array.from(job._sseControllers)) {
    try { ctrl.close(); } catch { /* ignore */ }
  }
  job._sseControllers.clear();
  if (job.zipPath) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(job.zipPath);
    } catch { /* ignore if already gone */ }
  }
  JOBS.delete(id);
}
