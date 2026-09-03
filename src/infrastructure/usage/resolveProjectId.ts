import { Database } from "bun:sqlite";

export function resolveProjectId(db: InstanceType<typeof Database>, normalizedDir: string): string | null {
  try {
    const stmt = db.prepare("SELECT id FROM project WHERE worktree = ?");
    const row = stmt.get(normalizedDir) as { id: string } | undefined;
    if (row) return row.id;
    return null;
  } catch {
    return null;
  }
}
