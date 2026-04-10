// Archiver service — assembles source zip + R2 files into a single backup archive
import archiver from "archiver";
import type { Readable } from "node:stream";

export interface ArchiveEntry {
  name: string;
  data: Uint8Array | Readable;
}

export async function createBackupZip(
  entries: ArchiveEntry[],
  outputPath: string,
  onProgress?: (msg: string, percent: number) => void
): Promise<string> {
  const { createWriteStream } = await import("node:fs");
  const { promises: fs } = await import("node:fs");

  const output = createWriteStream(outputPath);
  const archive = archiver("zip", { zlib: { level: 6 } });

  let resolved = false;
  const done = new Promise<string>((resolve, reject) => {
    output.on("close", () => {
      if (!resolved) { resolved = true; resolve(outputPath); }
    });
    archive.on("error", (err: Error) => {
      if (!resolved) { resolved = true; reject(err); }
    });
  });

  archive.pipe(output);

  // Add source zip
  for (const entry of entries) {
    onProgress?.(`Adding ${entry.name}...`, -1);
    archive.append(entry.data, { name: entry.name });
  }

  archive.finalize();
  await done;
  return outputPath;
}
