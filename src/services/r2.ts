// Cloudflare R2 service — list and stream objects via AWS S3 SDK
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface R2Config {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: string;
}

const R2_CONNECTION_TIMEOUT_MS = 10_000;
const R2_REQUEST_TIMEOUT_MS = 30_000;
const R2_SOCKET_TIMEOUT_MS = 10_000;
const R2_STREAM_IDLE_TIMEOUT_MS = 10_000;
const R2_RETRY_ATTEMPTS = 4;
const R2_RETRY_BASE_DELAY_MS = 1_000;

function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
      socketTimeout: R2_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    }),
  });
}

function getR2StreamIdleTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.R2_STREAM_IDLE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : R2_STREAM_IDLE_TIMEOUT_MS;
}

function createCancellationError(): Error {
  const error = new Error("Backup cancelled");
  error.name = "CancellationError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createCancellationError();
  }
}

async function pipelineWithIdleTimeout(stream: Readable, outputPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  const idleTimeoutMs = getR2StreamIdleTimeoutMs();
  let lastActivity = Date.now();
  const onData = () => {
    lastActivity = Date.now();
  };
  const onAbort = () => {
    stream.destroy(createCancellationError());
  };

  stream.on("data", onData);
  signal?.addEventListener("abort", onAbort, { once: true });

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity <= idleTimeoutMs) {
      return;
    }

    const error = new Error(`R2 stream idle for ${idleTimeoutMs}ms`);
    error.name = "TimeoutError";
    stream.destroy(error);
  }, Math.max(25, Math.min(1_000, Math.floor(idleTimeoutMs / 2))));

  try {
    await pipeline(stream, createWriteStream(outputPath));
  } finally {
    clearInterval(idleTimer);
    stream.off("data", onData);
    signal?.removeEventListener("abort", onAbort);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function isRetryableR2Error(error: unknown): boolean {
  const description = formatError(error).toLowerCase();

  return !(
    description.includes("cancellationerror") ||
    description.includes("aborterror") ||
    description.includes("backup cancelled") ||
    description.includes("nosuchkey") ||
    description.includes("not found") ||
    description.includes("status code 404")
  );
}

async function retryR2Operation<T>(
  label: string,
  operation: () => Promise<T>,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < R2_RETRY_ATTEMPTS) {
    attempt += 1;
    throwIfAborted(signal);

    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableR2Error(error) || attempt >= R2_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = R2_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      onProgress?.(`${label} failed (${formatError(error)}). Retrying in ${delayMs}ms (${attempt}/${R2_RETRY_ATTEMPTS})...`);
      await Bun.sleep(delayMs);
      throwIfAborted(signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed after retries`);
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body;
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "pipe" in body &&
    typeof body.pipe === "function"
  ) {
    return body as Readable;
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "transformToWebStream" in body &&
    typeof body.transformToWebStream === "function"
  ) {
    return Readable.fromWeb(
      (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream() as any
    );
  }

  if (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body
  ) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }

  throw new Error("Unsupported R2 object body type");
}

export async function listR2Objects(
  config: R2Config,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<R2Object[]> {
  onProgress?.("Fetching R2 file list...");
  const allObjects: R2Object[] = [];
  let continuationToken: string | undefined;
  let page = 0;

  do {
    const currentPage = page + 1;
    const res = await retryR2Operation(
      `Listing R2 page ${currentPage}`,
      async () => {
        throwIfAborted(signal);
        const client = createR2Client(config);
        const command = new ListObjectsV2Command({
          Bucket: config.bucket,
          MaxKeys: 1000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        });

        return client.send(command, signal ? { abortSignal: signal } : undefined);
      },
      onProgress,
      signal
    );
    page = currentPage;

    if (res.Contents) {
      for (const obj of res.Contents) {
        if (obj.Key) {
          allObjects.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? "",
          });
        }
      }
    }

    onProgress?.(`Fetching R2 file list... ${allObjects.length} objects found (page ${page})`);
    continuationToken = res.IsTruncated ? (res.NextContinuationToken ?? undefined) : undefined;
  } while (continuationToken);

  return allObjects;
}

export async function downloadR2ObjectStream(
  config: R2Config,
  key: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<Readable> {
  throwIfAborted(signal);
  onProgress?.(`  Downloading ${key}...`);
  const client = createR2Client(config);

  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });

  const res = await client.send(command, signal ? { abortSignal: signal } : undefined);

  if (!res.Body) {
    throw new Error(`Empty response for ${key}`);
  }

  return toNodeReadable(res.Body);
}

export async function downloadR2ObjectToFile(
  config: R2Config,
  key: string,
  outputPath: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return retryR2Operation(
    `Downloading ${key}`,
    async () => {
      throwIfAborted(signal);
      await rm(outputPath, { force: true }).catch(() => {});
      const stream = await downloadR2ObjectStream(config, key, onProgress, signal);
      await pipelineWithIdleTimeout(stream, outputPath, signal);
      return outputPath;
    },
    onProgress,
    signal
  );
}

export async function downloadR2Object(
  config: R2Config,
  key: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const stream = await downloadR2ObjectStream(config, key, onProgress, signal);
  const buffer = await streamToBuffer(stream);
  return new Uint8Array(buffer);
}
