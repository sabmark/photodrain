# PhotoDrain Context

## Purpose

PhotoDrain is a private Electron desktop app for local Google Photos backup and cleanup automation. It helps a user create or reuse Google Photos Takeout exports, download ZIP archives into a dated local backup folder, validate those local files, and then perform a guarded Google Photos cleanup workflow.

## Domain Language

- **Google profile**: A local PhotoDrain profile with its own persistent Electron browser partition and cached Google display details.
- **Backup root folder**: The user-selected local directory where dated backup folders are created.
- **Dated backup folder**: The per-day folder inside the backup root, named with `YYYY-MM-DD`.
- **Takeout export**: A Google Takeout archive request containing Google Photos data.
- **Validated ZIP**: A local non-empty `.zip` file in the backup folder that enables cleanup actions.
- **Visible browser**: The embedded Google browser session shown to the user for manual sign-in and review.
- **Final delete confirmation**: The local typed `DELETE` confirmation and checkbox required before emptying Google Photos trash.

## Ownership Boundaries

- PhotoDrain owns only local app state, local logs, local screenshots, downloaded ZIP validation, and visible browser automation.
- Google owns authentication, account security, Takeout pages, Photos pages, and any UI prompts.
- The user owns account access, Google confirmations, backup folder selection, and the final destructive cleanup decision.
- There is no backend service and no cloud upload path in this app.

## Engineering Notes

- Keep orchestration policy close to Electron IPC and automation state transitions.
- Extract repeated page-scoring or parsing mechanics only when there are fixtures or repeated call sites to justify it.
- Prefer testable pure functions for backup paths, ZIP validation, profile transitions, and Google control-selection heuristics.
- Treat Google page selectors and text matching as unstable; preserve manual recovery paths and debug artifacts.
