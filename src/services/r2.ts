// Cloudflare R2 service — list and download objects via AWS S3 SDK
import { S3Client, ListObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
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

export async function listR2Objects(
  config: R2Config,
  onProgress?: (msg: string) => void
): Promise<R2Object[]> {
  onProgress?.("Fetching R2 file list...");
  const client = createR2Client(config);
  const allObjects: R2Object[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsCommand({
      Bucket: config.bucket,
      MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    });

    const res = await client.send(command);

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

    continuationToken = res.IsTruncated ? (res.NextContinuationToken ?? undefined) : undefined;
  } while (continuationToken);

  return allObjects;
}

export async function downloadR2Object(
  config: R2Config,
  key: string,
  onProgress?: (msg: string) => void
): Promise<Uint8Array> {
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

  const buffer = await res.Body.transformToByteArray();
  return new Uint8Array(buffer);
}
