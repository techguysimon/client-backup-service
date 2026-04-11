import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { downloadR2ObjectToFile, type R2Config, type R2Object } from "./r2.js";

export interface PrefetchedR2Object {
  object: R2Object;
  tempPath: string;
  cleanup(): Promise<void>;
}

interface PrefetchR2ObjectsOptions {
  objects: R2Object[];
  tempDir: string;
  config?: R2Config;
  concurrency?: number;
  onProgress?: (msg: string) => void;
  downloadToFile?: (object: R2Object, tempPath: string) => Promise<void>;
}

type ScheduledDownloadResult =
  | { ok: true; value: PrefetchedR2Object }
  | { ok: false; error: unknown };

function normalizeConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

function buildTempPath(tempDir: string, index: number, key: string): string {
  const baseName = basename(key) || "object";
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return join(tempDir, `${String(index).padStart(6, "0")}-${safeName}`);
}

export async function* prefetchR2ObjectsToDisk(
  options: PrefetchR2ObjectsOptions
): AsyncGenerator<PrefetchedR2Object> {
  const concurrency = normalizeConcurrency(options.concurrency);
  const { objects, tempDir } = options;

  mkdirSync(tempDir, { recursive: true });

  const downloadToFile = options.downloadToFile ?? (async (object: R2Object, tempPath: string) => {
    if (!options.config) {
      throw new Error("prefetchR2ObjectsToDisk requires config when no custom downloadToFile is provided");
    }

    await downloadR2ObjectToFile(options.config, object.key, tempPath, options.onProgress);
  });

  let nextToSchedule = 0;
  const scheduled = new Map<number, Promise<ScheduledDownloadResult>>();

  const scheduleMore = () => {
    while (scheduled.size < concurrency && nextToSchedule < objects.length) {
      const index = nextToSchedule;
      const object = objects[index];
      const tempPath = buildTempPath(tempDir, index, object.key);

      const scheduledDownload = (async (): Promise<ScheduledDownloadResult> => {
        try {
          await downloadToFile(object, tempPath);
          return {
            ok: true,
            value: {
              object,
              tempPath,
              cleanup: async () => {
                await rm(tempPath, { force: true });
              },
            },
          };
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => {});
          return { ok: false, error };
        }
      })();

      scheduled.set(index, scheduledDownload);
      nextToSchedule += 1;
    }
  };

  scheduleMore();

  try {
    for (let index = 0; index < objects.length; index += 1) {
      const resultPromise = scheduled.get(index);
      if (!resultPromise) {
        throw new Error(`Missing prefetched R2 download for index ${index}`);
      }

      const result = await resultPromise;
      scheduled.delete(index);
      scheduleMore();

      if (result.ok === false) {
        throw result.error;
      }

      yield result.value;
    }
  } finally {
    const remainingResults = await Promise.allSettled(Array.from(scheduled.values()));
    const tempPaths = remainingResults.flatMap((result) => {
      if (result.status !== "fulfilled" || !result.value.ok) {
        return [];
      }

      return [result.value.value.tempPath];
    });

    await Promise.allSettled(tempPaths.map((tempPath) => rm(tempPath, { force: true })));
  }
}
