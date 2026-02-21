import { readFile, writeFile, mkdir, rename, copyFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Queue, Task, CreateTaskInput } from "../types.js";

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export const VALID_STATUSES = new Set(["pending", "in_progress", "review", "done"]);

const VALID_UPDATE_FIELDS = new Set([
  "status",
  "agentNotes",
  "filesModified",
  "afterScreenshot",
  "attempts",
  "note",
  "category",
  "priority",
]);

function emptyQueue(): Queue {
  return { version: 1, lastUpdated: new Date().toISOString(), items: [] };
}

function isValidPngBase64(data: string): boolean {
  if (!data || data.length < 16) return false;
  try {
    const buf = Buffer.from(data.slice(0, 16), "base64");
    // PNG magic bytes: 89 50 4E 47
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  } catch {
    return false;
  }
}

export class QueueManager {
  private queuePath: string;
  private backupPath: string;
  private screenshotsDir: string;

  constructor(private reviewDir: string) {
    this.queuePath = path.join(reviewDir, "queue.json");
    this.backupPath = path.join(reviewDir, "queue.json.bak");
    this.screenshotsDir = path.join(reviewDir, "screenshots");
  }

  async ensureDirs(): Promise<void> {
    if (!existsSync(this.reviewDir)) {
      await mkdir(this.reviewDir, { recursive: true });
    }
    if (!existsSync(this.screenshotsDir)) {
      await mkdir(this.screenshotsDir, { recursive: true });
    }
  }

  async read(): Promise<Queue> {
    try {
      const data = await readFile(this.queuePath, "utf-8");
      return JSON.parse(data) as Queue;
    } catch {
      // If primary file failed, try backup
      if (existsSync(this.backupPath)) {
        try {
          const backup = await readFile(this.backupPath, "utf-8");
          const queue = JSON.parse(backup) as Queue;
          console.warn("Warning: queue.json was corrupted, recovered from backup.");
          await writeFile(this.queuePath, backup, "utf-8");
          return queue;
        } catch {
          // Backup also corrupt
        }
      }
      // No file exists yet (first run) — return empty queue
      if (!existsSync(this.queuePath)) {
        return emptyQueue();
      }
      // File exists but is corrupt with no valid backup
      console.error(
        "Error: queue.json is corrupted and no valid backup exists. Starting with empty queue."
      );
      return emptyQueue();
    }
  }

  private async write(queue: Queue): Promise<void> {
    queue.lastUpdated = new Date().toISOString();
    const data = JSON.stringify(queue, null, 2);

    // Backup existing file before write
    if (existsSync(this.queuePath)) {
      try {
        await copyFile(this.queuePath, this.backupPath);
      } catch {
        // Best effort backup
      }
    }

    // Atomic write: write to temp file, then rename
    const tmpPath = this.queuePath + ".tmp";
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, this.queuePath);
  }

  async addTask(input: CreateTaskInput): Promise<Task> {
    await this.ensureDirs();

    if (!isValidPngBase64(input.screenshot)) {
      throw new Error("Invalid screenshot: not a valid base64-encoded PNG");
    }

    const queue = await this.read();

    const id = randomUUID();
    const now = new Date().toISOString();

    // Save screenshot to disk
    const screenshotFilename = `${id}.png`;
    const screenshotDiskPath = path.join(this.screenshotsDir, screenshotFilename);
    const screenshotBuffer = Buffer.from(input.screenshot, "base64");
    await writeFile(screenshotDiskPath, screenshotBuffer);

    const task: Task = {
      id,
      createdAt: now,
      updatedAt: now,
      url: input.url,
      type: input.type,
      note: input.note,
      category: input.category,
      priority: input.priority,
      status: "pending",
      screenshotPath: `.review/screenshots/${screenshotFilename}`,
      element: input.element ?? null,
      page: input.page,
      region: input.region ?? null,
      agentNotes: "",
      filesModified: [],
      afterScreenshot: null,
      attempts: [],
    };

    queue.items.push(task);
    await this.write(queue);
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const queue = await this.read();
    return queue.items.find((t) => t.id === id) ?? null;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const queue = await this.read();
    const index = queue.items.findIndex((t) => t.id === id);
    if (index === -1) return null;

    const task = queue.items[index];

    // Filter to only allowed fields
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (VALID_UPDATE_FIELDS.has(key)) {
        filtered[key] = value;
      }
    }

    // Validate status if provided
    if (filtered.status !== undefined && !VALID_STATUSES.has(filtered.status as string)) {
      throw new Error(
        `Invalid status: ${filtered.status}. Must be one of: ${[...VALID_STATUSES].join(", ")}`
      );
    }

    Object.assign(task, filtered, { updatedAt: new Date().toISOString() });
    await this.write(queue);
    return task;
  }

  async deleteTask(id: string): Promise<boolean> {
    const queue = await this.read();
    const task = queue.items.find((t) => t.id === id);
    if (!task) return false;

    queue.items = queue.items.filter((t) => t.id !== id);
    await this.write(queue);

    // Clean up screenshot files in background
    this.cleanupScreenshots(id).catch(() => {});

    return true;
  }

  private async cleanupScreenshots(taskId: string): Promise<void> {
    const files = [`${taskId}.png`, `${taskId}-after.png`];
    for (const file of files) {
      const filePath = path.join(this.screenshotsDir, file);
      try {
        await unlink(filePath);
      } catch {
        // File may not exist
      }
    }
  }

  async getNextPending(): Promise<Task | null> {
    const queue = await this.read();
    const pending = queue.items
      .filter((t) => t.status === "pending")
      .sort((a, b) => {
        const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (pd !== 0) return pd;
        // Secondary sort: oldest first (FIFO)
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    return pending[0] ?? null;
  }

  async saveAfterScreenshot(id: string, screenshotBase64: string): Promise<Task | null> {
    await this.ensureDirs();

    if (!isValidPngBase64(screenshotBase64)) {
      throw new Error("Invalid screenshot: not a valid base64-encoded PNG");
    }

    const queue = await this.read();
    const task = queue.items.find((t) => t.id === id);
    if (!task) return null;

    const filename = `${id}-after.png`;
    const diskPath = path.join(this.screenshotsDir, filename);
    await writeFile(diskPath, Buffer.from(screenshotBase64, "base64"));

    task.afterScreenshot = `.review/screenshots/${filename}`;
    task.updatedAt = new Date().toISOString();
    await this.write(queue);
    return task;
  }

  async getStatus(): Promise<{
    totalItems: number;
    pending: number;
    inProgress: number;
    review: number;
    done: number;
  }> {
    const queue = await this.read();
    return {
      totalItems: queue.items.length,
      pending: queue.items.filter((t) => t.status === "pending").length,
      inProgress: queue.items.filter((t) => t.status === "in_progress").length,
      review: queue.items.filter((t) => t.status === "review").length,
      done: queue.items.filter((t) => t.status === "done").length,
    };
  }

  getScreenshotsDir(): string {
    return this.screenshotsDir;
  }
}
