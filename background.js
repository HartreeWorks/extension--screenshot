const CAPTURE_PREFIX = "capture_";
const MAX_STORED_CAPTURES = 5;

const CAPTURE_MIN_INTERVAL_MS = 550;
const CAPTURE_MAX_QUOTA_RETRIES = 4;
const DEFAULT_MODE_MAX_BYTES = 1.5 * 1024 * 1024;
const HIGH_MODE_SOFT_MAX_BYTES = 8 * 1024 * 1024;
const TALL_PAGE_HEIGHT_THRESHOLD_CSS = 12000;
const EXTRA_DOWNSCALE_FOR_TALL_PAGES = 0.85;
const HIGH_MODE_SAFETY_SCALE = 0.95;

const DEFAULT_WEBP_QUALITIES = [0.82, 0.74, 0.68];
const DEFAULT_WEBP_QUALITIES_AFTER_EXTRA_DOWNSCALE = [0.74, 0.68];

const MENU_ID_CAPTURE_HIGH_QUALITY = "capture_high_quality";
const DEFAULT_ACTION_TITLE = "Screenshot";
const MESSAGE_RETAKE_CAPTURE_HIGH = "RETAKE_CAPTURE_HIGH";

let lastCaptureCallAt = 0;
let captureInProgress = false;

chrome.runtime.onInstalled.addListener(() => {
  createActionContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  createActionContextMenu();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_RETAKE_CAPTURE_HIGH) {
    return false;
  }

  (async () => {
    try {
      const source = normalizeRetakeSource(message.payload?.source);
      if (!source) {
        throw new Error("Retake is unavailable for this screenshot.");
      }

      if (captureInProgress) {
        throw new Error(
          "A capture is already in progress. Wait for it to finish, or cancel with Escape or manual scrolling."
        );
      }

      await runHighQualityRetake(source);
      sendResponse({ ok: true });
    } catch (error) {
      const messageText = getErrorMessage(error);
      console.error("High-quality retake failed:", error);
      await openViewer({ error: messageText }).catch(() => {});
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  await runCaptureForTab(tab, { quality: "standard" });
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID_CAPTURE_HIGH_QUALITY || !tab?.id) {
      return;
    }
    await runCaptureForTab(tab, { quality: "high" });
  });
}

function createActionContextMenu() {
  if (!chrome.contextMenus?.create || !chrome.contextMenus?.removeAll) {
    return;
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID_CAPTURE_HIGH_QUALITY,
      title: "Screenshot (high quality)",
      contexts: ["action"]
    });
  });
}

async function runCaptureForTab(tab, options) {
  if (!tab?.id) {
    return;
  }

  const quality = options?.quality === "high" ? "high" : "standard";
  const source = buildCaptureSource(tab);

  if (captureInProgress) {
    await openViewer({
      error: "A capture is already in progress. Wait for it to finish, or cancel with Escape or manual scrolling."
    });
    return;
  }

  captureInProgress = true;
  await setCaptureBadge(tab.id, "...", qualityBadgeColour(quality), "Capture started...");

  try {
    assertSupportedUrl(tab.url);
    const result = await captureFullPage(tab, { quality });
    await setCapturePhase(tab.id, "saving", quality);
    await saveToDownloads(result.dataUrl, result.filename);
    await storeCapture(result.captureId, result.dataUrl, result.filename, { quality, source });
    await openViewer({ captureId: result.captureId });
  } catch (error) {
    const message = getErrorMessage(error);
    console.error("Full page screenshot failed:", error);
    if (isCancellationError(message)) {
      await sendTabMessage(tab.id, {
        type: "SHOW_ERROR_TOAST",
        payload: { message }
      }).catch(() => {});
    } else {
      await openViewer({ error: message });
    }
  } finally {
    await sendTabMessage(tab.id, { type: "END_CAPTURE_SESSION" }).catch(() => {});
    captureInProgress = false;
    await clearCaptureBadge(tab.id);
  }
}

async function runHighQualityRetake(source) {
  const targetTab = await resolveRetakeTargetTab(source);
  if (!targetTab?.id) {
    throw new Error("Could not open the source tab for retake.");
  }

  await focusTab(targetTab.id, targetTab.windowId);
  await waitForTabReady(targetTab.id);

  const freshTab = await chrome.tabs.get(targetTab.id);
  await runCaptureForTab(freshTab, { quality: "high" });
}

async function resolveRetakeTargetTab(source) {
  const sourceUrl = source.url;
  const existingTab = Number.isInteger(source.tabId) ? await chrome.tabs.get(source.tabId).catch(() => null) : null;

  if (existingTab?.id && comparableUrl(existingTab.url) === comparableUrl(sourceUrl)) {
    return existingTab;
  }

  const createOptions = {
    url: sourceUrl,
    active: true
  };

  if (Number.isInteger(source.windowId)) {
    createOptions.windowId = source.windowId;
  }

  try {
    return await chrome.tabs.create(createOptions);
  } catch (_error) {
    delete createOptions.windowId;
    return chrome.tabs.create(createOptions);
  }
}

async function focusTab(tabId, windowId) {
  if (Number.isInteger(windowId) && windowId >= 0) {
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

async function waitForTabReady(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error("Source tab is no longer available.");
    }
    if (tab.status === "complete") {
      return;
    }
    await sleep(150);
  }
}

function assertSupportedUrl(url) {
  if (!url) {
    throw new Error("This tab does not have a capturable URL.");
  }

  const blockedSchemes = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "view-source:",
    "devtools://"
  ];
  if (blockedSchemes.some((scheme) => url.startsWith(scheme))) {
    throw new Error("This page type cannot be captured.");
  }
}

async function captureFullPage(tab, options) {
  const quality = options?.quality === "high" ? "high" : "standard";
  await ensureContentScript(tab.id);

  const metrics = await sendTabMessage(tab.id, { type: "GET_PAGE_METRICS" });
  if (!metrics || !metrics.viewportWidthCss || !metrics.viewportHeightCss) {
    throw new Error("Could not read page dimensions.");
  }

  const xPositions = buildPositions(metrics.fullWidthCss, metrics.viewportWidthCss);
  const yPositions = buildPositions(metrics.fullHeightCss, metrics.viewportHeightCss);
  const totalTiles = xPositions.length * yPositions.length;
  const originalPosition = { xCss: metrics.scrollX, yCss: metrics.scrollY };
  const tileScreenshots = [];

  await sendTabMessage(tab.id, {
    type: "START_CAPTURE_SESSION",
    payload: {
      quality,
      totalTiles
    }
  });
  await updateCaptureProgress(tab.id, 0, totalTiles, quality);

  try {
    await sendTabMessage(tab.id, { type: "HIDE_FIXED" });

    let capturedTiles = 0;
    for (const yCss of yPositions) {
      for (const xCss of xPositions) {
        await throwIfCaptureCancelled(tab.id);
        await sendTabMessage(tab.id, { type: "SCROLL_TO", payload: { xCss, yCss } });
        await throwIfCaptureCancelled(tab.id);

        const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
        tileScreenshots.push({ xCss, yCss, dataUrl });

        capturedTiles += 1;
        await updateCaptureProgress(tab.id, capturedTiles, totalTiles, quality);
      }
    }
  } finally {
    await sendTabMessage(tab.id, { type: "SCROLL_TO", payload: originalPosition }).catch(() => {});
    await sendTabMessage(tab.id, { type: "RESTORE_FIXED" }).catch(() => {});
  }

  if (tileScreenshots.length === 0) {
    throw new Error("No screenshot tiles were captured.");
  }

  await setCapturePhase(tab.id, "stitching", quality);
  const stitchedData = await stitchTiles(tileScreenshots, metrics);
  const retinaBaseBlob = await maybeDownscaleForRetinaBlob(
    stitchedData.blob,
    stitchedData.scale,
    metrics.dpr
  );

  await setCapturePhase(tab.id, "compressing", quality);
  const output =
    quality === "high"
      ? await buildHighQualityOutput(retinaBaseBlob)
      : await buildStandardOutput(retinaBaseBlob, metrics);

  const outputDataUrl = await blobToDataUrl(output.blob);

  return {
    dataUrl: outputDataUrl,
    filename: makeFilename(quality, output.extension),
    captureId: crypto.randomUUID()
  };
}

async function throwIfCaptureCancelled(tabId) {
  const status = await sendTabMessage(tabId, { type: "CHECK_CAPTURE_STATUS" }).catch(() => null);
  if (status?.cancelled) {
    throw new Error(status.reason || "Capture cancelled.");
  }
}

async function updateCaptureProgress(tabId, capturedTiles, totalTiles, quality) {
  const percent = totalTiles > 0 ? Math.round((capturedTiles / totalTiles) * 100) : 0;
  const badgeText = capturedTiles === 0 ? "..." : `${Math.min(percent, 100)}%`;
  const title = `Capturing ${capturedTiles}/${totalTiles} (${Math.min(percent, 100)}%)`;

  await Promise.all([
    setCaptureBadge(tabId, badgeText, qualityBadgeColour(quality), title),
    sendTabMessage(tabId, {
      type: "UPDATE_CAPTURE_PROGRESS",
      payload: { capturedTiles, totalTiles, quality }
    }).catch(() => {})
  ]);
}

async function setCapturePhase(tabId, phase, quality) {
  const phaseText =
    phase === "stitching"
      ? "Stitching screenshot..."
      : phase === "compressing"
        ? "Compressing screenshot..."
        : phase === "saving"
          ? "Saving screenshot..."
          : "Working...";

  await Promise.all([
    setCaptureBadge(tabId, "...", qualityBadgeColour(quality), phaseText),
    sendTabMessage(tabId, {
      type: "SET_CAPTURE_PHASE",
      payload: { phase, quality }
    }).catch(() => {})
  ]);
}

function qualityBadgeColour(quality) {
  return quality === "high" ? "#7a2fdb" : "#1a73e8";
}

async function setCaptureBadge(tabId, text, colour, title) {
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: colour }),
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setTitle({ tabId, title: `${title} - press Escape or scroll to cancel` })
  ]).catch(() => {});
}

async function clearCaptureBadge(tabId) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: "" }),
    chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE })
  ]).catch(() => {});
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function sendTabMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function captureVisibleTabWithRetry(windowId) {
  let attempt = 0;
  while (true) {
    await waitForCaptureQuotaWindow();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      if (!isCaptureQuotaError(error) || attempt >= CAPTURE_MAX_QUOTA_RETRIES) {
        throw error;
      }
      attempt += 1;
      await sleep(CAPTURE_MIN_INTERVAL_MS * (attempt + 1));
    }
  }
}

async function waitForCaptureQuotaWindow() {
  const now = Date.now();
  const elapsed = now - lastCaptureCallAt;
  if (elapsed < CAPTURE_MIN_INTERVAL_MS) {
    await sleep(CAPTURE_MIN_INTERVAL_MS - elapsed);
  }
  lastCaptureCallAt = Date.now();
}

function isCaptureQuotaError(error) {
  const message = getErrorMessage(error);
  return message.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND");
}

function isCancellationError(message) {
  return typeof message === "string" && message.toLowerCase().includes("cancelled");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPositions(fullSize, viewportSize) {
  const positions = [];
  if (fullSize <= viewportSize) {
    return [0];
  }

  const maxStart = fullSize - viewportSize;
  for (let pos = 0; pos < maxStart; pos += viewportSize) {
    positions.push(pos);
  }
  if (positions[positions.length - 1] !== maxStart) {
    positions.push(maxStart);
  }
  return positions;
}

async function stitchTiles(tileScreenshots, metrics) {
  const firstBlob = await dataUrlToBlob(tileScreenshots[0].dataUrl);
  const firstBitmap = await createImageBitmap(firstBlob);
  const scale = firstBitmap.width / metrics.viewportWidthCss;
  firstBitmap.close();

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("Invalid capture scale.");
  }

  const outputWidth = Math.max(1, Math.round(metrics.fullWidthCss * scale));
  const outputHeight = Math.max(1, Math.round(metrics.fullHeightCss * scale));
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create rendering context.");
  }

  for (const tile of tileScreenshots) {
    const blob = await dataUrlToBlob(tile.dataUrl);
    const bitmap = await createImageBitmap(blob);

    const drawX = Math.round(tile.xCss * scale);
    const drawY = Math.round(tile.yCss * scale);
    const drawWidth = Math.min(bitmap.width, outputWidth - drawX);
    const drawHeight = Math.min(bitmap.height, outputHeight - drawY);

    if (drawWidth > 0 && drawHeight > 0) {
      ctx.drawImage(bitmap, 0, 0, drawWidth, drawHeight, drawX, drawY, drawWidth, drawHeight);
    }
    bitmap.close();
  }

  const stitchedBlob = await canvas.convertToBlob({ type: "image/png" });
  return {
    blob: stitchedBlob,
    scale
  };
}

async function maybeDownscaleForRetinaBlob(inputBlob, capturedScale, dpr) {
  const isRetina = capturedScale >= 2 || dpr >= 2;
  if (!isRetina) {
    return inputBlob;
  }

  return transformBlob(inputBlob, { scale: 0.5, type: "image/png" });
}

async function buildStandardOutput(baseBlob, metrics) {
  let bestBlob = await encodeWebpToTarget(baseBlob, DEFAULT_WEBP_QUALITIES, DEFAULT_MODE_MAX_BYTES);

  if (
    bestBlob.size > DEFAULT_MODE_MAX_BYTES &&
    Number(metrics?.fullHeightCss || 0) > TALL_PAGE_HEIGHT_THRESHOLD_CSS
  ) {
    const extraScaled = await transformBlob(baseBlob, {
      scale: EXTRA_DOWNSCALE_FOR_TALL_PAGES,
      type: "image/png"
    });
    bestBlob = await encodeWebpToTarget(
      extraScaled,
      DEFAULT_WEBP_QUALITIES_AFTER_EXTRA_DOWNSCALE,
      DEFAULT_MODE_MAX_BYTES
    );
  }

  return {
    blob: bestBlob,
    extension: "webp"
  };
}

async function buildHighQualityOutput(baseBlob) {
  const pngBlob =
    baseBlob.type === "image/png" ? baseBlob : await transformBlob(baseBlob, { type: "image/png" });

  if (pngBlob.size <= HIGH_MODE_SOFT_MAX_BYTES) {
    return {
      blob: pngBlob,
      extension: "png"
    };
  }

  const reducedPngBlob = await transformBlob(pngBlob, {
    scale: HIGH_MODE_SAFETY_SCALE,
    type: "image/png"
  });
  return {
    blob: reducedPngBlob,
    extension: "png"
  };
}

async function encodeWebpToTarget(baseBlob, qualities, maxBytes) {
  let bestBlob = null;
  for (const quality of qualities) {
    const candidate = await transformBlob(baseBlob, {
      type: "image/webp",
      quality
    });
    bestBlob = candidate;
    if (candidate.size <= maxBytes) {
      break;
    }
  }

  if (!bestBlob) {
    throw new Error("Could not encode WebP output.");
  }
  return bestBlob;
}

async function transformBlob(inputBlob, options = {}) {
  const bitmap = await createImageBitmap(inputBlob);
  try {
    const scale = Number.isFinite(options.scale) ? options.scale : 1;
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    const outputType = options.type || "image/png";

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create transform context.");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const convertOptions = { type: outputType };
    if (typeof options.quality === "number") {
      convertOptions.quality = options.quality;
    }

    return canvas.convertToBlob(convertOptions);
  } finally {
    bitmap.close();
  }
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function blobToDataUrl(blob) {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("FileReader failed."));
      reader.readAsDataURL(blob);
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function saveToDownloads(dataUrl, filename) {
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

async function storeCapture(captureId, dataUrl, filename, meta = {}) {
  const storage = getStorageArea();
  const key = `${CAPTURE_PREFIX}${captureId}`;
  await storage.set({
    [key]: {
      dataUrl,
      filename,
      quality: meta.quality === "high" ? "high" : "standard",
      source: normalizeRetakeSource(meta.source),
      createdAt: Date.now()
    }
  });
  await trimStoredCaptures(storage);
}

async function trimStoredCaptures(storage) {
  const allItems = await storage.get(null);
  const captures = Object.entries(allItems)
    .filter(([key]) => key.startsWith(CAPTURE_PREFIX))
    .map(([key, value]) => ({
      key,
      createdAt: Number(value?.createdAt || 0)
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

  if (captures.length <= MAX_STORED_CAPTURES) {
    return;
  }

  const keysToRemove = captures.slice(MAX_STORED_CAPTURES).map((entry) => entry.key);
  await storage.remove(keysToRemove);
}

function getStorageArea() {
  return chrome.storage.local;
}

async function openViewer({ captureId, error }) {
  const url = new URL(chrome.runtime.getURL("viewer.html"));
  if (captureId) {
    url.searchParams.set("id", captureId);
  }
  if (error) {
    url.searchParams.set("error", error);
  }
  await chrome.tabs.create({ url: url.toString() });
}

function makeFilename(quality, extension) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const suffix = quality === "high" ? "-high" : "";
  const ext = extension || "png";
  return `screenshot-${y}-${m}-${d}-${hh}-${mm}-${ss}${suffix}.${ext}`;
}

function buildCaptureSource(tab) {
  return normalizeRetakeSource({
    url: typeof tab?.url === "string" ? tab.url : "",
    tabId: Number.isInteger(tab?.id) ? tab.id : null,
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null
  });
}

function normalizeRetakeSource(source) {
  const url = typeof source?.url === "string" ? source.url.trim() : "";
  if (!url) {
    return null;
  }

  return {
    url,
    tabId: Number.isInteger(source?.tabId) ? source.tabId : null,
    windowId: Number.isInteger(source?.windowId) ? source.windowId : null
  };
}

function comparableUrl(url) {
  const input = typeof url === "string" ? url.trim() : "";
  if (!input) {
    return "";
  }

  try {
    const parsed = new URL(input);
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return input;
  }
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error.";
}
