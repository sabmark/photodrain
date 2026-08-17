import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCleanupAction } from "../electron/cleanupSafety.ts";

test("rejects cleanup when neither a confirmation nor completion evidence appears", () => {
  assert.deepEqual(evaluateCleanupAction({
    confirmationDetected: false,
    confirmationDismissed: false,
    completionObserved: false
  }), {
    ok: false,
    reason: "Google did not show the expected confirmation or a completed-action result."
  });
});

test("rejects cleanup when the Google confirmation remains open", () => {
  assert.deepEqual(evaluateCleanupAction({
    confirmationDetected: true,
    confirmationDismissed: false,
    completionObserved: false
  }), {
    ok: false,
    reason: "The Google confirmation remained open, so the action was not completed."
  });
});

test("rejects cleanup when a dialog click has no verified result", () => {
  assert.deepEqual(evaluateCleanupAction({
    confirmationDetected: true,
    confirmationDismissed: true,
    completionObserved: false
  }), {
    ok: false,
    reason: "Google did not confirm that the action completed."
  });
});

test("accepts cleanup only after completion is observed", () => {
  assert.deepEqual(evaluateCleanupAction({
    confirmationDetected: true,
    confirmationDismissed: true,
    completionObserved: true
  }), { ok: true, reason: null });
});

test("accepts an immediate Google action when completion is independently observed", () => {
  assert.deepEqual(evaluateCleanupAction({
    confirmationDetected: false,
    confirmationDismissed: false,
    completionObserved: true
  }), { ok: true, reason: null });
});
