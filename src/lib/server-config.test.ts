import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_BUN_IDLE_TIMEOUT_SECONDS,
  DEFAULT_EPHEMERAL_BACKUP_STORAGE_DIR,
  DEFAULT_PERSISTENT_BACKUP_STORAGE_DIR,
  resolveBackupStorageDir,
  resolveBunIdleTimeoutSeconds,
} from "./server-config.ts";

const originalBackupStorageDir = process.env.BACKUP_STORAGE_DIR;
const originalIdleTimeout = process.env.BUN_IDLE_TIMEOUT_SECONDS;

afterEach(() => {
  if (originalBackupStorageDir === undefined) {
    delete process.env.BACKUP_STORAGE_DIR;
  } else {
    process.env.BACKUP_STORAGE_DIR = originalBackupStorageDir;
  }

  if (originalIdleTimeout === undefined) {
    delete process.env.BUN_IDLE_TIMEOUT_SECONDS;
  } else {
    process.env.BUN_IDLE_TIMEOUT_SECONDS = originalIdleTimeout;
  }
});

describe("server config", () => {
  test("prefers explicit BACKUP_STORAGE_DIR", () => {
    process.env.BACKUP_STORAGE_DIR = "/data/custom-backups";

    expect(resolveBackupStorageDir(() => false)).toBe("/data/custom-backups");
  });

  test("uses the persistent CapRover path when it exists", () => {
    delete process.env.BACKUP_STORAGE_DIR;

    expect(resolveBackupStorageDir((path) => path === DEFAULT_PERSISTENT_BACKUP_STORAGE_DIR.replace(/\/backups$/, ""))).toBe(
      DEFAULT_PERSISTENT_BACKUP_STORAGE_DIR
    );
  });

  test("falls back to ephemeral temp storage when no persistent path exists", () => {
    delete process.env.BACKUP_STORAGE_DIR;

    expect(resolveBackupStorageDir(() => false)).toBe(DEFAULT_EPHEMERAL_BACKUP_STORAGE_DIR);
  });

  test("uses a safe default Bun idle timeout", () => {
    delete process.env.BUN_IDLE_TIMEOUT_SECONDS;

    expect(resolveBunIdleTimeoutSeconds()).toBe(DEFAULT_BUN_IDLE_TIMEOUT_SECONDS);
  });

  test("accepts explicit Bun idle timeout overrides within Bun's limit", () => {
    process.env.BUN_IDLE_TIMEOUT_SECONDS = "180";

    expect(resolveBunIdleTimeoutSeconds()).toBe(180);
  });

  test("caps Bun idle timeout overrides at Bun's maximum", () => {
    process.env.BUN_IDLE_TIMEOUT_SECONDS = "300";

    expect(resolveBunIdleTimeoutSeconds()).toBe(255);
  });
});
