const CAPTURE_PREFIX = "capture_";
const RED = "#d62828";
const DRAG_THRESHOLD = 6;
const MIN_ARROW_LENGTH = 10;
const MAX_HISTORY_ENTRIES = 100;
const TOAST_DEFAULT_MS = 2200;
const MESSAGE_RETAKE_CAPTURE_HIGH = "RETAKE_CAPTURE_HIGH";
const Konva = globalThis.Konva;

const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const actionsEl = document.querySelector(".actions");
const retakeHqBtn = ensureRetakeButton(actionsEl, downloadBtn);
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const previewWrapEl = document.querySelector(".preview-wrap");
const editorShellEl = document.getElementById("editor-shell");
const stageContainerEl = document.getElementById("editor-stage");
const textEditorEl = document.getElementById("text-editor");
const saveBtnEl = document.getElementById("save-btn");
const toastEl = document.getElementById("toast");

let currentDataUrl = null;
let currentFilename = "screenshot.png";
let sourceCaptureContext = null;
let naturalWidth = 0;
let naturalHeight = 0;
let displayWidth = 0;
let displayHeight = 0;
let exportPixelRatio = 1;

let stage = null;
let baseLayer = null;
let annotationLayer = null;
let interactionLayer = null;
let transformer = null;
let baseImageNode = null;

let pointerStart = null;
let pointerDownOnEmpty = false;
let isDrawingArrow = false;
let draftArrow = null;
let suppressTextOnPointerUp = false;

let activeTextEdit = null;
let history = [];
let historyIndex = -1;
let applyingHistory = false;
let toastTimer = null;

init().catch((error) => {
  showToast(`Error: ${error?.message || String(error)}`, { error: true });
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
  setRetakeButtonEnabled(false);
  undoBtn.disabled = true;
  redoBtn.disabled = true;
});

copyBtn.addEventListener("click", () => {
  void copyAnnotatedImageToClipboard();
});

downloadBtn.addEventListener("click", () => {
  void downloadAnnotatedImage();
});

if (saveBtnEl) {
  saveBtnEl.addEventListener("click", () => {
    void downloadAnnotatedImage();
  });
}

if (retakeHqBtn) {
  retakeHqBtn.addEventListener("click", () => {
    void retakeInHighQuality();
  });
}

undoBtn.addEventListener("click", () => {
  undo();
});

redoBtn.addEventListener("click", () => {
  redo();
});

textEditorEl.addEventListener("input", () => {
  if (!activeTextEdit?.node) {
    return;
  }
  activeTextEdit.node.text(textEditorEl.value);
  annotationLayer.batchDraw();
  resizeTextEditorToContent();
});

textEditorEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    closeTextEditor({ cancel: false });
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeTextEditor({ cancel: true });
  }
});

textEditorEl.addEventListener("blur", () => {
  closeTextEditor({ cancel: false });
});

window.addEventListener("keydown", (event) => {
  if (isSaveShortcut(event)) {
    event.preventDefault();
    void downloadAnnotatedImage();
    return;
  }

  if (isCopyShortcut(event)) {
    event.preventDefault();
    void copyAnnotatedImageToClipboard();
    return;
  }

  if (isUndoShortcut(event)) {
    event.preventDefault();
    undo();
    return;
  }

  if (isRedoShortcut(event)) {
    event.preventDefault();
    redo();
    return;
  }

  if (isRetakeShortcut(event)) {
    event.preventDefault();
    void retakeInHighQuality();
    return;
  }

  if (document.activeElement === textEditorEl) {
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    const selected = getSelectedNode();
    if (!selected) {
      return;
    }

    event.preventDefault();
    selected.destroy();
    selectNode(null);
    annotationLayer.draw();
    recordHistory();
  }
});

async function init() {
  if (!Konva) {
    throw new Error("Konva failed to load.");
  }

  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    showToast(`Capture failed: ${error}`, { error: true });
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    setRetakeButtonEnabled(false);
    undoBtn.disabled = true;
    redoBtn.disabled = true;
    return;
  }

  const captureId = params.get("id");
  if (!captureId) {
    showToast("No screenshot id was provided.", { error: true });
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    setRetakeButtonEnabled(false);
    undoBtn.disabled = true;
    redoBtn.disabled = true;
    return;
  }

  const storage = chrome.storage.local;
  const key = `${CAPTURE_PREFIX}${captureId}`;
  const data = await storage.get(key);
  const item = data[key];

  if (!item?.dataUrl) {
    showToast("Screenshot data was not found.", { error: true });
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    setRetakeButtonEnabled(false);
    undoBtn.disabled = true;
    redoBtn.disabled = true;
    return;
  }

  currentDataUrl = item.dataUrl;
  currentFilename = item.filename || "screenshot.png";
  sourceCaptureContext = normalizeSourceContext(item.source);
  setRetakeButtonEnabled(Boolean(sourceCaptureContext));

  const imageEl = await loadImage(currentDataUrl);
  naturalWidth = imageEl.naturalWidth;
  naturalHeight = imageEl.naturalHeight;

  setupStage(imageEl);
  recordHistory();
  showToast("Screenshot saved to Downloads");
}

function setupStage(imageEl) {
  const availableWidth = Math.max(1, previewWrapEl.clientWidth - 2);
  displayWidth = Math.min(naturalWidth, availableWidth || naturalWidth);
  displayHeight = Math.max(1, Math.round(naturalHeight * (displayWidth / naturalWidth)));
  exportPixelRatio = naturalWidth / displayWidth;

  editorShellEl.style.width = `${displayWidth}px`;
  editorShellEl.style.height = `${displayHeight}px`;

  stage = new Konva.Stage({
    container: stageContainerEl,
    width: displayWidth,
    height: displayHeight
  });

  baseLayer = new Konva.Layer();
  annotationLayer = new Konva.Layer();
  interactionLayer = new Konva.Layer();

  baseImageNode = new Konva.Image({
    image: imageEl,
    x: 0,
    y: 0,
    width: displayWidth,
    height: displayHeight,
    listening: true
  });

  baseLayer.add(baseImageNode);

  transformer = new Konva.Transformer({
    rotateEnabled: false,
    flipEnabled: false,
    anchorSize: 8,
    anchorFill: "#ffffff",
    anchorStroke: RED,
    anchorStrokeWidth: 2,
    borderStroke: RED,
    borderStrokeWidth: 1.5,
    keepRatio: false,
    boundBoxFunc: (oldBox, newBox) => {
      if (Math.abs(newBox.width) < 8 || Math.abs(newBox.height) < 8) {
        return oldBox;
      }
      return newBox;
    }
  });

  interactionLayer.add(transformer);

  stage.add(baseLayer);
  stage.add(annotationLayer);
  stage.add(interactionLayer);

  stage.on("mousedown touchstart", handleStagePointerDown);
  stage.on("mousemove touchmove", handleStagePointerMove);
  stage.on("mouseup touchend", handleStagePointerUp);
  stage.on("mouseleave touchcancel", handleStagePointerCancel);

  stage.on("transformend", (event) => {
    if (!isAnnotationNode(event.target)) {
      return;
    }
    recordHistory();
  });
}

function handleStagePointerDown(event) {
  if (!stage) {
    return;
  }

  const pointer = stage.getPointerPosition();
  if (!pointer) {
    return;
  }

  if (isTransformerTarget(event.target)) {
    return;
  }

  if (isAnnotationNode(event.target)) {
    closeTextEditor({ cancel: false });
    selectNode(event.target);
    pointerStart = null;
    pointerDownOnEmpty = false;
    isDrawingArrow = false;
    suppressTextOnPointerUp = false;
    destroyDraftArrow();
    return;
  }

  if (!isEmptyTarget(event.target)) {
    return;
  }

  const hadSelected = !!getSelectedNode();
  closeTextEditor({ cancel: false });

  pointerStart = { x: pointer.x, y: pointer.y };
  pointerDownOnEmpty = true;
  isDrawingArrow = false;
  suppressTextOnPointerUp = hadSelected;
  destroyDraftArrow();
  selectNode(null);
}

function handleStagePointerMove() {
  if (!pointerDownOnEmpty || !pointerStart || !stage) {
    return;
  }

  const pointer = stage.getPointerPosition();
  if (!pointer) {
    return;
  }

  if (distance(pointerStart, pointer) <= DRAG_THRESHOLD) {
    return;
  }

  if (!isDrawingArrow) {
    isDrawingArrow = true;
    draftArrow = new Konva.Arrow({
      points: [pointerStart.x, pointerStart.y, pointer.x, pointer.y],
      stroke: RED,
      fill: RED,
      strokeWidth: 5,
      pointerLength: 14,
      pointerWidth: 12,
      lineCap: "round",
      lineJoin: "round",
      opacity: 0.65,
      dash: [8, 6],
      listening: false
    });
    interactionLayer.add(draftArrow);
  } else {
    draftArrow.points([pointerStart.x, pointerStart.y, pointer.x, pointer.y]);
  }

  interactionLayer.batchDraw();
}

function handleStagePointerUp() {
  if (!pointerDownOnEmpty || !pointerStart || !stage) {
    resetPointerState();
    return;
  }

  const pointer = stage.getPointerPosition() || pointerStart;

  if (isDrawingArrow && draftArrow) {
    const points = draftArrow.points();
    const length = distance({ x: points[0], y: points[1] }, { x: points[2], y: points[3] });
    destroyDraftArrow();

    if (length >= MIN_ARROW_LENGTH) {
      const arrow = createArrowNode(points);
      annotationLayer.add(arrow);
      annotationLayer.draw();
      selectNode(arrow);
      recordHistory();
    }

    resetPointerState();
    return;
  }

  const clickPoint = { x: pointerStart.x, y: pointerStart.y };
  const shouldCreateText = !suppressTextOnPointerUp && distance(pointerStart, pointer) <= DRAG_THRESHOLD;

  resetPointerState();

  if (shouldCreateText) {
    beginTextEditingAt(clickPoint.x, clickPoint.y);
  }
}

function handleStagePointerCancel() {
  destroyDraftArrow();
  resetPointerState();
}

function resetPointerState() {
  pointerStart = null;
  pointerDownOnEmpty = false;
  isDrawingArrow = false;
  suppressTextOnPointerUp = false;
}

function destroyDraftArrow() {
  if (!draftArrow) {
    return;
  }
  draftArrow.destroy();
  draftArrow = null;
  interactionLayer.batchDraw();
}

function beginTextEditingAt(x, y) {
  const textNode = createTextNode(x, y, "");
  annotationLayer.add(textNode);
  annotationLayer.draw();
  selectNode(textNode);
  openTextEditor(textNode, true);
}

function openTextEditor(textNode, isNew) {
  activeTextEdit = {
    node: textNode,
    isNew,
    originalText: textNode.text()
  };

  textEditorEl.value = textNode.text();
  textEditorEl.style.display = "block";
  textEditorEl.style.left = `${Math.max(0, Math.round(textNode.x()))}px`;
  textEditorEl.style.top = `${Math.max(0, Math.round(textNode.y() - textNode.fontSize() * 0.1))}px`;
  resizeTextEditorToContent();

  textEditorEl.focus();
  textEditorEl.select();
}

function resizeTextEditorToContent() {
  const lines = textEditorEl.value.split("\n");
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const width = Math.max(38, Math.min(displayWidth - 8, longestLine * 16 + 18));
  const height = Math.max(34, lines.length * 34);

  textEditorEl.style.width = `${width}px`;
  textEditorEl.style.height = `${height}px`;
}

function closeTextEditor(options = {}) {
  if (!activeTextEdit?.node) {
    return;
  }

  const { cancel = false, skipHistory = false } = options;
  const { node, isNew, originalText } = activeTextEdit;

  const updatedText = textEditorEl.value;
  let changed = false;

  if (cancel) {
    if (isNew) {
      node.destroy();
    } else {
      node.text(originalText);
    }
  } else if (updatedText.trim() === "") {
    node.destroy();
    changed = isNew || originalText.trim() !== "";
  } else {
    node.text(updatedText);
    changed = isNew || updatedText !== originalText;
  }

  textEditorEl.style.display = "none";
  textEditorEl.value = "";

  const nodeStillExists = typeof node.getLayer === "function" && !!node.getLayer();
  if (nodeStillExists) {
    selectNode(node);
  } else {
    selectNode(null);
  }

  annotationLayer.draw();

  if (changed && !skipHistory) {
    recordHistory();
  }

  activeTextEdit = null;
}

function createArrowNode(points) {
  return new Konva.Arrow({
    id: `arrow-${crypto.randomUUID()}`,
    points,
    stroke: RED,
    fill: RED,
    strokeWidth: 6,
    pointerLength: 18,
    pointerWidth: 14,
    lineCap: "round",
    lineJoin: "round",
    draggable: false
  });
}

function createTextNode(x, y, text) {
  return new Konva.Text({
    id: `text-${crypto.randomUUID()}`,
    x,
    y,
    text,
    fill: RED,
    fontSize: 28,
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    draggable: false
  });
}

function selectNode(node) {
  if (!transformer) {
    return;
  }

  if (!node || !isAnnotationNode(node)) {
    transformer.nodes([]);
    interactionLayer.batchDraw();
    return;
  }

  transformer.nodes([node]);
  interactionLayer.batchDraw();
}

function getSelectedNode() {
  if (!transformer) {
    return null;
  }

  const nodes = transformer.nodes();
  return nodes.length > 0 ? nodes[0] : null;
}

function isEmptyTarget(node) {
  return node === stage || node === baseImageNode;
}

function isAnnotationNode(node) {
  return !!node && node.getLayer && node.getLayer() === annotationLayer;
}

function isTransformerTarget(node) {
  return (
    !!node &&
    (node === transformer || node.getParent?.() === transformer || node.getLayer?.() === interactionLayer)
  );
}

function recordHistory() {
  if (!annotationLayer || applyingHistory) {
    return;
  }

  const snapshot = serializeAnnotations();
  if (historyIndex >= 0 && history[historyIndex] === snapshot) {
    updateUndoRedoButtons();
    return;
  }

  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);

  if (history.length > MAX_HISTORY_ENTRIES) {
    history.shift();
  }

  historyIndex = history.length - 1;
  updateUndoRedoButtons();
}

function serializeAnnotations() {
  const nodes = annotationLayer.getChildren((node) => isAnnotationNode(node));
  return JSON.stringify(nodes.map((node) => node.toObject()));
}

function restoreSnapshot(snapshot) {
  if (!annotationLayer) {
    return;
  }

  closeTextEditor({ cancel: false, skipHistory: true });
  selectNode(null);

  applyingHistory = true;
  try {
    annotationLayer.destroyChildren();

    const objects = JSON.parse(snapshot);
    for (const objectData of objects) {
      const node = Konva.Node.create(objectData);
      if (!node || (node.getClassName() !== "Arrow" && node.getClassName() !== "Text")) {
        continue;
      }
      annotationLayer.add(node);
    }

    annotationLayer.draw();
  } finally {
    applyingHistory = false;
    updateUndoRedoButtons();
  }
}

function undo() {
  if (historyIndex <= 0) {
    return;
  }

  historyIndex -= 1;
  restoreSnapshot(history[historyIndex]);
}

function redo() {
  if (historyIndex >= history.length - 1) {
    return;
  }

  historyIndex += 1;
  restoreSnapshot(history[historyIndex]);
}

function updateUndoRedoButtons() {
  const hasAnnotations = history.length > 1;
  undoBtn.classList.toggle("visible", hasAnnotations);
  redoBtn.classList.toggle("visible", hasAnnotations);
  if (saveBtnEl) {
    saveBtnEl.classList.toggle("visible", hasAnnotations);
  }
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex >= history.length - 1;
}

function isUndoShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  return modifier && !event.shiftKey && event.key.toLowerCase() === "z";
}

function isRedoShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier) {
    return false;
  }

  const key = event.key.toLowerCase();
  return (event.shiftKey && key === "z") || (!event.shiftKey && key === "y");
}

function isCopyShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  return modifier && !event.shiftKey && event.key.toLowerCase() === "c";
}

function isSaveShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  return modifier && !event.shiftKey && event.key.toLowerCase() === "s";
}

function isRetakeShortcut(event) {
  const modifier = event.metaKey || event.ctrlKey;
  return modifier && !event.shiftKey && event.key.toLowerCase() === "i";
}

async function copyAnnotatedImageToClipboard() {
  if (!currentDataUrl) {
    showToast("No screenshot loaded.", { error: true });
    return;
  }

  copyBtn.disabled = true;
  const savedChildren = Array.from(copyBtn.childNodes).map((n) => n.cloneNode(true));
  copyBtn.textContent = "Copying...";

  try {
    closeTextEditor({ cancel: false });
    const blob = await getCopyBlob();
    await writeImageBlobToClipboard(blob);
    showToast("Image copied to clipboard");
  } catch (error) {
    showToast(`Copy failed: ${error?.message || String(error)}`, { error: true });
  } finally {
    copyBtn.disabled = false;
    copyBtn.textContent = "";
    for (const child of savedChildren) {
      copyBtn.appendChild(child);
    }
  }
}

async function downloadAnnotatedImage() {
  if (!currentDataUrl) {
    showToast("No screenshot loaded.", { error: true });
    return;
  }

  downloadBtn.disabled = true;
  const previousText = downloadBtn.textContent;
  downloadBtn.textContent = "Downloading...";

  try {
    closeTextEditor({ cancel: false });
    const blob = await getCopyBlob();
    const dataUrl = await blobToDataUrl(blob);
    const filename = makeAnnotatedFilename(currentFilename);

    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false
    });

    showToast("Annotated screenshot saved to Downloads");
  } catch (error) {
    showToast(`Download failed: ${error?.message || String(error)}`, { error: true });
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = previousText;
  }
}

async function retakeInHighQuality() {
  if (!retakeHqBtn) {
    showToast("Retake button is unavailable.", { error: true });
    return;
  }

  if (!sourceCaptureContext) {
    showToast("Retake is unavailable for this screenshot.", { error: true });
    return;
  }

  retakeHqBtn.disabled = true;
  const previousText = retakeHqBtn.textContent;
  retakeHqBtn.textContent = "Retaking...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_RETAKE_CAPTURE_HIGH,
      payload: { source: sourceCaptureContext }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not start high-quality retake.");
    }

    showToast("High-quality retake finished");
  } catch (error) {
    showToast(`Retake failed: ${error?.message || String(error)}`, { error: true });
  } finally {
    retakeHqBtn.textContent = previousText;
    setRetakeButtonEnabled(Boolean(sourceCaptureContext));
  }
}

function setRetakeButtonEnabled(enabled) {
  if (!retakeHqBtn) {
    return;
  }
  retakeHqBtn.disabled = !enabled;
}

function normalizeSourceContext(source) {
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

function ensureRetakeButton(actionsNode, beforeNode) {
  let button = document.getElementById("retake-hq-btn");
  if (button) {
    return button;
  }

  if (!actionsNode) {
    return null;
  }

  button = document.createElement("button");
  button.id = "retake-hq-btn";
  button.type = "button";
  button.textContent = "Retake in high quality";

  if (beforeNode && beforeNode.parentElement === actionsNode) {
    actionsNode.insertBefore(button, beforeNode);
  } else {
    actionsNode.appendChild(button);
  }

  return button;
}

function makeAnnotatedFilename(filename) {
  const source = filename || "screenshot";
  const base = source.replace(/\.[^/.]+$/, "");
  return `${base}-annotated.png`;
}

async function getCopyBlob() {
  if (!stage) {
    return dataUrlToBlob(currentDataUrl);
  }

  closeTextEditor({ cancel: false });

  const selectedNodes = transformer.nodes();
  transformer.nodes([]);
  interactionLayer.batchDraw();

  try {
    const dataUrl = stage.toDataURL({
      pixelRatio: exportPixelRatio,
      mimeType: "image/png"
    });
    return dataUrlToBlob(dataUrl);
  } finally {
    transformer.nodes(selectedNodes);
    interactionLayer.batchDraw();
  }
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("FileReader failed."));
    reader.readAsDataURL(blob);
  });
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load screenshot image."));
    image.src = src;
  });
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function showToast(message, options = {}) {
  if (!toastEl) {
    return;
  }

  const { error = false, duration = TOAST_DEFAULT_MS } = options;
  toastEl.textContent = message;
  toastEl.classList.remove("error");
  if (error) {
    toastEl.classList.add("error");
  }

  toastEl.classList.add("show");

  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, duration);
}
