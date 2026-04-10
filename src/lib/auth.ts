// Auth lib — simple password check
export function checkPassword(input: string): boolean {
  const pw = process.env.BACKUP_PASSWORD;
  if (!pw) throw new Error("BACKUP_PASSWORD not configured");
  return input === pw;
}
