export interface ElementInfo {
  component: string;
  sourceFile: string;
  sourceLine: number;
  selector: string;
  rect?: { x: number; y: number; width: number; height: number };
  computedStyles?: Record<string, string>;
}

export interface PageInfo {
  component: string;
  sourceFile: string;
  sourceLine?: number;
}

export interface RegionInfo {
  rect: { x: number; y: number; width: number; height: number };
}

export type TaskType = "element" | "page" | "region";
export type TaskCategory = "tweak" | "bug" | "feature";
export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "pending" | "in_progress" | "review" | "done";

export interface TaskAttempt {
  agentNotes: string;
  filesModified: string[];
  retryReason: string;
  afterScreenshot: string | null;
  timestamp: string;
}

export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  type: TaskType;
  note: string;
  category: TaskCategory;
  priority: TaskPriority;
  status: TaskStatus;
  screenshotPath: string;
  element: ElementInfo | null;
  page: PageInfo;
  region: RegionInfo | null;
  agentNotes: string;
  filesModified: string[];
  afterScreenshot: string | null;
  attempts: TaskAttempt[];
}

export interface CreateTaskInput {
  url: string;
  note: string;
  category: TaskCategory;
  priority: TaskPriority;
  type: TaskType;
  screenshot: string; // base64 PNG
  element?: ElementInfo;
  page: PageInfo;
  region?: RegionInfo;
}

export interface Queue {
  version: number;
  lastUpdated: string;
  items: Task[];
}

export interface ReviewConfig {
  serverPort: number;
  projectRoot: string;
}

export interface WatcherOptions {
  serverUrl: string;
  projectRoot: string;
  maxTurns: number;
  allowedTools?: string;
  agentTimeout?: number;
  maxCrashes?: number;
}

export interface ActivityEntry {
  timestamp: string;
  type: "tool_start" | "tool_end" | "text" | "error" | "result";
  summary: string;
}
