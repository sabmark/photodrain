export type WorkflowStep =
  | "welcome"
  | "backup-folder"
  | "takeout-request"
  | "download-export"
  | "backup-summary"
  | "photos-cleanup"
  | "empty-trash"
  | "logs-settings";

export type AutomationStatus = "idle" | "running" | "paused" | "stopped" | "needs-manual-action" | "completed" | "error";

export type LogLevel = "info" | "warn" | "error" | "safety";

export interface AutomationLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  details?: unknown;
}

export interface DownloadedFile {
  filename: string;
  path: string;
  sizeBytes: number;
}

export interface InvalidDownloadFile extends DownloadedFile {
  reason: string;
}

export type DownloadProgressStatus = "idle" | "downloading" | "paused" | "partially-paused";

export interface DownloadProgressSample {
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  isPaused: boolean;
  canResume: boolean;
}

export interface DownloadProgressItem extends Omit<DownloadProgressSample, "totalBytes"> {
  totalBytes: number | null;
  percentComplete: number | null;
  etaSeconds: number | null;
}

export interface DownloadProgressSummary {
  status: DownloadProgressStatus;
  receivedBytes: number;
  totalBytes: number | null;
  percentComplete: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
  items: DownloadProgressItem[];
}

export interface StorageUsageItem {
  label: string;
  value: string;
}

export interface StorageUsageSummary {
  percentFull: string | null;
  used: string | null;
  limit: string | null;
  rawUsage: string | null;
  items: StorageUsageItem[];
  fetchedAt: string;
}

export interface UserProfile {
  id: string;
  name: string;
  backupFolder: string | null;
  backupRootFolder?: string | null;
  avatarDataUrl?: string | null;
  googleEmail?: string | null;
  googleName?: string | null;
  color?: string | null;
  pendingLogin?: boolean | null;
  previousProfileId?: string | null;
}

export interface AppState {
  profiles: UserProfile[];
  activeProfileId: string | null;
  activeProfileName: string | null;
  profileRefreshActive: boolean;
  backupFolder: string | null;
  backupRootFolder: string | null;
  currentUrl: string | null;
  isGoogleLoggedIn: boolean;
  status: AutomationStatus;
  downloadsComplete: boolean;
  downloadedFiles: DownloadedFile[];
  invalidDownloadFiles: InvalidDownloadFile[];
  totalDownloadedBytes: number;
  activeDownloadCount: number;
  pausedDownloadCount: number;
  downloadProgress: DownloadProgressSummary;
  googleAuthRequired: boolean;
  logs: AutomationLogEntry[];
  browserVisible: boolean;
  lastScreenshotPath: string | null;
}

export interface AutomationResult {
  ok: boolean;
  message: string;
}

export interface FinalDeletePayload {
  typedConfirmation: string;
  understandsPermanentDelete: boolean;
}
