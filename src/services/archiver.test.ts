import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createZipBuilder } from "./archiver.ts";

const tempDirs: string[] = [];

async function inspectZip(zipPath: string) {
  const script = [
    "import json, sys, zipfile",
    "path = sys.argv[1]",
    "with zipfile.ZipFile(path) as z:",
    "    print(json.dumps({",
    "        'names': z.namelist(),",
    "        'contents': {name: z.read(name).decode('utf-8') for name in z.namelist()},",
    "        'compress_types': {name: z.getinfo(name).compress_type for name in z.namelist()},",
    "    }))",
  ].join("\n");

  const proc = Bun.spawnSync(["python3", "-c", script, zipPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }

  return JSON.parse(proc.stdout.toString()) as {
    names: string[];
    contents: Record<string, string>;
    compress_types: Record<string, number>;
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createZipBuilder", () => {
  test("appends streamed and buffered entries without recompressing stored files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "client-backup-archiver-"));
    tempDirs.push(dir);
    const zipPath = join(dir, "backup.zip");

    const zip = await createZipBuilder(zipPath);

    await zip.appendEntry({
      name: "media/streamed.txt",
      data: Readable.from(["streamed content"]),
      store: true,
    });

    await zip.appendEntry({
      name: "source/source.txt",
      data: new TextEncoder().encode("buffered content"),
      store: true,
    });

    await zip.finalize();

    const inspected = await inspectZip(zipPath);

    expect(inspected.names).toEqual(["media/streamed.txt", "source/source.txt"]);
    expect(inspected.contents["media/streamed.txt"]).toBe("streamed content");
    expect(inspected.contents["source/source.txt"]).toBe("buffered content");
    expect(inspected.compress_types["media/streamed.txt"]).toBe(0);
    expect(inspected.compress_types["source/source.txt"]).toBe(0);
  });
});
