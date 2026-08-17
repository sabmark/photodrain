import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureBackupFolder, getDatedBackupFolder } from "../electron/backupFolder.ts";

test("derives and recreates a missing dated backup folder under the selected root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "photodrain-backup-root-"));
  try {
    const folder = getDatedBackupFolder(root, new Date("2026-08-17T12:00:00.000Z"));
    assert.equal(folder, path.join(root, "2026-08-17"));
    assert.equal(fs.existsSync(folder!), false);

    assert.equal(ensureBackupFolder(folder), folder);
    assert.equal(fs.statSync(folder!).isDirectory(), true);
    assert.doesNotThrow(() => ensureBackupFolder(folder));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not create a folder when no backup root is configured", () => {
  assert.equal(getDatedBackupFolder(null), null);
  assert.equal(ensureBackupFolder(null), null);
});
