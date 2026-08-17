import fs from "node:fs";
import path from "node:path";

export function getDatedBackupFolder(rootFolder: string | null | undefined, now = new Date()) {
  return rootFolder ? path.join(rootFolder, now.toISOString().slice(0, 10)) : null;
}

export function ensureBackupFolder(folder: string | null | undefined) {
  if (!folder) {
    return null;
  }
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}
