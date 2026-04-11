import { describe, expect, test } from "bun:test";

import {
  createJob,
  cleanupJob,
  hasActiveBackupJob,
  isJobCancellationRequested,
  requestJobCancellation,
  updateJob,
} from "./jobs.ts";

describe("job state", () => {
  test("returns true only while a backup is actively running", async () => {
    const job = createJob();

    expect(hasActiveBackupJob()).toBeTrue();

    updateJob(job.id, { status: "ready", progress: 100, message: "Done" });
    expect(hasActiveBackupJob()).toBeFalse();

    const errorJob = createJob();
    updateJob(errorJob.id, { status: "error", message: "Boom", error: "Boom" });
    expect(hasActiveBackupJob()).toBeFalse();

    await cleanupJob(job.id);
    await cleanupJob(errorJob.id);
  });

  test("tracks cancellation requests without immediately clearing active work", async () => {
    const job = createJob();

    expect(isJobCancellationRequested(job.id)).toBeFalse();

    requestJobCancellation(job.id, "Cancelling backup...");

    expect(isJobCancellationRequested(job.id)).toBeTrue();
    expect(hasActiveBackupJob()).toBeTrue();

    await cleanupJob(job.id);
  });
});
