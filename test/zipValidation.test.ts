import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectZipCompletion } from "../electron/zipValidation.ts";

function minimalZip() {
  const name = Buffer.from("photo.jpg");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(name.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(name.length, 28);

  const localRecord = Buffer.concat([localHeader, name]);
  const centralRecord = Buffer.concat([centralHeader, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.length, 12);
  end.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, end]);
}

test("accepts a ZIP only when its central directory and end record are complete", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "photodrain-zip-"));
  try {
    const filePath = path.join(folder, "complete.zip");
    fs.writeFileSync(filePath, minimalZip());
    assert.deepEqual(inspectZipCompletion(filePath), { valid: true, reason: null });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("rejects the same ZIP when its end-of-central-directory record is truncated", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "photodrain-zip-"));
  try {
    const filePath = path.join(folder, "partial.zip");
    fs.writeFileSync(filePath, minimalZip().subarray(0, -10));
    assert.deepEqual(inspectZipCompletion(filePath), {
      valid: false,
      reason: "End of ZIP central directory is missing. The download is incomplete."
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("rejects a non-ZIP file even when it is non-empty and named .zip", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "photodrain-zip-"));
  try {
    const filePath = path.join(folder, "fake.zip");
    fs.writeFileSync(filePath, "not a zip");
    assert.deepEqual(inspectZipCompletion(filePath), {
      valid: false,
      reason: "ZIP header is missing or invalid."
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
