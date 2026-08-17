export type DownloadProgressStatus = "idle" | "downloading" | "paused" | "partially-paused";

export interface DownloadProgressSample {
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  isPaused: boolean;
  canResume: boolean;
}

export interface DownloadProgressItem extends Omit<DownloadProgressSample, "totalBytes"> {
  totalBytes: number | null;
  percentComplete: number | null;
  etaSeconds: number | null;
}

export interface DownloadProgressSummary {
  status: DownloadProgressStatus;
  receivedBytes: number;
  totalBytes: number | null;
  percentComplete: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
  items: DownloadProgressItem[];
}

function percentage(receivedBytes: number, totalBytes: number) {
  return Math.min(100, Math.max(0, (receivedBytes / totalBytes) * 100));
}

function eta(receivedBytes: number, totalBytes: number, bytesPerSecond: number) {
  if (bytesPerSecond <= 0) {
    return null;
  }
  return Math.max(0, (totalBytes - receivedBytes) / bytesPerSecond);
}

export function summarizeDownloadProgress(samples: DownloadProgressSample[]): DownloadProgressSummary {
  const normalized = samples.map((sample) => ({
    ...sample,
    receivedBytes: Math.max(0, sample.receivedBytes),
    totalBytes: Math.max(0, sample.totalBytes),
    bytesPerSecond: sample.isPaused ? 0 : Math.max(0, sample.bytesPerSecond)
  }));
  const pausedCount = normalized.filter((sample) => sample.isPaused).length;
  const hasUnknownTotal = normalized.some((sample) => sample.totalBytes <= 0);
  const receivedBytes = normalized.reduce((sum, sample) => sum + sample.receivedBytes, 0);
  const knownTotalBytes = normalized.reduce((sum, sample) => sum + sample.totalBytes, 0);
  const totalBytes = normalized.length > 0 && !hasUnknownTotal ? knownTotalBytes : null;
  const bytesPerSecond = normalized.reduce((sum, sample) => sum + sample.bytesPerSecond, 0);
  const status: DownloadProgressStatus = normalized.length === 0
    ? "idle"
    : pausedCount === normalized.length
      ? "paused"
      : pausedCount > 0
        ? "partially-paused"
        : "downloading";

  return {
    status,
    receivedBytes,
    totalBytes,
    percentComplete: totalBytes && totalBytes > 0 ? percentage(receivedBytes, totalBytes) : null,
    bytesPerSecond,
    etaSeconds: totalBytes && status === "downloading" ? eta(receivedBytes, totalBytes, bytesPerSecond) : null,
    items: normalized.map((sample) => ({
      ...sample,
      totalBytes: sample.totalBytes > 0 ? sample.totalBytes : null,
      percentComplete: sample.totalBytes > 0 ? percentage(sample.receivedBytes, sample.totalBytes) : null,
      etaSeconds: !sample.isPaused && sample.totalBytes > 0
        ? eta(sample.receivedBytes, sample.totalBytes, sample.bytesPerSecond)
        : null
    }))
  };
}
