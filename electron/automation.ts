import type { BrowserController } from "./browserController.js";
import type { AutomationLogger } from "./logger.js";
import type { AutomationResult, AutomationStatus, FinalDeletePayload } from "./types.js";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FINAL_DELETE_CONFIRMATION = "DELETE";

interface PhotosSelectionCandidate {
  x: number;
  y: number;
  kind: string;
  label: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export class AutomationRunner {
  private status: AutomationStatus = "idle";
  private stopped = false;

  constructor(
    private readonly browser: BrowserController,
    private readonly logger: AutomationLogger,
    private readonly getBackupFolder: () => string | null,
    private readonly downloadsAreComplete: () => boolean,
    private readonly setLastScreenshot: (path: string) => void,
    private readonly notifyState: () => void
  ) {}

  getStatus() {
    return this.status;
  }

  pause() {
    if (this.status === "running") {
      this.status = "paused";
      this.logger.log("warn", "Automation paused by user");
      void this.updateAutomationBrowserLock(false);
      this.notifyState();
    }
  }

  resume() {
    if (this.status === "paused" || this.status === "needs-manual-action") {
      this.status = "running";
      this.stopped = false;
      this.logger.log("info", "Automation resumed");
      void this.updateAutomationBrowserLock(true);
      this.notifyState();
    }
  }

  stop() {
    this.stopped = true;
    this.status = "stopped";
    this.logger.log("warn", "Automation stopped by user");
    void this.updateAutomationBrowserLock(false);
    this.notifyState();
  }

  async requestTakeoutExport(archiveSize: string): Promise<AutomationResult> {
    return this.run("Sync Google Photos Takeout export", async () => {
      if (!this.getBackupFolder()) {
        throw new Error("Select a backup folder before checking Takeout exports.");
      }

      if (this.browser.getActiveDownloadCount() > 0) {
        this.logger.log("warn", "Takeout check skipped because a ZIP download is already in progress");
        const files = await this.browser.waitForDownloadsToFinish(1000 * 60 * 60 * 6);
        return { ok: true, message: `Download already in progress. Validated ${files.length} Takeout ZIP file(s).` };
      }

      const existing = await this.openTakeoutAndInspect();
      if (existing.inProgress) {
        this.logger.log("info", "Existing Takeout export is still in progress; waiting for it to become downloadable", existing);
        return this.waitForTakeoutReadyAndDownload();
      }

      if (existing.readyDownloadCount > 0) {
        this.logger.log("info", "Existing Takeout export is ready; starting download from Manage exports", existing);
        return this.downloadReadyTakeoutExport();
      }

      this.logger.log("info", "No ready or in-progress Google Photos Takeout export found; creating a new Google Photos export", existing);
      return this.createGooglePhotosExport(archiveSize);
    });
  }

  private async createGooglePhotosExport(archiveSize: string): Promise<AutomationResult> {
    if (this.browser.getActiveDownloadCount() > 0) {
      this.logger.log("warn", "New Takeout export request blocked because a ZIP download is already in progress");
      const files = await this.browser.waitForDownloadsToFinish(1000 * 60 * 60 * 6);
      return { ok: true, message: `Download already in progress. Validated ${files.length} Takeout ZIP file(s).` };
    }

    const existingFiles = this.browser.validateDownloads({ silent: true });
    if (existingFiles.length > 0) {
      this.logger.log("info", "New Takeout export request skipped because ZIP file(s) already exist in the backup folder", { files: existingFiles });
      return { ok: true, message: `Validated ${existingFiles.length} existing Takeout ZIP file(s).` };
    }

    const existingExport = await this.openTakeoutAndInspect();
    if (existingExport.inProgress) {
      this.logger.log("info", "New Takeout export request skipped because an export is already in progress; waiting for it instead", existingExport);
      return this.waitForTakeoutReadyAndDownload();
    }
    if (existingExport.readyDownloadCount > 0) {
      this.logger.log("info", "New Takeout export request skipped because a Google Photos export is already ready; downloading it instead", existingExport);
      return this.downloadReadyTakeoutExport();
    }

    await this.browser.open("https://takeout.google.com/");
    await this.waitForReady();
    await this.clickByText(["Deselect all"]);
    await this.waitOrThrow();
    await this.selectGooglePhotos();
    await this.clickByText(["Next step", "Continue"]);
    await this.waitOrThrow();
    await this.chooseExportOptions(archiveSize);
    await this.clickByText(["Create export"]);
    await this.waitForAnyText(["Export progress", "Creating a copy", "export is being created", "Manage exports"], 30000);
    this.logger.log("info", "Google Photos Takeout export request appears to be created", { archiveSize });
    return this.waitForTakeoutReadyAndDownload();
  }

  async waitForTakeoutReadyAndDownload(): Promise<AutomationResult> {
    const pollIntervalMs = 60000;
    const timeoutMs = 1000 * 60 * 60 * 24;
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      await this.waitOrThrow();
      if (this.browser.getActiveDownloadCount() > 0) {
        this.logger.log("warn", "Takeout polling paused because a ZIP download is already in progress");
        const files = await this.browser.waitForDownloadsToFinish(1000 * 60 * 60 * 6);
        return { ok: true, message: `Downloaded and validated ${files.length} Takeout ZIP file(s).` };
      }

      const status = await this.openTakeoutAndInspect();

      if (status.inProgress) {
        this.logger.log("info", "Takeout export still in progress; waiting before next check", { nextCheckSeconds: pollIntervalMs / 1000, status });
        await this.sleepWithPause(pollIntervalMs);
        continue;
      }

      if (status.downloadLimitReached) {
        this.logger.log("warn", "Takeout archive download limit reached; creating a new Google Photos export", status);
        return this.createGooglePhotosExport("50GB");
      }

      if (status.readyDownloadCount > 0) {
        this.logger.log("info", "Takeout export became ready for download", status);
        return this.downloadReadyTakeoutExport();
      }

      if (status.readyNonPhotosCount > 0) {
        this.logger.log("warn", "Ready Takeout archive exists but is not Google Photos; ignoring it and creating a new Google Photos export", status);
        return this.createGooglePhotosExport("50GB");
      }

      if (!status.inProgress) {
        this.status = "needs-manual-action";
        this.notifyState();
        return {
          ok: false,
          message: "Takeout did not show a ready or in-progress Google Photos export. Use the visible browser to inspect Manage exports."
        };
      }

    }

    throw new Error("Timed out waiting for the Takeout export to become ready.");
  }

  async openGmailForTakeout(): Promise<AutomationResult> {
    return this.run("Open Gmail for Takeout email", async () => {
      await this.browser.open("https://mail.google.com/mail/u/0/#search/subject%3A%22Archive%20of%20Google%20data%20requested%22");
      this.status = "needs-manual-action";
      this.logger.log("warn", "Gmail opened to the current Google Takeout archive request subject search.");
      this.notifyState();
      return { ok: true, message: "Gmail opened for the Takeout download email." };
    });
  }

  private async openTakeoutAndInspect() {
    await this.browser.open("https://takeout.google.com/");
    await this.waitForReady();
    await this.clickManageExportsIfPresent();
    await this.waitOrThrow();
    return this.inspectTakeoutExports();
  }

  private async inspectTakeoutExports() {
    return this.browser.executeScript<{
      readyDownloadCount: number;
      inProgress: boolean;
      activeExportStatus: string;
      readyNonPhotosCount: number;
      downloadLimitReached: boolean;
      hasManageExports: boolean;
      hasGooglePhotosText: boolean;
      bodySample: string;
    }>(`
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textFor = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).trim().toLowerCase();
        const body = document.body?.innerText?.toLowerCase() || '';
        const downloadLimitReached =
          body.includes("can't download this file again") ||
          body.includes("cannot download this file again") ||
          body.includes('maximum number of times') ||
          body.includes('downloaded this file 5 times');
        const statusTerms = [
          'export in progress',
          'in progress',
          'export is being created',
          'creating a copy',
          'archive of google data requested',
          'ready to download',
          'download',
          'canceled',
          'cancelled',
          'expired',
          'failed'
        ];
        const containers = Array.from(document.querySelectorAll('main section, main div, [role="main"] section, [role="main"] div, article, li'))
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = (el.textContent || '').trim().toLowerCase();
            return { el, rect, text };
          })
          .filter((item) => item.text.length > 0 && item.text.length < 3000 && statusTerms.some((term) => item.text.includes(term)))
          .sort((a, b) => (a.rect.top - b.rect.top) || (b.rect.width * b.rect.height - a.rect.width * a.rect.height));

        const isFailedText = (text) => ['canceled', 'cancelled', 'expired', 'failed'].some((term) => text.includes(term));
        const isInProgressText = (text) => [
          'export in progress',
          'in progress',
          'export is being created',
          'creating a copy',
          'archive of google data requested'
        ].some((term) => text.includes(term));

        const inProgressRows = containers.filter((item) => isInProgressText(item.text) && !isFailedText(item.text));

        const active = inProgressRows[0] || containers.find((item) =>
          item.text.includes('export in progress') ||
          item.text.includes('in progress') ||
          item.text.includes('export is being created') ||
          item.text.includes('creating a copy') ||
          item.text.includes('ready to download') ||
          (item.text.includes('download') && !item.text.includes('download your data'))
        ) || containers[0];

        const activeText = active?.text || body;
        const bodyHasVisibleInProgress = body.includes('export in progress') || body.includes('export is being created') || body.includes('creating a copy');
        const activeInProgress = inProgressRows.length > 0 || (isInProgressText(activeText) && !isFailedText(activeText)) || bodyHasVisibleInProgress;

        const activeCanceled = isFailedText(activeText);
        const activeReady = !activeInProgress && !activeCanceled && (
          activeText.includes('ready to download') ||
          (activeText.includes('download') && !activeText.includes('download your data'))
        );
        const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        const readyRows = Array.from(document.querySelectorAll('a[href*="/manage/archive/"], a[href*="./manage/archive/"]')).map((el) => {
          const text = textFor(el);
          const rect = el.getBoundingClientRect();
          const isFailed = ['canceled', 'cancelled', 'expired', 'failed'].some((term) => text.includes(term));
          const isReady = text.includes('completed') || text.includes('ready') || text.includes('available until');
          let score = 0;
          if (!visible(el) || isFailed || !isReady) return null;
          if (text.includes('google photos')) score += 1000;
          if (text.includes('completed')) score += 100;
          if (text.includes('available until')) score += 50;
          score -= Math.max(0, rect.top) / 1000;
          return { text, score };
        }).filter(Boolean).sort((a, b) => b.score - a.score);
        const readyPhotosRows = readyRows.filter((row) => row.text.includes('google photos'));
        const readyNonPhotosRows = readyRows.filter((row) => !row.text.includes('google photos'));
        const downloadControls = controls.filter((el) => {
          const text = textFor(el);
          const containerText = (el.closest('section, article, li, div')?.textContent || '').toLowerCase();
          if (!visible(el)) return false;
          if (activeInProgress) return false;
          if (!(text.includes('download') || text.includes('/takeout/download'))) return false;
          if (text.includes('download your data') || text.includes('learn') || text.includes('access log')) return false;
          if (text.includes('access-log') || text.includes('access_log')) return false;
          if (['canceled', 'cancelled', 'expired', 'failed'].some((term) => containerText.includes(term))) return false;
          return true;
        });
        return {
          readyDownloadCount: readyPhotosRows.length,
          inProgress: activeInProgress,
          activeExportStatus: activeInProgress ? 'in-progress' : readyPhotosRows.length > 0 ? 'ready-google-photos' : readyNonPhotosRows.length > 0 ? 'ready-non-photos-ignored' : activeCanceled ? 'historical-canceled' : activeReady ? 'ready-unknown-ignored' : 'unknown',
          readyNonPhotosCount: readyNonPhotosRows.length,
          downloadLimitReached,
          hasManageExports: body.includes('manage exports'),
          hasGooglePhotosText: body.includes('google photos'),
          bodySample: (readyPhotosRows[0]?.text || readyNonPhotosRows[0]?.text || activeText).slice(0, 1200)
        };
      })();
    `);
  }

  private async clickManageExportsIfPresent() {
    const clicked = await this.browser.executeScript<boolean>(`
      (() => {
        const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        const target = candidates.find((el) => {
          const text = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
          return text.includes('manage exports');
        });
        if (target instanceof HTMLElement) {
          target.click();
          return true;
        }
        return false;
      })();
    `);

    if (clicked) {
      this.logger.log("info", "Opened Takeout Manage exports area");
      await this.waitOrThrow();
    }
  }

  private async downloadReadyTakeoutExport(): Promise<AutomationResult> {
    await this.waitOrThrow();
    const readyArchiveHref = await this.browser.executeScript<string | null>(`
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textFor = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).trim().toLowerCase();
        const row = Array.from(document.querySelectorAll('a[href*="/manage/archive/"], a[href*="./manage/archive/"]')).map((el) => {
          const text = textFor(el);
          const rect = el.getBoundingClientRect();
          const isFailed = ['canceled', 'cancelled', 'expired', 'failed'].some((term) => text.includes(term));
          const isReady = text.includes('completed') || text.includes('ready') || text.includes('available until');
          let score = 0;
          if (!visible(el) || isFailed || !isReady) return null;
          if (!text.includes('google photos')) return null;
          if (text.includes('google photos')) score += 1000;
          if (text.includes('completed')) score += 100;
          if (text.includes('available until')) score += 50;
          score -= Math.max(0, rect.top) / 1000;
          return { href: el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href'), score };
        }).filter(Boolean).sort((a, b) => b.score - a.score)[0];
        return row?.href || null;
      })();
    `);

    if (readyArchiveHref) {
      this.logger.log("info", "Opening ready Takeout archive detail", { href: readyArchiveHref });
      await this.browser.open(readyArchiveHref);
      await this.waitForReady();
    }

    const downloadLimitReached = await this.detectTakeoutDownloadLimitReached();

    if (downloadLimitReached) {
      this.logger.log("warn", "Takeout archive download limit reached on detail page; creating a new Google Photos export");
      return this.createGooglePhotosExport("50GB");
    }

    const result = await this.browser.executeScript<{ candidates: Array<{ text: string; x: number; y: number; score: number }> }>(`
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textFor = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).trim().toLowerCase();
        const body = document.body?.innerText?.toLowerCase() || '';
        if (['export in progress', 'in progress', 'export is being created', 'creating a copy'].some((term) => body.includes(term))) {
          return { candidates: [] };
        }
        const blocked = (text) =>
          text.includes('download your data') ||
          text.includes('learn') ||
          text.includes('access log') ||
          text.includes('access-log') ||
          text.includes('access_log') ||
          text.includes('see report') ||
          text.includes('report');
        const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        const targets = controls.map((el) => {
          const text = textFor(el);
          const containerText = (el.closest('section, article, li, div')?.textContent || '').toLowerCase();
          const ownLabel = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
          let score = 0;
          if (!visible(el)) return null;
          if (!(text.includes('download') || text.includes('/takeout/download'))) return null;
          if (blocked(text)) return null;
          if (ownLabel && !ownLabel.includes('download')) return null;
          if (['canceled', 'cancelled', 'expired', 'failed'].some((term) => containerText.includes(term))) return null;
          if (ownLabel === 'download') score += 100;
          if (ownLabel === 'download again') score += 95;
          if (ownLabel.includes('download')) score += 50;
          if (text.includes('/takeout/download')) score += 40;
          if (containerText.includes('ready to download')) score += 20;
          const rect = el.getBoundingClientRect();
          return { text: text.slice(0, 180), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, score };
        }).filter(Boolean).sort((a, b) => b.score - a.score);

        return {
          candidates: targets.map((target) => ({
            text: target.text,
            x: target.x,
            y: target.y,
            score: target.score
          }))
        };
      })();
    `);

    this.logger.log("info", "Takeout download candidates inspected", result);

    if (result.candidates.length === 0) {
      this.status = "needs-manual-action";
      this.notifyState();
      return { ok: false, message: "No Takeout download controls were found. Use the visible Takeout Manage exports page manually." };
    }

    let clicked = 0;
    const initialDownloadEventCount = this.browser.getDownloadEventCount();
    for (const candidate of result.candidates) {
      clicked += 1;
      const downloadEventCount = this.browser.getDownloadEventCount();
      this.logger.log("info", "Clicking Takeout download control", { clicked, candidate });
      await this.browser.setBrowserInteractionLocked(false);
      this.browser.clickAt(candidate.x, candidate.y);
      await sleep(250);
      await this.updateAutomationBrowserLock(true);
      const clickOutcome = await this.waitForDownloadStartOrLimit(downloadEventCount);
      if (clickOutcome === "modal-blocked") {
        await this.dismissBlockingModal();
        const debugPath = await this.dumpTakeoutDebug("takeout-download-blocking-modal");
        if (this.browser.getDownloadEventCount() > downloadEventCount) {
          this.logger.log("info", "Takeout download event arrived after blocking modal; validating local ZIP files before requesting a new export", { debugPath });
          const files = await this.browser.waitForDownloadsToFinish(1000 * 60 * 60 * 6, downloadEventCount);
          return { ok: true, message: `Downloaded and validated ${files.length} Takeout ZIP file(s).` };
        }
        this.logger.log("warn", "Takeout download opened a blocking modal; treating the archive as exhausted and creating a new Google Photos export", { debugPath });
        return this.createGooglePhotosExport("50GB");
      }
      if (clickOutcome === "limit-reached") {
        const debugPath = await this.dumpTakeoutDebug("takeout-download-limit");
        await this.dismissBlockingModal();
        if (this.browser.getDownloadEventCount() > downloadEventCount) {
          this.logger.log("info", "Takeout download event arrived after limit message; validating local ZIP files before requesting a new export", { debugPath });
          const files = await this.browser.waitForDownloadsToFinish(1000 * 60 * 60 * 6, downloadEventCount);
          return { ok: true, message: `Downloaded and validated ${files.length} Takeout ZIP file(s).` };
        }
        this.logger.log("warn", "Takeout archive download limit appeared after clicking Download; creating a new Google Photos export", { clickOutcome, debugPath });
        return this.createGooglePhotosExport("50GB");
      }
      if (clickOutcome === "download-started") {
        break;
      }
    }

    if (this.browser.getActiveDownloadCount() === 0) {
      const existingFiles = this.browser.validateDownloads({ silent: true });
      if (existingFiles.length > 0) {
        this.logger.log("info", "No active download remains because the Takeout ZIP already exists locally", { files: existingFiles });
        return { ok: true, message: `Validated ${existingFiles.length} existing Takeout ZIP file(s).` };
      }

      const debugPath = await this.dumpTakeoutDebug("takeout-no-download-after-click");
      this.logger.log("warn", "No download started after clicking Takeout Download; treating this archive as exhausted and creating a new Google Photos export", { debugPath });
      return this.createGooglePhotosExport("50GB");
    }

    const files = await this.browser.waitForDownloadsToFinish(1000 * 60 * 60 * 6, initialDownloadEventCount);
    if (files.length === 0) {
      this.status = "needs-manual-action";
      this.notifyState();
      return { ok: false, message: "Download controls were clicked, but no ZIP files were validated. Check the visible browser for Google confirmation prompts." };
    }

    return { ok: true, message: `Downloaded and validated ${files.length} Takeout ZIP file(s).` };
  }

  private async waitForDownloadStartOrLimit(initialDownloadEventCount: number) {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      await this.waitOrThrow();
      const limitState = await this.detectTakeoutDownloadLimitReachedSafely();
      if (limitState === "blocked") {
        return "modal-blocked" as const;
      }
      if (limitState === true) {
        return "limit-reached" as const;
      }
      if (this.browser.getActiveDownloadCount() > 0) {
        return "download-started" as const;
      }
      if (this.browser.getDownloadEventCount() > initialDownloadEventCount) {
        return "download-started" as const;
      }
      await sleep(1000);
    }

    const limitState = await this.detectTakeoutDownloadLimitReachedSafely();
    if (limitState === "blocked") {
      return "modal-blocked" as const;
    }
    if (limitState === true) {
      return "limit-reached" as const;
    }

    return this.browser.getActiveDownloadCount() > 0 || this.browser.getDownloadEventCount() > initialDownloadEventCount ? "download-started" as const : "no-download" as const;
  }

  private async detectTakeoutDownloadLimitReachedSafely() {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race<boolean | "blocked">([
        this.detectTakeoutDownloadLimitReached(),
        new Promise<"blocked">((resolve) => {
          timer = setTimeout(() => resolve("blocked"), 2500);
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async detectTakeoutDownloadLimitReached() {
    return this.browser.executeScript<boolean>(`
      (() => {
        const collectText = (root) => {
          const chunks = [];
          const visit = (node) => {
            if (!node) return;
            if (node.nodeType === Node.TEXT_NODE) {
              chunks.push(node.textContent || '');
              return;
            }
            if (!(node instanceof Element || node instanceof Document || node instanceof ShadowRoot)) return;
            if (node instanceof Element) {
              chunks.push(node.getAttribute('aria-label') || '');
              chunks.push(node.getAttribute('title') || '');
              chunks.push(node.getAttribute('data-tooltip') || '');
              if (node.shadowRoot) visit(node.shadowRoot);
            }
            for (const child of Array.from(node.childNodes || [])) visit(child);
          };
          visit(root);
          return chunks.join(' ').replace(/\\s+/g, ' ').toLowerCase();
        };

        const text = collectText(document);
        return text.includes("can't download this file again") ||
          text.includes("can’t download this file again") ||
          text.includes("cannot download this file again") ||
          text.includes("you can't download this file again") ||
          text.includes("you can’t download this file again") ||
          text.includes('maximum number of times') ||
          text.includes('downloaded this file 5 times') ||
          text.includes('try to download a file only 5 times') ||
          text.includes('try to download this file only 5 times') ||
          (text.includes('try to download') && text.includes('5 times')) ||
          text.includes('tried to download or have downloaded this file 5 times') ||
          text.includes('you can create a new request at any time');
      })();
    `);
  }

  private async dumpTakeoutDebug(label: string) {
    const screenshotPath = await this.browser.screenshot(label);
    const details = await this.browser.executeScript<{
      url: string;
      title: string;
      bodyText: string;
      deepText: string;
      dialogs: Array<{ role: string | null; ariaLabel: string | null; text: string }>;
      controls: Array<{ tag: string; role: string | null; ariaLabel: string | null; title: string | null; href: string | null; text: string; rect: { x: number; y: number; width: number; height: number } }>;
    }>(`
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const collectText = (root) => {
          const chunks = [];
          const visit = (node) => {
            if (!node) return;
            if (node.nodeType === Node.TEXT_NODE) {
              chunks.push(node.textContent || '');
              return;
            }
            if (!(node instanceof Element || node instanceof Document || node instanceof ShadowRoot)) return;
            if (node instanceof Element) {
              chunks.push(node.getAttribute('aria-label') || '');
              chunks.push(node.getAttribute('title') || '');
              chunks.push(node.getAttribute('data-tooltip') || '');
              chunks.push(node.getAttribute('role') || '');
              if (node.shadowRoot) visit(node.shadowRoot);
            }
            for (const child of Array.from(node.childNodes || [])) visit(child);
          };
          visit(root);
          return clean(chunks.join(' '));
        };
        const rectFor = (el) => {
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        };
        const controls = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'))
          .filter(visible)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            title: el.getAttribute('title'),
            href: el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href'),
            text: clean(el.textContent).slice(0, 500),
            rect: rectFor(el)
          }))
          .slice(0, 120);
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [aria-modal="true"]'))
          .filter(visible)
          .map((el) => ({
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            text: clean(el.textContent).slice(0, 2000)
          }));
        return {
          url: location.href,
          title: document.title,
          bodyText: clean(document.body?.innerText || '').slice(0, 5000),
          deepText: collectText(document).slice(0, 10000),
          dialogs,
          controls
        };
      })();
    `);

    const folder = path.join(app.getPath("userData"), "debug");
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ screenshotPath, ...details }, null, 2));
    this.logger.log("warn", `Saved Takeout debug dump: ${label}`, { path: filePath, screenshotPath, url: details.url, title: details.title });
    return filePath;
  }

  private async dismissBlockingModal() {
    this.browser.pressKey("Enter");
    await sleep(500);
    this.browser.pressKey("Escape");
    await sleep(500);
  }

  private async dumpPhotosDebug(label: string) {
    const screenshotPath = await this.browser.screenshot(label);
    const details = await this.browser.executeScript<{
      url: string;
      title: string;
      bodyText: string;
      controls: Array<{ tag: string; role: string | null; ariaLabel: string | null; title: string | null; text: string; rect: { x: number; y: number; width: number; height: number } }>;
      tiles: Array<{ tag: string; role: string | null; ariaLabel: string | null; href: string | null; rect: { x: number; y: number; width: number; height: number } }>;
    }>(`
      (() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const rectFor = (el) => {
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        };
        const controls = Array.from(document.querySelectorAll('[role="checkbox"], button, [role="button"], [aria-label*="Select"], [aria-label*="select"]'))
          .filter(visible)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            title: el.getAttribute('title'),
            text: clean(el.textContent).slice(0, 300),
            rect: rectFor(el)
          }))
          .slice(0, 200);
        const tiles = Array.from(document.querySelectorAll('[role="gridcell"], [data-id], a[href*="/photo/"], a[href*="/video/"], [aria-label*="Photo"], [aria-label*="Video"]'))
          .filter(visible)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            href: el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href'),
            rect: rectFor(el)
          }))
          .slice(0, 200);
        return {
          url: location.href,
          title: document.title,
          bodyText: clean(document.body?.innerText || '').slice(0, 5000),
          controls,
          tiles
        };
      })();
    `);

    const folder = path.join(app.getPath("userData"), "debug");
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ screenshotPath, ...details }, null, 2));
    this.logger.log("warn", `Saved Photos debug dump: ${label}`, { path: filePath, screenshotPath, url: details.url, title: details.title });
    return filePath;
  }

  async startPhotosCleanup(): Promise<AutomationResult> {
    return this.run("Prepare Google Photos cleanup", async () => {
      if (!this.downloadsAreComplete()) {
        throw new Error("ZIP downloads must be completed and validated before cleanup.");
      }

      await this.browser.open("https://photos.google.com/");
      await this.waitForReady();
      this.logger.log("info", "Google Photos opened for cleanup");
      await this.updateAutomationBrowserLock(true);
      const selection = await this.selectGooglePhotosRange();
      if (!selection.ok) {
        return selection;
      }
      const result = await this.moveSelectedPhotosToTrash();
      await this.updateAutomationBrowserLock(true);
      return result;
    });
  }

  async selectVisiblePhotosBatch(): Promise<AutomationResult> {
    return this.run("Select Google Photos range", async () => {
      return this.selectGooglePhotosRange();
    });
  }

  private async selectGooglePhotosRange(): Promise<AutomationResult> {
      if (!this.downloadsAreComplete()) {
        throw new Error("Cannot select photos until downloads have been validated.");
      }

      if (!this.browser.getCurrentUrl()?.includes("photos.google.com")) {
        await this.browser.open("https://photos.google.com/");
        await this.waitForReady();
      }

      const first = await this.getPhotosSelectionCandidate("first");
      if (!first) {
        const debugPath = await this.dumpPhotosDebug("photos-selection-no-candidates");
        this.status = "needs-manual-action";
        this.notifyState();
        return { ok: false, message: `No selectable Google Photos items were detected. Debug saved: ${debugPath}` };
      }

      await this.browser.setInPageInteractionBlocked(false);
      const firstControl = first.kind === "select-control" ? first : await this.revealPhotosSelectControl(first);
      if (!firstControl) {
        await this.updateAutomationBrowserLock(true);
        const debugPath = await this.dumpPhotosDebug("photos-selection-first-not-found");
        this.status = "needs-manual-action";
        this.notifyState();
        return { ok: false, message: `Could not reveal the first Google Photos select control. Debug saved: ${debugPath}` };
      }

      this.browser.moveMouseTo(firstControl.x, firstControl.y);
      await sleep(80);
      this.browser.clickAt(firstControl.x, firstControl.y);
      await sleep(700);
      this.logger.log("info", "Selected first visible Google Photos item", { first, firstControl });

      const scrollResult = await this.scrollGooglePhotosGridToBottom();
      await sleep(1200);

      const last = await this.getPhotosSelectionCandidate("last");
      const detectedLastControl = last && (last.kind === "select-control" ? last : await this.revealPhotosSelectControl(last));
      const lastControl = detectedLastControl ?? (last ? this.getPhotosTileSelectionCorner(last) : null);
      if (!last || !lastControl) {
        await this.updateAutomationBrowserLock(true);
        const debugPath = await this.dumpPhotosDebug("photos-selection-last-not-found");
        this.status = "needs-manual-action";
        this.notifyState();
        return { ok: false, message: `Could not reveal the last Google Photos select control after scrolling. Debug saved: ${debugPath}` };
      }

      if (!detectedLastControl) {
        this.logger.log("warn", "Last Google Photos checkbox was not exposed after hover; using tile selection-corner fallback", { last, lastControl });
      }
      this.browser.moveMouseTo(lastControl.x, lastControl.y);
      await sleep(100);
      this.browser.clickAt(lastControl.x, lastControl.y, ["shift"]);
      await sleep(800);
      await this.updateAutomationBrowserLock(true);

      this.logger.log("info", "Shift-clicked last visible Google Photos item for range selection", { first, firstControl, last, lastControl, scrollResult });
      return { ok: true, message: "Selected first item, scrolled to the bottom, then Shift-clicked the last item. Review selection before moving to trash." };
  }

  async moveSelectedToTrash(): Promise<AutomationResult> {
    return this.run("Move selected Google Photos items to trash", async () => {
      return this.moveSelectedPhotosToTrash();
    });
  }

  private async moveSelectedPhotosToTrash(): Promise<AutomationResult> {
    if (!this.downloadsAreComplete()) {
      throw new Error("Cannot move items to trash until downloads have been validated.");
    }

    const screenshot = await this.browser.screenshot("before-move-to-trash");
    this.setLastScreenshot(screenshot);
    const target = await this.findPhotosTrashControl();
    if (!target) {
      const debugPath = await this.dumpPhotosDebug("photos-trash-control-not-found");
      this.status = "needs-manual-action";
      this.notifyState();
      return { ok: false, message: `Could not find the Google Photos trash button. Debug saved: ${debugPath}` };
    }

    await this.browser.setInPageInteractionBlocked(false);
    this.browser.moveMouseTo(target.x, target.y);
    await sleep(120);
    this.browser.clickAt(target.x, target.y);
    const confirmation = await this.clickPhotosMoveToTrashConfirmation();
    if (!confirmation) {
      this.logger.log("warn", "Google Photos move-to-trash confirmation dialog was not detected after trash click");
    }
    await this.updateAutomationBrowserLock(false);
    this.status = "needs-manual-action";
    this.logger.log("safety", "Moved selected Google Photos items to trash", target);
    this.notifyState();
    return { ok: true, message: "Selected Google Photos items were moved to trash. Empty trash remains locked behind final confirmation." };
  }

  private async findPhotosTrashControl() {
    return this.browser.executeScript<{ x: number; y: number; label: string } | null>(`
      (() => {
        const lock = document.getElementById('photodrain-browser-lock');
        if (lock) lock.style.pointerEvents = 'none';
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none';
        };
        const textFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-tooltip') || '',
          el.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [title], [data-tooltip]'))
          .filter((el) => {
            if (!(el instanceof HTMLElement) || !visible(el)) return false;
            const text = textFor(el);
            if (text.includes('trash') || text.includes('delete') || text.includes('remove')) return true;
            const iconText = Array.from(el.querySelectorAll('svg, path, i')).map((child) => textFor(child)).join(' ');
            return iconText.includes('trash') || iconText.includes('delete');
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = textFor(el);
            let score = 0;
            if (text.includes('move to trash')) score += 1000;
            if (text.includes('trash')) score += 500;
            if (text.includes('delete')) score += 250;
            if ((el.getAttribute('role') || '').toLowerCase() === 'button') score += 50;
            if (el.tagName.toLowerCase() === 'button') score += 50;
            if (rect.top < 160) score += 100;
            if (rect.width <= 96 && rect.height <= 96) score += 50;
            if (text.includes('empty trash')) score -= 1000;
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              label: text.slice(0, 220),
              score
            };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        const target = controls[0];
        return target ? { x: target.x, y: target.y, label: target.label } : null;
      })();
    `);
  }

  private async findPhotosMoveToTrashConfirmation() {
    return this.browser.executeScript<{ x: number; y: number; label: string } | null>(`
      (() => {
        const lock = document.getElementById('photodrain-browser-lock');
        if (lock) lock.style.pointerEvents = 'none';
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none';
        };
        const textFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-tooltip') || '',
          el.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
          .filter(visible);
        const roots = dialogs.length > 0 ? dialogs : [document.body];
        const controls = roots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"]')))
          .filter((el) => {
            if (!(el instanceof HTMLElement) || !visible(el)) return false;
            const text = textFor(el);
            if (!text.includes('move to trash')) return false;
            if (text.includes('cancel')) return false;
            if (text.includes('empty trash')) return false;
            return true;
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = textFor(el);
            let score = 0;
            if (text === 'move to trash') score += 1000;
            if (text.includes('move to trash')) score += 500;
            if ((el.getAttribute('role') || '').toLowerCase() === 'button') score += 50;
            if (el.tagName.toLowerCase() === 'button') score += 50;
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              label: text.slice(0, 220),
              score
            };
          })
          .sort((a, b) => b.score - a.score);
        const target = controls[0];
        return target ? { x: target.x, y: target.y, label: target.label } : null;
      })();
    `);
  }

  private async clickPhotosMoveToTrashConfirmation() {
    const started = Date.now();
    while (Date.now() - started < 9000) {
      await sleep(350);
      const target = await this.browser.executeScript<{ label: string; x: number; y: number; source: string } | null>(`
        (() => {
          const lock = document.getElementById('photodrain-browser-lock');
          if (lock) lock.style.pointerEvents = 'none';
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight &&
              rect.right > 0 &&
              rect.left < window.innerWidth &&
              style.visibility !== 'hidden' &&
              style.display !== 'none';
          };
          const textFor = (el) => [
            el.getAttribute('aria-label') || '',
            el.getAttribute('title') || '',
            el.getAttribute('data-tooltip') || '',
            el.textContent || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], div[tabindex="-1"]'))
            .filter((el) => visible(el) && textFor(el).includes('move to trash'));
          const roots = dialogs.length > 0 ? dialogs : [document.body];
          const controls = roots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"], div[tabindex], span[tabindex]')))
            .filter((el) => {
              if (!(el instanceof HTMLElement) || !visible(el)) return false;
              const text = textFor(el);
              if (text.includes('cancel')) return false;
              if (text.includes('empty trash')) return false;
              const disabled = el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
              if (disabled) return false;
              const ownText = [
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || '',
                el.textContent || ''
              ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
              const role = (el.getAttribute('role') || '').toLowerCase();
              const rect = el.getBoundingClientRect();
              const isButtonLike = el.tagName.toLowerCase() === 'button' || role === 'button';
              const isCompact = rect.width <= 260 && rect.height <= 96;
              return ownText.includes('move to trash') && (isButtonLike || isCompact);
            })
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const text = textFor(el);
              const ownText = [
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || '',
                el.textContent || ''
              ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
              let score = 0;
              if (ownText === 'move to trash') score += 2000;
              if (ownText.includes('move to trash')) score += 1000;
              if (text.includes('move to trash')) score += 500;
              if ((el.getAttribute('role') || '').toLowerCase() === 'button') score += 100;
              if (el.tagName.toLowerCase() === 'button') score += 150;
              if (dialogs.some((dialog) => dialog.contains(el))) score += 250;
              if (rect.width <= 220 && rect.height <= 80) score += 50;
              if (rect.width > 260 || rect.height > 96) score -= 1000;
              return { text, score, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, source: el.tagName.toLowerCase() };
            })
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);

          const target = controls[0];
          if (target) return { label: target.text.slice(0, 220), x: target.x, y: target.y, source: target.source };

          const dialog = dialogs[0];
          if (dialog instanceof HTMLElement) {
            const rect = dialog.getBoundingClientRect();
            return {
              label: textFor(dialog).slice(0, 220),
              x: rect.right - 82,
              y: rect.bottom - 34,
              source: 'dialog-lower-right-fallback'
            };
          }
          return null;
        })();
      `);

      if (target) {
        this.logger.log("safety", "Clicking Google Photos move-to-trash confirmation by Electron input", target);
        this.browser.moveMouseTo(target.x, target.y);
        await sleep(120);
        this.browser.clickAt(target.x, target.y);
        await sleep(900);
        if (!(await this.isPhotosMoveToTrashDialogVisible())) {
          return { clicked: true, label: target.label, x: target.x, y: target.y };
        }

        this.logger.log("warn", "Move-to-trash dialog remained after coordinate click; pressing Enter as fallback", target);
        this.browser.pressKey("Enter");
        await sleep(900);
        if (!(await this.isPhotosMoveToTrashDialogVisible())) {
          return { clicked: true, label: `${target.label} via Enter fallback`, x: target.x, y: target.y };
        }
      }

      const confirmation = await this.findPhotosMoveToTrashConfirmation();
      if (confirmation) {
        this.logger.log("safety", "Confirming Google Photos move-to-trash dialog by coordinate fallback", confirmation);
        this.browser.moveMouseTo(confirmation.x, confirmation.y);
        await sleep(120);
        this.browser.clickAt(confirmation.x, confirmation.y);
        await sleep(900);
        if (!(await this.isPhotosMoveToTrashDialogVisible())) {
          return { clicked: true, label: confirmation.label, x: confirmation.x, y: confirmation.y };
        }
      }
    }

    const debugPath = await this.dumpPhotosDebug("photos-move-to-trash-confirmation-not-found");
    this.logger.log("warn", "Move-to-trash confirmation was not found before timeout", { debugPath });
    return null;
  }

  private async isPhotosMoveToTrashDialogVisible() {
    return this.browser.executeScript<boolean>(`
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
        };
        const textFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], div[tabindex="-1"]'))
          .some((el) => visible(el) && textFor(el).includes('move to trash'));
      })();
    `);
  }

  private async getPhotosSelectionCandidate(position: "first" | "last") {
    return this.browser.executeScript<PhotosSelectionCandidate | null>(`
      (() => {
        const position = ${JSON.stringify(position)};
        const lock = document.getElementById('photodrain-browser-lock');
        if (lock) lock.style.pointerEvents = 'none';
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none';
        };
        const labelFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const isSelected = (el) =>
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('data-is-selected') === 'true' ||
          el.className?.toString().toLowerCase().includes('selected');
        const selectControls = () => {
          const selectors = [
            '[role="checkbox"]',
            'button[aria-label*="Select"]',
            'button[aria-label*="select"]',
            '[role="button"][aria-label*="Select"]',
            '[role="button"][aria-label*="select"]',
            '[aria-label*="Select photo"]',
            '[aria-label*="Select video"]',
            '[aria-label*="Select item"]',
            '[aria-label*="Select image"]'
          ];
          const seen = new Set();
          return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .filter((el) => {
              if (!(el instanceof HTMLElement) || seen.has(el) || !visible(el) || isSelected(el)) return false;
              seen.add(el);
              const label = labelFor(el);
              const role = (el.getAttribute('role') || '').toLowerCase();
              if (!label.includes('select') && role !== 'checkbox') return false;
              if (label.includes('select all') || label.includes('selected') || label.includes('deselect')) return false;
              if (label.includes('account') || label.includes('navigation')) return false;
              return true;
            })
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                kind: 'select-control',
                label: labelFor(el).slice(0, 180),
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom
              };
            });
        };
        const mediaTiles = () => {
          const selectors = [
            '[role="gridcell"]',
            '[data-id]',
            'a[href*="/photo/"]',
            'a[href*="/video/"]',
            '[aria-label*="Photo taken"]',
            '[aria-label*="Video taken"]',
            '[aria-label*="Photo"]',
            '[aria-label*="Video"]'
          ];
          const seen = new Set();
          return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .map((el) => {
              if (!(el instanceof HTMLElement)) return null;
              let tile = el;
              for (let depth = 0; tile.parentElement && depth < 4; depth += 1) {
                const rect = tile.getBoundingClientRect();
                if (rect.width >= 90 && rect.height >= 90) break;
                tile = tile.parentElement;
              }
              return tile;
            })
            .filter((el) => {
              if (!(el instanceof HTMLElement) || seen.has(el) || !visible(el)) return false;
              seen.add(el);
              const rect = el.getBoundingClientRect();
              if (rect.width < 72 || rect.height < 72 || rect.top < 72) return false;
              const label = labelFor(el);
              if (label.includes('navigation') || label.includes('search') || label.includes('account')) return false;
              return true;
            })
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return {
                x: Math.min(rect.right - 12, rect.left + Math.max(28, Math.min(48, rect.width / 2))),
                y: Math.min(rect.bottom - 12, rect.top + Math.max(28, Math.min(48, rect.height / 2))),
                kind: 'tile-hover',
                label: labelFor(el).slice(0, 180),
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom
              };
            });
        };
        const candidates = [...selectControls(), ...mediaTiles()]
          .sort((a, b) => (a.top - b.top) || (a.left - b.left));
        return position === 'last' ? candidates[candidates.length - 1] || null : candidates[0] || null;
      })();
    `);
  }

  private async revealPhotosSelectControl(candidate: PhotosSelectionCandidate) {
    this.browser.moveMouseTo(candidate.x, candidate.y);
    await sleep(300);
    return this.findRevealedPhotosSelectControl(candidate);
  }

  private getPhotosTileSelectionCorner(candidate: PhotosSelectionCandidate) {
    if (
      !Number.isFinite(candidate.left) ||
      !Number.isFinite(candidate.top) ||
      !Number.isFinite(candidate.right) ||
      !Number.isFinite(candidate.bottom)
    ) {
      return null;
    }

    const left = candidate.left ?? candidate.x - 48;
    const top = candidate.top ?? candidate.y - 48;
    const right = candidate.right ?? candidate.x + 48;
    const bottom = candidate.bottom ?? candidate.y + 48;
    const x = Math.min(right - 18, left + 24);
    const y = Math.min(bottom - 18, top + 24);
    return { x, y, label: "tile selection corner fallback" };
  }

  private async findRevealedPhotosSelectControl(candidate: { x: number; y: number; left?: number; top?: number; right?: number; bottom?: number }) {
    return this.browser.executeScript<{ x: number; y: number; label: string } | null>(`
      (() => {
        const candidate = ${JSON.stringify(candidate)};
        const origin = { x: candidate.x, y: candidate.y };
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none';
        };
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const labelFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const isSelected = (el) =>
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('data-is-selected') === 'true' ||
          el.className?.toString().toLowerCase().includes('selected');
        const promotedControlAt = (x, y) => {
          const hit = document.elementFromPoint(x, y);
          let current = hit instanceof HTMLElement ? hit : hit?.parentElement;
          for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
            if (!visible(current) || isSelected(current)) continue;
            const role = normalize(current.getAttribute('role'));
            const label = labelFor(current);
            const href = current instanceof HTMLAnchorElement ? current.href : current.closest('a')?.href || '';
            const isMediaLink = href.includes('/photo/') || href.includes('/video/');
            const isSelectLike = label.includes('select') ||
              role === 'checkbox' ||
              (role === 'button' && !isMediaLink && current.getBoundingClientRect().width <= 72 && current.getBoundingClientRect().height <= 72);
            const isRejected = label.includes('select all') ||
              label.includes('selected') ||
              label.includes('deselect') ||
              label.includes('account') ||
              label.includes('navigation');
            if (isSelectLike && !isRejected && !isMediaLink) {
              const rect = current.getBoundingClientRect();
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                label: label.slice(0, 180),
                distance: Math.hypot(rect.left + rect.width / 2 - origin.x, rect.top + rect.height / 2 - origin.y)
              };
            }
          }
          return null;
        };
        const left = Number.isFinite(candidate.left) ? candidate.left : origin.x - 48;
        const top = Number.isFinite(candidate.top) ? candidate.top : origin.y - 48;
        const right = Number.isFinite(candidate.right) ? candidate.right : origin.x + 48;
        const bottom = Number.isFinite(candidate.bottom) ? candidate.bottom : origin.y + 48;
        const probePoints = [
          { x: left + 18, y: top + 18 },
          { x: left + 24, y: top + 24 },
          { x: left + 34, y: top + 34 },
          { x: right - 18, y: top + 18 },
          { x: right - 24, y: top + 24 },
          { x: origin.x, y: origin.y },
          { x: left + 18, y: Math.min(bottom - 18, top + 48) },
          { x: Math.min(right - 18, left + 48), y: top + 18 }
        ];
        for (const point of probePoints) {
          const target = promotedControlAt(point.x, point.y);
          if (target) return { x: target.x, y: target.y, label: target.label };
        }
        const controls = Array.from(document.querySelectorAll('[role="checkbox"], button[aria-label*="Select"], button[aria-label*="select"], [role="button"][aria-label*="Select"], [role="button"][aria-label*="select"], [aria-label*="Select photo"], [aria-label*="Select video"], [aria-label*="Select item"], [aria-label*="Select image"]'))
          .filter((el) => {
            if (!(el instanceof HTMLElement) || !visible(el) || isSelected(el)) return false;
            const label = labelFor(el);
            const role = normalize(el.getAttribute('role'));
            if (!label.includes('select') && role !== 'checkbox') return false;
            if (label.includes('select all') || label.includes('selected') || label.includes('deselect')) return false;
            if (label.includes('account') || label.includes('navigation')) return false;
            return true;
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            return {
              x: cx,
              y: cy,
              label: labelFor(el).slice(0, 180),
              distance: Math.hypot(cx - origin.x, cy - origin.y)
            };
          })
          .filter((item) => item.distance < 180)
          .sort((a, b) => a.distance - b.distance);
        const target = controls[0];
        return target ? { x: target.x, y: target.y, label: target.label } : null;
      })();
    `);
  }

  private async scrollGooglePhotosGrid() {
    return this.browser.executeScript<number>(`
      (() => {
        const candidates = [document.scrollingElement, document.documentElement, document.body, ...Array.from(document.querySelectorAll('main, [role="main"], div'))]
          .filter((el) => el instanceof HTMLElement || el instanceof Element);
        const scroller = candidates
          .map((el) => ({ el, distance: Math.max(0, el.scrollHeight - el.clientHeight) }))
          .sort((a, b) => b.distance - a.distance)[0]?.el || document.scrollingElement || document.documentElement;
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
          window.scrollBy({ top: Math.max(1400, window.innerHeight * 2.4), behavior: 'auto' });
          return Math.max(document.documentElement.scrollTop, document.body.scrollTop, window.scrollY);
        }
        scroller.scrollBy({ top: Math.max(1400, scroller.clientHeight * 2.4), behavior: 'auto' });
        return scroller.scrollTop;
      })();
    `);
  }

  private async scrollGooglePhotosGridToBottom() {
    let lastPosition = -1;
    let stablePasses = 0;
    let passes = 0;

    while (passes < 300 && stablePasses < 3) {
      await this.waitOrThrow();
      passes += 1;
      const position = await this.scrollGooglePhotosGrid();
      if (Math.abs(position - lastPosition) < 4) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }
      lastPosition = position;
      await sleep(180);
    }

    this.logger.log("info", "Scrolled Google Photos grid to bottom for range selection", { passes, position: lastPosition });
    return { passes, position: lastPosition };
  }

  async emptyTrash(payload: FinalDeletePayload): Promise<AutomationResult> {
    return this.run("Empty Google Photos trash", async () => {
      if (!this.getBackupFolder()) {
        throw new Error("Backup folder is required.");
      }
      if (!this.downloadsAreComplete()) {
        throw new Error("Cannot empty trash until ZIP downloads are completed and validated.");
      }
      if (payload.typedConfirmation !== FINAL_DELETE_CONFIRMATION || !payload.understandsPermanentDelete) {
        throw new Error("Final delete confirmation is incomplete.");
      }

      await this.browser.open("https://photos.google.com/trash");
      await this.waitForReady();
      const screenshot = await this.browser.screenshot("before-empty-trash");
      this.setLastScreenshot(screenshot);
      const target = await this.findPhotosEmptyTrashControl();
      if (!target) {
        const debugPath = await this.dumpPhotosDebug("photos-empty-trash-control-not-found");
        this.status = "needs-manual-action";
        this.notifyState();
        return { ok: false, message: `Could not find the Google Photos Empty trash button. Debug saved: ${debugPath}` };
      }

      await this.browser.setInPageInteractionBlocked(false);
      this.logger.log("safety", "Clicking Google Photos Empty trash button after final local confirmation", target);
      this.browser.moveMouseTo(target.x, target.y);
      await sleep(120);
      this.browser.clickAt(target.x, target.y);
      await sleep(700);

      const confirmation = await this.findPhotosEmptyTrashConfirmation();
      if (confirmation) {
        this.logger.log("safety", "Confirming Google Photos Empty trash dialog", confirmation);
        this.browser.moveMouseTo(confirmation.x, confirmation.y);
        await sleep(120);
        this.browser.clickAt(confirmation.x, confirmation.y);
        await sleep(700);
      } else {
        this.logger.log("warn", "Google Photos Empty trash confirmation dialog was not detected after Empty trash click");
      }

      await this.updateAutomationBrowserLock(false);
      return { ok: true, message: "Google Photos trash empty action was triggered after final local confirmation." };
    });
  }

  private async findPhotosEmptyTrashControl() {
    return this.findGooglePhotosButtonByText(["empty trash"], ["cancel", "move to trash"]);
  }

  private async findPhotosEmptyTrashConfirmation() {
    return this.findGooglePhotosButtonByText(["empty trash"], ["cancel", "move to trash"], true);
  }

  private async findGooglePhotosButtonByText(includeTerms: string[], excludeTerms: string[], preferDialog = false) {
    return this.browser.executeScript<{ x: number; y: number; label: string } | null>(`
      (() => {
        const includeTerms = ${JSON.stringify(includeTerms)};
        const excludeTerms = ${JSON.stringify(excludeTerms)};
        const preferDialog = ${JSON.stringify(preferDialog)};
        const lock = document.getElementById('photodrain-browser-lock');
        if (lock) lock.style.pointerEvents = 'none';
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            style.pointerEvents !== 'none';
        };
        const textFor = (el) => [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-tooltip') || '',
          el.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
          .filter(visible);
        const roots = preferDialog && dialogs.length > 0 ? dialogs : [document.body, ...dialogs];
        const controls = roots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"], [aria-label], [title], [data-tooltip]')))
          .filter((el) => {
            if (!(el instanceof HTMLElement) || !visible(el)) return false;
            const text = textFor(el);
            return includeTerms.some((term) => text.includes(term)) &&
              !excludeTerms.some((term) => text.includes(term));
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = textFor(el);
            let score = 0;
            for (const term of includeTerms) {
              if (text === term) score += 1000;
              if (text.includes(term)) score += 500;
            }
            if ((el.getAttribute('role') || '').toLowerCase() === 'button') score += 50;
            if (el.tagName.toLowerCase() === 'button') score += 50;
            if (dialogs.some((dialog) => dialog.contains(el))) score += 250;
            if (rect.width <= 180 && rect.height <= 80) score += 50;
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              label: text.slice(0, 220),
              score
            };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        const target = controls[0];
        return target ? { x: target.x, y: target.y, label: target.label } : null;
      })();
    `);
  }

  private async run(label: string, action: () => Promise<AutomationResult>): Promise<AutomationResult> {
    this.status = "running";
    this.stopped = false;
    this.logger.log("info", `${label} started`);
    await this.updateAutomationBrowserLock(true);
    this.notifyState();

    try {
      const result = await action();
      if (this.status === "running") {
        this.status = "completed";
      }
      this.logger.log("info", `${label} finished`, result);
      this.notifyState();
      return result;
    } catch (error) {
      this.status = this.stopped ? "stopped" : "error";
      const message = error instanceof Error ? error.message : String(error);
      this.logger.log("error", `${label} failed: ${message}`);
      this.notifyState();
      return { ok: false, message };
    } finally {
      await this.updateAutomationBrowserLock(this.browser.getActiveDownloadCount() > 0);
    }
  }

  private async updateAutomationBrowserLock(locked: boolean) {
    const url = this.browser.getCurrentUrl()?.toLowerCase() || "";
    const isGoogleManualAuthPage =
      url.includes("accounts.google.com") ||
      url.includes("signin") ||
      url.includes("challenge") ||
      url.includes("password");

    await this.browser.setBrowserInteractionLocked(locked && !isGoogleManualAuthPage);
  }

  private async waitOrThrow() {
    while (this.status === "paused") {
      await sleep(500);
    }
    if (this.stopped) {
      throw new Error("Automation stopped.");
    }
    await sleep(1000);
  }

  private async sleepWithPause(ms: number) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      await this.waitOrThrow();
      await sleep(Math.min(1000, ms - (Date.now() - started)));
    }
  }

  private async waitForReady() {
    await this.waitOrThrow();
    await this.browser.executeScript(`
      new Promise((resolve) => {
        if (document.readyState === 'complete') resolve(true);
        else window.addEventListener('load', () => resolve(true), { once: true });
      });
    `);
    await this.updateAutomationBrowserLock(this.status === "running");
  }

  private async clickByText(labels: string[]) {
    await this.waitOrThrow();
    const clicked = await this.browser.executeScript<boolean>(`
      (() => {
        const labels = ${JSON.stringify(labels.map((label) => label.toLowerCase()))};
        const elements = Array.from(document.querySelectorAll('button, [role="button"], a, div[tabindex], span[tabindex]'));
        for (const el of elements) {
          const text = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
          if (labels.some(label => text.includes(label))) {
            (el instanceof HTMLElement ? el : el.parentElement)?.click();
            return true;
          }
        }
        return false;
      })();
    `);

    if (!clicked) {
      this.status = "needs-manual-action";
      this.notifyState();
      throw new Error(`Could not find control: ${labels.join(" / ")}. Use the visible browser to continue, then resume.`);
    }
  }

  private async selectGooglePhotos() {
    await this.waitOrThrow();
    const selected = await this.browser.executeScript<boolean>(`
      (() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
          const value = walker.currentNode.textContent?.trim().toLowerCase();
          if (value === 'google photos') textNodes.push(walker.currentNode);
        }

        for (const node of textNodes) {
          let current = node.parentElement;
          for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
            const text = (current.textContent || '').toLowerCase();
            if (!text.includes('google photos')) continue;
            if (text.length > 1400) continue;
            const checkbox = current.querySelector('[role="checkbox"], input[type="checkbox"]');
            if (checkbox instanceof HTMLElement) {
              const checked = checkbox.getAttribute('aria-checked') === 'true' || (checkbox instanceof HTMLInputElement && checkbox.checked);
              if (!checked) checkbox.click();
              return true;
            }
          }
        }

        return false;
      })();
    `);

    if (!selected) {
      this.status = "needs-manual-action";
      this.notifyState();
      throw new Error("Could not select Google Photos. Select it manually in the visible browser, then resume.");
    }
  }

  private async chooseExportOptions(archiveSize: string) {
    await this.waitOrThrow();
    const result = await this.browser.executeScript<{ exportOnceClicked: boolean; zipClicked: boolean; sizeClicked: boolean; chosenSize: string }>(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const targetSize = ${JSON.stringify(archiveSize.toLowerCase().replace(/\s+/g, ""))};
        const textFor = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const radios = Array.from(document.querySelectorAll('[role="radio"], input[type="radio"]'));
        const once = radios.find((el) => ((el.closest('label, div')?.textContent || '') + (el.getAttribute('aria-label') || '')).toLowerCase().includes('export once'));
        let exportOnceClicked = false;
        if (once instanceof HTMLElement && once.getAttribute('aria-checked') !== 'true') {
          once.click();
          exportOnceClicked = true;
          await sleep(250);
        }

        let zipClicked = false;
        const zip = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], li, div[tabindex]')).find((el) => {
          const text = textFor(el);
          return visible(el) && (text === '.zip' || text.includes('file type: .zip') || text.includes('zip files can be opened'));
        });
        if (zip instanceof HTMLElement && !textFor(document.body).includes('file type: .zip')) {
          zip.click();
          zipClicked = true;
          await sleep(250);
        }

        const normalizeSize = (text) => text.replace(/\\s+/g, '');
        const sizeSummary = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], [aria-haspopup]')).find((el) => {
          const text = textFor(el);
          return visible(el) && (text.includes('file size') || ['2gb', '4gb', '10gb', '50gb'].some((size) => normalizeSize(text).includes(size)));
        });
        if (sizeSummary instanceof HTMLElement) {
          sizeSummary.scrollIntoView({ block: 'center', inline: 'center' });
          sizeSummary.click();
          await sleep(500);
        }

        const sizeOption = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], li, div[tabindex], span')).find((el) => {
          const text = normalizeSize(textFor(el));
          return visible(el) && text.includes(targetSize);
        });
        let sizeClicked = false;
        if (sizeOption instanceof HTMLElement) {
          sizeOption.scrollIntoView({ block: 'center', inline: 'center' });
          sizeOption.click();
          sizeClicked = true;
          await sleep(500);
        }

        return { exportOnceClicked, zipClicked, sizeClicked, chosenSize: targetSize };
      })();
    `);
    this.logger.log("info", "Takeout export options checked", { archiveSize, result });
  }

  private async waitForAnyText(labels: string[], timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await this.waitOrThrow();
      const found = await this.browser.executeScript<boolean>(`
        (() => {
          const body = document.body?.innerText?.toLowerCase() || '';
          return ${JSON.stringify(labels.map((label) => label.toLowerCase()))}.some(label => body.includes(label));
        })();
      `);
      if (found) {
        return;
      }
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for confirmation text: ${labels.join(" / ")}`);
  }
}
