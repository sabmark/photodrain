export interface ControllableDownload {
  isPaused(): boolean;
  canResume(): boolean;
  pause(): void;
  resume(): void;
}

export interface DownloadControlResult {
  attempted: number;
  succeeded: number;
  failed: number;
  mayRestart: number;
}

export function pauseDownloads(items: ControllableDownload[]): DownloadControlResult {
  const result = { attempted: 0, succeeded: 0, failed: 0, mayRestart: 0 };
  for (const item of items) {
    if (item.isPaused()) {
      continue;
    }
    result.attempted += 1;
    try {
      item.pause();
      if (item.isPaused()) {
        result.succeeded += 1;
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export function resumeDownloads(items: ControllableDownload[]): DownloadControlResult {
  const result = { attempted: 0, succeeded: 0, failed: 0, mayRestart: 0 };
  for (const item of items) {
    result.attempted += 1;
    if (!item.canResume()) {
      result.mayRestart += 1;
    }
    try {
      item.resume();
      if (!item.isPaused()) {
        result.succeeded += 1;
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
