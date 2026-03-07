(() => {
  if (window.__oneClickScreenshotInstalled) {
    return;
  }
  window.__oneClickScreenshotInstalled = true;

  let hiddenElements = [];
  let overlayEl = null;
  let listenersBound = false;

  const captureState = {
    active: false,
    cancelled: false,
    reason: "",
    quality: "standard",
    phase: "capturing",
    totalTiles: 0,
    capturedTiles: 0,
    programmaticScroll: false
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case "GET_PAGE_METRICS":
            sendResponse(getPageMetrics());
            return;
          case "START_CAPTURE_SESSION":
            startCaptureSession(message.payload || {});
            sendResponse({ ok: true });
            return;
          case "UPDATE_CAPTURE_PROGRESS":
            updateCaptureProgress(message.payload || {});
            sendResponse({ ok: true });
            return;
          case "SET_CAPTURE_PHASE":
            setCapturePhase(message.payload || {});
            sendResponse({ ok: true });
            return;
          case "CHECK_CAPTURE_STATUS":
            sendResponse({
              active: captureState.active,
              cancelled: captureState.cancelled,
              reason: captureState.reason
            });
            return;
          case "END_CAPTURE_SESSION":
            endCaptureSession();
            sendResponse({ ok: true });
            return;
          case "SCROLL_TO":
            await scrollToPosition(message.payload?.xCss || 0, message.payload?.yCss || 0);
            sendResponse({
              ok: !captureState.cancelled,
              cancelled: captureState.cancelled,
              reason: captureState.reason
            });
            return;
          case "HIDE_FIXED":
            sendResponse({ hiddenCount: hideFixedAndStickyElements() });
            return;
          case "RESTORE_FIXED":
            restoreHiddenElements();
            sendResponse({ ok: true });
            return;
          case "SHOW_ERROR_TOAST":
            showErrorToast(message.payload?.message || "An error occurred.");
            sendResponse({ ok: true });
            return;
          default:
            sendResponse({ ok: false, error: "Unknown message type." });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  });

  function getPageMetrics() {
    const docEl = document.documentElement;
    const body = document.body;

    const fullWidthCss = Math.max(
      docEl.scrollWidth,
      docEl.clientWidth,
      body ? body.scrollWidth : 0,
      body ? body.clientWidth : 0
    );
    const fullHeightCss = Math.max(
      docEl.scrollHeight,
      docEl.clientHeight,
      body ? body.scrollHeight : 0,
      body ? body.clientHeight : 0
    );

    return {
      fullWidthCss,
      fullHeightCss,
      viewportWidthCss: window.innerWidth,
      viewportHeightCss: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
  }

  function startCaptureSession(payload) {
    captureState.active = true;
    captureState.cancelled = false;
    captureState.reason = "";
    captureState.quality = payload.quality === "high" ? "high" : "standard";
    captureState.phase = "capturing";
    captureState.totalTiles = Number(payload.totalTiles || 0);
    captureState.capturedTiles = 0;
    captureState.programmaticScroll = false;

    addInteractionListeners();
    renderOverlay();
  }

  function updateCaptureProgress(payload) {
    if (!captureState.active) {
      return;
    }

    captureState.capturedTiles = Number(payload.capturedTiles || 0);
    captureState.totalTiles = Number(payload.totalTiles || captureState.totalTiles || 0);
    captureState.quality = payload.quality === "high" ? "high" : captureState.quality;
    captureState.phase = "capturing";
    renderOverlay();
  }

  function setCapturePhase(payload) {
    if (!captureState.active) {
      return;
    }

    const nextPhase = String(payload.phase || "").trim();
    if (nextPhase) {
      captureState.phase = nextPhase;
    }
    renderOverlay();
  }

  function endCaptureSession() {
    captureState.active = false;
    captureState.cancelled = false;
    captureState.reason = "";
    captureState.programmaticScroll = false;
    captureState.phase = "capturing";
    removeInteractionListeners();
    removeOverlay();
    restoreHiddenElements();
  }

  async function scrollToPosition(xCss, yCss) {
    captureState.programmaticScroll = true;

    const docEl = document.documentElement;
    const body = document.body;
    const previousDocScrollBehavior = docEl.style.scrollBehavior;
    const previousBodyScrollBehavior = body ? body.style.scrollBehavior : "";

    try {
      docEl.style.scrollBehavior = "auto";
      if (body) {
        body.style.scrollBehavior = "auto";
      }

      window.scrollTo(xCss, yCss);
      await waitForScrollSettled();
    } finally {
      docEl.style.scrollBehavior = previousDocScrollBehavior;
      if (body) {
        body.style.scrollBehavior = previousBodyScrollBehavior;
      }
      captureState.programmaticScroll = false;
    }
  }

  function waitForScrollSettled() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, 120);
        });
      });
    });
  }

  function addInteractionListeners() {
    if (listenersBound) {
      return;
    }
    listenersBound = true;

    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true, capture: true });
    window.addEventListener("keydown", onKeyDown, true);
  }

  function removeInteractionListeners() {
    if (!listenersBound) {
      return;
    }
    listenersBound = false;

    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("touchmove", onTouchMove, true);
    window.removeEventListener("keydown", onKeyDown, true);
  }

  function onWheel(event) {
    if (!captureState.active || captureState.programmaticScroll) {
      return;
    }
    if (!event.isTrusted) {
      return;
    }
    if (Math.abs(event.deltaX) < 0.5 && Math.abs(event.deltaY) < 0.5) {
      return;
    }
    cancelCapture("Capture cancelled because the page was scrolled.");
  }

  function onTouchMove(event) {
    if (!captureState.active || captureState.programmaticScroll) {
      return;
    }
    if (!event.isTrusted) {
      return;
    }
    cancelCapture("Capture cancelled because the page was scrolled.");
  }

  function onKeyDown(event) {
    if (!captureState.active) {
      return;
    }

    if (!event.isTrusted) {
      return;
    }

    if (event.key === "Escape") {
      cancelCapture("Capture cancelled because Escape was pressed.");
      return;
    }

    if (isScrollKey(event.key)) {
      cancelCapture("Capture cancelled because the page was scrolled.");
    }
  }

  function isScrollKey(key) {
    return (
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "PageUp" ||
      key === "PageDown" ||
      key === "Home" ||
      key === "End" ||
      key === " "
    );
  }

  function cancelCapture(reason) {
    if (!captureState.active || captureState.cancelled) {
      return;
    }
    captureState.cancelled = true;
    captureState.reason = reason;
    renderOverlay();
  }

  function renderOverlay() {
    if (!captureState.active) {
      removeOverlay();
      return;
    }

    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.setAttribute("data-one-click-capture-overlay", "true");
      overlayEl.style.position = "fixed";
      overlayEl.style.top = "12px";
      overlayEl.style.left = "50%";
      overlayEl.style.transform = "translateX(-50%)";
      overlayEl.style.zIndex = "2147483647";
      overlayEl.style.maxWidth = "360px";
      overlayEl.style.padding = "10px 12px";
      overlayEl.style.borderRadius = "10px";
      overlayEl.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.25)";
      overlayEl.style.fontFamily = "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      overlayEl.style.fontSize = "13px";
      overlayEl.style.lineHeight = "1.4";
      overlayEl.style.color = "#ffffff";
      overlayEl.style.whiteSpace = "normal";
      overlayEl.style.pointerEvents = "none";
      document.documentElement.appendChild(overlayEl);
    }

    if (captureState.cancelled) {
      overlayEl.style.background = "rgba(163, 31, 31, 0.94)";
      overlayEl.textContent = `${captureState.reason} Release input and wait for cleanup.`;
      return;
    }

    const total = Math.max(captureState.totalTiles, 1);
    const captured = Math.min(captureState.capturedTiles, total);
    const percent = Math.round((captured / total) * 100);
    const qualityText = captureState.quality === "high" ? "High quality" : "Standard quality";
    const phase = captureState.phase || "capturing";

    overlayEl.style.background = "rgba(11, 61, 145, 0.94)";
    if (phase === "capturing") {
      overlayEl.textContent = `${qualityText}: capturing ${captured}/${total} (${percent}%). Press Escape or scroll to cancel.`;
      return;
    }

    if (phase === "stitching") {
      overlayEl.textContent = `${qualityText}: stitching screenshot tiles. Press Escape to cancel.`;
      return;
    }

    if (phase === "compressing") {
      overlayEl.textContent = `${qualityText}: compressing output. Press Escape to cancel.`;
      return;
    }

    if (phase === "saving") {
      overlayEl.textContent = `${qualityText}: saving screenshot.`;
      return;
    }

    overlayEl.textContent = `${qualityText}: working...`;
  }

  function removeOverlay() {
    if (!overlayEl) {
      return;
    }
    overlayEl.remove();
    overlayEl = null;
  }

  function hideFixedAndStickyElements() {
    hiddenElements = [];
    const all = document.querySelectorAll("*");
    const viewportArea = window.innerWidth * window.innerHeight;

    for (const element of all) {
      const style = window.getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") {
        continue;
      }

      // Skip elements that cover most of the viewport — these are likely
      // app-shell containers (e.g. a fixed <main>), not overlays or toolbars.
      const rect = element.getBoundingClientRect();
      const elementArea = rect.width * rect.height;
      if (elementArea > viewportArea * 0.5) {
        continue;
      }

      hiddenElements.push({
        element,
        value: element.style.getPropertyValue("visibility"),
        priority: element.style.getPropertyPriority("visibility")
      });
      element.style.setProperty("visibility", "hidden", "important");
    }

    return hiddenElements.length;
  }

  function restoreHiddenElements() {
    for (const entry of hiddenElements) {
      if (!entry.element?.isConnected) {
        continue;
      }

      if (entry.value) {
        entry.element.style.setProperty("visibility", entry.value, entry.priority || "");
      } else {
        entry.element.style.removeProperty("visibility");
      }
    }
    hiddenElements = [];
  }

  function showErrorToast(message) {
    const el = document.createElement("div");
    el.setAttribute("data-one-click-capture-toast", "true");
    el.style.position = "fixed";
    el.style.top = "12px";
    el.style.left = "50%";
    el.style.transform = "translateX(-50%) translateY(-10px) scale(0.96)";
    el.style.zIndex = "2147483647";
    el.style.maxWidth = "360px";
    el.style.padding = "10px 14px";
    el.style.borderRadius = "8px";
    el.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.25)";
    el.style.fontFamily = "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    el.style.fontSize = "13px";
    el.style.lineHeight = "1.4";
    el.style.color = "#ffffff";
    el.style.background = "rgba(163, 31, 31, 0.94)";
    el.style.whiteSpace = "normal";
    el.style.pointerEvents = "none";
    el.style.opacity = "0";
    el.style.transition = "opacity 200ms ease, transform 200ms ease";
    el.textContent = message;
    document.documentElement.appendChild(el);

    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0) scale(1)";
    });

    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(-10px) scale(0.96)";
      setTimeout(() => el.remove(), 250);
    }, 3500);
  }
})();
