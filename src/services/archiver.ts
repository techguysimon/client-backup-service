// Archiver service — stream source zip + R2 files into a single backup archive
import archiver from "archiver";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

export type ArchiveData = Uint8Array | ArrayBuffer | Readable | ReadableStream<Uint8Array>;

export interface ArchiveEntry {
  name: string;
  data: ArchiveData;
  store?: boolean;
}

export interface ZipBuilder {
  appendEntry(entry: ArchiveEntry): Promise<void>;
  finalize(): Promise<string>;
}

function isWebReadableStream(value: ArchiveData): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && "getReader" in value && typeof value.getReader === "function";
}

function toArchiveSource(data: ArchiveData): Buffer | Readable {
  if (data instanceof Readable) {
    return data;
  }

  if (isWebReadableStream(data)) {
    return Readable.fromWeb(data as any);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  return Buffer.from(data);
}

export async function createZipBuilder(
  outputPath: string,
  onProgress?: (msg: string, percent: number) => void
): Promise<ZipBuilder> {
  const { createWriteStream } = await import("node:fs");

  const output = createWriteStream(outputPath);
  const archive = archiver("zip", { zlib: { level: 6 } });

  let settled = false;
  const done = new Promise<string>((resolve, reject) => {
    output.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(outputPath);
      }
    });

    output.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    archive.on("warning", (err: Error & { code?: string }) => {
      if (err.code === "ENOENT") {
        onProgress?.(`Archive warning: ${err.message}`, -1);
        return;
      }

      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    archive.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });

  archive.pipe(output);

  return {
    async appendEntry(entry: ArchiveEntry) {
      onProgress?.(`Adding ${entry.name}...`, -1);

      const source = toArchiveSource(entry.data);
      const sourceDone = source instanceof Readable ? finished(source) : null;

      archive.append(source, {
        name: entry.name,
        store: entry.store ?? false,
      });

      if (sourceDone) {
        await sourceDone;
      }
    },

    async finalize() {
      await archive.finalize();
      return done;
    },
  };
}

export async function createBackupZip(
  entries: ArchiveEntry[],
  outputPath: string,
  onProgress?: (msg: string, percent: number) => void
): Promise<string> {
  const zip = await createZipBuilder(outputPath, onProgress);

  for (const entry of entries) {
    await zip.appendEntry(entry);
  }

  return zip.finalize();
}
