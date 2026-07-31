# Project Scope And Stack

Last verified: 2026-07-31

## Confirmed Product Scope

PhotoDrain is a private, local-only Electron desktop app for Google Photos backup and cleanup automation. The app helps the user:

- Create and switch local Google profiles with isolated Electron session partitions.
- Sign in to Google manually in a visible embedded browser.
- Select a local backup root folder and use a dated backup folder for each run.
- Create, reuse, wait for, and download Google Photos Takeout exports.
- Validate downloaded Takeout ZIP files before cleanup is enabled.
- Select backed-up media in Google Photos, move selected items to trash, and empty trash only after explicit local confirmation.

PhotoDrain does not provide a backend service, hosted account, API server, cloud upload path, credential vault, or unattended Google authentication. Google passwords, two-factor authentication, CAPTCHA, and security prompts remain user-controlled in the visible browser.

## Confirmed Stack

- Electron `^33.2.0` for the desktop shell, main process, visible Google browser, downloads, filesystem access, and IPC.
- React `^18.3.1` for the renderer UI.
- Vite `^6.0.3` for renderer build and development server.
- TypeScript `^5.7.2` across renderer, Electron main, and preload code.
- Tailwind CSS `^3.4.16` for renderer styling.
- `electron-store` `^10.1.0` for local settings and profile state.
- `lucide-react` `^0.468.0` for renderer icons.
- `electron-builder` `^25.1.8` for packaged desktop builds.

## Source Evidence

- `electron/main.ts` owns app lifecycle, IPC registration, active profile state, backup folder resolution, Google profile refresh, and coordination between the browser controller and automation runner.
- `electron/browserController.ts` owns the embedded Google browser, persistent per-profile Google session partition, download tracking, ZIP validation, browser layout, and interaction locks.
- `electron/automation.ts` owns Google Takeout and Google Photos page automation for export discovery, export creation, downloads, selection, trash movement, and final deletion.
- `electron/store.ts` owns local profile and settings persistence through `electron-store`.
- `electron/preload.cts` exposes the constrained `window.photoDrain` bridge from renderer to main process.
- `src/renderer/App.tsx` owns the main user workflow surface.
- `package.json` defines the validated project scripts: `typecheck`, `lint`, `build`, `test`, and `check`.

## Verification Checklist

Run these from the PhotoDrain target repository before considering scope or stack changes ready for review:

```bash
npm test
npm run check
```

Manual verification remains required for Google account flows because Google Takeout and Google Photos UI automation depends on live third-party pages:

- Add or switch a Google profile and complete sign-in manually.
- Select a backup root folder and confirm the dated folder is shown.
- Check an existing Takeout export state or request a Google Photos export.
- Download and validate at least one Takeout ZIP.
- Confirm cleanup remains blocked until ZIP validation succeeds.
- Confirm emptying trash requires typed `DELETE` plus the explicit checkbox.

## Open Questions

- Should `BrowserView` remain the embedded browser primitive for now, or should a future Electron upgrade evaluate `WebContentsView` migration?
- Which automation heuristics should be extracted first into testable pure functions with fixtures?
- What is the minimum accepted manual smoke-test evidence for a release when Google UI behavior changes?
