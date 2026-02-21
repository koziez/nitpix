import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../server/index.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Minimal valid PNG base64
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

let tmpDir: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = path.join(os.tmpdir(), `nitpix-server-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  // Use port 0 for a random available port
  server = createServer(tmpDir, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmpDir, { recursive: true, force: true });
});

async function createTask(overrides: Record<string, unknown> = {}) {
  const body = {
    url: "/test",
    note: "Fix this",
    category: "tweak",
    priority: "medium",
    type: "element",
    screenshot: testPng(),
    page: { component: "App", sourceFile: "src/App.tsx" },
    ...overrides,
  };
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

describe("Server API", () => {
  describe("GET /api/status", () => {
    it("returns queue summary", async () => {
      const res = await fetch(`${baseUrl}/api/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("totalItems");
      expect(data).toHaveProperty("pending");
    });
  });

  describe("POST /api/tasks", () => {
    it("creates a task", async () => {
      const res = await createTask();
      expect(res.status).toBe(201);
      const task = await res.json();
      expect(task.note).toBe("Fix this");
      expect(task.status).toBe("pending");
      expect(task.id).toBeTruthy();
    });

    it("rejects missing note", async () => {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: { component: "App", sourceFile: "" } }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid screenshot", async () => {
      const res = await createTask({ screenshot: "not-a-png" });
      expect(res.status).toBe(500); // propagated through error handler
    });
  });

  describe("GET /api/tasks", () => {
    it("returns all tasks", async () => {
      const res = await fetch(`${baseUrl}/api/tasks`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("items");
      expect(Array.isArray(data.items)).toBe(true);
    });
  });

  describe("GET /api/tasks/:id", () => {
    it("returns a task by id", async () => {
      const createRes = await createTask();
      const task = await createRes.json();

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`);
      expect(res.status).toBe(200);
      const found = await res.json();
      expect(found.id).toBe(task.id);
    });

    it("returns 404 for unknown id", async () => {
      const res = await fetch(`${baseUrl}/api/tasks/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/tasks/:id", () => {
    it("updates task status", async () => {
      const createRes = await createTask();
      const task = await createRes.json();

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.status).toBe("in_progress");
    });

    it("rejects invalid status", async () => {
      const createRes = await createTask();
      const task = await createRes.json();

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "invalid_status" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown task", async () => {
      const res = await fetch(`${baseUrl}/api/tasks/nonexistent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/tasks/:id", () => {
    it("deletes a task", async () => {
      const createRes = await createTask();
      const task = await createRes.json();

      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      // Verify deleted
      const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`);
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for unknown task", async () => {
      const res = await fetch(`${baseUrl}/api/tasks/nonexistent`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("CORS", () => {
    it("allows localhost origin", async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Origin: "http://localhost:3000" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:3000"
      );
    });

    it("allows chrome-extension origin", async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Origin: "chrome-extension://abc123" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "chrome-extension://abc123"
      );
    });

    it("blocks non-localhost origin", async () => {
      const res = await fetch(`${baseUrl}/api/status`, {
        headers: { Origin: "https://evil.com" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
