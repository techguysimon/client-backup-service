import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

let lastS3ClientConfig: Record<string, unknown> | undefined;
let lastHttpHandlerOptions: Record<string, unknown> | undefined;

const sendMock = mock(async (command: { input?: Record<string, unknown> }) => {
  if (command instanceof MockListObjectsV2Command) {
    const token = command.input?.ContinuationToken as string | undefined;

    if (!token) {
      return {
        Contents: [
          {
            Key: "first.jpg",
            Size: 123,
            LastModified: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
        IsTruncated: true,
        NextContinuationToken: "page-2",
      };
    }

    return {
      Contents: [
        {
          Key: "second.jpg",
          Size: 456,
          LastModified: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      IsTruncated: false,
    };
  }

  if (command instanceof MockGetObjectCommand) {
    return {
      Body: Readable.from(["streamed-object"]),
    };
  }

  throw new Error(`Unexpected command: ${command?.constructor?.name ?? "unknown"}`);
});

class MockListObjectsV2Command {
  constructor(public input: Record<string, unknown>) {}
}

class MockGetObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}

class MockS3Client {
  constructor(config?: Record<string, unknown>) {
    lastS3ClientConfig = config;
  }

  send(command: { input?: Record<string, unknown> }) {
    return sendMock(command);
  }
}

class MockNodeHttpHandler {
  constructor(options?: Record<string, unknown>) {
    lastHttpHandlerOptions = options;
  }
}

mock.module("@smithy/node-http-handler", () => ({
  NodeHttpHandler: MockNodeHttpHandler,
}));

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: MockS3Client,
  ListObjectsV2Command: MockListObjectsV2Command,
  GetObjectCommand: MockGetObjectCommand,
}));

const tempDirs: string[] = [];
const { listR2Objects, downloadR2ObjectStream, downloadR2ObjectToFile } = await import("./r2.ts");

describe("r2 service", () => {
  beforeEach(() => {
    sendMock.mockClear();
    lastS3ClientConfig = undefined;
    lastHttpHandlerOptions = undefined;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("continues through every truncated page", async () => {
    const objects = await listR2Objects({
      endpoint: "https://example.r2.cloudflarestorage.com",
      accessKey: "test-access-key",
      secretKey: "test-secret-key",
      bucket: "test-bucket",
    });

    expect(objects).toHaveLength(2);
    expect(objects.map((object) => object.key)).toEqual(["first.jpg", "second.jpg"]);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  test("configures R2 requests with explicit HTTP timeouts", async () => {
    await downloadR2ObjectStream(
      {
        endpoint: "https://example.r2.cloudflarestorage.com",
        accessKey: "test-access-key",
        secretKey: "test-secret-key",
        bucket: "test-bucket",
      },
      "first.jpg"
    );

    expect(lastS3ClientConfig?.requestHandler).toBeDefined();
    expect(lastHttpHandlerOptions).toBeDefined();
    expect(lastHttpHandlerOptions?.connectionTimeout).toBeGreaterThan(0);
    expect(lastHttpHandlerOptions?.requestTimeout).toBeGreaterThan(0);
    expect(lastHttpHandlerOptions?.socketTimeout).toBeGreaterThan(0);
  });

  test("returns an object body as a stream", async () => {
    const stream = await downloadR2ObjectStream(
      {
        endpoint: "https://example.r2.cloudflarestorage.com",
        accessKey: "test-access-key",
        secretKey: "test-secret-key",
        bucket: "test-bucket",
      },
      "first.jpg"
    );

    expect(await new Response(stream as unknown as BodyInit).text()).toBe("streamed-object");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test("writes an object body directly to a temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "client-backup-r2-file-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "first.jpg");

    const writtenPath = await downloadR2ObjectToFile(
      {
        endpoint: "https://example.r2.cloudflarestorage.com",
        accessKey: "test-access-key",
        secretKey: "test-secret-key",
        bucket: "test-bucket",
      },
      "first.jpg",
      outputPath
    );

    expect(writtenPath).toBe(outputPath);
    expect(readFileSync(outputPath, "utf8")).toBe("streamed-object");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
