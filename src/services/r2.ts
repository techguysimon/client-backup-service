// Cloudflare R2 service — list and stream objects via AWS S3 SDK
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface R2Config {
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
  });
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
  onProgress?: (msg: string) => void
): Promise<R2Object[]> {
  onProgress?.("Fetching R2 file list...");
  const client = createR2Client(config);
  const allObjects: R2Object[] = [];
  let continuationToken: string | undefined;
  let page = 0;

  do {
    const command = new ListObjectsV2Command({
      Bucket: config.bucket,
      MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    });

    const res = await client.send(command);
    page += 1;

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
  onProgress?: (msg: string) => void
): Promise<Readable> {
  onProgress?.(`  Downloading ${key}...`);
  const client = createR2Client(config);

  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });

  const res = await client.send(command);

  if (!res.Body) {
    throw new Error(`Empty response for ${key}`);
  }

  return toNodeReadable(res.Body);
}

export async function downloadR2Object(
  config: R2Config,
  key: string,
  onProgress?: (msg: string) => void
): Promise<Uint8Array> {
  const stream = await downloadR2ObjectStream(config, key, onProgress);
  const buffer = await streamToBuffer(stream);
  return new Uint8Array(buffer);
}
