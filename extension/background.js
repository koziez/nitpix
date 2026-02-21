/**
 * Nitpix — Background Service Worker
 *
 * Handles:
 * - Screenshot capture via chrome.tabs.captureVisibleTab
 * - Posting tasks to the local server
 * - Extension icon click to toggle selection mode
 * - Keyboard shortcuts for element/region selection
 * - Side panel registration
 */

const SERVER_URL = "http://localhost:4173";

// Open side panel on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-element-selection") {
    toggleSelectionMode();
  } else if (command === "toggle-region-selection") {
    toggleSelectionMode(undefined, undefined, "region");
  }
});

// Listen for messages from content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "CREATE_TASK":
      handleCreateTask(message.payload, sender.tab?.id).then(
        (result) => sendResponse(result),
        (err) => sendResponse({ error: err.message })
      );
      return true; // async response

    case "TOGGLE_SELECTION":
      toggleSelectionMode(sender.tab?.id || message.tabId, message.enter, message.mode).then(
        (result) => sendResponse(result),
        (err) => sendResponse({ error: err.message })
      );
      return true;

    case "SELECTION_MODE_CHANGED":
      // Forward to side panel
      chrome.runtime.sendMessage({
        type: "SELECTION_STATE_UPDATE",
        active: message.active,
        mode: message.mode,
      }).catch(() => {});
      break;

    case "CAPTURE_AFTER":
      captureAfterScreenshot(message.taskId).then(
        (result) => sendResponse(result),
        (err) => sendResponse({ error: err.message })
      );
      return true;

    case "CHECK_SERVER":
      checkServer().then(
        (status) => sendResponse(status),
        () => sendResponse({ connected: false })
      );
      return true;
  }
});

async function handleCreateTask(payload, tabId) {
  // Capture screenshot of the visible tab
  let screenshot = "";
  if (tabId) {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    // Strip the data:image/png;base64, prefix
    screenshot = dataUrl.replace(/^data:image\/png;base64,/, "");
  }

  const taskData = {
    url: payload.url,
    note: payload.note,
    category: payload.category,
    priority: payload.priority,
    type: payload.taskType,
    screenshot,
    element: payload.element || undefined,
    page: payload.page,
    region: payload.region || undefined,
  };

  const response = await fetch(`${SERVER_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(taskData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server error: ${response.status} ${errorText}`);
  }

  const task = await response.json();

  // Notify side panel that a new task was created
  chrome.runtime.sendMessage({ type: "TASK_CREATED", task }).catch(() => {});

  return { ok: true, task };
}

async function toggleSelectionMode(tabId, enter, mode) {
  if (!tabId) {
    // Get the active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    tabId = tab?.id;
  }
  if (!tabId) return { error: "No active tab" };

  const msg = { type: "TOGGLE_SELECTION_MODE" };
  if (enter !== undefined) msg.enter = enter;
  if (mode) msg.mode = mode;

  // Try sending to existing content script first
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Content script not injected yet — inject it and retry
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function captureAfterScreenshot(taskId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  const screenshot = dataUrl.replace(/^data:image\/png;base64,/, "");

  const response = await fetch(`${SERVER_URL}/api/tasks/${taskId}/after-screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ screenshot }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server error: ${response.status} ${errorText}`);
  }

  return await response.json();
}

async function checkServer() {
  const response = await fetch(`${SERVER_URL}/api/status`);
  if (!response.ok) throw new Error("Server not reachable");
  const data = await response.json();
  return { connected: true, ...data };
}
