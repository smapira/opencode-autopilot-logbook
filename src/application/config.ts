const DEFAULT_OUTPUT_DIR = "artifacts/daily";
const DUPLICATE_WINDOW_MS = 90_000;

export function getOutputDir(): string {
  return process.env.OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}

export function isPluginDisabled(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true";
}

export function isTranscriptIncluded(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT !== "false";
}

export function isDailyLimitEnabled(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT === "true";
}

export function getThrottleWindowMs(): number {
  const raw = process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
  if (raw === undefined || raw === "") return DUPLICATE_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DUPLICATE_WINDOW_MS;
  return parsed;
}

export function getTemplatePath(): string | undefined {
  return process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE || undefined;
}

// Re-export env helpers for usage to keep single source (used by UsagePort default)
export function isUsageProjectOnly(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY !== "false";
}

import { homedir } from "node:os";
import { join } from "node:path";

export function getDbPath(): string {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH;
  if (custom && custom.trim() !== "") return custom;
  return join(homedir(), ".local/share/opencode/opencode.db");
}
