# One-click full-page screenshot extension

## What it does

- Click the extension icon once.
- Captures the whole page as PNG.
- On Retina/high-DPI captures, downscales output by 50%.
- Saves immediately to Downloads (no save dialog).
- Opens a preview tab with a `Copy image` button.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/Users/ph/Documents/www/_try/2026-03-02-screenshot-chrome-extension`.

## Notes

- Some page types (for example `chrome://` pages) are not capturable by Chrome extensions.
- Very large pages may exceed browser canvas limits.
