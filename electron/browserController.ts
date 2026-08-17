import { BrowserView, BrowserWindow, DownloadItem, Notification, Session, app, dialog, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AutomationLogger } from "./logger.js";
import type { DownloadedFile, InvalidDownloadFile, StorageUsageSummary } from "./types.js";
import { ensureBackupFolder } from "./backupFolder.js";
import { pauseDownloads, resumeDownloads } from "./downloadControls.js";
import { summarizeDownloadProgress } from "./downloadProgress.js";
import { isManualGoogleAuthChallenge } from "./googleAuth.js";
import { inspectZipCompletion } from "./zipValidation.js";

const TOP_BAR_HEIGHT = 0;
const SIDEBAR_WIDTH = 260;
const SIDEBAR_COMPACT_WIDTH = 220;
const SIDEBAR_NARROW_WIDTH = 72;

export class BrowserController {
  private view: BrowserView | null = null;
  private lockView: BrowserView | null = null;
  private parent: BrowserWindow | null = null;
  private googleSession: Session | null = null;
  private configuredDownloadPartitions = new Set<string>();
  private downloads = new Map<string, DownloadedFile>();
  private invalidDownloads = new Map<string, InvalidDownloadFile>();
  private activeDownloads = new Set<string>();
  private activeDownloadItems = new Map<string, DownloadItem>();
  private userCanceledDownloads = new Set<string>();
  private downloadEventCount = 0;
  private downloadProgress = new Map<string, { receivedBytes: number; totalBytes: number; state: "progressing" | "interrupted" }>();
  private browserVisible = false;
  private preferredBrowserWidth: number | null = null;
  private browserInteractionLocked = false;
  private googleAuthRequired = false;
  private googleAuthNotification: Notification | null = null;

  constructor(
    private readonly logger: AutomationLogger,
    private readonly getBackupFolder: () => string | null,
    private readonly getGooglePartition: () => string,
    private readonly notifyState: () => void
  ) {}

  attach(parent: BrowserWindow) {
    this.parent = parent;
    parent.on("resize", () => this.layout());
    parent.on("focus", () => parent.flashFrame(false));
  }

  getCurrentUrl() {
    return this.view?.webContents.getURL() || null;
  }

  getBrowserVisible() {
    return this.browserVisible;
  }

  getDownloadedFiles() {
    return [...this.downloads.values()];
  }

  getInvalidDownloadFiles() {
    return [...this.invalidDownloads.values()];
  }

  getTotalDownloadedBytes() {
    return this.getDownloadedFiles().reduce((sum, file) => sum + file.sizeBytes, 0);
  }

  getActiveDownloadCount() {
    return this.activeDownloads.size;
  }

  getDownloadEventCount() {
    return this.downloadEventCount;
  }

  getPausedDownloadCount() {
    return [...this.activeDownloadItems.entries()].filter(([targetPath, item]) =>
      item.isPaused() || this.downloadProgress.get(targetPath)?.state === "interrupted"
    ).length;
  }

  getDownloadProgress() {
    return summarizeDownloadProgress([...this.activeDownloadItems.entries()].map(([targetPath, item]) => ({
      filename: path.basename(targetPath),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      bytesPerSecond: item.getCurrentBytesPerSecond(),
      isPaused: item.isPaused() || this.downloadProgress.get(targetPath)?.state === "interrupted",
      canResume: item.canResume()
    })));
  }

  getGoogleAuthRequired() {
    return this.googleAuthRequired;
  }

  pauseActiveDownloads() {
    const result = pauseDownloads([...this.activeDownloadItems.values()]);
    this.updateTaskbarDownloadProgress();
    this.logger.log(result.failed > 0 ? "warn" : "info", `Paused ${result.succeeded} active download(s)`, result);
    this.notifyState();
    return {
      ok: result.succeeded > 0 && result.failed === 0,
      message: result.failed > 0
        ? `Paused ${result.succeeded} download(s), but ${result.failed} could not be paused.`
        : result.succeeded > 0
          ? `Paused ${result.succeeded} download(s).`
          : "No running downloads were available to pause."
    };
  }

  resumeActiveDownloads() {
    const resumableItems = [...this.activeDownloadItems.entries()]
      .filter(([targetPath, item]) => item.isPaused() || this.downloadProgress.get(targetPath)?.state === "interrupted")
      .map(([, item]) => item);
    const result = resumeDownloads(resumableItems);
    this.updateTaskbarDownloadProgress();
    this.logger.log(result.failed > 0 ? "warn" : "info", `Resumed ${result.succeeded} paused download(s)`, result);
    this.notifyState();
    const restartNote = result.mayRestart > 0
      ? ` ${result.mayRestart} download(s) may restart from byte zero because Google did not advertise range support.`
      : "";
    return {
      ok: result.succeeded > 0 && result.failed === 0,
      message: result.failed > 0
        ? `Resumed ${result.succeeded} download(s), but ${result.failed} could not be resumed.${restartNote}`
        : result.succeeded > 0
          ? `Resumed ${result.succeeded} download(s).${restartNote}`
          : "No paused downloads were available to resume."
    };
  }

  cancelActiveDownloads() {
    let canceled = 0;
    const targetPaths = [...this.activeDownloadItems.keys()];
    for (const [targetPath, item] of this.activeDownloadItems) {
      this.userCanceledDownloads.add(targetPath);
      item.cancel();
      canceled += 1;
    }

    for (const targetPath of targetPaths) {
      this.deleteIfPresent(targetPath);
      this.deleteIfPresent(`${targetPath}.crdownload`);
      this.deleteIfPresent(`${targetPath}.tmp`);
    }

    this.activeDownloads.clear();
    this.activeDownloadItems.clear();
    this.downloadProgress.clear();
    this.updateTaskbarDownloadProgress();
    void this.setGoogleAuthRequired(false);
    void this.setBrowserInteractionLocked(false);
    this.logger.log("warn", `Canceled ${canceled} active download(s) and deleted incomplete local file(s)`);
    this.notifyState();
  }

  async setBrowserInteractionLocked(locked: boolean) {
    this.browserInteractionLocked = locked;
    if (!this.view) {
      return;
    }

    if (locked) {
      await this.setExternalBrowserLock(true);
    }

    const isManualAuthPage = await this.isManualGoogleAuthPage();
    const shouldLock = locked && !isManualAuthPage;
    await this.setExternalBrowserLock(shouldLock);
    await this.view.webContents.executeJavaScript(`
      (() => {
        const existing = document.getElementById('photodrain-browser-lock');
        if (${JSON.stringify(shouldLock)}) {
          if (existing) return;
          const overlay = document.createElement('div');
          overlay.id = 'photodrain-browser-lock';
          overlay.style.position = 'fixed';
          overlay.style.inset = '0';
          overlay.style.zIndex = '2147483647';
          overlay.style.cursor = 'wait';
          overlay.style.display = 'grid';
          overlay.style.placeItems = 'center';
          overlay.style.background = 'rgba(255, 255, 255, 0.02)';
          overlay.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
          }, true);
          document.documentElement.appendChild(overlay);
          return;
        }
        existing?.remove();
      })();
    `, true).catch((error) => {
      this.logger.log("warn", "Could not update browser interaction lock", { locked, shouldLock, message: error instanceof Error ? error.message : String(error) });
    });
  }

  async setGoogleAuthRequired(required: boolean) {
    if (this.googleAuthRequired === required) {
      return;
    }

    this.googleAuthRequired = required;
    if (!required) {
      this.parent?.flashFrame(false);
      this.googleAuthNotification?.close();
      this.googleAuthNotification = null;
      this.notifyState();
      return;
    }

    this.show();
    await this.setBrowserInteractionLocked(false);
    const parent = this.parent;
    if (parent && !parent.isFocused()) {
      parent.flashFrame(true);

      if (Notification.isSupported()) {
        const notification = new Notification({
          title: "PhotoDrain needs your attention",
          body: "Google needs your password before the Takeout ZIP download can begin. Enter it only in the visible Google page.",
          silent: false,
          timeoutType: "never",
          urgency: "critical"
        });
        notification.on("click", () => {
          if (parent.isMinimized()) {
            parent.restore();
          }
          parent.show();
          parent.focus();
        });
        notification.on("failed", (_event, error) => {
          this.logger.log("warn", "Could not show Google authentication notification", { error });
        });
        this.googleAuthNotification = notification;
        notification.show();
      }

      if (parent.isMinimized()) {
        parent.restore();
      }
      parent.show();
      parent.focus();
    }

    this.notifyState();
  }

  async prepareForDownloadInteraction() {
    if (!this.parent) {
      throw new Error("Main window is not ready");
    }

    const parent = this.parent;
    const needsAttention = parent.isMinimized() || !parent.isFocused();
    this.show();

    if (parent.isMinimized()) {
      parent.restore();
    }
    parent.show();
    this.layout();

    // Allow Windows and Electron to apply the restored content bounds before
    // page coordinates are inspected and sent back as trusted mouse input.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.layout();

    const bounds = this.view?.getBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("The visible Google browser is not ready for the download confirmation.");
    }

    if (needsAttention) {
      parent.flashFrame(true);
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: "PhotoDrain is ready to download",
          body: "Google may ask you to confirm your password. PhotoDrain brought the Google page forward so you can finish the download.",
          silent: false
        });
        notification.on("click", () => {
          if (parent.isMinimized()) {
            parent.restore();
          }
          parent.show();
          parent.focus();
        });
        notification.on("failed", (_event, error) => {
          this.logger.log("warn", "Could not show download attention notification", { error });
        });
        notification.show();
      }
    }

    parent.focus();
    this.logger.log("info", "Prepared visible Google browser for download confirmation", { bounds, needsAttention });
  }

  async setInPageInteractionBlocked(blocked: boolean) {
    if (!this.view) {
      return;
    }

    await this.view.webContents.executeJavaScript(`
      (() => {
        const existing = document.getElementById('photodrain-browser-lock');
        if (${JSON.stringify(blocked)}) {
          if (existing) return;
          const overlay = document.createElement('div');
          overlay.id = 'photodrain-browser-lock';
          overlay.style.position = 'fixed';
          overlay.style.inset = '0';
          overlay.style.zIndex = '2147483647';
          overlay.style.cursor = 'wait';
          overlay.style.background = 'rgba(255, 255, 255, 0.02)';
          overlay.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
          }, true);
          overlay.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
          }, true);
          overlay.addEventListener('mouseup', (event) => {
            event.preventDefault();
            event.stopPropagation();
          }, true);
          document.documentElement.appendChild(overlay);
          return;
        }
        existing?.remove();
      })();
    `, true).catch((error) => {
      this.logger.log("warn", "Could not update in-page browser interaction blocker", { blocked, message: error instanceof Error ? error.message : String(error) });
    });
  }

  setBrowserWidth(width: number) {
    this.preferredBrowserWidth = Math.max(280, Math.floor(width));
    this.layout();
    this.notifyState();
  }

  async waitForDownloadsToFinish(timeoutMs: number, initialDownloadEventCount = this.downloadEventCount) {
    const started = Date.now();
    const initialFileCount = this.validateDownloads({ silent: true }).length;
    let sawDownloadStart = this.activeDownloads.size > 0;

    while (Date.now() - started < timeoutMs) {
      if (this.activeDownloads.size > 0) {
        sawDownloadStart = true;
      }

      const files = this.validateDownloads({ silent: true });
      if (files.length > initialFileCount && this.activeDownloads.size === 0) {
        return this.validateDownloads();
      }

      if (this.downloadEventCount > initialDownloadEventCount && this.activeDownloads.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (this.activeDownloads.size === 0) {
          return this.validateDownloads();
        }
      }

      if (sawDownloadStart && this.activeDownloads.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (this.activeDownloads.size === 0) {
          return this.validateDownloads();
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error("Timed out waiting for Takeout ZIP downloads to finish.");
  }

  show() {
    if (!this.parent) {
      return;
    }
    const view = this.ensureView();
    if (!this.browserVisible) {
      this.parent.addBrowserView(view);
    }
    this.browserVisible = true;
    this.layout();
    this.notifyState();
  }

  hide() {
    if (this.parent && this.view && this.browserVisible) {
      this.removeExternalBrowserLock();
      this.parent.removeBrowserView(this.view);
    }
    this.browserVisible = false;
    this.notifyState();
  }

  async open(url: string) {
    const view = this.ensureView();
    this.show();
    this.logger.log("info", `Opening ${url}`);
    await view.webContents.loadURL(url);
  }

  async clearGoogleSession() {
    this.logger.log("warn", "Clearing saved Google browser session");
    await this.getGoogleSession().clearStorageData();
    await this.getGoogleSession().clearCache();
    this.downloads.clear();
    await this.open("https://accounts.google.com/");
  }

  async checkLoginStatus() {
    const cookies = await this.getGoogleSession().cookies.get({ domain: ".google.com" });
    const hasSessionCookie = cookies.some((cookie) => ["SID", "HSID", "SSID", "SAPISID", "APISID"].includes(cookie.name));
    this.logger.log(hasSessionCookie ? "info" : "warn", hasSessionCookie ? "Google session cookies found" : "Google session cookies not found");
    return hasSessionCookie;
  }

  async captureGoogleProfile() {
    const view = this.ensureView();
    const inspectProfile = async () => (await view.webContents.executeJavaScript(`
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const cleanName = (value) => clean(String(value || '')
          .replace(/[()]/g, ' ')
          .replace(/\\s*:\\s*/g, ' ')
          .replace(/google account|account|signed in as|change account|manage your google account/ig, ''));
        const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i;
        const candidates = Array.from(document.querySelectorAll('[aria-label], [title], img, a, button, h1, h2, [role="heading"], div, span'));
        const texts = candidates.map((el) => clean([
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('alt') || '',
          el.textContent || ''
        ].join(' '))).filter((text) => text && text.length < 1200);
        const bodyText = clean(document.body?.innerText || '');
        const emailText = texts.find((text) => emailPattern.test(text)) || bodyText.match(emailPattern)?.[0] || '';
        const googleEmail = emailText.match(emailPattern)?.[0] || null;
        let googleName = null;
        if (emailText) {
          googleName = cleanName(emailText.replace(emailPattern, ''));
        }
        if (!googleName) {
          const headingText = texts.find((text) => /^welcome,\\s+/i.test(text)) || '';
          googleName = cleanName(headingText.replace(/^welcome,\\s+/i, '')) || null;
        }
        if (!googleName && bodyText.toLowerCase().includes('google account')) {
          const lines = bodyText.split(/\\n+/).map(clean).filter(Boolean);
          const emailIndex = lines.findIndex((line) => emailPattern.test(line));
          const nearbyName = emailIndex > 0 ? lines.slice(Math.max(0, emailIndex - 3), emailIndex).reverse().find((line) =>
            !emailPattern.test(line) &&
            !/google account|manage your|privacy|account/i.test(line) &&
            line.length >= 2 &&
            line.length <= 80
          ) : null;
          googleName = cleanName(nearbyName) || null;
        }
        const images = Array.from(document.querySelectorAll('img')).map((img) => {
          const rect = img.getBoundingClientRect();
          const src = img.currentSrc || img.src || '';
          const label = clean([img.alt || '', img.getAttribute('aria-label') || '', img.getAttribute('title') || '', img.parentElement?.getAttribute('aria-label') || ''].join(' '));
          let score = 0;
          if (src.includes('googleusercontent.com')) score += 100;
          if (src.includes('photo')) score += 30;
          if (label.toLowerCase().includes('profile') || label.toLowerCase().includes('account')) score += 40;
          if (rect.width >= 24 && rect.height >= 24 && rect.width <= 128 && rect.height <= 128) score += 30;
          if (rect.top < 120 || rect.right > window.innerWidth - 180) score += 20;
          return { src, label, score };
        }).filter((item) => item.src && item.score > 0).sort((a, b) => b.score - a.score);
        return {
          avatarUrl: images[0]?.src || null,
          googleEmail,
          googleName: googleName || null
        };
      })();
    `, true).catch(() => ({ avatarUrl: null, googleEmail: null, googleName: null }))) as {
      avatarUrl: string | null;
      googleEmail: string | null;
      googleName: string | null;
    };

    const currentUrl = view.webContents.getURL().toLowerCase();
    if (!currentUrl.includes("myaccount.google.com")) {
      await view.webContents.loadURL("https://myaccount.google.com/");
      await this.waitForDocumentReady();
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }

    let details = await inspectProfile();
    if (!details.googleEmail && !details.googleName) {
      await view.webContents.loadURL("https://www.google.com/");
      await this.waitForDocumentReady();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await view.webContents.executeJavaScript(`
        (() => {
          const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'));
          const account = controls.find((el) => {
            const label = [
              el.getAttribute('aria-label') || '',
              el.getAttribute('title') || '',
              el.textContent || ''
            ].join(' ').toLowerCase();
            return label.includes('google account') || label.includes('google apps') || label.includes('account');
          });
          if (account instanceof HTMLElement) {
            account.click();
            return true;
          }
          return false;
        })();
      `, true).catch(() => false);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      details = await inspectProfile();
    }

    let avatarDataUrl: string | null = null;
    if (details.avatarUrl?.startsWith("data:image/")) {
      avatarDataUrl = details.avatarUrl;
    } else if (details.avatarUrl?.startsWith("http")) {
      try {
        const response = await this.getGoogleSession().fetch(details.avatarUrl);
        const contentType = response.headers.get("content-type") || "image/png";
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 0 && buffer.length < 1_500_000) {
          avatarDataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
        }
      } catch (error) {
        this.logger.log("warn", "Could not cache Google profile avatar", { message: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      avatarDataUrl,
      googleEmail: details.googleEmail,
      googleName: details.googleName
    };
  }

  async getGoogleOneStorageUsage(): Promise<StorageUsageSummary> {
    const view = this.ensureView();
    const url = "https://one.google.com/storage/management?g1_landing_page=6";
    this.logger.log("info", "Loading Google One storage usage");
    await view.webContents.loadURL(url);
    await this.waitForDocumentReady();

    const started = Date.now();
    while (Date.now() - started < 15000) {
      const ready = await view.webContents.executeJavaScript(`
        (() => {
          const text = document.body?.innerText || '';
          return /Storage used/i.test(text) || /storage full/i.test(text) || /Google Drive/i.test(text);
        })();
      `, true).catch(() => false);
      if (ready) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const summary = await view.webContents.executeJavaScript(`
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const xpath = '/html/body/div[6]/c-wiz/div/div/span/div/main/c-wiz/c-wiz/div[1]/div[1]';
        const xpathNode = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        const candidates = [
          xpathNode,
          ...Array.from(document.querySelectorAll('main div, c-wiz div'))
        ].filter(Boolean);

        const node = candidates.find((candidate) => {
          const text = candidate.innerText || candidate.textContent || '';
          return /Storage used/i.test(text) && /of\\s+\\d/i.test(text);
        });

        if (!node) {
          throw new Error('Google One storage summary was not found.');
        }

        const lines = String(node.innerText || node.textContent || '')
          .split(/\\n+/)
          .map(clean)
          .filter(Boolean)
          .filter((line) => !/^expand_(less|more)$/i.test(line) && !/^Usage details$/i.test(line));

        const fullLine = lines.find((line) => /storage full/i.test(line)) || null;
        const rawUsage = lines.find((line) => /\\bof\\b/i.test(line) && /\\d/.test(line)) || null;
        const usageMatch = rawUsage?.match(/^(.+?)\\s+of\\s+(.+)$/i) || null;
        const startIndex = lines.findIndex((line) => /^Gmail$|^Google Drive$|^Google Photos$/i.test(line));
        const details = [];

        if (startIndex >= 0) {
          for (let index = startIndex; index < lines.length - 1; index += 2) {
            const label = lines[index];
            const value = lines[index + 1];
            if (/^Gmail$|^Google Drive$|^Google Photos$/i.test(label) && /\\d/.test(value)) {
              details.push({ label, value });
            }
          }
        }

        return {
          percentFull: fullLine?.match(/\\d+%/)?.[0] || null,
          used: usageMatch?.[1] || null,
          limit: usageMatch?.[2] || null,
          rawUsage,
          items: details,
          fetchedAt: new Date().toISOString()
        };
      })();
    `, true) as StorageUsageSummary;

    this.logger.log("info", "Loaded Google One storage usage", summary);
    return summary;
  }

  private async waitForDocumentReady() {
    if (!this.view) {
      return;
    }
    await this.view.webContents.executeJavaScript(`
      new Promise((resolve) => {
        if (document.readyState === 'complete') resolve(true);
        else window.addEventListener('load', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 10000);
      });
    `, true).catch(() => false);
  }

  switchProfile() {
    if (this.parent && this.view && this.browserVisible) {
      this.removeExternalBrowserLock();
      this.parent.removeBrowserView(this.view);
    }
    this.view?.webContents.close();
    this.view = null;
    this.googleSession = null;
    this.downloads.clear();
    this.activeDownloads.clear();
    this.activeDownloadItems.clear();
    this.userCanceledDownloads.clear();
    this.downloadProgress.clear();
    this.browserVisible = false;
    this.browserInteractionLocked = false;
    this.updateTaskbarDownloadProgress();
    this.notifyState();
  }

  async executeScript<T>(script: string): Promise<T> {
    const view = this.ensureView();
    return view.webContents.executeJavaScript(script, true) as Promise<T>;
  }

  clickAt(x: number, y: number, modifiers: Array<"shift" | "control" | "ctrl" | "alt" | "meta" | "command" | "cmd" | "isKeypad" | "isAutoRepeat" | "leftButtonDown" | "middleButtonDown" | "rightButtonDown" | "capsLock" | "numLock" | "left" | "right"> = []) {
    const view = this.ensureView();
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y), modifiers });
    view.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, modifiers });
    view.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, modifiers });
  }

  moveMouseTo(x: number, y: number) {
    const view = this.ensureView();
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
  }

  pressKey(keyCode: string) {
    const view = this.ensureView();
    view.webContents.sendInputEvent({ type: "keyDown", keyCode });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode });
  }

  async screenshot(label: string) {
    const view = this.ensureView();
    const image = await view.webContents.capturePage();
    const folder = path.join(app.getPath("userData"), "screenshots");
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.png`);
    fs.writeFileSync(filePath, image.toPNG());
    this.logger.log("safety", `Saved screenshot: ${label}`, { path: filePath });
    return filePath;
  }

  validateDownloads(options: { silent?: boolean } = {}) {
    const folder = this.getBackupFolder();
    if (!folder) {
      return [];
    }

    ensureBackupFolder(folder);

    const candidates = fs
      .readdirSync(folder)
      .filter((filename) => filename.toLowerCase().endsWith(".zip"))
      .map((filename) => {
        const filePath = path.join(folder, filename);
        const stat = fs.statSync(filePath);
        return { filename, path: filePath, sizeBytes: stat.size };
      });

    this.downloads.clear();
    this.invalidDownloads.clear();
    for (const file of candidates) {
      const inspection = inspectZipCompletion(file.path);
      if (file.sizeBytes > 0 && inspection.valid) {
        this.downloads.set(file.path, file);
        continue;
      }
      this.invalidDownloads.set(file.path, {
        ...file,
        reason: inspection.reason || "ZIP file is empty or incomplete."
      });
    }
    const files = this.getDownloadedFiles();
    if (!options.silent) {
      this.logger.log("info", `Validated ${files.length} downloaded ZIP file(s)`, { files });
      if (this.invalidDownloads.size > 0) {
        this.logger.log("warn", `Rejected ${this.invalidDownloads.size} incomplete or invalid ZIP file(s)`, { files: this.getInvalidDownloadFiles() });
      }
      this.notifyState();
    }
    return files;
  }

  async chooseBackupFolder() {
    if (!this.parent) {
      throw new Error("Main window is not ready");
    }

    const result = await dialog.showOpenDialog(this.parent, {
      title: "Select PhotoDrain backup root folder",
      properties: ["openDirectory", "createDirectory"]
    });

    return result.canceled ? null : result.filePaths[0];
  }

  private ensureView() {
    if (this.view) {
      return this.view;
    }

    this.view = new BrowserView({
      webPreferences: {
        session: this.getGoogleSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      void this.view?.webContents.loadURL(url);
      return { action: "deny" };
    });
    this.view.webContents.on("did-finish-load", () => {
      if (this.browserInteractionLocked) {
        void this.setBrowserInteractionLocked(true);
      }
    });
    return this.view;
  }

  private layout() {
    if (!this.parent || !this.view || !this.browserVisible) {
      return;
    }

    const bounds = this.parent.getContentBounds();
    const sidebarWidth = bounds.width < 900 ? SIDEBAR_NARROW_WIDTH : bounds.width < 1024 ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_WIDTH;
    const mainMinimumWidth = bounds.width >= 1200 ? 420 : 360;
    const availableForBrowser = bounds.width - sidebarWidth - mainMinimumWidth;
    const defaultBrowserWidth = availableForBrowser;
    const targetBrowserWidth = this.preferredBrowserWidth ?? defaultBrowserWidth;
    const browserWidth = Math.max(280, Math.min(targetBrowserWidth, availableForBrowser));

    this.view.setBounds({
      x: bounds.width - browserWidth,
      y: TOP_BAR_HEIGHT,
      width: browserWidth,
      height: bounds.height - TOP_BAR_HEIGHT
    });
    this.view.setAutoResize({ width: true, height: true });

    if (this.lockView) {
      this.lockView.setBounds({
        x: bounds.width - browserWidth,
        y: TOP_BAR_HEIGHT,
        width: browserWidth,
        height: bounds.height - TOP_BAR_HEIGHT
      });
      this.lockView.setAutoResize({ width: true, height: true });
    }
  }

  private async setExternalBrowserLock(locked: boolean) {
    if (!this.parent || !this.browserVisible) {
      return;
    }

    if (!locked) {
      this.removeExternalBrowserLock();
      return;
    }

    if (!this.lockView) {
      this.lockView = new BrowserView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      this.lockView.setBackgroundColor("#00ffffff");
      await this.lockView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <style>
              html, body {
                margin: 0;
                width: 100%;
                height: 100%;
                overflow: hidden;
                background: rgba(255, 255, 255, 0.34);
                cursor: wait;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              }
              body {
                display: grid;
                place-items: center;
                box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.16);
              }
              .glass {
                color: #0f172a;
                border: 1px solid rgba(15, 23, 42, 0.18);
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.62);
                box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
                padding: 10px 12px;
                font-size: 13px;
                font-weight: 600;
                text-align: center;
                user-select: none;
              }
            </style>
          </head>
          <body>
            <div class="glass">PhotoDrain is controlling this browser</div>
            <script>
              addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
              }, true);
              addEventListener("mousedown", (event) => {
                event.preventDefault();
                event.stopPropagation();
              }, true);
              addEventListener("mouseup", (event) => {
                event.preventDefault();
                event.stopPropagation();
              }, true);
            </script>
          </body>
        </html>
      `)}`);
    }

    if (!this.parent.getBrowserViews().includes(this.lockView)) {
      this.parent.addBrowserView(this.lockView);
    }
    this.layout();
  }

  private removeExternalBrowserLock() {
    if (this.parent && this.lockView && this.parent.getBrowserViews().includes(this.lockView)) {
      this.parent.removeBrowserView(this.lockView);
    }
  }

  private configureDownloads() {
    if (!this.googleSession) {
      return;
    }
    const partition = this.getGooglePartition();
    if (this.configuredDownloadPartitions.has(partition)) {
      return;
    }
    this.configuredDownloadPartitions.add(partition);

    this.googleSession.on("will-download", (event, item: DownloadItem) => {
      this.downloadEventCount += 1;
      void this.setGoogleAuthRequired(false);
      const folder = this.getBackupFolder();
      if (!folder) {
        this.logger.log("error", "Download blocked because no backup folder is selected");
        item.cancel();
        return;
      }

      fs.mkdirSync(folder, { recursive: true });
      const filename = this.normalizeDuplicateZipName(item.getFilename());
      const targetPath = path.join(folder, filename);
      const totalBytes = item.getTotalBytes();

      if (fs.existsSync(targetPath)) {
        const existingSize = fs.statSync(targetPath).size;
        if (existingSize > 0 && totalBytes > 0 && existingSize >= totalBytes) {
          item.cancel();
          this.downloads.set(targetPath, { filename, path: targetPath, sizeBytes: existingSize });
          this.updateTaskbarDownloadProgress();
          this.logger.log("info", `Download skipped because file already exists: ${filename}`, { targetPath, existingSize, totalBytes });
          this.notifyState();
          return;
        }

        this.logger.log("warn", `Existing file is incomplete or size is unknown; deleting before re-download: ${filename}`, { targetPath, existingSize, totalBytes });
        this.deleteIfPresent(targetPath);
      }

      this.activeDownloads.add(targetPath);
      this.activeDownloadItems.set(targetPath, item);
      this.downloadProgress.set(targetPath, { receivedBytes: item.getReceivedBytes(), totalBytes, state: "progressing" });
      item.setSavePath(targetPath);
      this.logger.log("info", `Download started: ${filename}`, { targetPath });
      this.updateTaskbarDownloadProgress();
      void this.setBrowserInteractionLocked(true);
      this.notifyState();

      item.on("updated", (_updatedEvent, state) => {
        this.downloadProgress.set(targetPath, {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          state
        });
        this.updateTaskbarDownloadProgress();
        this.notifyState();
      });

      item.on("done", (_doneEvent, state) => {
        this.activeDownloads.delete(targetPath);
        this.activeDownloadItems.delete(targetPath);
        this.downloadProgress.delete(targetPath);
        if (this.activeDownloads.size === 0) {
          this.updateTaskbarDownloadProgress();
          void this.setBrowserInteractionLocked(false);
        }

        if (this.userCanceledDownloads.delete(targetPath)) {
          this.deleteIfPresent(targetPath);
          this.deleteIfPresent(`${targetPath}.crdownload`);
          this.deleteIfPresent(`${targetPath}.tmp`);
          this.logger.log("warn", `Download canceled and incomplete file deleted: ${filename}`, { targetPath });
          this.notifyState();
          return;
        }

        if (state !== "completed") {
          this.logger.log("error", `Download did not complete: ${filename}`, { state });
          this.notifyState();
          return;
        }

        const stat = fs.statSync(targetPath);
        this.downloads.set(targetPath, { filename, path: targetPath, sizeBytes: stat.size });
        this.logger.log("info", `Download completed: ${filename}`, { targetPath, sizeBytes: stat.size });
        this.notifyState();
      });
    });
  }

  private normalizeDuplicateZipName(filename: string) {
    return filename.replace(/ \(\d+\)(?=\.zip$)/i, "");
  }

  private updateTaskbarDownloadProgress() {
    if (!this.parent) {
      return;
    }

    if (this.downloadProgress.size === 0) {
      this.parent.setProgressBar(-1);
      return;
    }

    let receivedBytes = 0;
    let totalBytes = 0;
    let hasUnknownTotal = false;

    for (const progress of this.downloadProgress.values()) {
      receivedBytes += Math.max(0, progress.receivedBytes);
      if (progress.totalBytes > 0) {
        totalBytes += progress.totalBytes;
      } else {
        hasUnknownTotal = true;
      }
    }

    if (hasUnknownTotal || totalBytes <= 0) {
      this.parent.setProgressBar(2, { mode: "indeterminate" });
      return;
    }

    const progress = Math.min(1, Math.max(0, receivedBytes / totalBytes));
    const allPaused = this.activeDownloadItems.size > 0 && this.getPausedDownloadCount() === this.activeDownloadItems.size;
    this.parent.setProgressBar(progress, allPaused ? { mode: "paused" } : undefined);
  }

  async isManualGoogleAuthPage() {
    if (!this.view) {
      return false;
    }

    const url = this.view.webContents.getURL();
    if (isManualGoogleAuthChallenge(url)) {
      return true;
    }

    const pageText = await this.view.webContents.executeJavaScript(
      "(document.body?.innerText || '').slice(0, 20000)",
      true
    ).catch(() => "") as string;
    return isManualGoogleAuthChallenge(url, pageText);
  }

  private deleteIfPresent(filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (error) {
      this.logger.log("warn", "Could not delete incomplete download file", { filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private getGoogleSession() {
    if (!this.googleSession) {
      this.googleSession = session.fromPartition(this.getGooglePartition());
      this.configureDownloads();
    }

    return this.googleSession;
  }
}
