export type DownloadStartOutcome = "download-started" | "limit-reached" | "modal-blocked" | "no-download";

interface DownloadStartWaitOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  waitForReady: () => Promise<void>;
  waitForManualAuthentication: () => Promise<boolean>;
  detectDownloadLimit: () => Promise<boolean | "blocked">;
  hasDownloadStarted: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForDownloadStartSignal(options: DownloadStartWaitOptions): Promise<DownloadStartOutcome> {
  const now = options.now || Date.now;
  let started = now();

  while (true) {
    await options.waitForReady();

    if (await options.waitForManualAuthentication()) {
      started = now();
      continue;
    }

    const limitState = await options.detectDownloadLimit();
    if (limitState === "blocked") {
      if (await options.waitForManualAuthentication()) {
        started = now();
        continue;
      }
      return "modal-blocked";
    }
    if (limitState === true) {
      return "limit-reached";
    }
    if (options.hasDownloadStarted()) {
      return "download-started";
    }
    if (now() - started >= options.timeoutMs) {
      return "no-download";
    }

    await options.sleep(options.pollIntervalMs);
  }
}
