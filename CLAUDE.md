# Nitpix

A Chrome extension + local Express server for annotating UI issues in React apps. Creates structured tasks that Claude Code can process via `/nitpix` skill or the `nitpix watch` auto-dispatch mode.

## Project Structure

```
nitpix/
├── cli.ts                 # CLI entry point (init, serve, watch, extension, queue-*)
├── watcher.ts             # Auto-dispatch: SSE listener + claude -p spawner
├── types.ts               # Shared TypeScript interfaces (Task, Queue, etc.)
├── server/
│   ├── index.ts           # Express server: REST API, SSE broadcasting, CORS
│   └── queue.ts           # QueueManager: JSON file I/O, screenshots, priority sorting
├── extension/
│   ├── manifest.json      # Chrome Manifest V3
│   ├── content.js         # Content script: element/region selection, React fiber inspection
│   ├── background.js      # Service worker: screenshot capture, message routing
│   ├── sidepanel.html/js/css  # Side panel: task queue, review/accept/retry UI
│   └── icons/
├── skill/
│   └── nitpix/SKILL.md    # Claude Code skill prompt (copied to target project by init)
├── test/
│   ├── queue.test.ts      # QueueManager unit tests
│   └── server.test.ts     # Express API integration tests
├── eslint.config.js       # ESLint flat config
├── .github/workflows/ci.yml  # CI pipeline (typecheck + lint + test)
└── dist/                  # Compiled JS output (tsc)
```

## Key Conventions

- **Single runtime dependency**: express. No additional npm packages.
- **Chrome extension**: Vanilla JS only, no build step. Uses `el()` DOM helper for safe element creation — never use `innerHTML`.
- **TypeScript**: Strict mode, ES2022 target, NodeNext modules. Build with `npm run build` (tsc).
- **Server port**: 4173 by default, configurable in `.review/config.json`.
- **Task status flow**: `pending` → `in_progress` → `review` → `done` (or back to `pending` on retry, up to `maxRetries`).
- **Status validation**: Task status updates are validated against the set `{pending, in_progress, review, done}`. Only an allowlisted set of task fields can be updated via PUT.
- **SSE over polling**: Side panel and watcher connect to `GET /api/events` for real-time updates.
- **CORS**: Restricted to `localhost`, `127.0.0.1`, and `chrome-extension://` origins.

## Architecture

- **Extension → Server**: Content script sends task data to background.js, which captures a screenshot and POSTs to the Express API.
- **Server → Extension**: SSE broadcasts (`task_created`, `task_updated`, `task_deleted`) keep the side panel in sync.
- **Server → Watcher**: Same SSE stream triggers auto-dispatch of `claude -p` agents.
- **Agent → Server**: The agent (whether manual `/nitpix` or auto-dispatched) updates task status via `PUT /api/tasks/:id`.

## Important Patterns

- **React fiber inspection**: `content.js` walks `__reactFiber$` → `_debugSource` to find source files. Checks `#root`, `#app`, `#__next`, `#__nuxt`, and `[data-reactroot]`. Only works in React dev mode.
- **Computed styles**: Element selections capture a curated subset of CSS properties (font, color, layout, spacing) via `getComputedStyle`, skipping default values.
- **Attempt history**: When a task is retried, the previous attempt (agent notes, files modified, retry reason, after screenshot) is preserved in the `attempts` array so the agent doesn't repeat the same mistake.
- **Package root detection**: `cli.ts` uses `getPackageRoot()` which walks up from `import.meta.url` to find `package.json`, so it works whether run from source or from `dist/`.
- **Async error handling**: All Express route handlers use an `asyncHandler` wrapper to properly propagate async errors to the global error handler.
- **Queue corruption protection**: `queue.ts` backs up `queue.json` before every write and uses atomic writes (temp file + rename). On read failure, it attempts recovery from backup.
- **Screenshot validation**: Base64 screenshot data is validated for PNG magic bytes before writing to disk.
- **Screenshot cleanup**: Deleting a task also removes its screenshot files from disk.
- **Agent timeout**: The watcher kills agent processes after a configurable timeout (default 10 min).
- **Crash loop protection**: The watcher tracks consecutive agent crashes (exits without updating status) per task. After 2 crashes (configurable via `--max-crashes`), it halts auto-dispatch for that task. The counter resets when a human retries the task from the side panel.
- **Delete undo toast**: Side panel shows a 3-second undo toast before actually sending the DELETE request.

## Common Tasks

**Build**: `npm run build`
**Type-check**: `npm run typecheck`
**Lint**: `npm run lint`
**Test**: `npm test`
**Run server**: `nitpix serve --project <path>` or `npm run serve`
**Run watcher**: `nitpix watch --project <path>`
**Test changes to extension**: Reload the extension at `chrome://extensions` after modifying files in `extension/`.
