// Client Backup Service — Bun.serve entry point
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPassword } from "./lib/auth.js";
import { createJob, getJob, updateJob, addSSEController, removeSSEController, cleanupJob, broadcastDone, broadcastError } from "./lib/jobs.js";
import { fetchRepoZip } from "./services/github.js";
import { listR2Objects, downloadR2Object } from "./services/r2.js";
import { createBackupZip, type ArchiveEntry } from "./services/archiver.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "8080");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "techguysimon/idrivesocal-main";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? "main";
const R2_ENDPOINT = process.env.R2_ENDPOINT ?? "";
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY ?? "";
const R2_SECRET_KEY = process.env.R2_SECRET_KEY ?? "";
const R2_BUCKET = process.env.R2_BUCKET ?? "idrivesocal-media";
const TEMP_DIR = "/tmp/backups";

// ─── HTML UI ─────────────────────────────────────────────────────────────────
const UI_HTML = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");

// ─── Backup Job Runner ────────────────────────────────────────────────────────
async function runBackup(jobId: string) {
  const job = getJob(jobId);
  if (!job) return;
  const r2Config = { endpoint: R2_ENDPOINT, accessKey: R2_ACCESS_KEY, secretKey: R2_SECRET_KEY, bucket: R2_BUCKET };
  const entries: ArchiveEntry[] = [];

  try {
    // 1. Fetch GitHub zip
    updateJob(jobId, { status: "preparing", progress: 5, message: "Fetching source from GitHub..." });
    const repoName = GITHUB_REPO.replace("/", "-");
    const dateStr = new Date().toISOString().slice(0, 10);
    const sourceZip = await fetchRepoZip(GITHUB_REPO, GITHUB_BRANCH, GITHUB_TOKEN, (msg) =>
      updateJob(jobId, { message: msg })
    );
    entries.push({ name: `source/${repoName}-${dateStr}.zip`, data: sourceZip });
    updateJob(jobId, { progress: 20, message: "Source downloaded." });

    // 2. List R2 objects
    updateJob(jobId, { status: "downloading_r2", progress: 25, message: "Listing R2 files..." });
    const r2Objects = await listR2Objects(r2Config, (msg) =>
      updateJob(jobId, { message: msg })
    );
    if (r2Objects.length === 0) {
      updateJob(jobId, { progress: 100, message: "R2 bucket is empty — no media to download." });
    }
    updateJob(jobId, { progress: 30, message: `Found ${r2Objects.length} files in R2. Downloading...` });

    // 3. Download R2 files in batches of 10
    const batchSize = 10;
    const downloaded: { key: string; data: Uint8Array }[] = [];
    for (let i = 0; i < r2Objects.length; i += batchSize) {
      const batch = r2Objects.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((obj) =>
          downloadR2Object(r2Config, obj.key).then((data) => ({ key: obj.key, data }))
        )
      );
      downloaded.push(...batchResults);
      const pct = 30 + Math.round(((i + batch.length) / r2Objects.length) * 55);
      updateJob(jobId, { progress: pct, message: `Downloading media... ${i + batch.length}/${r2Objects.length}` });
    }

    // 4. Add media to archive
    updateJob(jobId, { status: "archiving", progress: 88, message: "Creating backup archive..." });
    for (const { key, data } of downloaded) {
      entries.push({ name: `media/${key}`, data });
    }

    // 5. Zip it all
    const zipPath = `${TEMP_DIR}/backup-${jobId}.zip`;
    await createBackupZip(entries, zipPath, (msg, pct) => {
      if (pct >= 0) updateJob(jobId, { progress: 88 + Math.round(pct * 0.1), message: msg });
    });

    updateJob(jobId, { status: "ready", progress: 100, message: "Backup ready!", zipPath });
    broadcastDone(jobId, zipPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcastError(jobId, msg);
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
      const job = createJob();
      runBackup(job.id); // fire and forget
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
        message: job.message,
        error: job.error,
      });
    }

    // GET /api/backup/:id/download → stream zip
    if (method === "GET" && path.match(/^\/api\/backup\/[^/]+\/download$/)) {
      const id = path.split("/")[3];
      const job = getJob(id);
      if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
      if (!job.zipPath) return Response.json({ error: "Zip not ready" }, { status: 400 });
      const { existsSync } = await import("node:fs");
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
        start(c) { ctrl = c; addSSEController(id, c); },
        cancel() { if (ctrl) removeSSEController(id, ctrl); },
      });

      const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Pragma": "no-cache",
        "Expires": "0",
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

console.log(`Client Backup Service running on port ${PORT}`);
