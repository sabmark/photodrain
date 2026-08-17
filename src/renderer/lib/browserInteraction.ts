export interface BrowserInteractionState {
  activeStep: string;
  activeDownloadCount: number;
  browserVisible: boolean;
  googleAuthRequired: boolean;
  status: string;
}

const automationLockedSteps = new Set(["download-export", "backup-summary", "photos-cleanup"]);

export function desiredBrowserInteractionLock(state: BrowserInteractionState): boolean | null {
  if (!state.browserVisible) {
    return null;
  }

  if (state.googleAuthRequired || state.status === "needs-manual-action") {
    return false;
  }

  if (automationLockedSteps.has(state.activeStep)) {
    return true;
  }

  if (state.activeDownloadCount === 0 && state.status !== "running") {
    return false;
  }

  return null;
}
