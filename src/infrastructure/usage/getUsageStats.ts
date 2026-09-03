import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { resolveProjectId } from "./resolveProjectId";
import { queryDailyStats, querySessionCost, queryTotalStats, toYyyyMmDd } from "./queryDailyStats";
import type { UsageStats } from "../../domain/formatting";

export type { UsageStats };

export function getDbPath(): string {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH;
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return join(homedir(), ".local/share/opencode/opencode.db");
}

export function isUsageProjectOnly(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY !== "false";
}

export function getUsageStats(params: {
  directory: string;
  sessionId: string;
  date: string;
  projectOnly: boolean;
  dbPath?: string;
}): UsageStats | null {
  const dbPath = params.dbPath ?? getDbPath();
  if (!existsSync(dbPath)) return null;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true } as unknown as Record<string, unknown>);
    const normalizedDir = resolve(params.directory);
    const projectId = resolveProjectId(db, normalizedDir);
    const dateStr = toYyyyMmDd(params.date);
    const dailyRow = queryDailyStats(db, projectId, dateStr, params.projectOnly);
    const totalRow = queryTotalStats(db, projectId, params.projectOnly);
    const sessionCost = querySessionCost(db, params.sessionId);
    return {
      dayCost: Number(dailyRow?.dayCost ?? 0),
      tokensInput: Number(dailyRow?.tokensInput ?? 0),
      tokensOutput: Number(dailyRow?.tokensOutput ?? 0),
      cacheRead: Number(dailyRow?.cacheRead ?? 0),
      sessionsToday: Number(dailyRow?.sessionsToday ?? 0),
      totalCost: Number(totalRow?.totalCost ?? 0),
      sessionCost,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// Re-export helpers for facade compatibility
export { toYyyyMmDd } from "./queryDailyStats";
export { resolveProjectId } from "./resolveProjectId";
export { queryDailyStats, querySessionCost, queryTotalStats } from "./queryDailyStats";
