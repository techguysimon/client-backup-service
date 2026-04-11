import { describe, expect, test } from "bun:test";

import { buildArchivingMessage, formatActiveDownloadLabel } from "./backup-status.ts";

describe("backup status wording", () => {
  test("formats singular and plural active download labels", () => {
    expect(formatActiveDownloadLabel(0)).toBe("0 active R2 downloads");
    expect(formatActiveDownloadLabel(1)).toBe("1 active R2 download");
    expect(formatActiveDownloadLabel(4)).toBe("4 active R2 downloads");
  });

  test("includes the actual active download count in archiving messages", () => {
    expect(
      buildArchivingMessage({
        processedFiles: 25,
        totalFiles: 100,
        processedBytesLabel: "25 MB",
        totalBytesLabel: "100 MB",
        activeDownloads: 1,
      })
    ).toBe("Archiving media... 25/100 (25 MB/100 MB) with 1 active R2 download");

    expect(
      buildArchivingMessage({
        processedFiles: 25,
        totalFiles: 100,
        processedBytesLabel: "25 MB",
        totalBytesLabel: "100 MB",
        activeDownloads: 3,
      })
    ).toBe("Archiving media... 25/100 (25 MB/100 MB) with 3 active R2 downloads");
  });
});
