export interface CleanupActionEvidence {
  confirmationDetected: boolean;
  confirmationDismissed: boolean;
  completionObserved: boolean;
}

export interface CleanupActionDecision {
  ok: boolean;
  reason: string | null;
}

export function evaluateCleanupAction(evidence: CleanupActionEvidence): CleanupActionDecision {
  if (!evidence.confirmationDetected && !evidence.completionObserved) {
    return { ok: false, reason: "Google did not show the expected confirmation or a completed-action result." };
  }

  if (evidence.confirmationDetected && !evidence.confirmationDismissed) {
    return { ok: false, reason: "The Google confirmation remained open, so the action was not completed." };
  }

  if (!evidence.completionObserved) {
    return { ok: false, reason: "Google did not confirm that the action completed." };
  }

  return { ok: true, reason: null };
}
