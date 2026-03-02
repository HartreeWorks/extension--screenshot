# Screenshot extension

## What it does

- Click the extension icon once.
- Captures the whole page.
- On Retina/high-DPI captures, downscales output by 50%.
- Saves immediately to Downloads (no save dialog).
- Opens a preview tab where you can annotate with red arrows/text and copy the annotated image.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `/Users/ph/Documents/www/Browser extensions/Screenshot`.

## Annotation controls

- Drag on the screenshot: draw a red arrow.
- Click empty area: create red text and type.
- Click annotation: select and resize.
- Backspace/Delete: remove selected annotation.
- Cmd/Ctrl+Z: undo.
- Shift+Cmd/Ctrl+Z or Ctrl+Y: redo.

## Notes

- Some page types (for example `chrome://` pages) are not capturable by Chrome extensions.
- Very large pages may exceed browser canvas limits.
