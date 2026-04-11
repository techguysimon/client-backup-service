// IDSC Backup Service — Bun.serve entry point
import { createReadStream, readFileSync, mkdirSync, existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { checkPassword } from "./lib/auth.js";
import {
  createJob,
  getJob,
  getActiveBackupJob,
  updateJob,
  addSSEController,
  removeSSEController,
  cleanupJob,
  broadcastDone,
  broadcastError,
} from "./lib/jobs.js";
import { fetchRepoZipStream } from "./services/github.js";
import { createZipBuilder } from "./services/archiver.js";
import { prefetchR2ObjectsToDisk } from "./services/r2-prefetch.js";
import { listR2Objects } from "./services/r2.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "8080");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "techguysimon/idrivesocal-main";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? "main";
const R2_ENDPOINT = process.env.R2_ENDPOINT ?? "";
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY ?? "";
const R2_SECRET_KEY = process.env.R2_SECRET_KEY ?? "";
const R2_BUCKET = process.env.R2_BUCKET ?? "idrivesocal-media";
const R2_DOWNLOAD_CONCURRENCY = Math.max(1, parseInt(process.env.R2_DOWNLOAD_CONCURRENCY ?? "4", 10) || 4);
const TEMP_DIR = "/tmp/backups";
mkdirSync(TEMP_DIR, { recursive: true });

// ─── HTML UI ─────────────────────────────────────────────────────────────────
const UI_HTML = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function calculateArchiveProgress(processedBytes: number, totalBytes: number, processedFiles: number, totalFiles: number): number {
  if (totalBytes > 0) {
    return 30 + Math.round((processedBytes / totalBytes) * 60);
  }

  if (totalFiles > 0) {
    return 30 + Math.round((processedFiles / totalFiles) * 60);
  }

  return 90;
}

// ─── Backup Job Runner ────────────────────────────────────────────────────────
async function runBackup(jobId: string) {
  const job = getJob(jobId);
  if (!job) return;

  const r2Config = {
    endpoint: R2_ENDPOINT,
    accessKey: R2_ACCESS_KEY,
    secretKey: R2_SECRET_KEY,
    bucket: R2_BUCKET,
  };

  const repoName = GITHUB_REPO.replace("/", "-");
  const dateStr = new Date().toISOString().slice(0, 10);
  const zipPath = `${TEMP_DIR}/backup-${jobId}.zip`;
  const mediaTempDir = join(TEMP_DIR, `media-${jobId}`);

  try {
    const zip = await createZipBuilder(zipPath);

    // 1. Fetch GitHub zip and stream directly into archive
    updateJob(jobId, { status: "preparing", progress: 5, message: "Fetching source from GitHub..." });
    const sourceZipStream = await fetchRepoZipStream(GITHUB_REPO, GITHUB_BRANCH, GITHUB_TOKEN, (msg) =>
      updateJob(jobId, { message: msg })
    );
    await zip.appendEntry({
      name: `source/${repoName}-${dateStr}.zip`,
      data: sourceZipStream,
      store: true,
    });
    updateJob(jobId, { progress: 20, message: "Source archived." });

    // 2. List R2 objects
    updateJob(jobId, { status: "downloading_r2", progress: 25, message: "Listing R2 files..." });
    const r2Objects = await listR2Objects(r2Config, (msg) => updateJob(jobId, { message: msg }));
    const totalBytes = r2Objects.reduce((sum, object) => sum + object.size, 0);

    if (r2Objects.length === 0) {
      updateJob(jobId, { status: "archiving", progress: 95, message: "No media found. Finalizing backup archive..." });
      await zip.finalize();
      updateJob(jobId, { status: "ready", progress: 100, message: "Backup ready!", zipPath });
      broadcastDone(jobId, zipPath);
      return;
    }

    updateJob(jobId, {
      status: "archiving",
      progress: 30,
      message: `Prefetching and archiving ${r2Objects.length} media files (${formatBytes(totalBytes)}) with ${R2_DOWNLOAD_CONCURRENCY} parallel R2 downloads...`,
    });

    // 3. Prefetch R2 files to temp storage, then append them to the archive in order
    let processedFiles = 0;
    let processedBytes = 0;
    let lastProgressAt = 0;
    let lastReportedFiles = 0;

    const reportMediaProgress = (force = false) => {
      const now = Date.now();
      const shouldReport =
        force ||
        processedFiles === r2Objects.length ||
        processedFiles - lastReportedFiles >= 25 ||
        now - lastProgressAt >= 1000;

      if (!shouldReport) return;

      lastProgressAt = now;
      lastReportedFiles = processedFiles;

      updateJob(jobId, {
        status: "archiving",
        progress: Math.min(90, calculateArchiveProgress(processedBytes, totalBytes, processedFiles, r2Objects.length)),
        message: `Archiving media... ${processedFiles}/${r2Objects.length} (${formatBytes(processedBytes)}/${formatBytes(totalBytes)}) using ${R2_DOWNLOAD_CONCURRENCY} parallel downloads`,
      });
    };

    for await (const prefetched of prefetchR2ObjectsToDisk({
      objects: r2Objects,
      tempDir: mediaTempDir,
      config: r2Config,
      concurrency: R2_DOWNLOAD_CONCURRENCY,
    })) {
      await zip.appendEntry({
        name: `media/${prefetched.object.key}`,
        data: createReadStream(prefetched.tempPath),
        store: true,
      });
      await prefetched.cleanup();

      processedFiles += 1;
      processedBytes += prefetched.object.size;
      reportMediaProgress();
    }

    reportMediaProgress(true);

    // 4. Finalize zip
    updateJob(jobId, { status: "archiving", progress: 95, message: "Finalizing backup archive..." });
    await zip.finalize();

    updateJob(jobId, { status: "ready", progress: 100, message: "Backup ready!", zipPath });
    broadcastDone(jobId, zipPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (existsSync(zipPath)) {
      try {
        await unlink(zipPath);
      } catch {
        // ignore cleanup failures for partial archives
      }
    }

    updateJob(jobId, { status: "error", message: msg, error: msg });
    broadcastError(jobId, msg);
  } finally {
    await rm(mediaTempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Bun.serve ───────────────────────────────────────────────────────────────
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // GET / → UI
    if (method === "GET" && path === "/") {
      return new Response(UI_HTML, { headers: { "Content-Type": "text/html" } });
    }

    // GET /health
    if (method === "GET" && path === "/health") {
      return Response.json({ ok: true });
    }

    // POST /api/backup → start job
    if (method === "POST" && path === "/api/backup") {
      let body: { password?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      if (!checkPassword(body.password ?? "")) {
        return Response.json({ error: "Invalid password" }, { status: 401 });
      }

      const activeJob = getActiveBackupJob();
      if (activeJob) {
        return Response.json(
          {
            error: "A backup is already in progress. Please wait for it to finish before starting another one.",
            job_id: activeJob.id,
            status: activeJob.status,
          },
          { status: 409 }
        );
      }

      const job = createJob();
      runBackup(job.id);
      return Response.json({ status: "starting", job_id: job.id }, { status: 202 });
    }

    // GET /api/backup/:id → job status
    if (method === "GET" && path.startsWith("/api/backup/") && !path.includes("/download")) {
      const id = path.split("/")[3];
      const job = getJob(id);
      if (!job) return Response.json({ error: "Job not found" }, { status: 404 });

      return Response.json({
        status: job.status,
        progress: job.progress,
        message: job.error ?? job.message,
        error: job.error,
      });
    }

    // GET /api/backup/:id/download → stream zip
    if (method === "GET" && path.match(/^\/api\/backup\/[^/]+\/download$/)) {
      const id = path.split("/")[3];
      const job = getJob(id);
      if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
      if (!job.zipPath) return Response.json({ error: "Zip not ready" }, { status: 400 });
      if (!existsSync(job.zipPath)) return Response.json({ error: "Zip not found" }, { status: 404 });

      const file = Bun.file(job.zipPath);
      const dateStr = new Date().toISOString().slice(0, 10);
      return new Response(file, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="backup-${dateStr}.zip"`,
        },
      });
    }

    // GET /api/backup/:id/stream → SSE
    if (method === "GET" && path.match(/^\/api\/backup\/[^/]+\/stream$/)) {
      const id = path.split("/")[3];
      const job = getJob(id);
      if (!job) return Response.json({ error: "Job not found" }, { status: 404 });

      let ctrl: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          addSSEController(id, c);
        },
        cancel() {
          if (ctrl) removeSSEController(id, ctrl);
        },
      });

      const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        Pragma: "no-cache",
        Expires: "0",
      };
      return new Response(stream, { headers });
    }

    // DELETE /api/backup/:id → cancel cleanup
    if (method === "DELETE" && path.match(/^\/api\/backup\/[^/]+$/)) {
      const id = path.split("/")[3];
      await cleanupJob(id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`IDSC Backup Service running on port ${PORT}`);
