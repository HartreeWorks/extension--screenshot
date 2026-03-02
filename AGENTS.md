# Repository Guidelines

## Project structure & module organisation
- `manifest.json`: Chrome Extension Manifest V3 entry point and permissions.
- `background.js`: service worker for capture orchestration, storage, downloads, and viewer tab creation.
- `content.js`: in-page script for scrolling, page metrics, and capture-state overlay.
- `viewer.html`, `viewer.js`, `viewer.css`: screenshot review/annotation UI.
- `vendor/`: third-party browser libraries (currently `konva.min.js`).
- `icons/`, `icon.png`, `fonts/`: packaged UI assets.
- `README.md`: user-facing setup and behaviour notes.

## Build, test, and development commands
- `open chrome://extensions` then **Load unpacked** with this repo path to run locally.
- `node --check background.js` validates service-worker syntax.
- `node --check content.js` validates content-script syntax.
- `node --check viewer.js` validates viewer logic syntax.
- `git diff` and `git status --short` are the primary pre-commit checks.

There is no build step or automated test suite at present; development is direct-edit and reload.

## Coding style & naming conventions
- Use plain JavaScript (ES modules where already used) with 2-space indentation and semicolons.
- Prefer `const`/`let`; avoid implicit globals.
- Function names: `camelCase` with verb-first intent (for example, `runCaptureForTab`).
- Constants: `UPPER_SNAKE_CASE`.
- Keep files ASCII unless existing content requires otherwise.
- Keep UI copy short and action-oriented.

## Testing guidelines
- Manual verification is required for functional changes:
  1. Capture standard and high-quality screenshots.
  2. Verify Downloads save works.
  3. Verify viewer annotation actions (arrow, text, undo/redo, copy/download).
  4. Verify failure paths (unsupported pages, cancelled capture).
- If changing capture flow, test at least one long page and one high-DPI page.

## Commit & pull request guidelines
- Commit messages should be short, imperative, and specific (for example, `Add one-click high-quality retake from viewer`).
- Keep commits focused by concern (capture pipeline vs viewer UI vs styling).
- PRs should include:
  - concise summary of behaviour changes,
  - manual test steps performed,
  - screenshots/GIFs for viewer UI changes,
  - notes on permission or manifest changes (if any).

## Security & configuration tips
- Request the minimum needed permissions in `manifest.json`.
- Avoid capturing restricted schemes (`chrome://`, `chrome-extension://`, etc.).
- Do not introduce remote script dependencies; keep vendor assets local and versioned.
