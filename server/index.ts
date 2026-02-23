import express from "express";
import type { Task, CreateTaskInput, ActivityEntry } from "../types.js";
import { QueueManager, VALID_STATUSES, VALID_ACTIVITY_TYPES } from "./queue.js";

type AsyncHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<void>;

function asyncHandler(fn: AsyncHandler) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Allow no-origin requests (curl, server-to-server)
  if (origin.startsWith("chrome-extension://")) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function createServer(reviewDir: string, port: number) {
  const app = express();
  const queue = new QueueManager(reviewDir);

  app.use(express.json({ limit: "50mb" }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(`  ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  // CORS — restrict to localhost and Chrome extensions
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
      res.header("Access-Control-Allow-Origin", origin || "*");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Serve screenshot files
  app.use("/screenshots", express.static(queue.getScreenshotsDir()));

  // --- SSE ---

  const sseClients: Set<express.Response> = new Set();
  const taskActivity: Map<string, ActivityEntry[]> = new Map();

  function broadcast(event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(msg);
    }
  }

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Send initial keepalive
    res.write(":\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  // --- Task endpoints ---
  // NOTE: /api/tasks/next must be defined before /api/tasks/:id
  // so "next" is not matched as an :id parameter.

  app.get(
    "/api/tasks",
    asyncHandler(async (_req, res) => {
      const data = await queue.read();
      res.json(data);
    })
  );

  app.get(
    "/api/tasks/next",
    asyncHandler(async (_req, res) => {
      const task = await queue.getNextPending();
      res.json(task ?? null);
    })
  );

  app.get(
    "/api/tasks/:id",
    asyncHandler(async (req, res) => {
      const task = await queue.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      res.json(task);
    })
  );

  app.post(
    "/api/tasks",
    asyncHandler(async (req, res) => {
      const input = req.body as CreateTaskInput;
      if (!input.note || !input.page) {
        res.status(400).json({ error: "note and page are required" });
        return;
      }
      const task = await queue.addTask(input);
      broadcast("task_created", task);
      res.status(201).json(task);
    })
  );

  app.put(
    "/api/tasks/:id",
    asyncHandler(async (req, res) => {
      const updates = req.body as Partial<Task>;

      // Validate status if provided
      if (updates.status !== undefined && !VALID_STATUSES.has(updates.status)) {
        res.status(400).json({
          error: `Invalid status: ${updates.status}. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
        });
        return;
      }

      const task = await queue.updateTask(req.params.id, updates);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      broadcast("task_updated", task);
      if (task.status !== "in_progress") {
        taskActivity.delete(req.params.id);
      }
      res.json(task);
    })
  );

  app.delete(
    "/api/tasks/:id",
    asyncHandler(async (req, res) => {
      const deleted = await queue.deleteTask(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      taskActivity.delete(req.params.id);
      broadcast("task_deleted", { id: req.params.id });
      res.json({ ok: true });
    })
  );

  // --- After Screenshot endpoint ---

  app.post(
    "/api/tasks/:id/after-screenshot",
    asyncHandler(async (req, res) => {
      const { screenshot } = req.body as { screenshot: string };
      if (!screenshot) {
        res.status(400).json({ error: "screenshot is required" });
        return;
      }
      const task = await queue.saveAfterScreenshot(req.params.id, screenshot);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      broadcast("task_updated", task);
      res.json(task);
    })
  );

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
      if (!type || !VALID_ACTIVITY_TYPES.has(type)) {
        res.status(400).json({
          error: `Invalid activity type: ${type}. Must be one of: ${[...VALID_ACTIVITY_TYPES].join(", ")}`,
        });
        return;
      }
      const entry: ActivityEntry = {
        timestamp: new Date().toISOString(),
        type: type as ActivityEntry["type"],
        summary: summary || "",
      };
      const entries = taskActivity.get(req.params.id) ?? [];
      entries.push(entry);
      taskActivity.set(req.params.id, entries);
      broadcast("task_activity", { taskId: req.params.id, entry });
      res.json({ entries });
    })
  );

  app.get(
    "/api/tasks/:id/activity",
    asyncHandler(async (req, res) => {
      const task = await queue.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      const entries = taskActivity.get(req.params.id) ?? [];
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

  // --- Status endpoint ---

  app.get(
    "/api/status",
    asyncHandler(async (_req, res) => {
      const status = await queue.getStatus();
      res.json(status);
    })
  );

  // --- Global error handler ---

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error(`  Server error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  );

  // Start server with error handling
  const server = app.listen(port, () => {
    console.log(`Nitpix server running at http://localhost:${port}`);
    console.log(`  Review dir: ${reviewDir}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  Error: Port ${port} is already in use.`);
      console.error(
        `  Either stop the other process or change the port in .review/config.json\n`
      );
    } else {
      console.error(`\n  Server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  return server;
}
