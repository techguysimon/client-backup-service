export interface ArchivingMessageInput {
  processedFiles: number;
  totalFiles: number;
  processedBytesLabel: string;
  totalBytesLabel: string;
  activeDownloads: number;
}

export function formatActiveDownloadLabel(activeDownloads: number): string {
  return `${activeDownloads} active R2 download${activeDownloads === 1 ? "" : "s"}`;
}

export function buildArchivingMessage(input: ArchivingMessageInput): string {
  return `Archiving media... ${input.processedFiles}/${input.totalFiles} (${input.processedBytesLabel}/${input.totalBytesLabel}) with ${formatActiveDownloadLabel(input.activeDownloads)}`;
}
