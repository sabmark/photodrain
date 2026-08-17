import assert from "node:assert/strict";
import test from "node:test";
import { waitForDownloadStartSignal } from "../electron/downloadStartWait.ts";
import { isManualGoogleAuthChallenge } from "../electron/googleAuth.ts";

test("recognizes Google password and reauthentication challenges without inspecting credentials", () => {
  assert.equal(isManualGoogleAuthChallenge("https://accounts.google.com/v3/signin/challenge/pwd"), true);
  assert.equal(isManualGoogleAuthChallenge("https://takeout.google.com/manage/archive/123", "To continue, first verify it's you"), true);
  assert.equal(isManualGoogleAuthChallenge("https://takeout.google.com/manage/archive/123", "Your export is ready to download"), false);
});

test("suspends the download-start timeout while manual Google authentication is pending", async () => {
  let now = 0;
  let authChecks = 0;
  let downloadStarted = false;

  const outcome = await waitForDownloadStartSignal({
    timeoutMs: 20_000,
    pollIntervalMs: 1_000,
    now: () => now,
    waitForReady: async () => {
      now += 1_000;
    },
    waitForManualAuthentication: async () => {
      authChecks += 1;
      if (authChecks === 1) {
        now += 60_000;
        return true;
      }
      downloadStarted = true;
      return false;
    },
    detectDownloadLimit: async () => false,
    hasDownloadStarted: () => downloadStarted,
    sleep: async (ms) => {
      now += ms;
    }
  });

  assert.equal(outcome, "download-started");
});

test("reports no download so the caller can stop instead of restarting the export", async () => {
  let now = 0;
  const outcome = await waitForDownloadStartSignal({
    timeoutMs: 2_000,
    pollIntervalMs: 500,
    now: () => now,
    waitForReady: async () => undefined,
    waitForManualAuthentication: async () => false,
    detectDownloadLimit: async () => false,
    hasDownloadStarted: () => false,
    sleep: async (ms) => {
      now += ms;
    }
  });

  assert.equal(outcome, "no-download");
});
