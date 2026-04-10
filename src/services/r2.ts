// Cloudflare R2 service — list and download objects via S3-compatible API
// Uses native fetch with AWS Signature Version 4 signing (no AWS SDK needed)

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

function hmacSha256(key: Uint8Array, data: string): Uint8Array {
  const { createHmac } = require("crypto") as typeof import("crypto");
  return createHmac("sha256", Buffer.from(key)).update(data).digest();
}

function sha256Hex(data: string): string {
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(data).digest("hex");
}

function buildAuthHeaders(
  method: string,
  path: string,
  config: R2Config,
  contentSha256: string,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";

  const signedHeaders: Record<string, string> = {
    ...extraHeaders,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": contentSha256,
    "x-amz-bucket-region": region,
  };

  // Sort headers case-insensitively
  const sortedHeaderNames = Object.keys(signedHeaders)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const canonicalHeaders = sortedHeaderNames
    .map(k => `${k.toLowerCase()}:${signedHeaders[k]}`)
    .join("\n") + "\n";

  const signedHeaderNames = sortedHeaderNames.map(k => k.toLowerCase()).join(";");

  const canonicalRequest = [
    method,
    path,
    "", // no query string
    canonicalHeaders,
    signedHeaderNames,
    contentSha256,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(Buffer.from(`AWS4${config.secretKey}`, "utf8"), dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

  const headers: Record<string, string> = {
    ...signedHeaders,
    Authorization: authorization,
  };

  return headers;
}

function s3Request(
  method: string,
  urlPath: string,
  config: R2Config,
  body?: string
): Record<string, string> {
  const path = `/${config.bucket}${urlPath}`;
  const sha256 = body ? sha256Hex(body) : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return buildAuthHeaders(method, path, config, sha256);
}

function parseR2ListXml(xml: string): Array<{ key: string; size: number; lastModified: string }> {
  const results: Array<{ key: string; size: number; lastModified: string }> = [];

  // Parse Key, Size, LastModified in order — each <Contents> block
  const contentsBlocks = xml.split("<Contents>");
  for (const block of contentsBlocks) {
    if (!block.includes("<Key>")) continue;
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    const sizeMatch = /<Size>(\d+)<\/Size>/.exec(block);
    const dateMatch = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
    if (keyMatch) {
      results.push({
        key: keyMatch[1].trim(),
        size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
        lastModified: dateMatch ? dateMatch[1].trim() : "",
      });
    }
  }
  return results;
}

export async function listR2Objects(
  config: R2Config,
  onProgress?: (msg: string) => void
): Promise<R2Object[]> {
  onProgress?.("Fetching R2 file list...");
  const path = "/?list-type=2&max-keys=1000";
  const headers = s3Request("GET", path, config);
  const res = await fetch(`${config.endpoint}${path}`, { headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 list failed (${res.status}): ${text}`);
  }

  const xml = await res.text();
  const objects = parseR2ListXml(xml);
  const allObjects = [...objects];

  // Handle pagination
  if (xml.includes("<IsTruncated>true</IsTruncated>")) {
    let continuationToken = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1];
    while (continuationToken) {
      const nextPath = `/?list-type=2&max-keys=1000&continuation-token=${encodeURIComponent(continuationToken)}`;
      const nextHeaders = s3Request("GET", nextPath, config);
      const nextRes = await fetch(`${config.endpoint}${nextPath}`, { headers: nextHeaders });
      if (!nextRes.ok) break;
      const nextXml = await nextRes.text();
      allObjects.push(...parseR2ListXml(nextXml));
      if (nextXml.includes("<IsTruncated>true</IsTruncated>")) {
        continuationToken = nextXml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] ?? "";
      } else {
        break;
      }
    }
  }

  return allObjects;
}

export async function downloadR2Object(
  config: R2Config,
  key: string,
  onProgress?: (msg: string) => void
): Promise<Uint8Array> {
  onProgress?.(`  Downloading ${key}...`);
  const path = `/${encodeURIComponent(key)}`;
  const headers = s3Request("GET", path, config);
  const res = await fetch(`${config.endpoint}/${config.bucket}${path}`, { headers });
  if (!res.ok) throw new Error(`R2 download failed for ${key} (${res.status})`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}
