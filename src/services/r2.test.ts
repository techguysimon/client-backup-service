import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Readable } from "node:stream";

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
  send(command: { input?: Record<string, unknown> }) {
    return sendMock(command);
  }
}

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: MockS3Client,
  ListObjectsV2Command: MockListObjectsV2Command,
  GetObjectCommand: MockGetObjectCommand,
}));

const { listR2Objects, downloadR2ObjectStream } = await import("./r2.ts");

describe("r2 service", () => {
  beforeEach(() => {
    sendMock.mockClear();
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
});
