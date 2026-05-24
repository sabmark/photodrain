import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AutomationLogEntry, LogLevel } from "./types.js";

export class AutomationLogger {
  private readonly logPath: string;
  private readonly entries: AutomationLogEntry[] = [];
  private listener: ((entry: AutomationLogEntry) => void) | null = null;

  constructor() {
    this.logPath = path.join(app.getPath("userData"), "automation-log.json");
    this.loadExisting();
  }

  setListener(listener: (entry: AutomationLogEntry) => void) {
    this.listener = listener;
  }

  getLogPath() {
    return this.logPath;
  }

  getEntries() {
    return [...this.entries];
  }

  log(level: LogLevel, message: string, details?: unknown) {
    const entry: AutomationLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      details
    };

    this.entries.push(entry);
    this.flush();
    this.listener?.(entry);
    return entry;
  }

  private loadExisting() {
    try {
      if (!fs.existsSync(this.logPath)) {
        return;
      }

      const parsed = JSON.parse(fs.readFileSync(this.logPath, "utf8")) as AutomationLogEntry[];
      if (Array.isArray(parsed)) {
        this.entries.push(...parsed);
      }
    } catch {
      this.entries.length = 0;
    }
  }

  private flush() {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.writeFileSync(this.logPath, JSON.stringify(this.entries.slice(-1000), null, 2));
  }
}
