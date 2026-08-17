import { BrowserWindow, Menu, app, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationRunner } from "./automation.js";
import { ensureBackupFolder, getDatedBackupFolder } from "./backupFolder.js";
import { BrowserController } from "./browserController.js";
import { AutomationLogger } from "./logger.js";
import { createProfile, deleteProfile, ensureProfiles, getActiveProfile, getProfiles, isPendingProfile, prunePendingProfiles, settingsStore, switchProfile, updateActiveProfile } from "./store.js";
import type { AppState, FinalDeletePayload } from "./types.js";

let mainWindow: BrowserWindow | null = null;
let lastScreenshotPath: string | null = null;
let profileRefreshActive = false;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pendingProfileIdsThisRun = new Set<string>();

const logger = new AutomationLogger();
ensureProfiles();
const getBackupFolder = () => {
  const activeProfile = getActiveProfile();
  return getDatedBackupFolder(activeProfile?.backupRootFolder) ?? activeProfile?.backupFolder ?? null;
};
const getGooglePartition = () => `persist:photodrain-google-${(getActiveProfile()?.id ?? "no-profile").replace(/[^a-z0-9_-]/gi, "-")}`;
const browser = new BrowserController(logger, getBackupFolder, getGooglePartition, notifyState);
const automation = new AutomationRunner(
  browser,
  logger,
  getBackupFolder,
  () => browser.getDownloadedFiles().length > 0,
  (filePath) => {
    lastScreenshotPath = filePath;
  },
  notifyState
);

function createState(): AppState {
  const downloadedFiles = browser.getDownloadedFiles();
  const profiles = getProfiles();
  const activeProfile = getActiveProfile();
  return {
    profiles,
    activeProfileId: activeProfile?.id ?? null,
    activeProfileName: activeProfile?.name ?? null,
    profileRefreshActive,
    backupFolder: getBackupFolder(),
    backupRootFolder: activeProfile?.backupRootFolder ?? null,
    currentUrl: browser.getCurrentUrl(),
    isGoogleLoggedIn: false,
    status: automation.getStatus(),
    downloadsComplete: downloadedFiles.length > 0,
    downloadedFiles,
    invalidDownloadFiles: browser.getInvalidDownloadFiles(),
    totalDownloadedBytes: browser.getTotalDownloadedBytes(),
    activeDownloadCount: browser.getActiveDownloadCount(),
    pausedDownloadCount: browser.getPausedDownloadCount(),
    downloadProgress: browser.getDownloadProgress(),
    googleAuthRequired: browser.getGoogleAuthRequired(),
    logs: logger.getEntries(),
    browserVisible: browser.getBrowserVisible(),
    lastScreenshotPath
  };
}

function notifyState() {
  mainWindow?.webContents.send("app:state", createState());
}

async function withProfileRefresh<T>(action: () => Promise<T>) {
  profileRefreshActive = true;
  notifyState();
  try {
    return await action();
  } finally {
    profileRefreshActive = false;
    notifyState();
  }
}

function cleanGoogleProfileName(value: string | null | undefined) {
  const cleaned = String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s*:\s*/g, " ")
    .replace(/google account|account|signed in as|change account|manage your google account/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

async function refreshActiveProfileFromGoogle() {
  try {
    const activeProfile = getActiveProfile();
    if (!activeProfile) {
      return false;
    }
    const details = await browser.captureGoogleProfile();
    if (details.avatarDataUrl || details.googleEmail || details.googleName) {
      const googleName = cleanGoogleProfileName(details.googleName);
      updateActiveProfile({
        ...details,
        googleName,
        name: googleName || details.googleEmail || activeProfile.name,
        pendingLogin: false,
        previousProfileId: null
      });
      pendingProfileIdsThisRun.delete(activeProfile.id);
      logger.log("info", "Cached Google profile details", { profile: getActiveProfile()?.name, hasAvatar: Boolean(details.avatarDataUrl), googleEmail: details.googleEmail, googleName });
      notifyState();
      return Boolean(details.googleEmail || googleName);
    }
  } catch (error) {
    logger.log("warn", "Could not refresh Google profile details", { message: error instanceof Error ? error.message : String(error) });
  }
  return false;
}

function finalizePendingProfileFallback() {
  const activeProfile = getActiveProfile();
  if (!activeProfile || !isPendingProfile(activeProfile)) {
    return false;
  }

  updateActiveProfile({
    name: "Google profile",
    pendingLogin: false,
    previousProfileId: null
  });
  pendingProfileIdsThisRun.delete(activeProfile.id);
  logger.log("warn", "Finalized Google profile with fallback name because account details were not exposed by the page");
  notifyState();
  return true;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 720,
    title: "PhotoDrain",
    icon: path.join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    logger.log("error", "Renderer failed to load", { errorCode, errorDescription, validatedUrl });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.log("error", "Renderer process exited", details);
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logger.log(level >= 2 ? "error" : "info", `Renderer console: ${message}`, { line, sourceId });
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    logger.log("info", "Renderer finished loading", { url: mainWindow?.webContents.getURL() });
    const rootChildren = await mainWindow?.webContents.executeJavaScript("document.getElementById('root')?.children.length ?? -1", true);
    logger.log("info", "Renderer root check", { rootChildren });
  });

  browser.attach(mainWindow);

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  logger.setListener((entry) => {
    mainWindow?.webContents.send("app:log", entry);
    notifyState();
  });

  ipcMain.handle("app:get-state", async () => {
    let activeProfile = getActiveProfile();
    const isGoogleLoggedIn = activeProfile ? await browser.checkLoginStatus() : false;
    if (isGoogleLoggedIn && (!activeProfile.googleEmail || !activeProfile.googleName || activeProfile.name === "Sign in to Google")) {
      await withProfileRefresh(refreshActiveProfileFromGoogle);
      activeProfile = getActiveProfile();
    }
    if (!isGoogleLoggedIn && activeProfile && isPendingProfile(activeProfile) && !pendingProfileIdsThisRun.has(activeProfile.id)) {
      prunePendingProfiles();
    }
    return { ...createState(), isGoogleLoggedIn };
  });

  ipcMain.handle("app:select-backup-folder", async () => {
    const rootFolder = await browser.chooseBackupFolder();
    if (rootFolder) {
      const folder = getDatedBackupFolder(rootFolder);
      if (!folder) {
        throw new Error("Could not create dated backup folder.");
      }
      ensureBackupFolder(folder);
      updateActiveProfile({ backupRootFolder: rootFolder, backupFolder: folder });
      logger.log("info", "Backup root folder selected", { profile: getActiveProfile()?.name, rootFolder, folder });
      notifyState();
    }
    return rootFolder;
  });

  ipcMain.handle("app:set-backup-folder", async (_event, folder: string) => {
    const datedFolder = getDatedBackupFolder(folder);
    if (!datedFolder) {
      throw new Error("Backup root folder is required.");
    }
    ensureBackupFolder(datedFolder);
    updateActiveProfile({ backupRootFolder: folder, backupFolder: datedFolder });
    logger.log("info", "Backup root folder set", { profile: getActiveProfile()?.name, rootFolder: folder, folder: datedFolder });
    notifyState();
    return createState();
  });

  ipcMain.handle("profiles:create", async () => {
    const profile = createProfile();
    pendingProfileIdsThisRun.add(profile.id);
    browser.switchProfile();
    logger.log("info", "Google profile created and selected; opening sign-in", { profile });
    await browser.open("https://accounts.google.com/");
    notifyState();
    return createState();
  });

  ipcMain.handle("profiles:switch", async (_event, id: string) => {
    const profile = switchProfile(id);
    browser.switchProfile();
    logger.log("info", "Profile selected", { profile });
    notifyState();
    return createState();
  });

  ipcMain.handle("profiles:rename", async (_event, id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Profile name is required.");
    }
    const profiles = getProfiles();
    if (!profiles.some((profile) => profile.id === id)) {
      throw new Error("Profile not found.");
    }
    settingsStore.set("profiles", profiles.map((profile) => profile.id === id ? { ...profile, name: trimmed } : profile));
    logger.log("info", "Profile renamed", { id, name: trimmed });
    notifyState();
    return createState();
  });

  ipcMain.handle("profiles:delete", async (_event, id: string) => {
    pendingProfileIdsThisRun.delete(id);
    const activeProfile = deleteProfile(id);
    browser.switchProfile();
    logger.log("warn", "Profile deleted", { id, activeProfile });
    notifyState();
    return createState();
  });

  ipcMain.handle("browser:open-google-login", async () => browser.open("https://accounts.google.com/"));
  ipcMain.handle("browser:check-login-status", async () => {
    const isLoggedIn = await browser.checkLoginStatus();
    let refreshed = false;
    if (isLoggedIn) {
      refreshed = await withProfileRefresh(refreshActiveProfileFromGoogle);
    }
    const activeProfile = getActiveProfile();
    if (activeProfile && isPendingProfile(activeProfile)) {
      if (isLoggedIn && !refreshed) {
        finalizePendingProfileFallback();
      } else {
        logger.log("warn", "Google session cookies were found, but profile identity was not captured yet");
        notifyState();
        return false;
      }
    }
    notifyState();
    return isLoggedIn;
  });
  ipcMain.handle("browser:get-storage-usage", async () => {
    const isLoggedIn = await browser.checkLoginStatus();
    if (!isLoggedIn) {
      throw new Error("Sign in to Google before loading storage usage.");
    }
    const summary = await browser.getGoogleOneStorageUsage();
    notifyState();
    return summary;
  });
  ipcMain.handle("browser:clear-google-session", async () => {
    await browser.clearGoogleSession();
    if (getActiveProfile()) {
      updateActiveProfile({ avatarDataUrl: null, googleEmail: null, googleName: null, pendingLogin: false, previousProfileId: null });
    }
    notifyState();
  });
  ipcMain.handle("browser:show", async () => browser.show());
  ipcMain.handle("browser:hide", async () => browser.hide());
  ipcMain.handle("browser:set-width", async (_event, width: number) => browser.setBrowserWidth(width));
  ipcMain.handle("browser:set-interaction-locked", async (_event, locked: boolean) => browser.setBrowserInteractionLocked(locked));

  ipcMain.handle("automation:request-takeout-export", async (_event, archiveSize: string) => automation.requestTakeoutExport(archiveSize));
  ipcMain.handle("automation:open-gmail-for-takeout", async () => automation.openGmailForTakeout());
  ipcMain.handle("automation:start-photos-cleanup", async () => automation.startPhotosCleanup());
  ipcMain.handle("automation:select-visible-photos-batch", async () => automation.selectVisiblePhotosBatch());
  ipcMain.handle("automation:move-selected-to-trash", async () => automation.moveSelectedToTrash());
  ipcMain.handle("automation:empty-trash", async (_event, payload: FinalDeletePayload) => automation.emptyTrash(payload));
  ipcMain.handle("automation:pause", async () => automation.pause());
  ipcMain.handle("automation:resume", async () => automation.resume());
  ipcMain.handle("automation:stop", async () => automation.stop());
  ipcMain.handle("downloads:validate", async () => browser.validateDownloads());
  ipcMain.handle("downloads:pause", async () => browser.pauseActiveDownloads());
  ipcMain.handle("downloads:resume", async () => browser.resumeActiveDownloads());
  ipcMain.handle("downloads:cancel", async () => browser.cancelActiveDownloads());
  ipcMain.handle("logs:open-folder", async () => shell.openPath(path.dirname(logger.getLogPath())));
}

if (process.platform === "win32") {
  app.setAppUserModelId("local.photodrain.app");
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
