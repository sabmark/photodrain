# PhotoDrain Agent Instructions

## Project Context

- Read `CONTEXT.md` before implementation or review.
- Keep PhotoDrain local-only: no backend, hosted service, cloud upload, or stored Google credentials.
- Treat Google UI automation as brittle. Preserve visible user control for sign-in, 2FA, CAPTCHA, account security prompts, and destructive confirmations.
- Record durable architecture decisions in `docs/adr/`.

## Repository Structure

- `electron/main.ts`: Electron lifecycle, IPC handlers, profile orchestration, and renderer state fanout.
- `electron/browserController.ts`: embedded Google browser, persistent session partitions, download handling, screenshots, storage inspection, and browser locks.
- `electron/automation.ts`: Google Takeout and Google Photos automation.
- `electron/store.ts`: local `electron-store` profile and settings persistence.
- `electron/preload.cts`: constrained renderer IPC bridge.
- `src/renderer/`: React UI, components, and styles.
- `scripts/`: local debug or automation helpers.

## Verification

Run from the repository root:

```bash
npm run typecheck
npm run lint
npm run build
```

Use `npm test` for the fast local validation set and `npm run check` for the full build-backed validation set.
Use `docs/verification.md` for manual smoke checks and release-gate evidence.

## Safety

- Do not automate around Google authentication or security prompts.
- Do not enable cleanup until local ZIP validation has passed.
- Keep final trash emptying gated by typed `DELETE` plus an explicit checkbox.
- Do not commit screenshots, ZIP files, logs, Electron user data, or backup contents.
