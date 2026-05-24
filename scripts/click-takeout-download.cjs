const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const GOOGLE_PARTITION = "persist:photodrain-google";
app.setName("photodrain");
app.setPath("userData", path.join(app.getPath("appData"), "photodrain"));
const settingsPath = path.join(app.getPath("userData"), "settings.json");

function readBackupFolder() {
  const raw = fs.readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(raw);
  if (!settings.backupFolder) {
    throw new Error("No backup folder is configured in PhotoDrain settings.");
  }
  fs.mkdirSync(settings.backupFolder, { recursive: true });
  return settings.backupFolder;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const backupFolder = readBackupFolder();
  const googleSession = session.fromPartition(GOOGLE_PARTITION);
  const activeDownloads = new Set();
  const completedDownloads = [];

  googleSession.on("will-download", (_event, item) => {
    const filename = item.getFilename();
    const targetPath = path.join(backupFolder, filename);
    activeDownloads.add(targetPath);
    item.setSavePath(targetPath);
    console.log(`Download started: ${filename}`);

    item.once("done", (_doneEvent, state) => {
      activeDownloads.delete(targetPath);
      if (state === "completed") {
        completedDownloads.push(targetPath);
        console.log(`Download completed: ${targetPath}`);
      } else {
        console.log(`Download ended with state ${state}: ${filename}`);
      }
    });
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: "PhotoDrain Takeout Download Helper",
    webPreferences: {
      session: googleSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await win.loadURL("https://takeout.google.com/");
  await wait(3000);

  console.log("Loaded Takeout");
  await win.webContents.executeJavaScript(`
    (() => {
      const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const target = candidates.find((el) => {
        const text = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        return text.includes('manage exports');
      });
      if (target instanceof HTMLElement) target.click();
      return Boolean(target);
    })();
  `);
  console.log("Clicked Manage exports if present");
  await wait(2500);

  const debugFolder = path.join(process.cwd(), "debug");
  fs.mkdirSync(debugFolder, { recursive: true });
  console.log("Capturing screenshot");
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(debugFolder, "takeout-before-click.png"), image.toPNG());

  console.log("Collecting visible controls");
  const controlsDebugJson = await win.webContents.executeJavaScript(`
    (() => JSON.stringify(Array.from(document.querySelectorAll('a, button, [role="button"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      const text = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).trim();
      const style = window.getComputedStyle(el);
      return {
        text: text.slice(0, 260),
        tag: el.tagName,
        role: el.getAttribute('role'),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    }).filter((item) => item.visible)))();
  `);
  const controlsDebug = JSON.parse(controlsDebugJson);
  fs.writeFileSync(path.join(debugFolder, "takeout-controls.json"), JSON.stringify(controlsDebug, null, 2));

  console.log("Finding ready archive row");
  const openedArchiveJson = await win.webContents.executeJavaScript(`
    (() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textFor = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).trim().toLowerCase();
      const blocked = (text) =>
        text.includes('download your data') ||
        text.includes('learn') ||
        text.includes('access log') ||
        text.includes('access-log') ||
        text.includes('access_log');

      const archiveRows = Array.from(document.querySelectorAll('a[href*="/manage/archive/"], a[href*="./manage/archive/"]'));
      const readyArchiveRow = archiveRows.map((el) => {
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
        return { href: el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href'), text: text.slice(0, 220), score };
      }).filter(Boolean).sort((a, b) => b.score - a.score)[0];

      return JSON.stringify({
        openedArchive: readyArchiveRow ? readyArchiveRow.text : null,
        href: readyArchiveRow?.href || null,
        title: document.title,
        body: (document.body?.innerText || '').slice(0, 1800)
      });
    })();
  `);
  const openedArchive = JSON.parse(openedArchiveJson);
  fs.writeFileSync(path.join(debugFolder, "takeout-opened-archive.json"), JSON.stringify(openedArchive, null, 2));
  if (openedArchive.href) {
    console.log(`Opening archive detail: ${openedArchive.href}`);
    await win.loadURL(openedArchive.href);
    await wait(2500);
  }
  const detailImage = await win.webContents.capturePage();
  fs.writeFileSync(path.join(debugFolder, "takeout-after-open-archive.png"), detailImage.toPNG());

  console.log("Clicking download candidates");
  const resultJson = await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textFor = (el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('href') || '')).trim().toLowerCase();
      const blocked = (text) =>
        text.includes('download your data') ||
        text.includes('learn') ||
        text.includes('access log') ||
        text.includes('access-log') ||
        text.includes('access_log');

      const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const targets = controls.map((el) => {
        const text = textFor(el);
        const containerText = (el.closest('section, article, li, div')?.textContent || '').toLowerCase();
        const ownLabel = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        let score = 0;
        if (!visible(el)) return null;
        if (!(text.includes('download') || text.includes('/takeout/download'))) return null;
        if (blocked(text)) return null;
        if (['canceled', 'cancelled', 'expired', 'failed'].some((term) => containerText.includes(term))) return null;
        if (ownLabel === 'download') score += 100;
        if (ownLabel.includes('download')) score += 50;
        if (text.includes('/takeout/download')) score += 40;
        if (containerText.includes('ready to download') || containerText.includes('completed')) score += 20;
        return { el, text: text.slice(0, 220), score };
      }).filter(Boolean).sort((a, b) => b.score - a.score);

      let clicked = 0;
      for (const target of targets) {
        target.el.scrollIntoView({ block: 'center', inline: 'center' });
        await sleep(400);
        target.el.click();
        clicked += 1;
        await sleep(1800);
      }

      return JSON.stringify({ clicked, candidates: targets.map((target) => target.text) });
    })();
  `);
  const result = JSON.parse(resultJson);

  console.log(JSON.stringify(result, null, 2));
  const afterClickImage = await win.webContents.capturePage();
  fs.writeFileSync(path.join(debugFolder, "takeout-after-click.png"), afterClickImage.toPNG());

  if (result.clicked === 0) {
    console.log("No valid download controls clicked. Debug files written to debug/takeout-before-click.png and debug/takeout-controls.json");
    await wait(3000);
    app.quit();
    return;
  }

  const startedWaiting = Date.now();
  while (Date.now() - startedWaiting < 1000 * 60 * 2) {
    if (completedDownloads.length > 0 && activeDownloads.size === 0) {
      await wait(1500);
      break;
    }
    await wait(1000);
  }

  const zips = fs
    .readdirSync(backupFolder)
    .filter((filename) => filename.toLowerCase().endsWith(".zip"))
    .map((filename) => {
      const filePath = path.join(backupFolder, filename);
      return { filename, sizeBytes: fs.statSync(filePath).size };
    });

  console.log(`Validated ZIP files in ${backupFolder}:`);
  console.log(JSON.stringify(zips, null, 2));
  await wait(3000);
  app.quit();
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error(error);
    app.quit();
  });
});
