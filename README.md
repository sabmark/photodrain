# PhotoDrain

PhotoDrain is a private Electron desktop app for local Google Photos backup and cleanup automation.

It runs a visible, user-controlled Google browser session inside Electron. The user signs in manually, including any 2FA or security prompts. PhotoDrain stores only local Electron browser session data and cached profile display details. It never asks for or stores a Google password.

## What It Does

- Creates separate local Google profiles with isolated persistent Electron sessions.
- Caches the logged-in Google profile name, email, and avatar for switching accounts.
- Requests Google Takeout exports for Google Photos.
- Reuses existing in-progress or ready Google Photos Takeout exports when possible.
- Downloads Takeout ZIP files into a dated local backup folder.
- Validates local ZIP files before cleanup actions are enabled.
- Opens Google Photos, selects backed-up media, and moves it to trash.
- Requires final local confirmation before emptying trash.
- Stores logs and screenshots locally for review.

## Workflow

1. Add a Google profile and sign in manually in the visible browser.
2. Select a backup root folder.
3. PhotoDrain creates a dated folder inside the root, for example `2026-05-25`.
4. PhotoDrain checks Google Takeout Manage exports.
5. If a Google Photos export is in progress, it waits.
6. If a Google Photos export is ready, it downloads ZIP files.
7. If no usable Google Photos export exists, it creates one.
8. After ZIP validation, PhotoDrain can open Google Photos and move selected media to trash.
9. Emptying trash requires typed confirmation and an explicit checkbox.

## Local-Only Architecture

- Electron
- React
- TypeScript
- Vite
- Tailwind CSS
- Node.js filesystem APIs
- `electron-store`
- Electron `BrowserView` automation

There is no backend, no hosted service, and no cloud upload.

## Safety Notes

PhotoDrain is an unofficial automation tool. Google Takeout and Google Photos do not provide a stable UI automation contract, so their pages may change.

PhotoDrain does not bypass:

- CAPTCHA
- 2FA
- password prompts
- account security prompts
- Google confirmations

When Google requires user action, the app uses the visible browser session so the user can complete it manually.

## Local Data

Electron stores app data in the platform user-data folder. PhotoDrain creates local data such as:

- `settings.json`
- `automation-log.json`
- `screenshots/*.png`
- profile-specific persistent Google browser partitions

Use the in-app clear session action to remove the active profile's saved Google session.

## Development

Install dependencies:

```bash
npm install
```

Run the Electron app in development:

```bash
npm run dev
```

Run checks:

```bash
npm run typecheck
npm run lint
npm run build
```

See `docs/verification.md` for the full automated and manual smoke-test checklist.

Package:

```bash
npm run dist
```

## Docker

Electron GUI apps need a desktop display server, so Docker is not the primary Windows development path. The included Dockerfile is intended for dependency install and build checks.

```bash
docker build -t photodrain-build .
```
