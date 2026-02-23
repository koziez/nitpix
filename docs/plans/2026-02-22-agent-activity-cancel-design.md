# Agent Activity Streaming + Cancel

## Problem

When the watcher dispatches an agent for a task, the side panel only shows "in progress" with a spinner. There's no way to see what the agent is doing or cancel it without killing the watcher process.

## Solution

Two features via Approach A (watcher → server → side panel, all through existing SSE):

1. **Agent activity streaming**: Watcher parses `stream-json` output, summarizes tool calls and text, POSTs to server, server broadcasts via SSE, side panel renders.
2. **Cancel agent**: Side panel sends cancel request to server, server broadcasts via SSE, watcher kills the child process, task marked as `done`.

## Data Model

Activity is transient (in-memory on the server, not persisted to `queue.json`).

```ts
interface ActivityEntry {
  timestamp: string;
  type: "tool_start" | "tool_end" | "text" | "error" | "result";
  summary: string; // e.g. "Reading src/App.tsx", "Complete ($0.03, 5 turns)"
}
```

Server holds `Map<string, ActivityEntry[]>` keyed by task ID. Cleared when task leaves `in_progress`.

## Watcher Changes

- Switch `claude -p` to `--output-format stream-json`
- Parse JSONL stdout. For each event:
  - `assistant` message with `tool_use` → POST activity `tool_start` with summary like "Reading src/App.tsx"
  - `assistant` message with `text` → POST activity `text` with first ~80 chars
  - `user` message with `tool_result` → POST activity `tool_end`
  - `result` → POST activity `result` with cost/turns
- Listen for `task_cancel` SSE event — if it matches `currentTaskId`, kill child process, update task status to `done`
- Still log prefixed output to the watcher terminal for debugging

## Server Changes

- In-memory `Map<string, ActivityEntry[]>` (outside QueueManager)
- `POST /api/tasks/:id/activity` — append entry, broadcast `task_activity` SSE event `{ taskId, entry }`
- `POST /api/tasks/:id/cancel` — update task status to `done`, broadcast `task_cancel` SSE event `{ id }`, clear activity
- Clear activity for a task when its status changes away from `in_progress`
- `GET /api/tasks/:id/activity` — return current activity entries (for side panel reconnect)

## Side Panel Changes

- Listen for `task_activity` SSE events, store activity per task
- Listen for `task_cancel` SSE events, clear activity
- Expanded `in_progress` task cards show:
  - **Cancel** button (red, next to the spinner)
  - **Activity log** section: scrollable list of summarized entries, auto-scroll to bottom
- Activity log clears when task status changes

## Decisions

- **Cancel → done** (not pending): User chose this. Cancelled tasks are considered abandoned.
- **Summarized status** (not raw log): Watcher extracts tool names + file paths, not raw stdout.
- **stream-json parsing**: Reliable structured JSON, not fragile regex on plain text.
- **Transient activity**: No disk persistence. Activity only matters while agent is running.
