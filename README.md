<p align="center">
  <img src="logo.jpeg" width="120" alt="Nitpix logo" />
</p>

<h1 align="center">Nitpix</h1>

<p align="center">Pixel-perfect UI review for React apps, powered by Claude Code.</p>

---

Annotate UI issues in your browser while developing. Creates structured tasks for Claude Code to fix — manually or automatically.

**How it works:** You browse your React app → click elements or draw regions that need changes → write a note → Claude Code reads the task, sees the screenshot, knows the exact source file, and makes the fix.

## Prerequisites

- Node.js 18+
- Google Chrome
- A React app running in development mode on localhost
- Claude Code (for processing tasks)

## Install

```bash
# From GitHub
npm install -g github:your-username/nitpix

# Or clone and install locally
git clone <repo-url>
cd nitpix
npm install -g .
```

## Setup

```bash
# 1. Initialize a target project
nitpix init /path/to/your/react-project

# 2. Start the review server
nitpix serve --project /path/to/your/react-project
```

The `init` command creates:
- `.review/` directory in your project (screenshots + task queue)
- `.claude/commands/nitpix.md` (the `/nitpix` skill for Claude Code)
- Adds `.review/` to your `.gitignore`

### Install the Chrome Extension

```bash
nitpix extension
```

This prints the path to the extension folder. Then:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the folder printed above

You'll see the Nitpix icon in your toolbar.

## Usage

### 1. Annotate Issues

With your React app and the review server both running:

1. **Open the side panel** — Click the Nitpix extension icon. A side panel opens showing the task queue.
2. **Select an element** — Click "Select Element" in the side panel (or press `Cmd+Shift+S`). Hover over your app to see elements highlight in blue. Click one.
3. **Select a region** — Click "Select Region" (or press `Cmd+Shift+E`). Click and drag to draw a rectangle around an area of interest.
4. **Write your note** — An inline popup appears showing the detected source file. Describe what you want changed, pick a category and priority, then submit.
5. **Or make a page-wide note** — Click "Page Note" in the side panel to create a task about the entire page instead of a specific element.

The extension automatically:
- Takes a screenshot of the current page
- Detects the React component and source file via fiber inspection
- Captures computed CSS styles for element selections
- Sends everything to the local server

### 2. Process Tasks

You have two options:

**Automatic (recommended)** — Run the watcher in a separate terminal:

```bash
nitpix watch --project /path/to/your/react-project
```

The watcher listens for new tasks via SSE and automatically spawns a Claude Code agent for each one. Tasks are processed sequentially by priority. You'll see agent output streamed in the terminal.

> **⚠️ Dangerous mode:** The watcher spawns Claude Code agents with `--allowedTools`, which bypasses normal permission prompts. The agent can **read, write, and delete files** in your project without asking for confirmation. By default the allowed tools are `Edit,Write,Read,Bash(curl:*),Glob,Grep` — the agent cannot run arbitrary shell commands, but it has full read/write access to your project files. Always review changes with `git diff` after tasks complete, and make sure your work is committed before running the watcher.

The watcher enforces a max retry limit (default: 2). If a task has been retried that many times, the watcher skips it — you can still process it manually.

**Manual** — In your project directory, run `/nitpix` in Claude Code. It fetches and processes one task at a time. This runs within your normal Claude Code session with standard permission prompts.

### 3. Review Results

After the agent makes changes, tasks move to **review** status (not done). Expand the task in the side panel to see:
- The original screenshot
- Agent notes explaining what was changed
- List of files that were modified

Then either:
- **Accept** — marks the task as done
- **Retry** — captures an after screenshot of the current state, writes a follow-up note, and sends the task back to pending. The agent will see what it tried before and why it was rejected.

Deleting a task shows a brief undo toast before the deletion is finalized.

The side panel updates in real time via Server-Sent Events.

## Architecture

```
Chrome Extension          Local Server (:4173)        Claude Code
                                │
  Content Script ─POST──> Express API
  - click element         - writes queue.json
  - region select         - saves screenshots    ┌──> watch mode (auto)
  - React fiber           - SSE broadcasts  ─────┤
    inspection                                    └──> /nitpix (manual)
  Side Panel <───SSE────> /api/events                  │
  - task queue            - serves screenshots         │
  - review/accept/retry                          PUT──> marks task "review"
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+S` (Mac) / `Ctrl+Shift+S` | Toggle element selection mode |
| `Cmd+Shift+E` (Mac) / `Ctrl+Shift+E` | Toggle region selection mode |

## CLI Reference

| Command | Description |
|---------|-------------|
| `nitpix init <project-path>` | Set up `.review/` dir and `/nitpix` skill in a project |
| `nitpix start [--project <path>]` | Start server + watcher together (recommended) |
| `nitpix serve [--project <path>]` | Start the review server (default port 4173) |
| `nitpix watch [--project <path>]` | Watch for tasks and auto-dispatch Claude Code agents |
| `nitpix extension` | Show Chrome extension install path |
| `nitpix queue-next [--project <path>]` | Print next pending task as JSON |
| `nitpix queue-update <id> '<json>'` | Update a task (e.g. status, agent notes) |

### Watch/Start Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project <path>` | current dir | Path to the project with `.review/` |
| `--max-turns <n>` | 25 | Max agent turns per task |
| `--allowed-tools <tools>` | `Edit,Write,Read,Bash(curl:*),Glob,Grep` | Comma-separated tools the agent can use |
| `--agent-timeout <ms>` | 600000 (10 min) | Wall-clock timeout per agent in ms |
| `--max-retries <n>` | 2 | Max retry attempts before the watcher skips a task |

## Server API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | SSE stream (task_created, task_updated, task_deleted) |
| `GET` | `/api/tasks` | List all tasks |
| `POST` | `/api/tasks` | Create a task (used by extension) |
| `GET` | `/api/tasks/next` | Next pending task by priority |
| `GET` | `/api/tasks/:id` | Get a single task by ID |
| `PUT` | `/api/tasks/:id` | Update a task (validates status and field allowlist) |
| `DELETE` | `/api/tasks/:id` | Delete a task (also cleans up screenshots) |
| `POST` | `/api/tasks/:id/after-screenshot` | Upload after screenshot |
| `GET` | `/api/status` | Queue summary counts |
| `GET` | `/screenshots/:file` | Serve a screenshot |

## Task Types

| Type | Description |
|------|-------------|
| **Element** | Specific element selected via click. Includes React component name, source file, line number, CSS selector, and computed styles. |
| **Region** | Rectangular area selected via click-and-drag. Includes region bounds. |
| **Page** | Entire page note. Includes the page-level React component. |

## Task Lifecycle

```
pending → in_progress → review → done
                          │
                          └──→ pending (retry with feedback, up to max-retries)
```

## How Source Detection Works

In React development builds, every DOM element has a `__reactFiber$` property. The extension walks up the fiber tree to find `_debugSource`, which contains the exact source file path and line number. This means:

- **No configuration needed** — no route-to-file mapping
- **Works with any React app** — Create React App, Vite, Next.js, Nuxt, etc.
- **Element-level precision** — click a button, get `Button.tsx:15`
- **Page-level detection** — the highest user component in the tree is captured as the page file

This only works in development mode. Production builds strip `_debugSource`.

## Configuration

After running `init`, edit `.review/config.json` in your project:

```json
{
  "serverPort": 4173,
  "projectRoot": "/absolute/path/to/your/project"
}
```

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Lint
npm run lint

# Run tests
npm test

# Build
npm run build
```

## Troubleshooting

**"Server disconnected" in side panel**
The review server isn't running. Start it with `nitpix serve --project <path>`.

**Source file shows "Unknown"**
The app isn't running in React development mode, or the clicked element is outside the React tree. Make sure your dev server is running (not a production build).

**Extension doesn't activate on the page**
The content script injects on both `http://localhost/*` and `https://localhost/*`. If your dev server uses a different host, update `host_permissions` and `content_scripts.matches` in `extension/manifest.json`.

**Tasks aren't appearing after submit**
Check the browser console (in the extension's service worker) for errors. The most common cause is the server not running or a CORS issue.

**Port already in use**
Another process is using port 4173. Either stop it or change the port in `.review/config.json`.

**Watcher can't find `claude` command**
Make sure Claude Code is installed and `claude` is in your PATH. See https://docs.anthropic.com/en/docs/claude-code.
