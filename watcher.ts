import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import type { Task, WatcherOptions } from "./types.js";

// ─── SSE Client ──────────────────────────────────────────────────

type SSEHandlers = Record<string, (data: unknown) => void>;

function connectSSE(
  url: string,
  handlers: SSEHandlers,
  onError: () => void,
  onConnect: () => void
): { close: () => void } {
  let destroyed = false;

  const req = http.get(url, (res) => {
    if (destroyed) return;
    onConnect();

    let buffer = "";
    let currentEvent = "message";

    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            handlers[currentEvent]?.(data);
          } catch {
            // ignore malformed data
          }
          currentEvent = "message";
        }
        // ":" lines are keepalive comments, ignore
      }
    });

    res.on("end", () => {
      if (!destroyed) onError();
    });
  });

  req.on("error", () => {
    if (!destroyed) onError();
  });

  return {
    close: () => {
      destroyed = true;
      req.destroy();
    },
  };
}

// ─── Prompt Builder ──────────────────────────────────────────────

function buildPrompt(task: Task, projectRoot: string, serverUrl: string): string {
  const sourceRef =
    task.type === "element" && task.element?.sourceFile
      ? `Read "${task.element.sourceFile}" around line ${task.element.sourceLine}`
      : task.type === "region"
        ? `Use the screenshot and region.rect bounds (${JSON.stringify(task.region?.rect)}) to understand the area`
        : `Read "${task.page.sourceFile}"`;

  const attemptsSection =
    task.attempts.length > 0
      ? `
## Previous Attempts (FAILED — do NOT repeat the same approach)
${task.attempts
  .map(
    (a, i) =>
      `Attempt ${i + 1}: ${a.agentNotes}
  Rejected: ${a.retryReason}${a.afterScreenshot ? `\n  After screenshot: ${projectRoot}/${a.afterScreenshot}` : ""}`
  )
  .join("\n")}`
      : "";

  return `You are an AI agent working on a UI review task in the project at: ${projectRoot}

## Task
${JSON.stringify(task, null, 2)}

## Instructions

1. Read the screenshot at "${projectRoot}/${task.screenshotPath}" to see what the developer sees.

2. ${sourceRef}
${task.element?.selector ? `   CSS selector: "${task.element.selector}"` : ""}
${task.element?.computedStyles ? `   Current computed styles: ${JSON.stringify(task.element.computedStyles)}` : ""}

3. Understand the developer's note: "${task.note}"
   Make sense of it in the context of the screenshot and source code.
${attemptsSection}

4. Make the code change. Keep it minimal and focused on exactly what the note describes.

5. After making changes, update the task status by running:
   curl -s -X PUT ${serverUrl}/api/tasks/${task.id} \\
     -H "Content-Type: application/json" \\
     -d '{"status": "review", "agentNotes": "<brief description of what you changed>", "filesModified": ["<file1>", "<file2>"]}'

IMPORTANT: Set status to "review" (not "done"). The developer will accept or retry from the browser.`;
}

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

// ─── HTTP Helpers ────────────────────────────────────────────────

async function fetchJSON(url: string, options?: { method?: string; body?: unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options?.method || "GET",
      headers: options?.body ? { "Content-Type": "application/json" } : {},
      timeout: 30000,
    };

    const req = http.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout: ${url}`));
    });

    req.on("error", reject);
    if (options?.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ─── Watch Loop ──────────────────────────────────────────────────

const DEFAULT_ALLOWED_TOOLS = "Edit,Write,Read,Bash(curl:*),Glob,Grep";
const DEFAULT_AGENT_TIMEOUT = 600000; // 10 minutes
const DEFAULT_MAX_RETRIES = 2;

export function startWatcher(options: WatcherOptions): { stop: () => void } {
  const {
    serverUrl,
    projectRoot,
    maxTurns,
    allowedTools = DEFAULT_ALLOWED_TOOLS,
    agentTimeout = DEFAULT_AGENT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  let pendingQueue: string[] = [];
  let processing = false;
  let currentProcess: ChildProcess | null = null;
  let currentTaskId: string | null = null;
  let sseConnection: { close: () => void } | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // ── Logging helpers ──

  function log(msg: string) {
    console.log(`  ${msg}`);
  }

  function logTask(task: Task) {
    const source =
      task.type === "element" && task.element?.sourceFile
        ? `${task.element.component} — ${task.element.sourceFile}:${task.element.sourceLine}`
        : task.page.sourceFile
          ? `${task.page.component} — ${task.page.sourceFile}`
          : task.url;

    console.log();
    console.log(`  ─── Task ${task.id.slice(0, 8)} ── [${task.priority}] [${task.category}] ───`);
    console.log(`  "${task.note}"`);
    console.log(`  ${source}`);
    console.log(`  ${"─".repeat(54)}`);
    console.log();
  }

  // ── Queue management ──

  function enqueue(taskId: string) {
    if (!pendingQueue.includes(taskId) && taskId !== currentTaskId) {
      pendingQueue.push(taskId);
      kickProcessing();
    }
  }

  async function kickProcessing() {
    if (processing || stopped || pendingQueue.length === 0) return;
    processing = true;

    try {
      // Always fetch the highest-priority pending task from the server
      // rather than trusting our local queue order
      const task = (await fetchJSON(`${serverUrl}/api/tasks/next`)) as Task | null;
      if (!task) {
        pendingQueue = [];
        log("Watching for tasks... (0 pending)");
        return;
      }

      // Check max retries — skip tasks that have exceeded the limit
      if (maxRetries > 0 && task.attempts.length >= maxRetries) {
        log(
          `Task ${task.id.slice(0, 8)} has reached max retries (${maxRetries}). Skipping.`
        );
        pendingQueue = pendingQueue.filter((id) => id !== task.id);
        return;
      }

      // Remove this task from our queue
      pendingQueue = pendingQueue.filter((id) => id !== task.id);

      await processTask(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Error fetching next task: ${msg}`);
      // Retry after a delay
      setTimeout(() => kickProcessing(), 5000);
      return;
    } finally {
      processing = false;
    }

    if (!stopped) {
      if (pendingQueue.length > 0) {
        kickProcessing();
      } else {
        log(`Watching for tasks... (0 pending)`);
      }
    }
  }

  // ── Task processing ──

  async function processTask(task: Task): Promise<void> {
    currentTaskId = task.id;
    logTask(task);

    // Claim the task
    try {
      await fetchJSON(`${serverUrl}/api/tasks/${task.id}`, {
        method: "PUT",
        body: { status: "in_progress" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to claim task: ${msg}`);
      currentTaskId = null;
      return;
    }

    // Build prompt and spawn agent
    const prompt = buildPrompt(task, projectRoot, serverUrl);
    const startTime = Date.now();

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
        child.stdout.on("end", () => {
          if (stdoutBuffer.trim()) {
            try {
              const event = JSON.parse(stdoutBuffer) as StreamEvent;
              const activities = extractActivities(event);
              for (const activity of activities) {
                log(`[agent] ${activity.summary}`);
                fetchJSON(`${serverUrl}/api/tasks/${task.id}/activity`, {
                  method: "POST",
                  body: activity,
                }).catch(() => {});
              }
            } catch {
              console.log(`  [agent] ${stdoutBuffer}`);
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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // Check task status after agent finishes
    try {
      const updated = (await fetchJSON(
        `${serverUrl}/api/tasks/${task.id}`
      )) as Task;

      if (updated.status === "review") {
        log(`Task ${task.id.slice(0, 8)} → review (${elapsed}s)`);
        if (updated.agentNotes) {
          log(`Agent notes: ${updated.agentNotes}`);
        }
      } else if (updated.status === "in_progress") {
        // Agent crashed without updating status — reset to pending
        log(`Agent exited (code ${exitCode}) without updating task. Resetting to pending.`);
        await fetchJSON(`${serverUrl}/api/tasks/${task.id}`, {
          method: "PUT",
          body: { status: "pending" },
        });
      } else {
        log(`Task ${task.id.slice(0, 8)} → ${updated.status} (${elapsed}s)`);
      }
    } catch {
      log(`Could not verify task status after agent exit.`);
    }

    console.log();
    currentTaskId = null;
  }

  // ── SSE connection ──

  let reconnectDelay = 1000;

  function connect() {
    if (stopped) return;

    sseConnection = connectSSE(
      `${serverUrl}/api/events`,
      {
        task_created: (data) => {
          const task = data as Task;
          enqueue(task.id);
        },
        task_updated: (data) => {
          const task = data as Task;
          if (task.status === "pending") {
            enqueue(task.id);
          }
        },
        task_deleted: (data) => {
          const { id } = data as { id: string };
          pendingQueue = pendingQueue.filter((qid) => qid !== id);
        },
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
      },
      () => {
        // On disconnect — reconnect with backoff
        if (stopped) return;
        log(`SSE disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          syncAndReconnect();
        }, reconnectDelay);
      },
      () => {
        // On connect
        reconnectDelay = 1000;
      }
    );
  }

  async function syncAndReconnect() {
    if (stopped) return;
    try {
      const queue = (await fetchJSON(`${serverUrl}/api/tasks`)) as {
        items: Task[];
      };
      const pending = queue.items.filter((t) => t.status === "pending");
      for (const task of pending) {
        enqueue(task.id);
      }
    } catch {
      // Will retry on next reconnect
    }
    connect();
  }

  // ── Startup ──

  async function init() {
    // Verify server is reachable
    try {
      await fetchJSON(`${serverUrl}/api/status`);
    } catch {
      console.error(`\n  Error: Cannot reach server at ${serverUrl}`);
      console.error(`  Start the server first: nitpix serve\n`);
      process.exit(1);
    }

    console.log();
    console.log("  Nitpix Watcher");
    console.log(`  Project: ${projectRoot}`);
    console.log(`  Server:  ${serverUrl}`);
    if (agentTimeout > 0) {
      console.log(`  Timeout: ${Math.round(agentTimeout / 1000)}s`);
    }
    if (maxRetries > 0) {
      console.log(`  Max retries: ${maxRetries}`);
    }
    console.log();
    console.log("  ⚠  DANGEROUS MODE — The agent runs with --allowedTools and can");
    console.log(`     edit/write/delete files in your project without confirmation.`);
    console.log(`     Allowed tools: ${allowedTools}`);
    console.log(`     Review changes with git diff after tasks complete.`);
    console.log();

    // Fetch existing pending tasks
    try {
      const queue = (await fetchJSON(`${serverUrl}/api/tasks`)) as {
        items: Task[];
      };
      const pending = queue.items.filter((t) => t.status === "pending");
      for (const task of pending) {
        pendingQueue.push(task.id);
      }
      log(`Watching for tasks... (${pendingQueue.length} pending)`);
    } catch {
      log("Watching for tasks...");
    }

    // Connect to SSE
    connect();

    // Start processing if there are pending tasks
    if (pendingQueue.length > 0) {
      kickProcessing();
    }
  }

  init();

  // ── Shutdown ──

  return {
    stop: async () => {
      stopped = true;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sseConnection) sseConnection.close();

      if (currentProcess) {
        currentProcess.kill("SIGTERM");
        // Give it a moment to exit
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (currentProcess) currentProcess.kill("SIGKILL");
            resolve();
          }, 5000);
          currentProcess!.on("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }

      // Reset current task if still in_progress
      if (currentTaskId) {
        try {
          const task = (await fetchJSON(
            `${serverUrl}/api/tasks/${currentTaskId}`
          )) as Task;
          if (task.status === "in_progress") {
            await fetchJSON(`${serverUrl}/api/tasks/${currentTaskId}`, {
              method: "PUT",
              body: { status: "pending" },
            });
            log(`Reset task ${currentTaskId.slice(0, 8)} to pending.`);
          }
        } catch {
          // Best effort
        }
      }
    },
  };
}
