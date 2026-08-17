import assert from "node:assert/strict";
import test from "node:test";
import { pauseDownloads, resumeDownloads, type ControllableDownload } from "../electron/downloadControls.ts";

function fakeDownload(options: { paused?: boolean; resumable?: boolean; failResume?: boolean } = {}) {
  let paused = options.paused ?? false;
  const item: ControllableDownload = {
    isPaused: () => paused,
    canResume: () => options.resumable ?? true,
    pause: () => {
      paused = true;
    },
    resume: () => {
      if (options.failResume) {
        throw new Error("resume failed");
      }
      paused = false;
    }
  };
  return item;
}

test("pauses running items and leaves already-paused items alone", () => {
  const result = pauseDownloads([fakeDownload(), fakeDownload({ paused: true })]);
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, mayRestart: 0 });
});

test("resumes paused items and flags transfers that may restart from zero", () => {
  const result = resumeDownloads([
    fakeDownload({ paused: true }),
    fakeDownload({ paused: true, resumable: false })
  ]);
  assert.deepEqual(result, { attempted: 2, succeeded: 2, failed: 0, mayRestart: 1 });
});

test("reports resume failures instead of claiming success", () => {
  const result = resumeDownloads([fakeDownload({ paused: true, failResume: true })]);
  assert.deepEqual(result, { attempted: 1, succeeded: 0, failed: 1, mayRestart: 0 });
});

test("resumes an interrupted candidate even when Electron does not mark it paused", () => {
  const result = resumeDownloads([fakeDownload({ paused: false })]);
  assert.deepEqual(result, { attempted: 1, succeeded: 1, failed: 0, mayRestart: 0 });
});
