export const DEFAULT_PERSISTENT_STORAGE_ROOT = "/captain/data";
export const DEFAULT_PERSISTENT_BACKUP_STORAGE_DIR = `${DEFAULT_PERSISTENT_STORAGE_ROOT}/backups`;
export const DEFAULT_EPHEMERAL_BACKUP_STORAGE_DIR = "/tmp/backups";
export const DEFAULT_BUN_IDLE_TIMEOUT_SECONDS = 300;

export function resolveBackupStorageDir(pathExists: (path: string) => boolean = () => false): string {
  const configured = process.env.BACKUP_STORAGE_DIR?.trim();
  if (configured) {
    return configured;
  }

  if (pathExists(DEFAULT_PERSISTENT_STORAGE_ROOT)) {
    return DEFAULT_PERSISTENT_BACKUP_STORAGE_DIR;
  }

  return DEFAULT_EPHEMERAL_BACKUP_STORAGE_DIR;
}

export function resolveBunIdleTimeoutSeconds(): number {
  const raw = process.env.BUN_IDLE_TIMEOUT_SECONDS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return DEFAULT_BUN_IDLE_TIMEOUT_SECONDS;
}
