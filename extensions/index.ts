/**
 * pi-agentic-search — Deep research agent extension for pi
 *
 * Spawns a cheap research agent ("Search") that autonomously searches,
 * fetches, and synthesizes information on a given topic. Runs as a
 * background process with a live progress widget.
 *
 * Features:
 * - Real-time tool progress tracking
 * - Throttled UI updates
 * - Context window usage tracking
 * - Long task handling via temp files
 * - Auto-retry on transient errors (429, 5xx, network)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getMarkdownTheme,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Constants ──────────────────────────────────────────────────────────

const UPDATE_THROTTLE_MS = 150;
const TASK_LIMIT = 8000; // Write to file if task exceeds this length

// Retry config for transient errors (429, 5xx, network)
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 5000; // 5s, then 10s, 20s

// Activity timeout — if no events for this long, consider the process stuck
const ACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes

// ── Types ──────────────────────────────────────────────────────────────

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  contextWindow?: number;
  turns: number;
}

interface ToolEvent {
  tool: string;
  args: string;
  toolCallId?: string;
  status: "running" | "done";
}

interface SearchProgress {
  status: "pending" | "running" | "completed" | "failed";
  recentTools: ToolEvent[];
  toolCount: number;
  tokens: number;
  contextWindow?: number;
  durationMs: number;
  lastMessage: string;
  error?: string;
}

interface SearchResult {
  task: string;
  exitCode: number;
  messages: any[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  progress: SearchProgress;
}

interface SearchDetails {
  mode: "widget";
  task: string;
  goal: string;
  result?: SearchResult;
  status?: "started" | "running" | "completed" | "failed";
  error?: string;
}

interface SearchSettings {
  model?: string;
  keybinding?: number; // 1-9, default: 2
}

// ── Agent Registry ────────────────────────────────────────────────────

type AgentStatus = "running" | "stopped" | "completed" | "failed";

interface RegisteredAgent {
  id: string;
  widgetId: string;
  task: string;
  goal: string;
  status: AgentStatus;
  startTime: number;
  abort: () => void;
  retry: () => void;
  result?: SearchResult;
  progress: SearchProgress;
  model?: string;
  canceledByUser?: boolean;
  stoppedByUser?: boolean;
}

class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();
  private listeners: Array<() => void> = [];

  register(agent: RegisteredAgent) {
    this.agents.set(agent.id, agent);
    this.notify();
  }

  unregister(id: string) {
    this.agents.delete(id);
    this.notify();
  }

  get(id: string): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  getAll(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  getRunning(): RegisteredAgent[] {
    return this.getAll().filter((a) => a.status === "running");
  }

  stopAll() {
    for (const agent of this.getRunning()) {
      agent.abort();
      agent.status = "stopped";
    }
    this.notify();
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// Global registry instance
const agentRegistry = new AgentRegistry();

// ── Agent Control Panel ──────────────────────────────────────────────

import { matchesKey, Key } from "@earendil-works/pi-tui";

class AgentControlPanel {
  private selectedIndex = 0;
  private agents: RegisteredAgent[] = [];
  private tui: any;
  private theme: any;
  private done: (value: void) => void;
  private disposeListener: () => void;
  private pi: ExtensionAPI;
  private ui: any;

  constructor(tui: any, theme: any, done: (value: void) => void, pi: ExtensionAPI, ui: any) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.pi = pi;
    this.ui = ui;
    this.agents = agentRegistry.getAll();
    this.disposeListener = agentRegistry.onChange(() => {
      this.agents = agentRegistry.getAll();
      if (this.selectedIndex >= this.agents.length) {
        this.selectedIndex = Math.max(0, this.agents.length - 1);
      }
      tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.disposeListener();
      this.done();
      return;
    }

    if (this.agents.length === 0) return;

    if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
      this.selectedIndex--;
      this.tui.requestRender();
    } else if (matchesKey(data, Key.down) && this.selectedIndex < this.agents.length - 1) {
      this.selectedIndex++;
      this.tui.requestRender();
    } else if (data === "s" || data === "S") {
      // Stop — pause, no parent feedback, can retry later
      const agent = this.agents[this.selectedIndex];
      if (agent && agent.status === "running") {
        agent.stoppedByUser = true;
        agent.abort();
        agent.status = "stopped";
        // Don't unregister - keep in registry so it can be retried
        this.tui.requestRender();
      }
    } else if (data === "c" || data === "C") {
      // Cancel — kill, send failure to parent with "canceled by user" message
      const agent = this.agents[this.selectedIndex];
      if (agent) {
        agent.canceledByUser = true;
        // If agent is stopped, we need to send the cancel message directly
        if (agent.status === "stopped") {
          // Send cancel message to parent LLM
          const summary = `Research failed for: ${agent.goal}\nStatus: Canceled by user`;
          this.pi.sendMessage(
            {
              customType: "search-result",
              content: summary,
              display: true,
              details: {
                mode: "widget",
                task: agent.task,
                goal: agent.goal,
              },
            },
            {
              deliverAs: "followUp",
              triggerTurn: true,
            },
          );
          // Remove widget if it exists
          if (agent.widgetId) {
            this.ui.setWidget(agent.widgetId, undefined);
          }
          agentRegistry.unregister(agent.id);
        } else {
          agent.abort();
          agent.status = "failed";
          agentRegistry.unregister(agent.id);
        }
        this.tui.requestRender();
      }
    } else if (data === "r" || data === "R") {
      // Retry — kill + respawn fresh, no parent feedback
      const agent = this.agents[this.selectedIndex];
      if (agent) {
        agent.retry();
        this.tui.requestRender();
      }
    } else if (data === "a" || data === "A") {
      // Stop all
      agentRegistry.stopAll();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];

    // Header
    lines.push(theme.fg("accent", theme.bold("┌─ Research Agents ───────────────────────────────────────┐")));
    lines.push("");

    if (this.agents.length === 0) {
      lines.push(theme.fg("muted", "  No active agents"));
      lines.push("");
    } else {
      for (let i = 0; i < this.agents.length; i++) {
        const agent = this.agents[i];
        const selected = i === this.selectedIndex;
        const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
        const num = `${i + 1}.`;

        // Status icon
        let icon: string;
        let iconColor: string;
        switch (agent.status) {
          case "running":
            icon = "⟳";
            iconColor = "warning";
            break;
          case "stopped":
            icon = "⏸";
            iconColor = "muted";
            break;
          case "completed":
            icon = "✓";
            iconColor = "success";
            break;
          case "failed":
            icon = "✗";
            iconColor = "error";
            break;
        }

        const duration = formatDuration(Date.now() - agent.startTime);
        const modelStr = agent.model ? theme.fg("dim", ` (${agent.model})`) : "";
        const goal = agent.goal.length > 45 ? agent.goal.slice(0, 45) + "..." : agent.goal;

        // Agent line
        lines.push(
          `${prefix}${theme.fg("dim", num)} ${theme.fg(iconColor, icon)} ${theme.fg("text", goal)}${modelStr} ${theme.fg("dim", duration)}`
        );

        // Actions (only for selected)
        if (selected) {
          const actions: string[] = [];
          if (agent.status === "running") {
            actions.push(theme.fg("accent", "[S]top") + theme.fg("dim", " pause"));
            actions.push(theme.fg("error", "[C]ancel") + theme.fg("dim", " kill"));
            actions.push(theme.fg("warning", "[R]etry") + theme.fg("dim", " restart"));
          } else if (agent.status === "stopped") {
            actions.push(theme.fg("warning", "[R]etry") + theme.fg("dim", " restart"));
          }
          if (actions.length > 0) {
            lines.push(`    ${actions.join("  ")}`);
          }
        }

        lines.push("");
      }
    }

    // Footer
    lines.push(theme.fg("accent", "──────────────────────────────────────────────────────────"));
    if (this.agents.length > 0) {
      lines.push(theme.fg("dim", "  ↑↓ navigate  ") + theme.fg("accent", "[A]stop all") + theme.fg("dim", "  ") + theme.fg("muted", "[Esc]close"));
    } else {
      lines.push(theme.fg("dim", "  [Esc] close"));
    }
    lines.push(theme.fg("accent", "└────────────────────────────────────────────────────────┘"));

    return lines;
  }

  invalidate(): void {
    // Clear any cached state if needed
  }
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let lastCall = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: any[]) => {
    const now = Date.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      lastCall = Date.now();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = undefined;
        fn(...args);
      }, remaining);
    }
  }) as T;
}

// ── Helper Functions ──────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    contextWindow?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    const ctxStr = formatContextUsage(usage.contextTokens, usage.contextWindow);
    parts.push(`ctx:${ctxStr}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolPreview(name: string, args: Record<string, any>): string {
  switch (name) {
    case "search":
      return `search: ${((args.query as string) || "").slice(0, 80)}`;
    case "fetch":
      return `fetch: ${((args.url as string) || "").slice(0, 80)}`;
    default: {
      const s = JSON.stringify(args);
      return `${name} ${s.slice(0, 60)}`;
    }
  }
}

function isTransientError(result: SearchResult): boolean {
  const msg = (
    result.errorMessage ||
    result.progress.error ||
    result.stderr ||
    ""
  ).toLowerCase();

  // 429 rate limit
  if (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit")
  )
    return true;

  // 5xx server errors
  if (
    /(?:^|\s)5[0-9]{2}(?:\s|$)/.test(msg) ||
    msg.includes("500 internal server") ||
    msg.includes("502 bad gateway") ||
    msg.includes("503 service unavailable") ||
    msg.includes("504 gateway timeout")
  )
    return true;

  // Network errors
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("fetch failed")
  )
    return true;

  return false;
}

// ── Config ─────────────────────────────────────────────────────────────

function getConfigDir(): string {
  const localConfig = path.join(process.cwd(), ".pi", "config", "pi-agentic-search");
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }
  return path.join(os.homedir(), ".pi", "config", "pi-agentic-search");
}

function getSourceDir(): string {
  const dir =
    typeof __dirname !== "undefined"
      ? __dirname
      : path.dirname(new URL(import.meta.url).pathname);
  return dir;
}

function loadSettings(): SearchSettings {
  const configDir = getConfigDir();
  const settingsPath = path.join(configDir, "settings.json");

  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf-8").trim();
      if (content) {
        return JSON.parse(content);
      }
    }
  } catch {
    // ignore parse errors
  }

  return {};
}

function readNonCommentContent(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const nonCommentLines = content
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.trim());
    return nonCommentLines.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function loadSystemPrompt(): string {
  const configDir = getConfigDir();
  const sourceDir = getSourceDir();

  const replaceContent = readNonCommentContent(path.join(configDir, "replace-system-prompt.md"));
  if (replaceContent) {
    return replaceContent;
  }

  const defaultPath = path.join(sourceDir, "default-system-prompt.md");
  let defaultPrompt: string;
  try {
    defaultPrompt = fs.readFileSync(defaultPath, "utf-8").trim();
  } catch {
    throw new Error(`Failed to load default system prompt from ${defaultPath}`);
  }

  const prependContent = readNonCommentContent(path.join(configDir, "prepend-system-prompt.md"));
  const appendContent = readNonCommentContent(path.join(configDir, "append-system-prompt.md"));

  const parts: string[] = [];
  if (prependContent) parts.push(prependContent);
  parts.push(defaultPrompt);
  if (appendContent) parts.push(appendContent);

  return parts.join("\n\n");
}

// ── Message Extraction ────────────────────────────────────────────────

function getFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function extractTextFromContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function getDisplayItems(
  messages: any[],
): Array<
  { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }
> {
  const items: Array<
    { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }
  > = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

// ── Pi Binary Resolution ─────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
  const entry = process.argv[1];
  if (entry) {
    try {
      const realEntry = fs.realpathSync(entry);
      if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
        return { command: process.execPath, baseArgs: [realEntry] };
      }
    } catch {
      // ignore
    }
  }
  return { command: "pi", baseArgs: [] };
}

// ── Build Pi Args ────────────────────────────────────────────────────

async function buildPiArgs(
  systemPrompt: string,
  model: string | undefined,
  task: string,
  cwd: string,
): Promise<{ args: string[]; tempDir: string }> {
  const piBin = resolvePiBinary();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-search-"));

  // Write system prompt to temp file
  const promptPath = path.join(tempDir, "search-prompt.md");
  await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

  const args = [
    ...piBin.baseArgs,
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-skills",
    "--no-extensions",
    "-e",
    "npm:pi-search-tool",
    "--tools",
    "search,fetch",
    "--append-system-prompt",
    promptPath,
  ];

  // Add model flag if configured
  if (model) {
    args.push("--model", model);
  }

  // Handle long tasks by writing to file
  if (task.length > TASK_LIMIT) {
    const taskPath = path.join(tempDir, "task.md");
    await fs.promises.writeFile(taskPath, `Research Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
    args.push(`@${taskPath}`);
  } else {
    args.push(`Research Task: ${task}`);
  }

  return { args: [piBin.command, ...args], tempDir };
}

// ── Run Search (Background) ───────────────────────────────────────────

async function runSearchInBackground(
  task: string,
  goal: string,
  systemPrompt: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: any) => void) | undefined,
  cwd: string,
  startTime: number,
  ui: any,
): Promise<{ result: SearchResult; widgetId: string }> {

  const result: SearchResult = {
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    progress: {
      status: "running",
      recentTools: [],
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
      lastMessage: "",
    },
  };

  const progress = result.progress;
  const WIDGET_TOOL_LIMIT = 5;

  // Activity tracking for staleness detection
  let lastActivityTime = Date.now();
  let activityCheckTimer: ReturnType<typeof setInterval> | undefined;

  // Register widget with unique ID per spawn (supports Box rendering)
  // The render() closure reads mutable progress/result, so it's always up-to-date
  const widgetId = `search-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Register widget ONCE with callback form (supports Box rendering)
  let tuiRef: any = null;
  ui.setWidget(widgetId, (tui: any, theme: any) => {
    tuiRef = tui;
    return {
      render: () => {
        const duration = formatDuration(Date.now() - startTime);
        const isRunning = progress.status === "running";
        const isFailed = progress.status === "failed";
        const staleMs = Date.now() - lastActivityTime;
        const isStale = isRunning && staleMs > ACTIVITY_TIMEOUT_MS;
        const icon = isStale ? "⚠" : isRunning ? "⟳" : isFailed ? "✗" : "✓";
        const iconColor = isStale ? "error" : isRunning ? "warning" : isFailed ? "error" : "success";
        const modelStr = result.model ? theme.fg("dim", ` (${result.model})`) : "";
        const stats = isStale
          ? `${progress.toolCount} searches · ${duration} · probably failed`
          : `${progress.toolCount} searches · ${duration}`;
        const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));

        // Header: icon + label + stats
        box.addChild(new Text(
          `${theme.fg(iconColor, icon)} ${theme.fg("toolTitle", theme.bold("research"))}${modelStr} — ${theme.fg(isStale ? "error" : "dim", stats)}`,
          0, 0,
        ));

        // Tool log — last N tools
        const tools = progress.recentTools;
        const toShow = tools.slice(-WIDGET_TOOL_LIMIT);
        const skipped = tools.length - toShow.length;
        if (skipped > 0) {
          box.addChild(new Text(theme.fg("muted", `  … ${skipped} earlier`), 0, 0));
        }
        for (const t of toShow) {
          if (t.status === "running") {
            box.addChild(new Text(
              `${theme.fg("warning", "▸")} ${theme.fg("muted", t.tool)}: ${theme.fg("dim", t.args)}`,
              0, 0,
            ));
          } else {
            box.addChild(new Text(`  ${theme.fg("muted", t.tool)}: ${theme.fg("dim", t.args)}`, 0, 0));
          }
        }

        // Latest "thinking" message
        if (progress.lastMessage) {
          const preview =
            progress.lastMessage.length > 100
              ? progress.lastMessage.slice(0, 100) + "…"
              : progress.lastMessage;
          box.addChild(new Text(theme.fg("text", preview), 0, 0));
        }

        // Usage line
        const usageParts: string[] = [];
        if (result.usage.turns)
          usageParts.push(theme.fg("dim", `${result.usage.turns} turn${result.usage.turns !== 1 ? "s" : ""}`));
        if (result.usage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(result.usage.input)}`));
        if (result.usage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(result.usage.output)}`));
        if (result.usage.cacheRead) usageParts.push(theme.fg("dim", `R${formatTokens(result.usage.cacheRead)}`));
        if (result.usage.cacheWrite) usageParts.push(theme.fg("dim", `W${formatTokens(result.usage.cacheWrite)}`));
        if (result.usage.cost) usageParts.push(theme.fg("dim", `$${result.usage.cost.toFixed(4)}`));
        if (progress.tokens > 0) {
          const ctxStr = formatContextUsage(progress.tokens, progress.contextWindow);
          const pct = progress.contextWindow ? (progress.tokens / progress.contextWindow) * 100 : 0;
          const ctxColor = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";
          usageParts.push(theme.fg(ctxColor, ctxStr));
        }
        if (usageParts.length) {
          box.addChild(new Text(usageParts.join(" "), 0, 0));
        }

        // Error
        if (progress.error) {
          box.addChild(new Text(theme.fg("error", `Error: ${progress.error}`), 0, 0));
        }

        const width = process.stdout.columns || 80;
        const lines = box.render(width);
        // Add separator line between widgets
        lines.push("");
        return lines;
      },
      invalidate: () => {},
    };
  });
  ui.setStatus("search", ui.theme.fg("warning", "⟳ research"));

  const fireUpdate = throttle(() => {
    lastActivityTime = Date.now();
    progress.durationMs = Date.now() - startTime;
    if (tuiRef?.requestRender) tuiRef.requestRender();
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: progress.lastMessage || "(searching...)" }],
        details: {
          mode: "widget",
          task,
          goal,
          result,
        },
      });
    }
  }, UPDATE_THROTTLE_MS);

  const { args, tempDir } = await buildPiArgs(systemPrompt, model, task, cwd);
  const command = args[0];
  const spawnArgs = args.slice(1);

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(command, spawnArgs, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Activity timeout — kill process if stuck
      activityCheckTimer = setInterval(() => {
        const elapsed = Date.now() - lastActivityTime;
        if (elapsed > ACTIVITY_TIMEOUT_MS) {
          progress.status = "failed";
          progress.error = `No activity for ${Math.round(elapsed / 1000)}s — process appears stuck`;
          proc.kill("SIGTERM");
          setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
        }
      }, 30_000); // Check every 30s

      let buf = "";
      let stderrBuf = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const evt = JSON.parse(line) as any;
          progress.durationMs = Date.now() - startTime;

          // Track tool execution start
          if (evt.type === "tool_execution_start") {
            progress.toolCount++;
            progress.recentTools.push({
              tool: evt.toolName,
              args: formatToolPreview(evt.toolName, (evt.args || {}) as Record<string, any>),
              toolCallId: evt.toolCallId,
              status: "running",
            });
            if (progress.recentTools.length > 20) {
              progress.recentTools = progress.recentTools.slice(-20);
            }
            fireUpdate();
          }

          // Track tool execution updates (for progress)
          if (evt.type === "tool_execution_update") {
            const hit = evt.toolCallId
              ? progress.recentTools.find((t) => t.toolCallId === evt.toolCallId)
              : undefined;
            if (hit) {
              if (evt.args) {
                hit.args = formatToolPreview(evt.toolName, evt.args);
              }
            }
            fireUpdate();
          }

          // Track tool execution end
          if (evt.type === "tool_execution_end") {
            const hit = evt.toolCallId
              ? progress.recentTools.find((t) => t.toolCallId === evt.toolCallId)
              : undefined;
            if (hit) {
              hit.status = "done";
            }
            fireUpdate();
          }

          // Track tool results
          if (evt.type === "tool_result_end") {
            fireUpdate();
          }

          // Track messages
          if (evt.type === "message_end" && evt.message) {
            const msg = evt.message;
            result.messages.push(msg);

            if (msg.role === "assistant") {
              result.usage.turns++;
              const u = msg.usage;
              if (u) {
                result.usage.input += u.input || 0;
                result.usage.output += u.output || 0;
                result.usage.cacheRead += u.cacheRead || 0;
                result.usage.cacheWrite += u.cacheWrite || 0;
                result.usage.cost += u.cost?.total || 0;
                progress.tokens =
                  (u as any).totalTokens ||
                  (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
                result.usage.contextTokens = progress.tokens;
              }
              if (!result.model && msg.model) result.model = msg.model;
              if (msg.stopReason) result.stopReason = msg.stopReason;
              if (msg.errorMessage) {
                result.errorMessage = msg.errorMessage;
                progress.error = msg.errorMessage;
              }

              // Extract latest prose for progress display
              const text = extractTextFromContent(msg.content);
              if (text) {
                const proseLines: string[] = [];
                let inCodeBlock = false;
                for (const line of text.split("\n")) {
                  if (line.trimStart().startsWith("```")) {
                    inCodeBlock = !inCodeBlock;
                    continue;
                  }
                  if (!inCodeBlock && line.trim()) {
                    proseLines.push(line.trim());
                  }
                }
                if (proseLines.length > 0) {
                  progress.lastMessage = proseLines.slice(0, 3).join(" ");
                }
              }
            }

            fireUpdate();
          }
        } catch {
          // Non-JSON lines are expected
        }
      };

      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        lines.forEach(processLine);
      });

      proc.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString();
      });

      proc.on("close", (code) => {
        if (activityCheckTimer) {
          clearInterval(activityCheckTimer);
          activityCheckTimer = undefined;
        }
        if (buf.trim()) processLine(buf);
        if (code !== 0 && stderrBuf.trim() && !progress.error) {
          // Filter out pi's internal dashboard errors (expected when process is killed)
          const filteredStderr = stderrBuf.trim()
            .split('\n')
            .filter((line: string) => !line.includes('[dashboard]'))
            .join('\n')
            .trim();
          if (filteredStderr) {
            progress.error = filteredStderr;
            result.stderr = filteredStderr;
          }
        }
        resolve(code ?? 1);
      });

      proc.on("error", () => {
        if (activityCheckTimer) {
          clearInterval(activityCheckTimer);
          activityCheckTimer = undefined;
        }
        resolve(1);
      });

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
    progress.durationMs = Date.now() - startTime;

    // Truncate output if very large
    if (getFinalOutput(result.messages).length > DEFAULT_MAX_BYTES) {
      truncateHead(getFinalOutput(result.messages), {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
    }

    return { result, widgetId };
  } finally {
    if (activityCheckTimer) {
      clearInterval(activityCheckTimer);
      activityCheckTimer = undefined;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── Build Search Summary ──────────────────────────────────────────────

function buildSearchSummary(result: SearchResult, goal: string, canceledByUser = false): string {
  const finalOutput = getFinalOutput(result.messages);
  const isError = result.exitCode !== 0;

  const parts: string[] = [];

  if (isError) {
    parts.push(`Research failed for: ${goal}`);
    if (canceledByUser) {
      parts.push(`Status: Canceled by user`);
    }
    const error = result.errorMessage || result.progress.error || result.stderr;
    if (error) parts.push(`Error: ${error}`);
    parts.push("");
    if (finalOutput) {
      parts.push("Partial results:");
      parts.push("");
      parts.push(finalOutput);
    }
  } else {
    parts.push(`Research completed for: ${goal}`);
    if (result.usage.turns > 0) {
      const usageStr = formatUsageStats(result.usage, result.model);
      if (usageStr) parts.push(`Stats: ${usageStr}`);
    }
    if (result.progress.durationMs > 0) {
      parts.push(`Duration: ${formatDuration(result.progress.durationMs)}`);
    }
    parts.push("");
    if (finalOutput) {
      parts.push("## Research Summary");
      parts.push("");
      parts.push(finalOutput);
    } else {
      parts.push("(no findings)");
    }
  }

  return parts.join("\n");
}

// ── Main Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Ensure config files exist on session start
  pi.on("session_start", async (_event: any, ctx: any) => {
    const configDir = getConfigDir();
    try {
      await fs.promises.mkdir(configDir, { recursive: true });

      const prependPath = path.join(configDir, "prepend-system-prompt.md");
      if (!fs.existsSync(prependPath)) {
        await fs.promises.writeFile(
          prependPath,
          "# Prepend instructions before the default research prompt\n" +
            "# Content here is added before the default prompt\n" +
            "# This file survives updates\n\n",
          "utf-8",
        );
      }

      const appendPath = path.join(configDir, "append-system-prompt.md");
      if (!fs.existsSync(appendPath)) {
        await fs.promises.writeFile(
          appendPath,
          "# Append instructions after the default research prompt\n" +
            "# Content here is added after the default prompt\n" +
            "# This file survives updates\n\n",
          "utf-8",
        );
      }

      const replacePath = path.join(configDir, "replace-system-prompt.md");
      if (!fs.existsSync(replacePath)) {
        await fs.promises.writeFile(
          replacePath,
          "# Replace the default research prompt entirely\n" +
            "# If this file has non-comment content, it will be used instead of the default\n" +
            "# This file survives updates\n\n",
          "utf-8",
        );
      }

      const settingsPath = path.join(configDir, "settings.json");
      if (!fs.existsSync(settingsPath)) {
        await fs.promises.writeFile(
          settingsPath,
          JSON.stringify({ model: "", keybinding: 2 }, null, 2) + "\n",
          "utf-8",
        );
      }
    } catch {
      // ignore errors
    }

    // Register keybinding for agent control panel
    const settings = loadSettings();
    const keyNum = settings.keybinding ?? 2;
    pi.registerShortcut(`ctrl+shift+${keyNum}` as any, {
      description: "Open research agent control panel",
      handler: async () => {
        ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
          return new AgentControlPanel(tui, theme, done, pi, ctx.ui);
        }, { overlay: true });
      },
    });
  });

  // Register message renderer for research results
  pi.registerMessageRenderer("search-result", (message: any, options: any, theme: any) => {
    const { expanded } = options;
    const details = message.details as SearchDetails | undefined;

    const mdTheme = getMarkdownTheme();
    const isError = details?.result?.exitCode !== 0;
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    let text = `${icon} ${theme.fg("toolTitle", theme.bold("research"))} ${theme.fg("accent", isError ? "failed" : "completed")}`;

    if (details?.result?.usage) {
      const usageStr = formatUsageStats(details.result.usage, details.result.model);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
    }

    if (expanded && message.content) {
      const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      box.addChild(new Spacer(1));
      box.addChild(new Markdown(message.content, 0, 0, mdTheme));
      return box;
    }

    // Collapsed: show first few lines
    const preview = message.content?.split("\n").slice(0, 5).join("\n") || "(no content)";
    text += `\n${theme.fg("text", preview)}`;

    const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  // Register the agentic search tool
  pi.registerTool({
    name: "agentic_search",
    label: "Agentic Search",
    description:
      "Spawn a dedicated research agent that autonomously searches, fetches, and synthesizes information on a given topic. Unlike the primitive search and fetch tools — which return raw results — this agent reasons across multiple sources, follows leads, resolves conflicts, and returns a structured Research Summary. Use when the topic requires depth, cross-referencing, or synthesis beyond a single query.",
    promptSnippet: "Spawn an autonomous research agent for deep, multi-source investigation",
    promptGuidelines: [
      "Use agentic_search for complex or broad topics requiring synthesis across multiple sources — not for simple factual lookups where search + fetch suffices.",
      "Use agentic_search when the answer requires resolving conflicting sources, following chains of references, or producing a structured summary rather than raw results.",
      "The research agent is read-only — it can only search the web and fetch pages. It cannot modify anything or execute code.",
      "Good topics for agentic_search: comparing technologies, understanding trends, researching best practices, investigating controversies, gathering evidence for decisions.",
      "Simple factual questions (e.g., 'What is the capital of France?') should use the search tool directly, not agentic_search.",
    ],
    parameters: Type.Object({
      goal: Type.String({
        description:
          "The research question or topic to investigate. Be specific and outcome-oriented: what should the agent find out, compare, or explain? E.g. 'What are the current best practices for rate limiting in distributed APIs?' rather than 'rate limiting'.",
      }),
      context: Type.String({
        description:
          "Background that helps the agent focus its research: why this is being investigated, what is already known, what angle matters most, or what sources to prioritize or avoid. E.g. 'We are building a Node.js API gateway. We already use Redis. Interested in token bucket vs sliding window approaches.'",
      }),
    }),
    async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) {
      const settings = loadSettings();
      const systemPrompt = loadSystemPrompt();
      const startTime = Date.now();
      const task = `Research the following:\n\nGoal: ${params.goal}\n\nContext: ${params.context}`;

      // Create an abort controller for this agent
      let agentAbortController = new AbortController();
      let agentId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let activeWidgetId: string | undefined;

      // Fire and forget — run search in background with auto-retry on transient errors
      const backgroundTask = async () => {
        // Clear widget and status when done
        const clearWidget = () => {
          if (activeWidgetId) {
            ctx.ui.setWidget(activeWidgetId, undefined);
          }
          ctx.ui.setStatus("search", undefined);
          agentRegistry.unregister(agentId);
        };

        let attempt = 0;
        let localCanceledByUser = false;
        // Initial empty result for the widget (before first run)
        let result: SearchResult = {
          task,
          exitCode: 0,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          progress: { status: "running", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
        };

        // Retry function for the registry
        const retryAgent = () => {
          // Remove old widget before creating new one
          if (activeWidgetId) {
            ctx.ui.setWidget(activeWidgetId, undefined);
          }
          agentAbortController.abort();
          agentAbortController = new AbortController();
          attempt = 0;
          localCanceledByUser = false;
          result = {
            task,
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            progress: { status: "running", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
          };
          // Update existing agent in registry (keep same ID and widget)
          const existingAgent = agentRegistry.get(agentId);
          if (existingAgent) {
            existingAgent.status = "running";
            existingAgent.stoppedByUser = false;
            existingAgent.canceledByUser = false;
            existingAgent.startTime = Date.now();
            existingAgent.progress = result.progress;
            existingAgent.abort = () => {
              localCanceledByUser = true;
              agentAbortController.abort();
            };
          } else {
            // Fallback: re-register if not found
            agentRegistry.register({
              id: agentId,
              widgetId: activeWidgetId || "",
              task,
              goal: params.goal,
              status: "running",
              startTime: Date.now(),
              abort: () => {
                agentAbortController.abort();
              },
              retry: retryAgent,
              progress: result.progress,
              model: settings.model,
            });
          }
          runBackground();
        };

        // Register the agent
        agentRegistry.register({
          id: agentId,
          widgetId: "", // Will be updated when widget is created
          task,
          goal: params.goal,
          status: "running",
          startTime,
          abort: () => {
            localCanceledByUser = true;
            agentAbortController.abort();
          },
          retry: retryAgent,
          progress: result.progress,
          model: settings.model,
        });

        const runBackground = async () => {
          attempt = 0;

          while (attempt <= MAX_RETRIES) {
          try {
            const bgResult = await runSearchInBackground(
              task,
              params.goal,
              systemPrompt,
              settings.model,
              agentAbortController.signal,
              undefined,
              ctx.cwd,
              startTime,
              ctx.ui,
            );
            result = bgResult.result;
            activeWidgetId = bgResult.widgetId;

            // Update agent registry with widgetId
            const agent = agentRegistry.get(agentId);
            if (agent) {
              agent.widgetId = activeWidgetId;
              agent.progress = result.progress;
              agent.model = result.model;
            }

            // Check if agent was stopped by user — no feedback to LLM, keep widget visible
            const currentAgent = agentRegistry.get(agentId);
            if (currentAgent?.stoppedByUser) {
              // Agent was stopped, keep in registry with stopped status
              // Update widget to show stopped status
              if (activeWidgetId) {
                ctx.ui.setWidget(activeWidgetId, (tui: any, theme: any) => {
                  return {
                    render: () => {
                      const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
                      box.addChild(new Text(
                        `${theme.fg("muted", "⏸")} ${theme.fg("toolTitle", theme.bold("research"))} — ${theme.fg("muted", "stopped")}`,
                        0, 0,
                      ));
                      box.addChild(new Text(
                        theme.fg("dim", `  ${params.goal.length > 50 ? params.goal.slice(0, 50) + "..." : params.goal}`),
                        0, 0,
                      ));
                      const width = process.stdout.columns || 80;
                      const lines = box.render(width);
                      lines.push("");
                      return lines;
                    },
                    invalidate: () => {},
                  };
                });
              }
              return;
            }

            // If agent was canceled, send failure message with canceled status
            if (localCanceledByUser) {
              const summary = buildSearchSummary(result, params.goal, true);
              pi.sendMessage(
                {
                  customType: "search-result",
                  content: summary,
                  display: true,
                  details: {
                    mode: "widget",
                    task,
                    goal: params.goal,
                    result,
                  },
                },
                {
                  deliverAs: "followUp",
                  triggerTurn: true,
                },
              );
              if (activeWidgetId) {
                ctx.ui.setWidget(activeWidgetId, undefined);
              }
              ctx.ui.setStatus("search", undefined);
              return;
            }

            // Success — send results and return
            if (result.progress.status === "completed") {
              const summary = buildSearchSummary(result, params.goal, localCanceledByUser);
              pi.sendMessage(
                {
                  customType: "search-result",
                  content: summary,
                  display: true,
                  details: {
                    mode: "widget",
                    task,
                    goal: params.goal,
                    result,
                  },
                },
                {
                  deliverAs: "followUp",
                  triggerTurn: true,
                },
              );
              clearWidget();
              return;
            }

            // Failed — check if transient
            if (!isTransientError(result) || attempt >= MAX_RETRIES) {
              const summary = buildSearchSummary(result, params.goal, localCanceledByUser);
              pi.sendMessage(
                {
                  customType: "search-result",
                  content: summary,
                  display: true,
                  details: {
                    mode: "widget",
                    task,
                    goal: params.goal,
                    result,
                  },
                },
                {
                  deliverAs: "followUp",
                  triggerTurn: true,
                },
              );
              clearWidget();
              return;
            }

            // Transient error — retry with backoff
            attempt++;
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            const errorMsg =
              result.errorMessage || result.progress.error || result.stderr || "unknown error";

            // Show retry status in widget
            if (activeWidgetId) {
              ctx.ui.setWidget(activeWidgetId, (_tui: any, th: any) => {
                return {
                  render: () => {
                    const box = new Box(1, 0, (t: string) => th.bg("customMessageBg", t));
                    box.addChild(new Text(
                      `${th.fg("warning", "⟳")} ${th.fg("toolTitle", th.bold("research"))} — ${th.fg("warning", `retrying (${attempt}/${MAX_RETRIES})`)}`,
                      0, 0,
                    ));
                    box.addChild(new Text(
                      th.fg("dim", params.goal.length > 60 ? params.goal.slice(0, 60) + "..." : params.goal),
                      0, 0,
                    ));
                    box.addChild(new Text(
                      th.fg("error", `Error: ${errorMsg.slice(0, 80)}`),
                      0, 0,
                    ));
                    box.addChild(new Text(
                      th.fg("muted", `Waiting ${Math.round(delay / 1000)}s before retry`),
                      0, 0,
                    ));
                    const width = process.stdout.columns || 80;
                    return box.render(width);
                  },
                  invalidate: () => {},
                };
              });
            }
            ctx.ui.setStatus("search", ctx.ui.theme.fg("warning", `⟳ research retry ${attempt}/${MAX_RETRIES}`));

            await new Promise((r) => setTimeout(r, delay));

            // Check if aborted during wait
            if (agentAbortController.signal.aborted) return;
          } catch (error) {
            // Check if agent was stopped by user — no feedback to LLM
            const currentAgent = agentRegistry.get(agentId);
            if (currentAgent?.stoppedByUser) {
              // Clean up widget
              if (activeWidgetId) {
                ctx.ui.setWidget(activeWidgetId, undefined);
              }
              ctx.ui.setStatus("search", undefined);
              return;
            }
            // Build summary with canceledByUser flag if applicable
            const summary = buildSearchSummary(result, params.goal, localCanceledByUser);
            pi.sendMessage(
              {
                customType: "search-result",
                content: summary,
                display: true,
                details: {
                  mode: "widget",
                  task,
                  goal: params.goal,
                  result,
                },
              },
              {
                deliverAs: "followUp",
                triggerTurn: true,
              },
            );
            clearWidget();
            return;
          }
        }
        };

        // Start the background run
        await runBackground();
      };

      // Start background task (don't await) with error catching
      backgroundTask().catch((error) => {
        // Check if agent was stopped by user — no feedback to LLM
        const currentAgent = agentRegistry.get(agentId);
        if (currentAgent?.stoppedByUser) {
          // Clean up status
          ctx.ui.setStatus("search", undefined);
          return;
        }
        // Unexpected error — try to send failure message and clean up
        try {
          pi.sendMessage(
            {
              customType: "search-result",
              content: `Research failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
              display: true,
              details: {
                error: error instanceof Error ? error.message : String(error),
              },
            },
            {
              deliverAs: "followUp",
              triggerTurn: true,
            },
          );
          ctx.ui.setStatus("search", undefined);
        } catch {
          // Last resort — nothing more we can do
        }
      });

      // Return immediately
      return {
        content: [
          {
            type: "text",
            text: [
              `Research started in background for: ${params.goal}`,
              "",
              "IMPORTANT: The research agent is running in the background and will deliver a comprehensive summary automatically when done. Wait for the results before proceeding with your own searching or fetching — the agent is doing that work for you. You may spawn additional research agents for unrelated topics in parallel.",
            ].join("\n"),
          },
        ],
        details: {
          mode: "widget",
          task,
          goal: params.goal,
          status: "started",
        },
      };
    },

    renderCall(args: any, theme: any, _context: any) {
      const goal = args.goal || "...";
      const preview = goal.length > 50 ? `${goal.slice(0, 50)}...` : goal;

      let text = theme.fg("toolTitle", theme.bold("research "));
      text += theme.fg("accent", preview);

      if (args.context) {
        const contextPreview =
          args.context.length > 50 ? `${args.context.slice(0, 50)}...` : args.context;
        text += `\n  ${theme.fg("dim", contextPreview)}`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: any, theme: any, _context: any) {
      const details = result.details as SearchDetails | undefined;

      if (!details) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      // Handle "started" status (background mode)
      if (details.status === "started") {
        const goal = details.task?.match(/Goal: (.+)/)?.[1] || "";
        const c = new Container();

        c.addChild(
          new Text(
            theme.fg("warning", "⟳ ") +
              theme.fg("toolTitle", theme.bold("research")) +
              theme.fg("accent", " — searching in background"),
            0,
            0,
          ),
        );

        if (goal)
          c.addChild(
            new Text(theme.fg("dim", "  Goal: ") + theme.fg("text", goal), 0, 0),
          );

        c.addChild(new Spacer(1));
        c.addChild(
          new Text(
            theme.fg(
              "warning",
              "Waiting for research results — delegate searching, do not search/fetch yourself.",
            ),
            0,
            0,
          ),
        );

        return c;
      }

      const mdTheme = getMarkdownTheme();

      if (!details.result) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const r = details.result;
      const prog = r.progress;
      const isError = r.exitCode !== 0;
      const isRunning = prog.status === "running";
      const icon = isRunning
        ? theme.fg("warning", "⟳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);

      if (expanded) {
        const container = new Container();

        // Header: icon + research + stats
        const modelStr = r.model ? ` (${r.model})` : "";
        const stats = `${prog.toolCount} searches · ${formatDuration(prog.durationMs)}`;
        let header = `${icon} ${theme.fg("toolTitle", theme.bold("research"))}${theme.fg("dim", modelStr)} — ${theme.fg("dim", stats)}`;
        if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));

        if (isError && (r.errorMessage || prog.error)) {
          container.addChild(
            new Text(theme.fg("error", `Error: ${r.errorMessage || prog.error}`), 0, 0),
          );
        }

        // Tool log
        if (prog.recentTools.length > 0) {
          container.addChild(new Spacer(1));
          for (const t of prog.recentTools.slice(-10)) {
            const statusIcon =
              t.status === "running" ? theme.fg("warning", "▸") : theme.fg("muted", "  ");
            container.addChild(
              new Text(
                `${statusIcon} ${theme.fg("muted", t.tool)}: ${theme.fg("dim", t.args)}`,
                0,
                0,
              ),
            );
          }
        }

        // Latest "thinking" message
        if (prog.lastMessage) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("text", prog.lastMessage), 0, 0));
        }

        // Final output
        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
        } else if (displayItems.length === 0) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        }

        // Usage line
        container.addChild(new Spacer(1));
        const usageParts: string[] = [];
        if (r.usage.turns)
          usageParts.push(
            theme.fg("dim", `${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`),
          );
        if (r.usage.input)
          usageParts.push(theme.fg("dim", `↑${formatTokens(r.usage.input)}`));
        if (r.usage.output)
          usageParts.push(theme.fg("dim", `↓${formatTokens(r.usage.output)}`));
        if (r.usage.cacheRead)
          usageParts.push(theme.fg("dim", `R${formatTokens(r.usage.cacheRead)}`));
        if (r.usage.cacheWrite)
          usageParts.push(theme.fg("dim", `W${formatTokens(r.usage.cacheWrite)}`));
        if (r.usage.cost) usageParts.push(theme.fg("dim", `$${r.usage.cost.toFixed(4)}`));
        if (prog.tokens > 0 && prog.contextWindow) {
          const ctxStr = formatContextUsage(prog.tokens, prog.contextWindow);
          const pct = (prog.tokens / prog.contextWindow) * 100;
          const coloredCtx =
            pct > 90
              ? theme.fg("error", ctxStr)
              : pct > 70
                ? theme.fg("warning", ctxStr)
                : theme.fg("dim", ctxStr);
          usageParts.push(coloredCtx);
        }
        if (usageParts.length) {
          container.addChild(new Text(usageParts.join(" "), 0, 0));
        }

        return container;
      }

      // ── Collapsed view ──
      const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
      const stats = `${prog.toolCount} searches · ${formatDuration(prog.durationMs)}`;
      let text = `${icon} ${theme.fg("toolTitle", theme.bold("research"))}${modelStr} — ${theme.fg("dim", stats)}`;
      if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

      // Tool log — last 5
      const toolSlice = prog.recentTools.slice(-5);
      const toolSkip = prog.recentTools.length - toolSlice.length;
      if (toolSkip > 0) text += `\n${theme.fg("muted", `  … ${toolSkip} earlier`)}`;
      for (const t of toolSlice) {
        if (t.status === "running") {
          text += `\n${theme.fg("warning", "▸")} ${theme.fg("muted", t.tool)}: ${theme.fg("dim", t.args)}`;
        } else {
          text += `\n${theme.fg("muted", `  ${t.tool}:`)} ${theme.fg("dim", t.args)}`;
        }
      }

      // Last message or error
      if (isError && (r.errorMessage || prog.error)) {
        text += `\n${theme.fg("error", `Error: ${r.errorMessage || prog.error}`)}`;
      } else if (prog.lastMessage) {
        const preview =
          prog.lastMessage.length > 100
            ? `${prog.lastMessage.slice(0, 100)}…`
            : prog.lastMessage;
        text += `\n${theme.fg("text", preview)}`;
      }

      // Usage line
      const usageParts: string[] = [];
      if (r.usage.turns)
        usageParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
      if (r.usage.input) usageParts.push(`↑${formatTokens(r.usage.input)}`);
      if (r.usage.output) usageParts.push(`↓${formatTokens(r.usage.output)}`);
      if (r.usage.cacheRead) usageParts.push(`R${formatTokens(r.usage.cacheRead)}`);
      if (r.usage.cacheWrite) usageParts.push(`W${formatTokens(r.usage.cacheWrite)}`);
      if (r.usage.cost) usageParts.push(`$${r.usage.cost.toFixed(4)}`);
      if (prog.tokens > 0) {
        usageParts.push(formatContextUsage(prog.tokens, prog.contextWindow));
      }
      if (usageParts.length) {
        text += `\n${theme.fg("dim", usageParts.join(" "))}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
