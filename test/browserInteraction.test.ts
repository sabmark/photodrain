import assert from "node:assert/strict";
import test from "node:test";
import { desiredBrowserInteractionLock } from "../src/renderer/lib/browserInteraction.ts";

const baseState = {
  activeStep: "download-export",
  activeDownloadCount: 0,
  browserVisible: true,
  googleAuthRequired: false,
  status: "running"
};

test("unlocks Step 3 when Google needs manual download or password confirmation", () => {
  assert.equal(desiredBrowserInteractionLock({
    ...baseState,
    googleAuthRequired: true,
    status: "needs-manual-action"
  }), false);
});

test("manual action takes precedence over automation-only step locking", () => {
  assert.equal(desiredBrowserInteractionLock({
    ...baseState,
    activeStep: "photos-cleanup",
    status: "needs-manual-action"
  }), false);
});

test("keeps the Google panel locked during normal Step 3 automation", () => {
  assert.equal(desiredBrowserInteractionLock(baseState), true);
});

test("does not issue a lock command while the browser is hidden", () => {
  assert.equal(desiredBrowserInteractionLock({ ...baseState, browserVisible: false }), null);
});
