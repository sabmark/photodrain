import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDownloadProgress } from "../electron/downloadProgress.ts";

test("summarizes aggregate download percentage, speed, and ETA", () => {
  const summary = summarizeDownloadProgress([
    {
      filename: "takeout-1.zip",
      receivedBytes: 500,
      totalBytes: 1_000,
      bytesPerSecond: 100,
      isPaused: false,
      canResume: true
    },
    {
      filename: "takeout-2.zip",
      receivedBytes: 250,
      totalBytes: 500,
      bytesPerSecond: 50,
      isPaused: false,
      canResume: true
    }
  ]);

  assert.equal(summary.status, "downloading");
  assert.equal(summary.receivedBytes, 750);
  assert.equal(summary.totalBytes, 1_500);
  assert.equal(summary.percentComplete, 50);
  assert.equal(summary.bytesPerSecond, 150);
  assert.equal(summary.etaSeconds, 5);
  assert.equal(summary.items[0]?.percentComplete, 50);
});

test("reports paused downloads without inventing speed or ETA", () => {
  const summary = summarizeDownloadProgress([
    {
      filename: "takeout.zip",
      receivedBytes: 500,
      totalBytes: 1_000,
      bytesPerSecond: 90,
      isPaused: true,
      canResume: true
    }
  ]);

  assert.equal(summary.status, "paused");
  assert.equal(summary.percentComplete, 50);
  assert.equal(summary.bytesPerSecond, 0);
  assert.equal(summary.etaSeconds, null);
});

test("keeps percentage and ETA unknown when any active total is unavailable", () => {
  const summary = summarizeDownloadProgress([
    {
      filename: "takeout.zip",
      receivedBytes: 500,
      totalBytes: 0,
      bytesPerSecond: 100,
      isPaused: false,
      canResume: false
    }
  ]);

  assert.equal(summary.totalBytes, null);
  assert.equal(summary.percentComplete, null);
  assert.equal(summary.etaSeconds, null);
});
