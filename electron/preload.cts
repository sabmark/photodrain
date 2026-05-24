import { contextBridge, ipcRenderer } from "electron";
import type { AppState, AutomationLogEntry, FinalDeletePayload } from "./types.js";

const api = {
  getState: () => ipcRenderer.invoke("app:get-state") as Promise<AppState>,
  selectBackupFolder: () => ipcRenderer.invoke("app:select-backup-folder") as Promise<string | null>,
  setBackupFolder: (folder: string) => ipcRenderer.invoke("app:set-backup-folder", folder) as Promise<AppState>,
  createProfile: () => ipcRenderer.invoke("profiles:create") as Promise<AppState>,
  switchProfile: (id: string) => ipcRenderer.invoke("profiles:switch", id) as Promise<AppState>,
  renameProfile: (id: string, name: string) => ipcRenderer.invoke("profiles:rename", id, name) as Promise<AppState>,
  deleteProfile: (id: string) => ipcRenderer.invoke("profiles:delete", id) as Promise<AppState>,
  openGoogleLogin: () => ipcRenderer.invoke("browser:open-google-login") as Promise<void>,
  checkLoginStatus: () => ipcRenderer.invoke("browser:check-login-status") as Promise<boolean>,
  clearGoogleSession: () => ipcRenderer.invoke("browser:clear-google-session") as Promise<void>,
  showBrowser: () => ipcRenderer.invoke("browser:show") as Promise<void>,
  hideBrowser: () => ipcRenderer.invoke("browser:hide") as Promise<void>,
  setBrowserWidth: (width: number) => ipcRenderer.invoke("browser:set-width", width) as Promise<void>,
  setBrowserInteractionLocked: (locked: boolean) => ipcRenderer.invoke("browser:set-interaction-locked", locked) as Promise<void>,
  requestTakeoutExport: (archiveSize: string) => ipcRenderer.invoke("automation:request-takeout-export", archiveSize),
  openGmailForTakeout: () => ipcRenderer.invoke("automation:open-gmail-for-takeout"),
  validateDownloads: () => ipcRenderer.invoke("downloads:validate"),
  pauseDownloads: () => ipcRenderer.invoke("downloads:pause"),
  resumeDownloads: () => ipcRenderer.invoke("downloads:resume"),
  cancelDownloads: () => ipcRenderer.invoke("downloads:cancel"),
  startPhotosCleanup: () => ipcRenderer.invoke("automation:start-photos-cleanup"),
  selectVisiblePhotosBatch: () => ipcRenderer.invoke("automation:select-visible-photos-batch"),
  moveSelectedToTrash: () => ipcRenderer.invoke("automation:move-selected-to-trash"),
  emptyTrash: (payload: FinalDeletePayload) => ipcRenderer.invoke("automation:empty-trash", payload),
  pause: () => ipcRenderer.invoke("automation:pause"),
  resume: () => ipcRenderer.invoke("automation:resume"),
  stop: () => ipcRenderer.invoke("automation:stop"),
  openLogsFolder: () => ipcRenderer.invoke("logs:open-folder"),
  onState: (callback: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on("app:state", listener);
    return () => ipcRenderer.removeListener("app:state", listener);
  },
  onLog: (callback: (entry: AutomationLogEntry) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: AutomationLogEntry) => callback(entry);
    ipcRenderer.on("app:log", listener);
    return () => ipcRenderer.removeListener("app:log", listener);
  }
};

contextBridge.exposeInMainWorld("photoDrain", api);

export type PhotoDrainApi = typeof api;
