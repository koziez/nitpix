/**
 * Nitpix — Content Script
 *
 * Injected into localhost pages. Handles:
 * - Element selection mode (hover highlight, click to annotate)
 * - React fiber inspection for source file detection
 * - Inline popup for annotation entry
 * - Page-wide note support (triggered from side panel)
 */

(function () {
  "use strict";

  // Avoid double-injection
  if (window.__nitpix) return;
  window.__nitpix = true;

  let selectionMode = false;
  let regionMode = false;
  let hoveredElement = null;
  let highlightOverlay = null;
  let popupContainer = null;
  let selectedElementInfo = null;
  let regionOverlay = null;
  let regionStart = null;
  let isDrawing = false;

  // ─── Service Worker Retry ─────────────────────────────────────────

  async function sendMsg(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      if (err.message?.includes("Receiving end does not exist")) {
        // Service worker was asleep — retry once to wake it
        await new Promise((r) => setTimeout(r, 100));
        return await chrome.runtime.sendMessage(msg);
      }
      throw err;
    }
  }

  // ─── React Fiber Inspection ───────────────────────────────────────

  function getFiber(element) {
    if (!element) return null;
    const key = Object.keys(element).find((k) =>
      k.startsWith("__reactFiber$")
    );
    return key ? element[key] : null;
  }

  function getSourceInfo(fiber) {
    let current = fiber;
    let elementSource = null;
    let pageSource = null;

    while (current) {
      if (current._debugSource && !elementSource) {
        elementSource = {
          fileName: current._debugSource.fileName,
          lineNumber: current._debugSource.lineNumber,
          columnNumber: current._debugSource.columnNumber,
          componentName: getComponentName(current),
        };
      }
      // Track the highest user component (skip node_modules)
      if (
        current._debugSource &&
        !current._debugSource.fileName.includes("node_modules")
      ) {
        pageSource = {
          fileName: current._debugSource.fileName,
          lineNumber: current._debugSource.lineNumber,
          componentName: getComponentName(current),
        };
      }
      current = current.return;
    }

    return { elementSource, pageSource };
  }

  function getComponentName(fiber) {
    if (!fiber || !fiber.type) return "Unknown";
    if (typeof fiber.type === "string") return fiber.type; // DOM element
    return fiber.type.displayName || fiber.type.name || "Anonymous";
  }

  function getCssSelector(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${current.id}`;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === "string") {
        const classes = current.className.trim().split(/\s+/).slice(0, 2);
        if (classes.length > 0 && classes[0] !== "") {
          selector += "." + classes.join(".");
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function getComputedStyleSubset(element) {
    const cs = window.getComputedStyle(element);
    const props = [
      "font-family", "font-size", "font-weight", "font-style", "line-height",
      "letter-spacing", "color", "background-color", "text-align",
      "text-decoration", "text-transform", "padding", "margin",
      "border", "border-radius", "display", "gap", "align-items",
      "justify-content", "width", "height", "max-width", "min-height",
      "opacity", "box-shadow",
    ];
    const result = {};
    const skip = new Set(["none", "normal", "0px", "auto", "0px 0px 0px 0px", "0px 0px", ""]);
    for (const prop of props) {
      const val = cs.getPropertyValue(prop);
      if (val && !skip.has(val)) {
        result[prop] = val;
      }
    }
    return result;
  }

  function getElementInfo(element) {
    const fiber = getFiber(element);
    const sourceInfo = fiber
      ? getSourceInfo(fiber)
      : { elementSource: null, pageSource: null };
    const rect = element.getBoundingClientRect();
    const computedStyles = getComputedStyleSubset(element);

    return {
      element: sourceInfo.elementSource
        ? {
            component: sourceInfo.elementSource.componentName,
            sourceFile: normalizeSourcePath(sourceInfo.elementSource.fileName),
            sourceLine: sourceInfo.elementSource.lineNumber,
            selector: getCssSelector(element),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            computedStyles,
          }
        : {
            component: "Unknown",
            sourceFile: "",
            sourceLine: 0,
            selector: getCssSelector(element),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            computedStyles,
          },
      page: sourceInfo.pageSource
        ? {
            component: sourceInfo.pageSource.componentName,
            sourceFile: normalizeSourcePath(sourceInfo.pageSource.fileName),
            sourceLine: sourceInfo.pageSource.lineNumber,
          }
        : {
            component: "Unknown",
            sourceFile: "",
            sourceLine: 0,
          },
    };
  }

  function normalizeSourcePath(filePath) {
    if (!filePath) return "";
    // Strip webpack/vite prefixes and absolute paths to get relative project path
    const srcIndex = filePath.indexOf("/src/");
    if (srcIndex !== -1) return filePath.substring(srcIndex + 1);
    return filePath
      .replace(/^.*?\/node_modules\//, "node_modules/")
      .replace(/^\/?/, "");
  }

  // ─── DOM Helper ───────────────────────────────────────────────────

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (key === "style" && typeof val === "object") {
          Object.assign(node.style, val);
        } else if (key === "style" && typeof val === "string") {
          node.style.cssText = val;
        } else if (key.startsWith("on") && typeof val === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else {
          node.setAttribute(key, val);
        }
      }
    }
    if (children) {
      for (const child of Array.isArray(children) ? children : [children]) {
        if (typeof child === "string") {
          node.appendChild(document.createTextNode(child));
        } else if (child) {
          node.appendChild(child);
        }
      }
    }
    return node;
  }

  // ─── Highlight Overlay ────────────────────────────────────────────

  function createHighlightOverlay() {
    const overlay = el("div", {
      id: "__nitpix-highlight",
      style: {
        position: "fixed",
        pointerEvents: "none",
        border: "2px solid #3b82f6",
        background: "rgba(59, 130, 246, 0.1)",
        zIndex: "2147483646",
        transition: "all 0.05s ease-out",
        display: "none",
        borderRadius: "2px",
      },
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function updateHighlight(element) {
    if (!highlightOverlay) highlightOverlay = createHighlightOverlay();
    if (!element) {
      highlightOverlay.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    highlightOverlay.style.display = "block";
    highlightOverlay.style.top = rect.top + "px";
    highlightOverlay.style.left = rect.left + "px";
    highlightOverlay.style.width = rect.width + "px";
    highlightOverlay.style.height = rect.height + "px";
  }

  // ─── Inline Popup ─────────────────────────────────────────────────

  function createOption(value, text, selected) {
    const opt = el("option", { value }, [text]);
    if (selected) opt.selected = true;
    return opt;
  }

  function showPopup(element, elementInfo) {
    removePopup();

    const rect = element.getBoundingClientRect();
    const sourceDisplay = elementInfo.element.sourceFile
      ? `${elementInfo.element.component} — ${elementInfo.element.sourceFile}:${elementInfo.element.sourceLine}`
      : elementInfo.element.selector;

    const textarea = el("textarea", {
      id: "__nitpix-note",
      placeholder: "What should be changed?",
      style: {
        width: "100%",
        height: "60px",
        background: "#16213e",
        border: "1px solid #444",
        borderRadius: "4px",
        color: "#e0e0e0",
        padding: "8px",
        fontSize: "13px",
        fontFamily: "inherit",
        resize: "vertical",
        boxSizing: "border-box",
      },
    });

    const categorySelect = el(
      "select",
      {
        id: "__nitpix-category",
        style: {
          flex: "1",
          background: "#16213e",
          border: "1px solid #444",
          borderRadius: "4px",
          color: "#e0e0e0",
          padding: "4px 8px",
          fontSize: "12px",
        },
      },
      [
        createOption("tweak", "Tweak"),
        createOption("bug", "Bug"),
        createOption("feature", "Feature"),
      ]
    );

    const prioritySelect = el(
      "select",
      {
        id: "__nitpix-priority",
        style: {
          flex: "1",
          background: "#16213e",
          border: "1px solid #444",
          borderRadius: "4px",
          color: "#e0e0e0",
          padding: "4px 8px",
          fontSize: "12px",
        },
      },
      [
        createOption("high", "High"),
        createOption("medium", "Medium", true),
        createOption("low", "Low"),
      ]
    );

    const cancelBtn = el(
      "button",
      {
        id: "__nitpix-cancel",
        style: {
          padding: "6px 14px",
          background: "transparent",
          border: "1px solid #444",
          borderRadius: "4px",
          color: "#9ca3af",
          cursor: "pointer",
          fontSize: "12px",
        },
        onClick: (e) => {
          e.stopPropagation();
          removePopup();
        },
      },
      ["Cancel"]
    );

    const submitBtn = el(
      "button",
      {
        id: "__nitpix-submit",
        style: {
          padding: "6px 14px",
          background: "#3b82f6",
          border: "none",
          borderRadius: "4px",
          color: "white",
          cursor: "pointer",
          fontSize: "12px",
        },
        onClick: (e) => {
          e.stopPropagation();
          submitTask(elementInfo);
        },
      },
      ["Submit"]
    );

    popupContainer = el(
      "div",
      {
        id: "__nitpix-popup",
        style: {
          position: "fixed",
          zIndex: "2147483647",
          background: "#1a1a2e",
          border: "1px solid #333",
          borderRadius: "8px",
          padding: "12px",
          width: "320px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize: "13px",
          color: "#e0e0e0",
        },
      },
      [
        // Source file label
        el(
          "div",
          {
            style: {
              marginBottom: "8px",
              color: "#9ca3af",
              fontSize: "11px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            title: sourceDisplay,
          },
          [sourceDisplay]
        ),
        // Textarea
        textarea,
        // Category + Priority row
        el("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } }, [
          categorySelect,
          prioritySelect,
        ]),
        // Buttons row
        el(
          "div",
          { style: { display: "flex", gap: "8px", marginTop: "10px", justifyContent: "flex-end" } },
          [cancelBtn, submitBtn]
        ),
      ]
    );

    // Position popup within the visible viewport
    const popupWidth = 320;
    const popupHeight = 220; // approximate height of the form
    const margin = 8;

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    let top;
    if (spaceBelow > popupHeight + margin) {
      top = rect.bottom + margin;
    } else if (spaceAbove > popupHeight + margin) {
      top = rect.top - popupHeight - margin;
    } else {
      // Neither side has enough room — pin to bottom of viewport
      top = window.innerHeight - popupHeight - margin;
    }
    // Clamp vertically
    top = Math.max(margin, Math.min(top, window.innerHeight - popupHeight - margin));
    popupContainer.style.top = top + "px";

    // Clamp horizontally
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - popupWidth - margin));
    popupContainer.style.left = left + "px";

    document.body.appendChild(popupContainer);

    // Focus the textarea
    setTimeout(() => textarea.focus(), 50);

    // Submit on Ctrl+Enter / Cmd+Enter
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitTask(elementInfo);
      }
      if (e.key === "Escape") {
        removePopup();
      }
    });

    // Prevent clicks inside popup from triggering selection
    popupContainer.addEventListener("click", (e) => e.stopPropagation());
    popupContainer.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  function removePopup() {
    if (popupContainer) {
      popupContainer.remove();
      popupContainer = null;
    }
    selectedElementInfo = null;
  }

  async function submitTask(elementInfo) {
    const noteEl = document.getElementById("__nitpix-note");
    const note = noteEl.value.trim();
    if (!note) {
      noteEl.style.borderColor = "#ef4444";
      return;
    }

    const category = document.getElementById("__nitpix-category").value;
    const priority = document.getElementById("__nitpix-priority").value;

    removePopup();
    exitSelectionMode();

    // Send to background script for screenshot + server POST
    try {
      const response = await sendMsg({
        type: "CREATE_TASK",
        payload: {
          url: window.location.pathname + window.location.search,
          note,
          category,
          priority,
          taskType: "element",
          element: elementInfo.element,
          page: elementInfo.page,
        },
      });

      if (response?.error) {
        showToast("Error: " + response.error, true);
      } else {
        showToast("Task created");
      }
    } catch (err) {
      showToast("Failed to create task: " + err.message, true);
    }
  }

  // ─── Page-Wide Note (triggered from side panel) ────────────────────

  async function submitPageNote(note, category, priority) {
    const appRoot =
      document.getElementById("root") ||
      document.getElementById("app") ||
      document.getElementById("__next") ||
      document.getElementById("__nuxt") ||
      document.querySelector("[data-reactroot]") ||
      document.body;
    const fiber = getFiber(appRoot);
    let pageSource = { component: "Unknown", sourceFile: "", sourceLine: 0 };

    if (fiber) {
      const info = getSourceInfo(fiber);
      if (info.pageSource) {
        pageSource = {
          component: info.pageSource.componentName,
          sourceFile: normalizeSourcePath(info.pageSource.fileName),
          sourceLine: info.pageSource.lineNumber,
        };
      }
    }

    try {
      const response = await sendMsg({
        type: "CREATE_TASK",
        payload: {
          url: window.location.pathname + window.location.search,
          note,
          category,
          priority,
          taskType: "page",
          element: null,
          page: pageSource,
        },
      });

      if (response?.error) {
        showToast("Error: " + response.error, true);
      } else {
        showToast("Page note created");
      }
    } catch (err) {
      showToast("Failed to create page note: " + err.message, true);
    }
  }

  // ─── Toast Notification ───────────────────────────────────────────

  function showToast(message, isError) {
    const toast = el(
      "div",
      {
        style: {
          position: "fixed",
          bottom: "24px",
          right: "24px",
          zIndex: "2147483647",
          background: isError ? "#ef4444" : "#22c55e",
          color: "white",
          padding: "8px 16px",
          borderRadius: "6px",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          fontSize: "13px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          transition: "opacity 0.3s",
          maxWidth: "400px",
        },
      },
      [message]
    );
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, isError ? 4000 : 2000);
  }

  // ─── Selection Mode ───────────────────────────────────────────────

  function enterSelectionMode() {
    selectionMode = true;
    document.body.style.cursor = "crosshair";
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function exitSelectionMode() {
    selectionMode = false;
    document.body.style.cursor = "";
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    updateHighlight(null);
    hoveredElement = null;
    try { sendMsg({ type: "SELECTION_MODE_CHANGED", active: false, mode: "element" }).catch(() => {}); } catch {}
  }

  function onMouseOver(e) {
    if (!selectionMode || popupContainer) return;
    if (e.target.id && e.target.id.startsWith("__nitpix")) return;
    hoveredElement = e.target;
    updateHighlight(hoveredElement);
    e.stopPropagation();
  }

  function onMouseOut(e) {
    if (!selectionMode || popupContainer) return;
    if (e.target === hoveredElement) {
      hoveredElement = null;
      updateHighlight(null);
    }
  }

  function onClick(e) {
    if (!selectionMode) return;
    if (popupContainer && popupContainer.contains(e.target)) return;
    if (e.target.id && e.target.id.startsWith("__nitpix")) return;

    e.preventDefault();
    e.stopPropagation();

    if (popupContainer) {
      removePopup();
      return;
    }

    const targetElement = e.target;
    selectedElementInfo = getElementInfo(targetElement);
    updateHighlight(null);
    showPopup(targetElement, selectedElementInfo);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      if (popupContainer) {
        removePopup();
      } else {
        exitSelectionMode();
      }
    }
  }

  // ─── Region Selection Mode ──────────────────────────────────────

  function enterRegionMode() {
    regionMode = true;
    document.body.style.cursor = "crosshair";
    document.addEventListener("mousedown", onRegionMouseDown, true);
    document.addEventListener("keydown", onRegionKeyDown, true);
  }

  function exitRegionMode() {
    regionMode = false;
    isDrawing = false;
    regionStart = null;
    document.body.style.cursor = "";
    document.removeEventListener("mousedown", onRegionMouseDown, true);
    document.removeEventListener("mousemove", onRegionMouseMove, true);
    document.removeEventListener("mouseup", onRegionMouseUp, true);
    document.removeEventListener("keydown", onRegionKeyDown, true);
    removeRegionOverlay();
    try { sendMsg({ type: "SELECTION_MODE_CHANGED", active: false, mode: "region" }).catch(() => {}); } catch {}
  }

  function removeRegionOverlay() {
    if (regionOverlay) {
      regionOverlay.remove();
      regionOverlay = null;
    }
  }

  function onRegionMouseDown(e) {
    if (!regionMode) return;
    if (popupContainer && popupContainer.contains(e.target)) return;
    if (e.target.id && e.target.id.startsWith("__nitpix")) return;

    // If popup is open and user clicks outside it, close the popup
    if (popupContainer) {
      removePopup();
      removeRegionOverlay();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    isDrawing = true;
    regionStart = { x: e.clientX, y: e.clientY };

    removeRegionOverlay();
    regionOverlay = el("div", {
      id: "__nitpix-region-overlay",
      style: {
        position: "fixed",
        border: "2px dashed #3b82f6",
        background: "rgba(59, 130, 246, 0.08)",
        zIndex: "2147483646",
        pointerEvents: "none",
        left: e.clientX + "px",
        top: e.clientY + "px",
        width: "0px",
        height: "0px",
      },
    });
    document.body.appendChild(regionOverlay);

    document.addEventListener("mousemove", onRegionMouseMove, true);
    document.addEventListener("mouseup", onRegionMouseUp, true);
  }

  function onRegionMouseMove(e) {
    if (!isDrawing || !regionStart || !regionOverlay) return;
    e.preventDefault();
    e.stopPropagation();

    const x = Math.min(e.clientX, regionStart.x);
    const y = Math.min(e.clientY, regionStart.y);
    const w = Math.abs(e.clientX - regionStart.x);
    const h = Math.abs(e.clientY - regionStart.y);

    regionOverlay.style.left = x + "px";
    regionOverlay.style.top = y + "px";
    regionOverlay.style.width = w + "px";
    regionOverlay.style.height = h + "px";
  }

  function onRegionMouseUp(e) {
    if (!isDrawing || !regionStart) return;
    e.preventDefault();
    e.stopPropagation();

    isDrawing = false;
    document.removeEventListener("mousemove", onRegionMouseMove, true);
    document.removeEventListener("mouseup", onRegionMouseUp, true);

    const x = Math.min(e.clientX, regionStart.x);
    const y = Math.min(e.clientY, regionStart.y);
    const w = Math.abs(e.clientX - regionStart.x);
    const h = Math.abs(e.clientY - regionStart.y);

    // Ignore tiny accidental clicks (less than 10px in either dimension)
    if (w < 10 || h < 10) {
      removeRegionOverlay();
      regionStart = null;
      return;
    }

    const regionRect = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(w),
      height: Math.round(h),
    };

    regionStart = null;
    showRegionPopup(regionRect);
  }

  function onRegionKeyDown(e) {
    if (e.key === "Escape") {
      if (popupContainer) {
        removePopup();
        removeRegionOverlay();
      } else {
        exitRegionMode();
      }
    }
  }

  function showRegionPopup(regionRect) {
    removePopup();

    // Get page source info for context
    const appRoot =
      document.getElementById("root") ||
      document.getElementById("app") ||
      document.getElementById("__next") ||
      document.getElementById("__nuxt") ||
      document.querySelector("[data-reactroot]") ||
      document.body;
    const fiber = getFiber(appRoot);
    let pageSource = { component: "Unknown", sourceFile: "", sourceLine: 0 };
    if (fiber) {
      const info = getSourceInfo(fiber);
      if (info.pageSource) {
        pageSource = {
          component: info.pageSource.componentName,
          sourceFile: normalizeSourcePath(info.pageSource.fileName),
          sourceLine: info.pageSource.lineNumber,
        };
      }
    }

    const pageDisplay = pageSource.sourceFile
      ? `${pageSource.component} — ${pageSource.sourceFile}`
      : window.location.pathname;

    const textarea = el("textarea", {
      id: "__nitpix-note",
      placeholder: "Describe what should change in this area...",
      style: {
        width: "100%",
        height: "60px",
        background: "#16213e",
        border: "1px solid #444",
        borderRadius: "4px",
        color: "#e0e0e0",
        padding: "8px",
        fontSize: "13px",
        fontFamily: "inherit",
        resize: "vertical",
        boxSizing: "border-box",
      },
    });

    const categorySelect = el(
      "select",
      {
        id: "__nitpix-category",
        style: {
          flex: "1",
          background: "#16213e",
          border: "1px solid #444",
          borderRadius: "4px",
          color: "#e0e0e0",
          padding: "4px 8px",
          fontSize: "12px",
        },
      },
      [
        createOption("tweak", "Tweak"),
        createOption("bug", "Bug"),
        createOption("feature", "Feature"),
      ]
    );

    const prioritySelect = el(
      "select",
      {
        id: "__nitpix-priority",
        style: {
          flex: "1",
          background: "#16213e",
          border: "1px solid #444",
          borderRadius: "4px",
          color: "#e0e0e0",
          padding: "4px 8px",
          fontSize: "12px",
        },
      },
      [
        createOption("high", "High"),
        createOption("medium", "Medium", true),
        createOption("low", "Low"),
      ]
    );

    const cancelBtn = el(
      "button",
      {
        style: {
          padding: "6px 14px",
          background: "transparent",
          border: "1px solid #444",
          borderRadius: "4px",
          color: "#9ca3af",
          cursor: "pointer",
          fontSize: "12px",
        },
        onClick: (e) => {
          e.stopPropagation();
          removePopup();
          removeRegionOverlay();
        },
      },
      ["Cancel"]
    );

    const submitBtn = el(
      "button",
      {
        style: {
          padding: "6px 14px",
          background: "#3b82f6",
          border: "none",
          borderRadius: "4px",
          color: "white",
          cursor: "pointer",
          fontSize: "12px",
        },
        onClick: (e) => {
          e.stopPropagation();
          submitRegionTask(regionRect, pageSource);
        },
      },
      ["Submit"]
    );

    popupContainer = el(
      "div",
      {
        id: "__nitpix-popup",
        style: {
          position: "fixed",
          zIndex: "2147483647",
          background: "#1a1a2e",
          border: "1px solid #333",
          borderRadius: "8px",
          padding: "12px",
          width: "320px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize: "13px",
          color: "#e0e0e0",
        },
      },
      [
        el(
          "div",
          {
            style: {
              marginBottom: "8px",
              color: "#9ca3af",
              fontSize: "11px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            title: pageDisplay,
          },
          ["Region — " + pageDisplay]
        ),
        textarea,
        el("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } }, [
          categorySelect,
          prioritySelect,
        ]),
        el(
          "div",
          { style: { display: "flex", gap: "8px", marginTop: "10px", justifyContent: "flex-end" } },
          [cancelBtn, submitBtn]
        ),
      ]
    );

    // Position popup within the visible viewport
    const popupWidth = 320;
    const popupHeight = 220; // approximate height of the form
    const margin = 8;

    const regionBottom = regionRect.y + regionRect.height;
    const spaceBelow = window.innerHeight - regionBottom;
    const spaceAbove = regionRect.y;

    let top;
    if (spaceBelow > popupHeight + margin) {
      top = regionBottom + margin;
    } else if (spaceAbove > popupHeight + margin) {
      top = regionRect.y - popupHeight - margin;
    } else {
      top = window.innerHeight - popupHeight - margin;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - popupHeight - margin));
    popupContainer.style.top = top + "px";

    const left = Math.max(margin, Math.min(regionRect.x, window.innerWidth - popupWidth - margin));
    popupContainer.style.left = left + "px";

    document.body.appendChild(popupContainer);
    setTimeout(() => textarea.focus(), 50);

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitRegionTask(regionRect, pageSource);
      }
      if (e.key === "Escape") {
        removePopup();
        removeRegionOverlay();
      }
    });

    popupContainer.addEventListener("click", (e) => e.stopPropagation());
    popupContainer.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  async function submitRegionTask(regionRect, pageSource) {
    const noteEl = document.getElementById("__nitpix-note");
    const note = noteEl.value.trim();
    if (!note) {
      noteEl.style.borderColor = "#ef4444";
      return;
    }

    const category = document.getElementById("__nitpix-category").value;
    const priority = document.getElementById("__nitpix-priority").value;

    removePopup();
    removeRegionOverlay();
    exitRegionMode();

    try {
      const response = await sendMsg({
        type: "CREATE_TASK",
        payload: {
          url: window.location.pathname + window.location.search,
          note,
          category,
          priority,
          taskType: "region",
          element: null,
          page: pageSource,
          region: { rect: regionRect },
        },
      });

      if (response?.error) {
        showToast("Error: " + response.error, true);
      } else {
        showToast("Region task created");
      }
    } catch (err) {
      showToast("Failed to create task: " + err.message, true);
    }
  }

  // ─── Message Handling ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "TOGGLE_SELECTION_MODE": {
        const mode = message.mode || "element";

        if (mode === "region") {
          // Exit element mode if active
          if (selectionMode) exitSelectionMode();

          if (message.enter !== undefined) {
            if (message.enter && !regionMode) enterRegionMode();
            else if (!message.enter && regionMode) exitRegionMode();
          } else {
            if (regionMode) exitRegionMode();
            else enterRegionMode();
          }
          sendResponse({ active: regionMode, mode: "region" });
        } else {
          // Exit region mode if active
          if (regionMode) exitRegionMode();

          if (message.enter !== undefined) {
            if (message.enter && !selectionMode) enterSelectionMode();
            else if (!message.enter && selectionMode) exitSelectionMode();
          } else {
            if (selectionMode) exitSelectionMode();
            else enterSelectionMode();
          }
          sendResponse({ active: selectionMode, mode: "element" });
        }
        break;
      }

      case "GET_SELECTION_MODE":
        sendResponse({
          active: selectionMode || regionMode,
          mode: regionMode ? "region" : "element",
        });
        break;

      case "PAGE_NOTE":
        submitPageNote(message.note, message.category, message.priority);
        sendResponse({ ok: true });
        break;
    }
  });
})();
