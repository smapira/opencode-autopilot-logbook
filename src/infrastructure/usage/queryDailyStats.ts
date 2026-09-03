import { Database } from "bun:sqlite";

export function toYyyyMmDd(date: string): string {
  if (date.length === 8) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  return date;
}

export function queryDailyStats(
  db: InstanceType<typeof Database>,
  projectId: string | null,
  dateStr: string,
  projectOnly: boolean,
): { sessionsToday: number; dayCost: number; tokensInput: number; tokensOutput: number; cacheRead: number } | undefined {
  const useProject = projectId !== null && projectOnly;
  if (useProject) {
    const stmt = db.prepare(
      `SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE project_id = ? AND date(datetime(time_created/1000,'unixepoch','localtime')) = ?`,
    );
    return stmt.get(projectId, dateStr) as
      | { sessionsToday: number; dayCost: number; tokensInput: number; tokensOutput: number; cacheRead: number }
      | undefined;
  }
  const stmt = db.prepare(
    `SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE date(datetime(time_created/1000,'unixepoch','localtime')) = ?`,
  );
  return stmt.get(dateStr) as
    | { sessionsToday: number; dayCost: number; tokensInput: number; tokensOutput: number; cacheRead: number }
    | undefined;
}

export function queryTotalStats(
  db: InstanceType<typeof Database>,
  projectId: string | null,
  projectOnly: boolean,
): { totalCost: number } | undefined {
  const useProject = projectId !== null && projectOnly;
  if (useProject) {
    const stmt = db.prepare(`SELECT coalesce(sum(cost),0) as totalCost FROM session WHERE project_id = ?`);
    return stmt.get(projectId) as { totalCost: number } | undefined;
  }
  const stmt = db.prepare(`SELECT coalesce(sum(cost),0) as totalCost FROM session`);
  return stmt.get() as { totalCost: number } | undefined;
}

export function querySessionCost(db: InstanceType<typeof Database>, sessionId: string): number | null {
  try {
    const stmt = db.prepare(`SELECT cost FROM session WHERE id = ?`);
    const row = stmt.get(sessionId) as { cost: number | null } | undefined;
    if (row && row.cost !== null && row.cost !== undefined) return Number(row.cost);
    return null;
  } catch {
    return null;
  }
}
