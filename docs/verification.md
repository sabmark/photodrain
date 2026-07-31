# Verification

Last updated: 2026-07-31

PhotoDrain verification has two layers:

- Automated local checks for TypeScript, linting, and build integrity.
- Manual smoke checks for live Google Takeout and Google Photos flows that depend on third-party pages.

## Automated Checks

Run all commands from the repository root.

Fast validation:

```bash
npm test
```

This runs:

- `npm run typecheck`
- `npm run lint`

Full validation:

```bash
npm run check
```

This runs:

- `npm run typecheck`
- `npm run lint`
- `npm run build`

Build-only validation:

```bash
npm run build
```

This validates the renderer build plus Electron main and preload TypeScript builds.

## Manual Smoke Checklist

Manual checks are required for changes that touch profile flow, backup folders, downloads, Google Takeout automation, Google Photos cleanup, browser layout, or destructive confirmation behavior.

### Profile And Sign-In

- Create a new Google profile.
- Confirm the visible Google browser opens for manual sign-in.
- Complete any password, 2FA, CAPTCHA, or account security prompts manually.
- Confirm PhotoDrain caches visible Google profile details when Google exposes them.
- Switch between profiles and confirm each profile keeps an isolated session.
- Clear a Google session and confirm the active profile is no longer treated as signed in.

### Backup Folder And ZIP Validation

- Select a backup root folder.
- Confirm PhotoDrain creates and displays a dated backup folder using `YYYY-MM-DD`.
- Place or download at least one non-empty `.zip` file in the active backup folder.
- Run download validation and confirm the UI reports the validated ZIP files.
- Confirm cleanup actions remain blocked when no valid ZIP exists.

### Takeout Export Flow

- Open the Takeout flow while signed in.
- Confirm an existing in-progress Google Photos export is detected and waited on rather than duplicated.
- Confirm an existing ready Google Photos export is downloaded from Manage exports.
- Confirm a new Google Photos Takeout export can be requested when no usable export exists.
- Confirm active downloads show progress and finish into the dated backup folder.
- Confirm canceling an active download removes incomplete local files.

### Google Photos Cleanup Flow

- Open Google Photos through the app.
- Select a small visible batch.
- Move the selected batch to trash.
- Confirm the app records a screenshot or log entry useful for reviewing the action.
- Confirm emptying trash is disabled until the local typed value is exactly `DELETE` and the explicit checkbox is selected.
- Confirm final trash emptying is performed only after those local confirmations.

### Recovery And Safety

- Pause, resume, and stop automation during a non-destructive step.
- Confirm the visible browser remains available when Google requires manual action.
- Confirm the app does not request or store a Google password.
- Confirm local logs, screenshots, Takeout ZIPs, backup folders, and Electron user data are not committed.

## Evidence To Record

For each reviewed change, record:

- Automated commands run and pass/fail result.
- Manual smoke areas exercised, if any.
- Any Google prompt or page-state variance observed.
- Screenshots or log paths only when they are useful for debugging; do not commit generated screenshots or logs.
- Known skipped checks and why they were not relevant.

## Release Gate

Before packaging or pushing a release candidate:

- `npm test` passes.
- `npm run check` passes.
- Manual smoke coverage is completed for every touched Google, download, profile, or destructive-cleanup path.
- No generated `dist`, `dist-electron`, `release`, screenshot, log, ZIP, backup, or Electron user-data files are staged.
