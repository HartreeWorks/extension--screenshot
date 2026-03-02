const CAPTURE_PREFIX = "capture_";

const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const copyBtn = document.getElementById("copy-btn");

let currentDataUrl = null;

init().catch((error) => {
  setStatus(`Error: ${error?.message || String(error)}`);
  copyBtn.disabled = true;
});

copyBtn.addEventListener("click", async () => {
  if (!currentDataUrl) {
    setStatus("No screenshot loaded.");
    return;
  }

  copyBtn.disabled = true;
  const previousText = copyBtn.textContent;
  copyBtn.textContent = "Copying...";

  try {
    const blob = await dataUrlToBlob(currentDataUrl);
    await writeImageBlobToClipboard(blob);
    setStatus("Image copied to clipboard.");
  } catch (error) {
    setStatus(`Copy failed: ${error?.message || String(error)}`);
  } finally {
    copyBtn.disabled = false;
    copyBtn.textContent = previousText;
  }
});

async function init() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    setStatus(`Capture failed: ${error}`);
    copyBtn.disabled = true;
    return;
  }

  const captureId = params.get("id");
  if (!captureId) {
    setStatus("No screenshot id was provided.");
    copyBtn.disabled = true;
    return;
  }

  const storage = getStorageArea();
  const key = `${CAPTURE_PREFIX}${captureId}`;
  const data = await storage.get(key);
  const item = data[key];

  if (!item?.dataUrl) {
    setStatus("Screenshot data was not found.");
    copyBtn.disabled = true;
    return;
  }

  currentDataUrl = item.dataUrl;
  previewEl.src = currentDataUrl;
  previewEl.style.display = "block";
  previewEl.onload = () => {
    setStatus(`Ready: ${item.filename || "screenshot.png"}`);
  };
}

function getStorageArea() {
  return chrome.storage.local;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function writeImageBlobToClipboard(blob) {
  const blobType = blob.type || "image/png";

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        [blobType]: blob
      })
    ]);
    return;
  } catch (error) {
    if (blobType === "image/png") {
      throw error;
    }
  }

  const pngBlob = await convertBlobToPng(blob);
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": pngBlob
    })
  ]);
}

async function convertBlobToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create conversion context.");
    }
    ctx.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}
