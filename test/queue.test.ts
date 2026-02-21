import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { QueueManager } from "../server/queue.js";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CreateTaskInput } from "../types.js";

// Minimal valid PNG base64 (8-byte header)
function testPng(): string {
  const buf = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return buf.toString("base64");
}

function testInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    url: "/test",
    note: "Fix this",
    category: "tweak",
    priority: "medium",
    type: "element",
    screenshot: testPng(),
    page: { component: "App", sourceFile: "src/App.tsx" },
    ...overrides,
  };
}

let tmpDir: string;
let queue: QueueManager;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `nitpix-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  queue = new QueueManager(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("QueueManager", () => {
  describe("read/write", () => {
    it("returns empty queue when no file exists", async () => {
      const q = await queue.read();
      expect(q.items).toEqual([]);
      expect(q.version).toBe(1);
    });

    it("recovers from corrupted queue.json using backup", async () => {
      // First addTask creates queue.json (no backup yet).
      // Second addTask backs up the 1-item queue, then writes the 2-item queue.
      const task = await queue.addTask(testInput());
      await queue.addTask(testInput());

      // Corrupt the primary file
      const queuePath = path.join(tmpDir, "queue.json");
      await writeFile(queuePath, "{{invalid json", "utf-8");

      // Read should recover from backup (contains first task)
      const q = await queue.read();
      expect(q.items.length).toBeGreaterThanOrEqual(1);
      expect(q.items[0].id).toBe(task.id);
    });

    it("returns empty queue when both primary and backup are corrupt", async () => {
      const queuePath = path.join(tmpDir, "queue.json");
      const backupPath = path.join(tmpDir, "queue.json.bak");

      await writeFile(queuePath, "corrupt", "utf-8");
      await writeFile(backupPath, "also corrupt", "utf-8");

      const q = await queue.read();
      expect(q.items).toEqual([]);
    });

    it("writes atomically via temp file", async () => {
      // Two writes needed: first creates queue.json, second creates backup
      await queue.addTask(testInput());
      await queue.addTask(testInput());

      // Verify no .tmp file left behind
      const tmpPath = path.join(tmpDir, "queue.json.tmp");
      expect(existsSync(tmpPath)).toBe(false);

      // Verify backup was created on second write
      const backupPath = path.join(tmpDir, "queue.json.bak");
      expect(existsSync(backupPath)).toBe(true);
    });
  });

  describe("addTask", () => {
    it("creates a task with correct fields", async () => {
      const task = await queue.addTask(testInput({ note: "Test note" }));

      expect(task.id).toBeTruthy();
      expect(task.note).toBe("Test note");
      expect(task.status).toBe("pending");
      expect(task.category).toBe("tweak");
      expect(task.priority).toBe("medium");
      expect(task.attempts).toEqual([]);
      expect(task.screenshotPath).toContain(".review/screenshots/");
    });

    it("saves screenshot to disk", async () => {
      const task = await queue.addTask(testInput());
      const screenshotPath = path.join(tmpDir, "screenshots", `${task.id}.png`);
      expect(existsSync(screenshotPath)).toBe(true);
    });

    it("rejects invalid base64 screenshot", async () => {
      await expect(
        queue.addTask(testInput({ screenshot: "not-a-png" }))
      ).rejects.toThrow("Invalid screenshot");
    });

    it("rejects empty screenshot", async () => {
      await expect(
        queue.addTask(testInput({ screenshot: "" }))
      ).rejects.toThrow("Invalid screenshot");
    });
  });

  describe("getTask", () => {
    it("returns task by id", async () => {
      const task = await queue.addTask(testInput());
      const found = await queue.getTask(task.id);
      expect(found?.id).toBe(task.id);
    });

    it("returns null for unknown id", async () => {
      const found = await queue.getTask("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("updateTask", () => {
    it("updates allowed fields", async () => {
      const task = await queue.addTask(testInput());
      const updated = await queue.updateTask(task.id, {
        status: "in_progress",
        agentNotes: "Working on it",
      });

      expect(updated?.status).toBe("in_progress");
      expect(updated?.agentNotes).toBe("Working on it");
    });

    it("strips disallowed fields (id, createdAt)", async () => {
      const task = await queue.addTask(testInput());
      const originalId = task.id;
      const originalCreatedAt = task.createdAt;

      const updated = await queue.updateTask(task.id, {
        id: "hacked-id",
        createdAt: "hacked-date",
        status: "review",
      } as Partial<import("../types.js").Task>);

      expect(updated?.id).toBe(originalId);
      expect(updated?.createdAt).toBe(originalCreatedAt);
      expect(updated?.status).toBe("review");
    });

    it("rejects invalid status values", async () => {
      const task = await queue.addTask(testInput());
      await expect(
        queue.updateTask(task.id, { status: "invalid" as never })
      ).rejects.toThrow("Invalid status");
    });

    it("returns null for unknown task", async () => {
      const result = await queue.updateTask("nonexistent", { status: "done" });
      expect(result).toBeNull();
    });
  });

  describe("deleteTask", () => {
    it("removes task from queue", async () => {
      const task = await queue.addTask(testInput());
      const deleted = await queue.deleteTask(task.id);
      expect(deleted).toBe(true);

      const q = await queue.read();
      expect(q.items.length).toBe(0);
    });

    it("cleans up screenshot files", async () => {
      const task = await queue.addTask(testInput());
      const screenshotPath = path.join(tmpDir, "screenshots", `${task.id}.png`);
      expect(existsSync(screenshotPath)).toBe(true);

      await queue.deleteTask(task.id);
      // Wait briefly for async cleanup
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(screenshotPath)).toBe(false);
    });

    it("returns false for unknown task", async () => {
      const deleted = await queue.deleteTask("nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("getNextPending", () => {
    it("returns highest priority pending task", async () => {
      await queue.addTask(testInput({ note: "Low", priority: "low" }));
      await queue.addTask(testInput({ note: "High", priority: "high" }));
      await queue.addTask(testInput({ note: "Medium", priority: "medium" }));

      const next = await queue.getNextPending();
      expect(next?.note).toBe("High");
    });

    it("uses FIFO order for same priority", async () => {
      const first = await queue.addTask(testInput({ note: "First" }));
      await queue.addTask(testInput({ note: "Second" }));

      const next = await queue.getNextPending();
      expect(next?.id).toBe(first.id);
    });

    it("returns null when no pending tasks", async () => {
      const task = await queue.addTask(testInput());
      await queue.updateTask(task.id, { status: "done" });

      const next = await queue.getNextPending();
      expect(next).toBeNull();
    });
  });

  describe("saveAfterScreenshot", () => {
    it("saves after screenshot and updates task", async () => {
      const task = await queue.addTask(testInput());
      const updated = await queue.saveAfterScreenshot(task.id, testPng());

      expect(updated?.afterScreenshot).toContain("-after.png");
      const filePath = path.join(tmpDir, "screenshots", `${task.id}-after.png`);
      expect(existsSync(filePath)).toBe(true);
    });

    it("rejects invalid screenshot", async () => {
      const task = await queue.addTask(testInput());
      await expect(
        queue.saveAfterScreenshot(task.id, "not-a-png")
      ).rejects.toThrow("Invalid screenshot");
    });

    it("returns null for unknown task", async () => {
      const result = await queue.saveAfterScreenshot("nonexistent", testPng());
      expect(result).toBeNull();
    });
  });

  describe("getStatus", () => {
    it("returns correct counts", async () => {
      await queue.addTask(testInput());
      const t2 = await queue.addTask(testInput());
      const t3 = await queue.addTask(testInput());
      await queue.updateTask(t2.id, { status: "in_progress" });
      await queue.updateTask(t3.id, { status: "done" });

      const status = await queue.getStatus();
      expect(status.totalItems).toBe(3);
      expect(status.pending).toBe(1);
      expect(status.inProgress).toBe(1);
      expect(status.done).toBe(1);
      expect(status.review).toBe(0);
    });
  });
});
