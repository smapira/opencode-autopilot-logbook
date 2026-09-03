import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppLogSink } from "./ports";

export function isWithinWindow(
  lastTriggeredAt: number | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  if (lastTriggeredAt === undefined) return false;
  return nowMs - lastTriggeredAt < windowMs;
}

export function isDailyLogbookExists(
  directory: string,
  outputDir: string,
  date: string,
): boolean {
  const p = resolve(directory, outputDir, `${date}_logbook.md`);
  return existsSync(p);
}

export function isDuplicateTrigger(
  sessionId: string,
  nowMs: number,
  windowMs: number,
  recentMap: Map<string, number>,
): boolean {
  return isWithinWindow(recentMap.get(sessionId), nowMs, windowMs);
}

export function pruneExpiredGuards(
  nowMs: number,
  windowMs: number,
  recentMap: Map<string, number>,
): void {
  for (const [sid, ts] of recentMap.entries()) {
    if (nowMs - ts >= windowMs * 2) recentMap.delete(sid);
  }
}

export function isThrottled(
  sessionId: string,
  nowMs: number,
  windowMs: number,
  inFlight: Set<string>,
  recentMap: Map<string, number>,
): boolean {
  return inFlight.has(sessionId) || isDuplicateTrigger(sessionId, nowMs, windowMs, recentMap);
}

export function isDailyLimitedInFlight(
  date: string,
  isDailyLimited: boolean,
  inFlightDates: Set<string>,
): boolean {
  return isDailyLimited && inFlightDates.has(date);
}

export function getDailyFileAction(
  isDailyLimited: boolean,
  directory: string,
  outputDir: string,
  date: string,
): "skip" | "warnCustom" | "continue" {
  if (!isDailyLimited) return "continue";
  if (process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE) return "warnCustom";
  if (isDailyLogbookExists(directory, outputDir, date)) return "skip";
  return "continue";
}

export function handleDailyFileAction(
  action: "skip" | "warnCustom" | "continue",
  sink: AppLogSink,
  date: string,
): boolean {
  if (action === "warnCustom") {
    void sink.warn(
      "OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT is not supported together with OPENCODE_DAILY_LOGBOOK_TEMPLATE (file name pattern is unknown). Daily limit check is skipped.",
    );
    return false;
  }
  if (action === "skip") {
    void sink.warn(
      `Daily logbook for ${date} already exists. Skipping generation (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`,
    );
    return true;
  }
  return false;
}
