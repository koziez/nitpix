/**
 * Nitpix — Side Panel
 *
 * Shows the task queue, handles page-wide notes,
 * toggles element/region selection mode,
 * and manages review accept/retry flow.
 */

const SERVER_URL = "http://localhost:4173";

let tasks = [];
let expandedTaskId = null;
let retryTaskId = null; // task currently showing retry form
let selectionModeActive = false;
let activeSelectionMode = null; // "element" or "region"
let taskActivityMap = {}; // taskId -> ActivityEntry[]

// ─── DOM References ────────────────────────────────────────────────

const serverStatus = document.getElementById("server-status");
const btnSelect = document.getElementById("btn-select");
const btnRegion = document.getElementById("btn-region");
const btnPageNote = document.getElementById("btn-page-note");
const pageNoteForm = document.getElementById("page-note-form");
const pageNoteText = document.getElementById("page-note-text");
const pageNoteCategory = document.getElementById("page-note-category");
const pageNotePriority = document.getElementById("page-note-priority");
const pageNoteCancel = document.getElementById("page-note-cancel");
const pageNoteSubmit = document.getElementById("page-note-submit");
const taskList = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const clearDoneBtn = document.getElementById("btn-clear-done");

// ─── Server Communication ──────────────────────────────────────────

async function fetchTasks() {
  try {
    const res = await fetch(`${SERVER_URL}/api/tasks`);
    if (!res.ok) throw new Error("Server error");
    const data = await res.json();
    tasks = data.items || [];
    for (const task of tasks) {
      if (task.status === "in_progress") {
        fetch(`${SERVER_URL}/api/tasks/${task.id}/activity`)
          .then((r) => r.json())
          .then((data) => {
            if (data.entries && data.entries.length > 0) {
              taskActivityMap[task.id] = data.entries;
              if (expandedTaskId === task.id) renderTasks();
            }
          })
          .catch(() => {});
      }
    }
    updateServerStatus(true);
    renderTasks();
  } catch {
    updateServerStatus(false);
  }
}

function updateServerStatus(connected) {
  serverStatus.className = `status-dot ${connected ? "connected" : "disconnected"}`;
  serverStatus.title = connected ? "Server connected" : "Server disconnected";
}

// ─── SSE Connection ────────────────────────────────────────────────

let eventSource = null;

function connectSSE() {
  eventSource = new EventSource(`${SERVER_URL}/api/events`);

  eventSource.addEventListener("task_created", (e) => {
    const task = JSON.parse(e.data);
    tasks.push(task);
    renderTasks();
  });

  eventSource.addEventListener("task_updated", (e) => {
    const updated = JSON.parse(e.data);
    const idx = tasks.findIndex((t) => t.id === updated.id);
    if (idx !== -1) tasks[idx] = updated;
    if (updated.status !== "in_progress") {
      delete taskActivityMap[updated.id];
    }
    renderTasks();
  });

  eventSource.addEventListener("task_deleted", (e) => {
    const { id } = JSON.parse(e.data);
    tasks = tasks.filter((t) => t.id !== id);
    renderTasks();
  });

  eventSource.addEventListener("task_activity", (e) => {
    const { taskId, entry } = JSON.parse(e.data);
    if (!taskActivityMap[taskId]) taskActivityMap[taskId] = [];
    taskActivityMap[taskId].push(entry);
    if (expandedTaskId === taskId) renderTasks();
  });

  eventSource.addEventListener("task_cancel", (e) => {
    const { id } = JSON.parse(e.data);
    delete taskActivityMap[id];
  });

  eventSource.onopen = () => {
    updateServerStatus(true);
    fetchTasks(); // full sync on reconnect
  };

  eventSource.onerror = () => {
    updateServerStatus(false);
  };
}

// ─── Rendering ─────────────────────────────────────────────────────

function renderTasks() {
  // Show/hide Clear Done button
  const hasDone = tasks.some((t) => t.status === "done");
  clearDoneBtn.classList.toggle("hidden", !hasDone);

  // Clear task list
  taskList.textContent = "";

  if (tasks.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

  // Sort: status group (pending → review → in_progress → done),
  // then priority (high first), then date (newest first)
  const statusOrder = { pending: 0, review: 1, in_progress: 2, done: 3 };
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = [...tasks].sort((a, b) => {
    const sd = statusOrder[a.status] - statusOrder[b.status];
    if (sd !== 0) return sd;
    const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pd !== 0) return pd;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  for (const task of sorted) {
    taskList.appendChild(createTaskCard(task));
  }
}

function createTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.id = task.id;

  const sourceFile = task.element?.sourceFile || task.page?.sourceFile || "";
  const component = task.element?.component || task.page?.component || "";
  const sourceDisplay = sourceFile
    ? `${component} — ${sourceFile}`
    : component;

  // Delete button (top-right x)
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "task-card-delete";
  deleteBtn.title = "Delete task";
  deleteBtn.textContent = "\u00d7";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });
  card.appendChild(deleteBtn);

  // Header with badges
  const header = document.createElement("div");
  header.className = "task-card-header";
  header.appendChild(createBadge(task.status, `badge-${task.status}`));
  if (task.status === "in_progress") {
    const spinner = document.createElement("span");
    spinner.className = "task-card-spinner";
    header.appendChild(spinner);
  }
  header.appendChild(createBadge(task.priority, `badge-${task.priority}`));
  header.appendChild(createBadge(task.category, `badge-${task.category}`));
  if (task.type === "region") {
    header.appendChild(createBadge("region", "badge-region"));
  }
  card.appendChild(header);

  // Note text
  const noteDiv = document.createElement("div");
  noteDiv.className = "task-card-note";
  noteDiv.textContent = task.note;
  card.appendChild(noteDiv);

  // Meta (source file, URL)
  const meta = document.createElement("div");
  meta.className = "task-card-meta";

  if (sourceDisplay) {
    const sourceSpan = document.createElement("span");
    sourceSpan.className = "task-card-source";
    sourceSpan.title = sourceDisplay;
    sourceSpan.textContent = sourceDisplay;
    meta.appendChild(sourceSpan);
  }

  const urlSpan = document.createElement("span");
  urlSpan.textContent = task.url;
  meta.appendChild(urlSpan);

  card.appendChild(meta);

  // Expanded detail view
  if (task.id === expandedTaskId) {
    card.appendChild(createTaskDetail(task));
  }

  // Click to expand/collapse
  card.addEventListener("click", (e) => {
    // Don't collapse when clicking buttons/forms inside the detail
    if (e.target.closest(".task-actions") || e.target.closest(".retry-form") || e.target.closest(".task-card-delete")) return;
    expandedTaskId = expandedTaskId === task.id ? null : task.id;
    retryTaskId = null;
    renderTasks();
  });

  return card;
}

function createTaskDetail(task) {
  const detail = document.createElement("div");
  detail.className = "task-detail";

  // Screenshot thumbnail
  if (task.screenshotPath) {
    const img = document.createElement("img");
    img.className = "task-detail-screenshot";
    const filename = task.screenshotPath.split("/").pop();
    img.src = `${SERVER_URL}/screenshots/${filename}`;
    img.alt = "Screenshot";
    img.onerror = () => (img.style.display = "none");
    detail.appendChild(img);
  }

  // Agent notes (if review or done)
  if (task.agentNotes) {
    const label = document.createElement("div");
    label.style.cssText = "font-size: 10px; color: #6b7280; margin-bottom: 2px; font-weight: 600;";
    label.textContent = "AGENT NOTES";
    detail.appendChild(label);

    const notes = document.createElement("div");
    notes.className = "task-agent-notes";
    notes.textContent = task.agentNotes;
    detail.appendChild(notes);
  }

  // Files modified
  if (task.filesModified && task.filesModified.length > 0) {
    const files = document.createElement("div");
    files.className = "task-files-modified";
    files.textContent = "Files: " + task.filesModified.join(", ");
    detail.appendChild(files);
  }

  // Previous attempts
  if (task.attempts && task.attempts.length > 0) {
    const attemptsLabel = document.createElement("div");
    attemptsLabel.style.cssText = "font-size: 10px; color: #6b7280; margin-top: 8px; margin-bottom: 4px; font-weight: 600;";
    attemptsLabel.textContent = `PREVIOUS ATTEMPTS (${task.attempts.length})`;
    detail.appendChild(attemptsLabel);

    for (const attempt of task.attempts) {
      const attemptDiv = document.createElement("div");
      attemptDiv.className = "task-attempt";

      const attemptNotes = document.createElement("div");
      attemptNotes.className = "attempt-notes";
      attemptNotes.textContent = attempt.agentNotes;
      attemptDiv.appendChild(attemptNotes);

      const attemptReason = document.createElement("div");
      attemptReason.className = "attempt-retry-reason";
      attemptReason.textContent = "Retry: " + attempt.retryReason;
      attemptDiv.appendChild(attemptReason);

      detail.appendChild(attemptDiv);
    }
  }

  // Actions based on status
  if (task.status === "review") {
    if (retryTaskId === task.id) {
      detail.appendChild(createRetryForm(task));
    } else {
      const actions = document.createElement("div");
      actions.className = "task-actions";

      const acceptBtn = document.createElement("button");
      acceptBtn.className = "btn btn-accept btn-sm";
      acceptBtn.textContent = "Accept";
      acceptBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        acceptTask(task.id);
      });

      const retryBtn = document.createElement("button");
      retryBtn.className = "btn btn-retry btn-sm";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        retryTaskId = task.id;
        renderTasks();
      });

      actions.appendChild(acceptBtn);
      actions.appendChild(retryBtn);
      detail.appendChild(actions);
    }
  } else if (task.status === "pending") {
    const actions = document.createElement("div");
    actions.className = "task-actions";

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "btn btn-secondary btn-sm";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      acceptTask(task.id);
    });

    actions.appendChild(dismissBtn);
    detail.appendChild(actions);
  } else if (task.status === "in_progress") {
    const actions = document.createElement("div");
    actions.className = "task-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-cancel btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling...";
      try {
        await fetch(`${SERVER_URL}/api/tasks/${task.id}/cancel`, { method: "POST" });
      } catch (err) {
        console.error("Failed to cancel task:", err);
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Cancel";
      }
    });

    actions.appendChild(cancelBtn);
    detail.appendChild(actions);

    const activity = taskActivityMap[task.id];
    if (activity && activity.length > 0) {
      const activityLabel = document.createElement("div");
      activityLabel.style.cssText = "font-size: 10px; color: #6b7280; margin-top: 8px; margin-bottom: 4px; font-weight: 600;";
      activityLabel.textContent = "ACTIVITY";
      detail.appendChild(activityLabel);

      const activityLog = document.createElement("div");
      activityLog.className = "task-activity-log";

      for (const entry of activity) {
        const line = document.createElement("div");
        line.className = "activity-entry";

        const icon = document.createElement("span");
        icon.className = "activity-icon";
        icon.textContent = entry.type === "tool_start" ? ">" : entry.type === "result" ? "*" : " ";
        line.appendChild(icon);

        const text = document.createElement("span");
        text.textContent = entry.summary;
        line.appendChild(text);

        activityLog.appendChild(line);
      }

      detail.appendChild(activityLog);

      requestAnimationFrame(() => {
        activityLog.scrollTop = activityLog.scrollHeight;
      });
    }
  }

  return detail;
}

function createRetryForm(task) {
  const form = document.createElement("div");
  form.className = "retry-form";

  const label = document.createElement("div");
  label.style.cssText = "font-size: 11px; color: #9ca3af; margin-bottom: 4px;";
  label.textContent = "What should be different?";
  form.appendChild(label);

  const textarea = document.createElement("textarea");
  textarea.className = "retry-textarea";
  textarea.placeholder = "Describe what's wrong with the fix...";
  form.appendChild(textarea);

  const btnRow = document.createElement("div");
  btnRow.className = "retry-btn-row";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn-secondary btn-sm";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    retryTaskId = null;
    renderTasks();
  });

  const sendBtn = document.createElement("button");
  sendBtn.className = "btn btn-retry btn-sm";
  sendBtn.textContent = "Send Back";
  sendBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const reason = textarea.value.trim();
    if (!reason) {
      textarea.style.borderColor = "#ef4444";
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";
    await retryTask(task, reason);
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(sendBtn);
  form.appendChild(btnRow);

  // Focus textarea after render
  setTimeout(() => textarea.focus(), 50);

  // Ctrl+Enter to submit
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  return form;
}

function createBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = `badge ${className}`;
  badge.textContent = text.replace("_", " ");
  return badge;
}

// ─── Review Actions ────────────────────────────────────────────────

async function acceptTask(taskId) {
  try {
    await fetch(`${SERVER_URL}/api/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
  } catch (err) {
    console.error("Failed to accept task:", err);
  }
}

async function deleteTask(taskId) {
  // Optimistically remove from local state
  const deletedTask = tasks.find((t) => t.id === taskId);
  tasks = tasks.filter((t) => t.id !== taskId);
  expandedTaskId = null;
  renderTasks();

  // Show undo toast
  let undone = false;
  const toast = document.createElement("div");
  toast.style.cssText =
    "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#1f2937;color:#e5e7eb;padding:8px 16px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:10px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity 0.2s;";
  toast.textContent = "Task deleted. ";

  const undoBtn = document.createElement("button");
  undoBtn.textContent = "Undo";
  undoBtn.style.cssText =
    "background:none;border:1px solid #6b7280;color:#60a5fa;cursor:pointer;padding:2px 8px;border-radius:4px;font-size:12px;";
  undoBtn.addEventListener("click", () => {
    undone = true;
    toast.remove();
    if (deletedTask) {
      tasks.push(deletedTask);
      renderTasks();
    }
  });
  toast.appendChild(undoBtn);
  document.body.appendChild(toast);

  // After delay, actually delete from server
  setTimeout(async () => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
    if (!undone) {
      try {
        await fetch(`${SERVER_URL}/api/tasks/${taskId}`, { method: "DELETE" });
      } catch (err) {
        console.error("Failed to delete task:", err);
        // Restore on failure
        if (deletedTask) {
          tasks.push(deletedTask);
          renderTasks();
        }
      }
    }
  }, 3000);
}

async function retryTask(task, retryReason) {
  try {
    // Capture after screenshot first
    let afterScreenshotPath = null;
    try {
      const captureResult = await chrome.runtime.sendMessage({
        type: "CAPTURE_AFTER",
        taskId: task.id,
      });
      if (!captureResult?.error) {
        // Re-fetch task to get updated afterScreenshot path
        const res = await fetch(`${SERVER_URL}/api/tasks`);
        const data = await res.json();
        const updated = (data.items || []).find((t) => t.id === task.id);
        afterScreenshotPath = updated?.afterScreenshot || null;
      }
    } catch {
      // Screenshot capture failed — continue without it
    }

    // Archive current attempt
    const attempt = {
      agentNotes: task.agentNotes,
      filesModified: task.filesModified || [],
      retryReason,
      afterScreenshot: afterScreenshotPath,
      timestamp: new Date().toISOString(),
    };

    const attempts = [...(task.attempts || []), attempt];

    await fetch(`${SERVER_URL}/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "pending",
        attempts,
        agentNotes: "",
        filesModified: [],
        afterScreenshot: null,
      }),
    });

    retryTaskId = null;
  } catch (err) {
    console.error("Failed to retry task:", err);
  }
}

// ─── Event Handlers ────────────────────────────────────────────────

btnSelect.addEventListener("click", async () => {
  try {
    const wantEnter = !selectionModeActive || activeSelectionMode !== "element";
    // If switching from region mode, cancel that first
    if (selectionModeActive && activeSelectionMode !== "element") {
      await chrome.runtime.sendMessage({ type: "TOGGLE_SELECTION", enter: false });
    }
    const response = await chrome.runtime.sendMessage({
      type: "TOGGLE_SELECTION",
      enter: wantEnter,
      mode: "element",
    });
    if (response?.error) {
      console.error("Selection toggle error:", response.error);
      return;
    }
    if (response?.active !== undefined) {
      selectionModeActive = response.active;
      activeSelectionMode = selectionModeActive ? "element" : null;
      updateSelectionButtons();
    }
  } catch (err) {
    console.error("Failed to toggle selection:", err);
  }
});

btnRegion.addEventListener("click", async () => {
  try {
    const wantEnter = !selectionModeActive || activeSelectionMode !== "region";
    // If switching from element mode, cancel that first
    if (selectionModeActive && activeSelectionMode !== "region") {
      await chrome.runtime.sendMessage({ type: "TOGGLE_SELECTION", enter: false });
    }
    const response = await chrome.runtime.sendMessage({
      type: "TOGGLE_SELECTION",
      enter: wantEnter,
      mode: "region",
    });
    if (response?.error) {
      console.error("Region toggle error:", response.error);
      return;
    }
    if (response?.active !== undefined) {
      selectionModeActive = response.active;
      activeSelectionMode = selectionModeActive ? "region" : null;
      updateSelectionButtons();
    }
  } catch (err) {
    console.error("Failed to toggle region:", err);
  }
});

function updateSelectionButtons() {
  if (selectionModeActive && activeSelectionMode === "element") {
    btnSelect.textContent = "Cancel Selection";
    btnSelect.classList.add("active");
    btnRegion.classList.remove("active");
    btnRegion.textContent = "Select Region";
  } else if (selectionModeActive && activeSelectionMode === "region") {
    btnRegion.textContent = "Cancel Region";
    btnRegion.classList.add("active");
    btnSelect.classList.remove("active");
    btnSelect.textContent = "Select Element";
  } else {
    btnSelect.textContent = "Select Element";
    btnSelect.classList.remove("active");
    btnRegion.textContent = "Select Region";
    btnRegion.classList.remove("active");
  }
}

btnPageNote.addEventListener("click", () => {
  pageNoteForm.classList.toggle("hidden");
  if (!pageNoteForm.classList.contains("hidden")) {
    pageNoteText.focus();
  }
});

pageNoteCancel.addEventListener("click", () => {
  pageNoteForm.classList.add("hidden");
  pageNoteText.value = "";
});

pageNoteSubmit.addEventListener("click", async () => {
  const note = pageNoteText.value.trim();
  if (!note) {
    pageNoteText.style.borderColor = "#ef4444";
    return;
  }

  // Send to content script to create page note (it has fiber access)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "PAGE_NOTE",
      note,
      category: pageNoteCategory.value,
      priority: pageNotePriority.value,
    });
  }

  pageNoteForm.classList.add("hidden");
  pageNoteText.value = "";
  pageNoteText.style.borderColor = "";
});

// Ctrl+Enter to submit, Escape to cancel page note
pageNoteText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    pageNoteSubmit.click();
  }
  if (e.key === "Escape") {
    pageNoteCancel.click();
  }
});

// Clear done tasks
clearDoneBtn.addEventListener("click", async () => {
  const doneTasks = tasks.filter((t) => t.status === "done");
  for (const task of doneTasks) {
    await deleteTask(task.id);
  }
});

// Listen for updates from background
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "TASK_CREATED":
      // SSE handles this now, but keep as fallback
      if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
        fetchTasks();
      }
      break;
    case "SELECTION_STATE_UPDATE":
      selectionModeActive = message.active;
      if (!message.active) activeSelectionMode = null;
      else if (message.mode) activeSelectionMode = message.mode;
      updateSelectionButtons();
      break;
  }
});

// ─── Initialization ────────────────────────────────────────────────

fetchTasks();
connectSSE();
