import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const fetchMock = mock<typeof fetch>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { fetchRepoZipStream } = await import("./github.ts");

describe("fetchRepoZipStream", () => {
  test("returns a readable stream for the GitHub zipball", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "main" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response("zip-contents", {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        })
      );

    const stream = await fetchRepoZipStream(
      "techguysimon/idrivesocal-main",
      "main",
      "github-token"
    );

    expect(await new Response(stream as unknown as BodyInit).text()).toBe("zip-contents");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
