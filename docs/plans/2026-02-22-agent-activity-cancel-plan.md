# Agent Activity Streaming + Cancel — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the side panel show real-time summarized agent activity and cancel running agents.

**Architecture:** Watcher parses `--output-format stream-json` from `claude -p`, POSTs summarized activity entries to the server. Server holds activity in-memory and broadcasts via SSE. Side panel renders activity log and cancel button. Cancel request flows from side panel → server → watcher (via SSE).

**Tech Stack:** TypeScript (server/watcher), vanilla JS (extension), Express, SSE

**Design doc:** `docs/plans/2026-02-22-agent-activity-cancel-design.md`

---

### Task 1: Add ActivityEntry type

**Files:**
- Modify: `types.ts`

**Step 1: Add the type**

Add after the `WatcherOptions` interface at the end of `types.ts`:

```ts
export interface ActivityEntry {
  timestamp: string;
  type: "tool_start" | "tool_end" | "text" | "error" | "result";
  summary: string;
}
```

**Step 2: Build to verify**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add types.ts
git commit -m "Add ActivityEntry type for agent activity streaming"
```

---

### Task 2: Add server activity + cancel endpoints

**Files:**
- Modify: `server/index.ts`
- Test: `test/server.test.ts`

**Step 1: Write failing tests for the new endpoints**

Add these tests to `test/server.test.ts` inside the `"Server API"` describe block:

```ts
describe("POST /api/tasks/:id/activity", () => {
  it("accepts an activity entry and returns 200", async () => {
    const createRes = await createTask();
    const task = await createRes.json();

    // Set to in_progress first
    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "tool_start",
        summary: "Reading src/App.tsx",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].summary).toBe("Reading src/App.tsx");
    expect(data.entries[0].timestamp).toBeTruthy();
  });

  it("returns 404 for unknown task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", summary: "hello" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tasks/:id/activity", () => {
  it("returns activity entries", async () => {
    const createRes = await createTask();
    const task = await createRes.json();

    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    // Post two entries
    await fetch(`${baseUrl}/api/tasks/${task.id}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tool_start", summary: "Reading file" }),
    });
    await fetch(`${baseUrl}/api/tasks/${task.id}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tool_end", summary: "Done reading" }),
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/activity`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(2);
  });

  it("returns empty array for task with no activity", async () => {
    const createRes = await createTask();
    const task = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/activity`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toEqual([]);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  it("sets task status to done", async () => {
    const createRes = await createTask();
    const task = await createRes.json();

    // Set to in_progress
    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    // Verify status is done
    const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const updated = await getRes.json();
    expect(updated.status).toBe("done");
  });

  it("clears activity on cancel", async () => {
    const createRes = await createTask();
    const task = await createRes.json();

    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    // Add activity
    await fetch(`${baseUrl}/api/tasks/${task.id}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", summary: "working" }),
    });

    // Cancel
    await fetch(`${baseUrl}/api/tasks/${task.id}/cancel`, { method: "POST" });

    // Activity should be cleared
    const actRes = await fetch(`${baseUrl}/api/tasks/${task.id}/activity`);
    const data = await actRes.json();
    expect(data.entries).toEqual([]);
  });

  it("returns 404 for unknown task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/nonexistent/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — routes don't exist yet

**Step 3: Implement the server endpoints**

In `server/index.ts`, add in-memory activity map and three new route handlers. Insert the activity map right after the `sseClients` set declaration:

```ts
// --- Activity (in-memory, transient) ---

import type { ActivityEntry } from "../types.js";

const taskActivity = new Map<string, ActivityEntry[]>();
```

Add the three routes after the existing `POST /api/tasks/:id/after-screenshot` block but before `GET /api/status`. The routes for `/api/tasks/:id/activity` and `/api/tasks/:id/cancel` must be defined before the generic `/api/tasks/:id` GET route won't conflict since these use POST/GET on different paths. But they must be before the status route. Add them after the after-screenshot endpoint:

```ts
// --- Activity endpoints ---

app.post(
  "/api/tasks/:id/activity",
  asyncHandler(async (req, res) => {
    const task = await queue.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const { type, summary } = req.body as { type: string; summary: string };
    const entry: ActivityEntry = {
      timestamp: new Date().toISOString(),
      type: type as ActivityEntry["type"],
      summary: summary || "",
    };

    const entries = taskActivity.get(req.params.id) || [];
    entries.push(entry);
    taskActivity.set(req.params.id, entries);

    broadcast("task_activity", { taskId: req.params.id, entry });
    res.json({ entries });
  })
);

app.get(
  "/api/tasks/:id/activity",
  asyncHandler(async (req, res) => {
    const entries = taskActivity.get(req.params.id) || [];
    res.json({ entries });
  })
);

app.post(
  "/api/tasks/:id/cancel",
  asyncHandler(async (req, res) => {
    const task = await queue.updateTask(req.params.id, { status: "done" });
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    taskActivity.delete(req.params.id);
    broadcast("task_cancel", { id: req.params.id });
    broadcast("task_updated", task);
    res.json(task);
  })
);
```

Also, add activity cleanup when task status changes away from `in_progress`. In the existing `PUT /api/tasks/:id` handler, after the `broadcast("task_updated", task)` line, add:

```ts
// Clear activity when leaving in_progress
if (task.status !== "in_progress") {
  taskActivity.delete(req.params.id);
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/index.ts test/server.test.ts
git commit -m "Add activity and cancel API endpoints"
```

---

### Task 3: Switch watcher to stream-json and parse activity

**Files:**
- Modify: `watcher.ts`

**Step 1: Add stream-json parser helper**

Add this helper function after the `buildPrompt` function in `watcher.ts`:

```ts
// ─── Stream-JSON Parser ─────────────────────────────────────────

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  result?: string;
  cost_usd?: number;
  num_turns?: number;
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `Reading ${input.file_path || "file"}`;
    case "Edit":
      return `Editing ${input.file_path || "file"}`;
    case "Write":
      return `Writing ${input.file_path || "file"}`;
    case "Glob":
      return `Searching for ${input.pattern || "files"}`;
    case "Grep":
      return `Searching for "${input.pattern || "..."}"`;
    case "Bash":
      return `Running ${(input.command as string)?.slice(0, 60) || "command"}`;
    default:
      return `Using ${name}`;
  }
}

function extractActivities(event: StreamEvent): Array<{ type: string; summary: string }> {
  const activities: Array<{ type: string; summary: string }> = [];

  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use" && block.name) {
        activities.push({
          type: "tool_start",
          summary: summarizeTool(block.name, block.input || {}),
        });
      } else if (block.type === "text" && block.text) {
        const trimmed = block.text.trim();
        if (trimmed.length > 0) {
          activities.push({
            type: "text",
            summary: trimmed.length > 80 ? trimmed.slice(0, 80) + "..." : trimmed,
          });
        }
      }
    }
  } else if (event.type === "result") {
    const cost = event.cost_usd != null ? `$${event.cost_usd.toFixed(3)}` : "";
    const turns = event.num_turns != null ? `${event.num_turns} turns` : "";
    const parts = [cost, turns].filter(Boolean).join(", ");
    activities.push({
      type: "result",
      summary: parts ? `Complete (${parts})` : "Complete",
    });
  }

  return activities;
}
```

**Step 2: Modify processTask to use stream-json and post activity**

Replace the agent spawn section in `processTask`. The key changes are:
1. Add `"--output-format", "stream-json"` to the args
2. Replace `prefixStream` with JSONL parsing that posts activity to the server
3. Keep terminal logging for debugging

Replace the `const exitCode = await new Promise<number>((resolve) => {` block entirely. The new version:

```ts
const exitCode = await new Promise<number>((resolve) => {
  const args = [
    "-p",
    prompt,
    "--allowedTools",
    allowedTools,
    "--output-format",
    "stream-json",
  ];

  if (maxTurns) {
    args.push("--max-turns", String(maxTurns));
  }

  const child = spawn("claude", args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  currentProcess = child;

  // Agent timeout
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (agentTimeout > 0) {
    timeoutHandle = setTimeout(() => {
      log(
        `Agent timeout (${Math.round(agentTimeout / 1000)}s). Killing process.`
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (currentProcess === child) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, agentTimeout);
  }

  // Parse stream-json output (JSONL on stdout)
  let stdoutBuffer = "";
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          const activities = extractActivities(event);
          for (const activity of activities) {
            log(`[agent] ${activity.summary}`);
            // Fire-and-forget POST to server
            fetchJSON(`${serverUrl}/api/tasks/${task.id}/activity`, {
              method: "POST",
              body: activity,
            }).catch(() => {});
          }
        } catch {
          // Non-JSON line, log as-is
          console.log(`  [agent] ${line}`);
        }
      }
    });
  }

  // Log stderr as-is
  if (child.stderr) {
    let stderrBuffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop()!;
      for (const line of lines) {
        console.log(`  [agent:err] ${line}`);
      }
    });
    child.stderr.on("end", () => {
      if (stderrBuffer) console.log(`  [agent:err] ${stderrBuffer}`);
    });
  }

  child.on("error", (err) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (err.message.includes("ENOENT")) {
      console.error(
        "\n  Error: 'claude' command not found. Install Claude Code:\n  https://docs.anthropic.com/en/docs/claude-code\n"
      );
    }
    resolve(1);
  });

  child.on("close", (code) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    currentProcess = null;
    resolve(code ?? 1);
  });
});
```

**Step 3: Add cancel listener to SSE handlers**

In the `connect()` function, add a `task_cancel` handler alongside the existing `task_created`, `task_updated`, `task_deleted` handlers:

```ts
task_cancel: (data) => {
  const { id } = data as { id: string };
  if (id === currentTaskId && currentProcess) {
    log(`Cancel requested for task ${id.slice(0, 8)}. Killing agent.`);
    currentProcess.kill("SIGTERM");
    setTimeout(() => {
      if (currentProcess) currentProcess.kill("SIGKILL");
    }, 5000);
  }
},
```

**Step 4: Build to verify**

Run: `npm run typecheck`
Expected: PASS

Run: `npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add watcher.ts
git commit -m "Switch watcher to stream-json parsing with activity posting and cancel support"
```

---

### Task 4: Add activity log and cancel button to side panel

**Files:**
- Modify: `extension/sidepanel.js`
- Modify: `extension/sidepanel.css`

**Step 1: Add activity state and SSE listener in sidepanel.js**

Add near the top of the file, after the existing state variables (`let selectionModeActive`, etc.):

```js
let taskActivityMap = {}; // taskId -> ActivityEntry[]
```

In the `connectSSE()` function, add two new event listeners after the existing `task_deleted` listener:

```js
eventSource.addEventListener("task_activity", (e) => {
  const { taskId, entry } = JSON.parse(e.data);
  if (!taskActivityMap[taskId]) taskActivityMap[taskId] = [];
  taskActivityMap[taskId].push(entry);
  // Only re-render if this task is expanded
  if (expandedTaskId === taskId) renderTasks();
});

eventSource.addEventListener("task_cancel", (e) => {
  const { id } = JSON.parse(e.data);
  delete taskActivityMap[id];
});
```

In the existing `task_updated` listener, add cleanup when a task leaves `in_progress`:

```js
eventSource.addEventListener("task_updated", (e) => {
  const updated = JSON.parse(e.data);
  const idx = tasks.findIndex((t) => t.id === updated.id);
  if (idx !== -1) tasks[idx] = updated;
  // Clear activity when task leaves in_progress
  if (updated.status !== "in_progress") {
    delete taskActivityMap[updated.id];
  }
  renderTasks();
});
```

Also fetch activity when reconnecting. In `fetchTasks()`, after setting `tasks = data.items || []`, add:

```js
// Fetch activity for any in_progress tasks
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
```

**Step 2: Add cancel button to expanded in_progress tasks**

In the `createTaskDetail` function, add a cancel button + activity log section for `in_progress` tasks. Add this block after the existing `if (task.status === "review")` / `else if (task.status === "pending")` blocks, as a new `else if`:

```js
else if (task.status === "in_progress") {
  // Cancel button
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

  // Activity log
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

    // Auto-scroll to bottom
    requestAnimationFrame(() => {
      activityLog.scrollTop = activityLog.scrollHeight;
    });
  }
}
```

**Step 3: Add CSS styles**

Add to the end of `extension/sidepanel.css`:

```css
/* ─── Cancel Button ─── */

.btn-cancel {
  background: #ef4444;
  color: white;
  border: none;
}

.btn-cancel:hover {
  background: #dc2626;
}

/* ─── Activity Log ─── */

.task-activity-log {
  background: #0a0a14;
  border: 1px solid #1e1e3a;
  border-radius: 4px;
  padding: 6px 8px;
  max-height: 150px;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 10px;
  line-height: 1.6;
}

.activity-entry {
  color: #9ca3af;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-icon {
  color: #3b82f6;
  margin-right: 4px;
  display: inline-block;
  width: 8px;
}
```

**Step 4: Test manually**

Reload the extension at `chrome://extensions`. Create a task, start the watcher, verify:
1. Activity entries appear in the expanded task card
2. Cancel button kills the agent and marks task as done
3. Activity clears when task completes or is cancelled

**Step 5: Commit**

```bash
git add extension/sidepanel.js extension/sidepanel.css
git commit -m "Add activity log and cancel button to side panel"
```

---

### Task 5: Typecheck, lint, test — final verification

**Step 1: Run full check suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: ALL PASS

**Step 2: Commit any fixes if needed**

---

### Summary

| Task | Files | What |
|------|-------|------|
| 1 | `types.ts` | Add `ActivityEntry` type |
| 2 | `server/index.ts`, `test/server.test.ts` | Activity + cancel API endpoints with tests |
| 3 | `watcher.ts` | Stream-json parsing, activity posting, cancel listener |
| 4 | `extension/sidepanel.js`, `extension/sidepanel.css` | Activity log UI + cancel button |
| 5 | — | Final verification |
