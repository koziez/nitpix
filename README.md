<p align="center">
  <img src="logo.jpeg" width="140" alt="Nitpix logo" />
</p>

<h1 align="center">Nitpix</h1>

<p align="center">
  <strong>Annotate UI issues in the browser. Claude Code writes the fix.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#cli-reference">CLI Reference</a> ·
  <a href="#server-api">Server API</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

Browse your React app → click an element or draw a region → describe what needs to change → Claude Code reads the task, sees the screenshot, knows the exact source file, and makes the fix.

## Quick Start

```bash
# Install globally from GitHub
npm install -g github:koziez/nitpix

# Initialize your React project
nitpix init /path/to/your/react-project

# Start the server + watcher
nitpix start --project /path/to/your/react-project
```

### Install the Chrome Extension

```bash
nitpix extension
```

This prints the path to the extension folder. Then:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select the printed path

> [!NOTE]
> **Prerequisites:** Node.js 18+, Google Chrome, a React app running in dev mode on localhost, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## How It Works

```
  Chrome Extension             Express Server (:4173)          Claude Code
  ┌────────────────┐          ┌────────────────────┐         ┌────────────┐
  │  Content Script │──POST──▶│  REST API           │         │            │
  │  · element pick │          │  · queue.json       │──SSE──▶│  watch     │
  │  · region draw  │          │  · screenshots      │         │  (auto)    │
  │  · fiber inspect│          │                    │         │            │
  │                │          │                    │         │  /nitpix   │
  │  Side Panel    │◀──SSE───│  /api/events        │         │  (manual)  │
  │  · task queue  │          │                    │◀──PUT───│            │
  │  · review/retry│          │                    │         │  marks     │
  └────────────────┘          └────────────────────┘         │  "review"  │
                                                              └────────────┘
```

**The extension captures everything the agent needs:** a screenshot of the page, the React component name and source file (via fiber inspection), computed CSS styles, and your description of the issue.

### Task Lifecycle

```
pending ──▶ in_progress ──▶ review ──▶ done
                              │
                              └──▶ pending (retry with feedback)
```

Tasks move to **review** after the agent makes changes — not straight to done. You review the result in the side panel and either **accept** or **retry** with a follow-up note. On retry, the previous attempt is preserved so the agent doesn't repeat the same mistake.

## Usage

### Annotating Issues

With your React app and the review server both running:

1. **Open the side panel** — Click the Nitpix icon in your toolbar.
2. **Select an element** — Click "Select Element" (or <kbd>Cmd+Shift+S</kbd>). Hover to highlight, click to select.
3. **Select a region** — Click "Select Region" (or <kbd>Cmd+Shift+E</kbd>). Click and drag a rectangle.
4. **Write your note** — Describe what needs to change, pick a category and priority, then submit.
5. **Page-wide note** — Click "Page Note" for issues that aren't tied to a specific element.

### Processing Tasks

**Automatic** — The watcher auto-dispatches a Claude Code agent for each new task:

```bash
nitpix watch --project /path/to/your/react-project
```

> [!WARNING]
> The watcher spawns Claude Code agents with `--allowedTools`, bypassing normal permission prompts. The agent gets `Edit,Write,Read,Bash(curl:*),Glob,Grep` — full read/write access to your project files, but no arbitrary shell commands. Always commit your work before running the watcher, and review changes with `git diff` afterward.

**Manual** — Run `/nitpix` inside Claude Code to fetch and process one task at a time with standard permission prompts.

### Reviewing Results

Expand a task in the side panel to see the original screenshot, agent notes, and files modified. Then:

- **Accept** — marks the task as done
- **Retry** — captures an "after" screenshot, prompts for a follow-up note, and sends the task back to pending

## React Source Detection

The extension walks React's `__reactFiber$` → `_debugSource` to find source files automatically.

- **Zero config** — no route-to-file mapping needed
- **Any React framework** — CRA, Vite, Next.js, Remix, etc.
- **Element precision** — click a button, get `Button.tsx:15`
- **Page detection** — captures the highest user component in the tree

> [!NOTE]
> Only works in development mode. Production builds strip `_debugSource`.

## CLI Reference

| Command | Description |
|---------|-------------|
| `nitpix init <path>` | Set up `.review/` dir and `/nitpix` skill in a project |
| `nitpix start [--project <path>]` | Start server + watcher together |
| `nitpix serve [--project <path>]` | Start the review server only (port 4173) |
| `nitpix watch [--project <path>]` | Watch for tasks and auto-dispatch agents |
| `nitpix extension` | Print Chrome extension install path |
| `nitpix queue-next [--project <path>]` | Print next pending task as JSON |
| `nitpix queue-update <id> '<json>'` | Update a task by ID |

<details>
<summary><strong>Watch / Start options</strong></summary>

| Flag | Default | Description |
|------|---------|-------------|
| `--project <path>` | current dir | Path to the project with `.review/` |
| `--max-turns <n>` | 25 | Max agent turns per task |
| `--allowed-tools <tools>` | `Edit,Write,Read,Bash(curl:*),Glob,Grep` | Comma-separated tools the agent can use |
| `--agent-timeout <ms>` | 600000 (10 min) | Timeout per agent |
| `--max-retries <n>` | 2 | Max retries before the watcher skips a task |

</details>

## Server API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | SSE stream (`task_created`, `task_updated`, `task_deleted`) |
| `GET` | `/api/tasks` | List all tasks |
| `POST` | `/api/tasks` | Create a task |
| `GET` | `/api/tasks/next` | Next pending task by priority |
| `GET` | `/api/tasks/:id` | Get a single task |
| `PUT` | `/api/tasks/:id` | Update a task |
| `DELETE` | `/api/tasks/:id` | Delete a task and its screenshots |
| `POST` | `/api/tasks/:id/after-screenshot` | Upload after screenshot |
| `GET` | `/api/status` | Queue summary counts |
| `GET` | `/screenshots/:file` | Serve a screenshot |

## Configuration

After `nitpix init`, edit `.review/config.json` in your project:

```json
{
  "serverPort": 4173,
  "projectRoot": "/absolute/path/to/your/project"
}
```

## Troubleshooting

<details>
<summary><strong>"Server disconnected" in side panel</strong></summary>

The review server isn't running. Start it with:
```bash
nitpix serve --project /path/to/your/react-project
```

</details>

<details>
<summary><strong>Source file shows "Unknown"</strong></summary>

Your app isn't running in React development mode, or the clicked element is outside the React tree. Make sure your dev server is running (not a production build).

</details>

<details>
<summary><strong>Extension doesn't activate on the page</strong></summary>

The content script injects on `http://localhost/*` and `https://localhost/*`. If your dev server uses a different host, update `host_permissions` and `content_scripts.matches` in `extension/manifest.json`.

</details>

<details>
<summary><strong>Tasks not appearing after submit</strong></summary>

Check the browser console (extension service worker) for errors. The most common cause is the server not running or a CORS mismatch.

</details>

<details>
<summary><strong>Port already in use</strong></summary>

Another process is on port 4173. Stop it, or change the port in `.review/config.json`.

</details>

<details>
<summary><strong>Watcher can't find <code>claude</code> command</strong></summary>

Make sure [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is installed and `claude` is in your PATH.

</details>

## Development

```bash
npm install          # Install dependencies
npm run typecheck    # Type-check
npm run lint         # Lint
npm test             # Run tests
npm run build        # Build
```

## License

MIT
