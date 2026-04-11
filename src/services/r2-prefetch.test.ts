import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prefetchR2ObjectsToDisk } from "./r2-prefetch.ts";
import type { R2Object } from "./r2.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("prefetchR2ObjectsToDisk", () => {
  test("yields files in original order while bounding concurrent temp downloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "client-backup-prefetch-"));
    tempDirs.push(dir);

    const objects: R2Object[] = [
      { key: "a.jpg", size: 100, lastModified: "2026-01-01T00:00:00.000Z" },
      { key: "b.jpg", size: 100, lastModified: "2026-01-02T00:00:00.000Z" },
      { key: "c.jpg", size: 100, lastModified: "2026-01-03T00:00:00.000Z" },
    ];

    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    const startedKeys: string[] = [];
    const yieldedKeys: string[] = [];
    const fileCountsDuringYield: number[] = [];
    const reportedActiveDownloads: number[] = [];

    const delays = new Map([
      ["a.jpg", 60],
      ["b.jpg", 10],
      ["c.jpg", 10],
    ]);

    for await (const prefetched of prefetchR2ObjectsToDisk({
      objects,
      tempDir: dir,
      concurrency: 2,
      onStateChange: (state) => {
        reportedActiveDownloads.push(state.activeDownloads);
      },
      downloadToFile: async (object, tempPath) => {
        startedKeys.push(object.key);
        activeDownloads += 1;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        await Bun.sleep(delays.get(object.key) ?? 1);
        await Bun.write(tempPath, `file:${object.key}`);
        activeDownloads -= 1;
      },
    })) {
      yieldedKeys.push(prefetched.object.key);
      fileCountsDuringYield.push(readdirSync(dir).length);
      expect(readFileSync(prefetched.tempPath, "utf8")).toBe(`file:${prefetched.object.key}`);
      await prefetched.cleanup();
    }

    expect(yieldedKeys).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(startedKeys.slice(0, 2)).toEqual(["a.jpg", "b.jpg"]);
    expect(maxActiveDownloads).toBe(2);
    expect(Math.max(...fileCountsDuringYield)).toBeLessThanOrEqual(2);
    expect(reportedActiveDownloads).toContain(2);
    expect(reportedActiveDownloads[reportedActiveDownloads.length - 1]).toBe(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
