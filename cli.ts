#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { createServer } from "./server/index.js";
import { QueueManager } from "./server/queue.js";
import { startWatcher } from "./watcher.js";
import type { ReviewConfig } from "./types.js";

const DEFAULT_PORT = 4173;

function getPackageRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function usage() {
  console.log(`Usage: nitpix <command> [options]

Commands:
  init <project-path>                   Set up .review/ dir and Claude Code skill in target project
  start [--project <path>]              Start server + watcher together (recommended)
  serve [--project <path>]              Start the review server only
  watch [--project <path>]              Start the watcher only (requires server running separately)
  extension                             Show Chrome extension install path
  queue-next [--project <path>]         Print next pending task as JSON
  queue-update <id> <json> [--project <path>]  Update a task

Watch/Start Options:
  --max-turns <n>                       Max agent turns per task (default: 25)
  --allowed-tools <tools>               Comma-separated tools for the agent
  --agent-timeout <ms>                  Agent timeout in ms (default: 600000 = 10 min)
  --max-retries <n>                     Max retry attempts per task (default: 2)

WARNING: watch/start runs agents in dangerous mode (--allowedTools). The agent
can read, write, and delete files in your project without confirmation prompts.
Commit your work before running and review changes with git diff afterward.
`);
}

function resolveReviewDir(args: string[]): string {
  const projectIdx = args.indexOf("--project");
  if (projectIdx !== -1 && args[projectIdx + 1]) {
    return path.join(path.resolve(args[projectIdx + 1]), ".review");
  }
  return path.join(process.cwd(), ".review");
}

async function resolvePort(reviewDir: string): Promise<number> {
  const configPath = path.join(reviewDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(
        await readFile(configPath, "utf-8")
      ) as ReviewConfig;
      return config.serverPort || DEFAULT_PORT;
    } catch {
      // fall through
    }
  }
  return DEFAULT_PORT;
}

function parseIntArg(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return fallback;
  const val = parseInt(args[idx + 1], 10);
  if (isNaN(val)) {
    console.error(`Invalid value for ${flag}: ${args[idx + 1]}`);
    process.exit(1);
  }
  return val;
}

function parseStringArg(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return fallback;
  return args[idx + 1];
}

async function cmdInit(projectPath: string) {
  const absProject = path.resolve(projectPath);
  if (!existsSync(absProject)) {
    console.error(`Project path does not exist: ${absProject}`);
    process.exit(1);
  }

  const reviewDir = path.join(absProject, ".review");
  const screenshotsDir = path.join(reviewDir, "screenshots");

  // Create .review/ structure
  await mkdir(screenshotsDir, { recursive: true });

  // Write template config
  const configPath = path.join(reviewDir, "config.json");
  if (!existsSync(configPath)) {
    const config: ReviewConfig = {
      serverPort: DEFAULT_PORT,
      projectRoot: absProject,
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.log(`  Created ${configPath}`);
  }

  // Write empty queue
  const queuePath = path.join(reviewDir, "queue.json");
  if (!existsSync(queuePath)) {
    await writeFile(
      queuePath,
      JSON.stringify({ version: 1, lastUpdated: new Date().toISOString(), items: [] }, null, 2),
      "utf-8"
    );
    console.log(`  Created ${queuePath}`);
  }

  // Copy skill to .claude/skills/nitpix/SKILL.md
  const skillSrc = path.join(getPackageRoot(), "skill", "nitpix", "SKILL.md");
  const skillDir = path.join(absProject, ".claude", "skills", "nitpix");
  const skillDest = path.join(skillDir, "SKILL.md");

  if (existsSync(skillSrc)) {
    await mkdir(skillDir, { recursive: true });
    await copyFile(skillSrc, skillDest);
    console.log(`  Copied skill to ${skillDest}`);
  } else {
    console.log(`  Skill file not found at ${skillSrc}, skipping`);
  }

  // Update .gitignore
  const gitignorePath = path.join(absProject, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (!content.includes(".review/")) {
      await writeFile(gitignorePath, content.trimEnd() + "\n.review/\n", "utf-8");
      console.log(`  Added .review/ to .gitignore`);
    }
  } else {
    await writeFile(gitignorePath, ".review/\n", "utf-8");
    console.log(`  Created .gitignore with .review/`);
  }

  console.log(`\nInitialized Nitpix in ${absProject}`);
  console.log(`Start the server with: nitpix serve --project ${projectPath}`);
}

function cmdExtension() {
  const extPath = path.join(getPackageRoot(), "extension");
  console.log(`Chrome extension location:
  ${extPath}

To install:
  1. Open chrome://extensions
  2. Enable "Developer mode" (top right toggle)
  3. Click "Load unpacked"
  4. Select the folder above
`);
}

async function cmdServe(args: string[]) {
  const reviewDir = resolveReviewDir(args);
  if (!existsSync(reviewDir)) {
    console.error(`No .review/ directory found at ${reviewDir}`);
    console.error(`Run: nitpix init <project-path>`);
    process.exit(1);
  }

  const port = await resolvePort(reviewDir);
  createServer(reviewDir, port);
}

async function cmdQueueNext(args: string[]) {
  const reviewDir = resolveReviewDir(args);
  const queue = new QueueManager(reviewDir);
  const task = await queue.getNextPending();
  console.log(JSON.stringify(task, null, 2));
}

async function cmdQueueUpdate(id: string, jsonStr: string, args: string[]) {
  const reviewDir = resolveReviewDir(args);
  const queue = new QueueManager(reviewDir);

  let updates: Record<string, unknown>;
  try {
    updates = JSON.parse(jsonStr);
  } catch {
    console.error("Invalid JSON:", jsonStr);
    process.exit(1);
  }

  const task = await queue.updateTask(id, updates);
  if (!task) {
    console.error(`Task not found: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(task, null, 2));
}

async function cmdStart(args: string[]) {
  const reviewDir = resolveReviewDir(args);
  if (!existsSync(reviewDir)) {
    console.error(`No .review/ directory found at ${reviewDir}`);
    console.error(`Run: nitpix init <project-path>`);
    process.exit(1);
  }

  const configPath = path.join(reviewDir, "config.json");
  if (!existsSync(configPath)) {
    console.error(`No config.json found in ${reviewDir}`);
    process.exit(1);
  }

  const config = JSON.parse(
    await readFile(configPath, "utf-8")
  ) as ReviewConfig;

  const port = config.serverPort || DEFAULT_PORT;
  const maxTurns = parseIntArg(args, "--max-turns", 25);
  const allowedTools = parseStringArg(
    args,
    "--allowed-tools",
    "Edit,Write,Read,Bash(curl:*),Glob,Grep"
  );
  const agentTimeout = parseIntArg(args, "--agent-timeout", 600000);
  const maxRetries = parseIntArg(args, "--max-retries", 2);

  // Start server first
  createServer(reviewDir, port);

  const serverUrl = `http://localhost:${port}`;
  const watcher = startWatcher({
    serverUrl,
    projectRoot: config.projectRoot,
    maxTurns,
    allowedTools,
    agentTimeout,
    maxRetries,
  });

  process.on("SIGINT", async () => {
    console.log("\n  Shutting down...");
    await watcher.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await watcher.stop();
    process.exit(0);
  });
}

async function cmdWatch(args: string[]) {
  const reviewDir = resolveReviewDir(args);
  if (!existsSync(reviewDir)) {
    console.error(`No .review/ directory found at ${reviewDir}`);
    console.error(`Run: nitpix init <project-path>`);
    process.exit(1);
  }

  const configPath = path.join(reviewDir, "config.json");
  if (!existsSync(configPath)) {
    console.error(`No config.json found in ${reviewDir}`);
    process.exit(1);
  }

  const config = JSON.parse(
    await readFile(configPath, "utf-8")
  ) as ReviewConfig;

  const maxTurns = parseIntArg(args, "--max-turns", 25);
  const allowedTools = parseStringArg(
    args,
    "--allowed-tools",
    "Edit,Write,Read,Bash(curl:*),Glob,Grep"
  );
  const agentTimeout = parseIntArg(args, "--agent-timeout", 600000);
  const maxRetries = parseIntArg(args, "--max-retries", 2);

  const serverUrl = `http://localhost:${config.serverPort || DEFAULT_PORT}`;

  const watcher = startWatcher({
    serverUrl,
    projectRoot: config.projectRoot,
    maxTurns,
    allowedTools,
    agentTimeout,
    maxRetries,
  });

  process.on("SIGINT", async () => {
    console.log("\n  Shutting down watcher...");
    await watcher.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await watcher.stop();
    process.exit(0);
  });
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "init":
      if (!args[1]) {
        console.error("Usage: nitpix init <project-path>");
        process.exit(1);
      }
      await cmdInit(args[1]);
      break;

    case "start":
      await cmdStart(args.slice(1));
      break;

    case "serve":
      await cmdServe(args.slice(1));
      break;

    case "watch":
      await cmdWatch(args.slice(1));
      break;

    case "extension":
      cmdExtension();
      break;

    case "queue-next":
      await cmdQueueNext(args.slice(1));
      break;

    case "queue-update":
      if (!args[1] || !args[2]) {
        console.error("Usage: nitpix queue-update <id> '<json>'");
        process.exit(1);
      }
      await cmdQueueUpdate(args[1], args[2], args.slice(3));
      break;

    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
