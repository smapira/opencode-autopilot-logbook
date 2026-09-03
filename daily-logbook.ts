import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const SERVICE_NAME = "daily-logbook-plugin";
const GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
const DUPLICATE_WINDOW_MS = 90_000;
const TRANSCRIPT_MAX_MESSAGES = 80;
const TRANSCRIPT_MAX_CHARS = 12_000;

const inFlightSessionIds = new Set<string>();
const dailyLimitInFlightByDate = new Set<string>();
const recentlyTriggeredAtBySessionId = new Map<string, number>();

const DEFAULT_OUTPUT_DIR = "artifacts/daily";

function getOutputDir(): string {
  return process.env.OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}

export const SAMPLE_TEMPLATE = `Create a daily logbook based on the session {{ sessionId }}.

## Steps

1. Check today's date ({{ dateJp }})
2. Create \`{{ outputDir }}/{{ date }}_logbook.md\` (append or update if it exists)
3. Report the created filename

## Guidelines

- Do not overwrite existing files; append or update instead
- Keep the logbook concise and focused on key points
- Prioritize discussion highlights, decisions made, and next actions
- Output language is template-driven (this default template uses English)
- Clearly separate facts from opinions (speculation/evaluation)

## Usage
{{ usage }}`;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[sS][kK]-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\b/g,
  /(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
];

export function maskSecrets(value: string): string {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
}

type Logger = PluginInput["client"];

type AppLogSink = {
  warn: (message: string) => Promise<void> | void;
  error: (message: string, error?: unknown) => Promise<void> | void;
  info?: (message: string) => Promise<void> | void;
};

function createV1LogSink(client: Logger): AppLogSink {
  return {
    warn: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "warn", message } });
      } catch {}
    },
    error: async (message, error) => {
      const errorMessage = error instanceof Error ? error.message : String(error ?? "");
      const fullMessage = errorMessage ? `${message}: ${errorMessage}` : message;
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "error", message: fullMessage } });
      } catch {}
    },
    info: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "info", message } });
      } catch {}
    },
  };
}

function createV2LogSink(): AppLogSink {
  return {
    warn: (message) => {
      console.warn(`[${SERVICE_NAME}] ${message}`);
    },
    error: (message, error) => {
      const errorMessage = error instanceof Error ? error.message : error !== undefined ? String(error) : "";
      const fullMessage = errorMessage ? `${message}: ${errorMessage}` : message;
      console.error(`[${SERVICE_NAME}] ${fullMessage}`);
    },
    info: (message) => {
      console.log(`[${SERVICE_NAME}] ${message}`);
    },
  };
}

function isPluginDisabled(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true";
}

function isRedactEnabled(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_REDACT !== "false";
}

function isTranscriptIncluded(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT !== "false";
}

function isDailyLimitEnabled(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT === "true";
}

export function getThrottleWindowMs(): number {
  const rawValue = process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
  if (rawValue === undefined || rawValue === "") {
    return DUPLICATE_WINDOW_MS;
  }
  const parsedMs = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedMs) || parsedMs < 0) {
    return DUPLICATE_WINDOW_MS;
  }
  return parsedMs;
}

export function isUsageProjectOnly(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY !== "false";
}

export function getDbPath(): string {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH;
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return join(homedir(), ".local/share/opencode/opencode.db");
}

export type UsageStats = {
  dayCost: number;
  sessionCost: number | null;
  tokensInput: number;
  tokensOutput: number;
  cacheRead: number;
  sessionsToday: number;
  totalCost: number;
};

function resolveProjectId(db: InstanceType<typeof Database>, normalizedDir: string): string | null {
  try {
    const stmt = db.prepare("SELECT id FROM project WHERE worktree = ?");
    const row = stmt.get(normalizedDir) as { id: string } | undefined;
    if (row) return row.id;
    return null;
  } catch {
    return null;
  }
}

function toYyyyMmDd(date: string): string {
  if (date.length === 8) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  return date;
}

function queryDailyStats(
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
    return stmt.get(projectId, dateStr) as { sessionsToday: number; dayCost: number; tokensInput: number; tokensOutput: number; cacheRead: number } | undefined;
  }
  const stmt = db.prepare(
    `SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE date(datetime(time_created/1000,'unixepoch','localtime')) = ?`,
  );
  return stmt.get(dateStr) as { sessionsToday: number; dayCost: number; tokensInput: number; tokensOutput: number; cacheRead: number } | undefined;
}

function queryTotalStats(
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

function querySessionCost(db: InstanceType<typeof Database>, sessionId: string): number | null {
  try {
    const stmt = db.prepare(`SELECT cost FROM session WHERE id = ?`);
    const row = stmt.get(sessionId) as { cost: number | null } | undefined;
    if (row && row.cost !== null && row.cost !== undefined) return Number(row.cost);
    return null;
  } catch {
    return null;
  }
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

export function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

export function formatUsageTable(stats: UsageStats | null, date: string, projectDisplayName?: string): string {
  if (!stats) return "";
  const displayDate = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  const heading = projectDisplayName ? `## Usage — ${displayDate} (project: ${projectDisplayName})` : `## Usage — ${displayDate}`;
  const hasSessionCost = stats.sessionCost !== null && stats.sessionCost !== undefined;
  const costLabel = hasSessionCost ? "Cost (本日/セッション)" : "Cost (本日)";
  const costValue = hasSessionCost ? `${formatCost(stats.dayCost)} / ${formatCost(stats.sessionCost as number)}` : formatCost(stats.dayCost);
  const tokensValue = `${formatTokens(stats.tokensInput)} / ${formatTokens(stats.tokensOutput)} / ${formatTokens(stats.cacheRead)}`;
  return `${heading}\n| 項目 | 値 |\n|---|---|\n| ${costLabel} | ${costValue} |\n| Tokens Input / Output / Cache Read | ${tokensValue} |\n| Sessions (本日) | ${stats.sessionsToday} |\n| Total Cost (累計) | ${formatCost(stats.totalCost)} |`;
}

function formatDateTokens(now: Date): { date: string; dateJp: string } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return {
    date: `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
    dateJp: `${year}年${month}月${day}日`,
  };
}

export function replaceTemplateVariables(
  template: string,
  sessionId: string,
  now: Date,
  outputDir: string,
  usageTable?: string,
): string {
  const { date, dateJp } = formatDateTokens(now);
  return template
    .replace(/\{\{\s*sessionId\s*\}\}/g, () => sessionId)
    .replace(/\{\{\s*date\s*\}\}/g, () => date)
    .replace(/\{\{\s*dateJp\s*\}\}/g, () => dateJp)
    .replace(/\{\{\s*outputDir\s*\}\}/g, () => outputDir)
    .replace(/\{\{\s*usage\s*\}\}/g, () => usageTable ?? "")
    .replace(/\{\{\s*usageTable\s*\}\}/g, () => usageTable ?? "");
}

function loadTemplate(directory: string): string {
  const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
  if (!customTemplatePath) return SAMPLE_TEMPLATE;
  const resolvedTemplatePath = resolve(directory, customTemplatePath);
  return readFileSync(resolvedTemplatePath, "utf-8");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)`;
}

function extractReadableText(part: { type: string; [key: string]: unknown }): string {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  return "";
}

export function buildTranscript(
  messages: Array<{ info: { role: "user" | "assistant" }; parts: Array<{ type: string; [key: string]: unknown }> }>,
): string {
  const recentMessages = messages.slice(-TRANSCRIPT_MAX_MESSAGES);
  const transcriptLines = recentMessages
    .map(({ info, parts }) => {
      const roleLabel = info.role === "user" ? "User" : "Assistant";
      const text = parts
        .map((part) => extractReadableText(part))
        .join("\n")
        .trim();
      if (!text) return "";
      return `[${roleLabel}]\n${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
  if (!transcriptLines) return "(No summarizable text history found in the source session)";
  const maskedTranscript = isRedactEnabled() ? maskSecrets(transcriptLines) : transcriptLines;
  return truncateText(maskedTranscript, TRANSCRIPT_MAX_CHARS);
}

export function buildPrompt(
  template: string,
  sessionId: string,
  transcript: string,
  includeTranscript: boolean,
  outputDir: string,
  now: Date,
  usageTable?: string,
): string {
  const replacedTemplate = replaceTemplateVariables(template, sessionId, now, outputDir, usageTable);
  let basePrompt: string;
  if (!includeTranscript || !transcript) {
    basePrompt = replacedTemplate;
  } else {
    basePrompt = `${replacedTemplate}

---
Below is an excerpt of the session ${sessionId} history. Create the daily logbook based on this history.

${transcript}`;
  }
  return basePrompt;
}

export function isWithinWindow(lastTriggeredAt: number | undefined, nowMs: number, windowMs: number): boolean {
  if (lastTriggeredAt === undefined) return false;
  return nowMs - lastTriggeredAt < windowMs;
}

function isDuplicateTrigger(sessionId: string, nowMs: number, windowMs: number): boolean {
  return isWithinWindow(recentlyTriggeredAtBySessionId.get(sessionId), nowMs, windowMs);
}

function pruneExpiredGuards(nowMs: number, windowMs: number): void {
  for (const [sessionId, timestamp] of recentlyTriggeredAtBySessionId.entries()) {
    if (nowMs - timestamp >= windowMs * 2) {
      recentlyTriggeredAtBySessionId.delete(sessionId);
    }
  }
}

export function isDailyLogbookExists(directory: string, outputDir: string, date: string): boolean {
  const dailyLogbookPath = resolve(directory, outputDir, `${date}_logbook.md`);
  return existsSync(dailyLogbookPath);
}

// ---------------------------------------------------------------------------
// Shared core: DRY for V1 event and V2 handleV2IdleEvent
// ---------------------------------------------------------------------------

type SessionAdapter = {
  get: (sessionId: string) => Promise<unknown>;
  getMessages: (sessionId: string) => Promise<unknown>;
  create: (title: string) => Promise<unknown>;
  prompt: (sessionId: string, text: string) => Promise<unknown>;
};

function resolveUsageTable(directory: string, sessionId: string, date: string): string | undefined {
  const stats = getUsageStats({ directory, sessionId, date, projectOnly: isUsageProjectOnly() });
  if (!stats) return undefined;
  const projectDisplayName = basename(resolve(directory));
  const displayDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const table = formatUsageTable(stats, displayDate, projectDisplayName);
  return table || undefined;
}

function resolveTemplate(directory: string): string {
  return loadTemplate(directory);
}

function parseSourceResult(result: unknown): { ok: boolean; error?: unknown; isGenerated?: boolean } {
  const typed = result as { error?: unknown; data?: { title?: string }; title?: string };
  if (typed?.error) return { ok: false, error: typed.error };
  const title = typed?.data?.title ?? typed?.title ?? "";
  if (title.startsWith(GENERATED_TITLE_PREFIX)) return { ok: false, isGenerated: true };
  return { ok: true };
}

function parseMessagesResult(result: unknown): { error?: unknown; data: Array<{ info: { role: "user" | "assistant" }; parts: Array<{ type: string; [key: string]: unknown }> }> } {
  const typed = result as { data?: unknown[]; messages?: unknown[]; error?: unknown };
  if (typed?.error) return { error: typed.error, data: [] };
  const data = (typed?.data ?? typed?.messages ?? typed ?? []) as Array<{
    info: { role: "user" | "assistant" };
    parts: Array<{ type: string; [key: string]: unknown }>;
  }>;
  const safe = Array.isArray(data) ? data : [];
  return { data: safe };
}

function parseCreateResult(result: unknown): { error?: unknown; id?: string } {
  const typed = result as { data?: { id: string }; id?: string; sessionID?: string; error?: unknown };
  if (typed?.error) return { error: typed.error };
  const id = typed?.data?.id ?? typed?.id ?? typed?.sessionID;
  if (!id) return { error: "missing session id" };
  return { id };
}

function isThrottled(sessionId: string, nowMs: number, windowMs: number): boolean {
  return inFlightSessionIds.has(sessionId) || isDuplicateTrigger(sessionId, nowMs, windowMs);
}

function isDailyLimitedInFlight(date: string, isDailyLimited: boolean): boolean {
  return isDailyLimited && dailyLimitInFlightByDate.has(date);
}

function getDailyFileAction(isDailyLimited: boolean, directory: string, outputDir: string, date: string): "skip" | "warnCustom" | "continue" {
  if (!isDailyLimited) return "continue";
  if (process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE) return "warnCustom";
  if (isDailyLogbookExists(directory, outputDir, date)) return "skip";
  return "continue";
}

function buildTranscriptFromData(data: Array<{ info: { role: "user" | "assistant" }; parts: Array<{ type: string; [key: string]: unknown }> }>): string {
  return isTranscriptIncluded() ? buildTranscript(data) : "";
}

function handleDailyFileAction(action: "skip" | "warnCustom" | "continue", sink: AppLogSink, date: string): boolean {
  if (action === "warnCustom") {
    void sink.warn(
      "OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT is not supported together with OPENCODE_DAILY_LOGBOOK_TEMPLATE (file name pattern is unknown). Daily limit check is skipped.",
    );
    return false;
  }
  if (action === "skip") {
    void sink.warn(`Daily logbook for ${date} already exists. Skipping generation (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
    return true;
  }
  return false;
}

function getUsageAndTemplate(directory: string, sessionId: string, date: string, sink: AppLogSink): { usageTable: string | undefined; template: string } {
  let usageTable: string | undefined;
  try {
    usageTable = resolveUsageTable(directory, sessionId, date);
  } catch (error) {
    void sink.warn(`Failed to get usage stats: ${error instanceof Error ? error.message : String(error)}`);
  }
  let template: string;
  try {
    template = resolveTemplate(directory);
  } catch (error) {
    const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
    void sink.warn(`Template load failed (${customTemplatePath ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`);
    void sink.error("Template load error", error);
    template = SAMPLE_TEMPLATE;
  }
  return { usageTable, template };
}

function shouldAbortSource(parsed: { ok: boolean; error?: unknown; isGenerated?: boolean }, sink: AppLogSink): boolean {
  if (parsed.error) {
    void sink.error("Failed to fetch source session", parsed.error);
    return true;
  }
  if (parsed.isGenerated) return true;
  return false;
}

function shouldAbortMessages(parsed: { error?: unknown }, sink: AppLogSink): boolean {
  if (parsed.error) {
    void sink.error("Failed to load source session messages", parsed.error);
    return true;
  }
  return false;
}

function shouldAbortCreate(parsed: { error?: unknown }, sink: AppLogSink): boolean {
  if (parsed.error) {
    void sink.error("Failed to create daily logbook session", parsed.error);
    return true;
  }
  return false;
}

function shouldAbortPrompt(result: { error?: unknown }, sink: AppLogSink): boolean {
  if (result.error) {
    void sink.error("Failed to send daily logbook prompt", result.error);
    return true;
  }
  return false;
}

export async function generateDailyLogbookCore(params: {
  sessionId: string;
  directory: string;
  sink: AppLogSink;
  adapter: SessionAdapter;
}): Promise<void> {
  if (isPluginDisabled()) return;
  const nowMs = Date.now();
  const throttleWindowMs = getThrottleWindowMs();
  pruneExpiredGuards(nowMs, throttleWindowMs);
  if (isThrottled(params.sessionId, nowMs, throttleWindowMs)) return;
  const now = new Date();
  const { date } = formatDateTokens(now);
  const outputDir = getOutputDir();
  const isDailyLimited = isDailyLimitEnabled();
  if (isDailyLimitedInFlight(date, isDailyLimited)) {
    await params.sink.warn(`Daily logbook for ${date} is already being generated. Skipping (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
    return;
  }
  inFlightSessionIds.add(params.sessionId);
  if (isDailyLimited) dailyLimitInFlightByDate.add(date);
  try {
    {
      let getResult: unknown;
      try {
        getResult = await params.adapter.get(params.sessionId);
      } catch (error) {
        getResult = { error };
      }
      const parsed = parseSourceResult(getResult);
      if (shouldAbortSource(parsed, params.sink)) return;
    }
    {
      const action = getDailyFileAction(isDailyLimited, params.directory, outputDir, date);
      if (handleDailyFileAction(action, params.sink, date)) return;
    }
    const { usageTable, template } = getUsageAndTemplate(params.directory, params.sessionId, date, params.sink);
    let msgResult: unknown;
    try {
      msgResult = await params.adapter.getMessages(params.sessionId);
    } catch (error) {
      msgResult = { error };
    }
    const parsedMsg = parseMessagesResult(msgResult);
    if (shouldAbortMessages(parsedMsg, params.sink)) return;
    const transcript = buildTranscriptFromData(parsedMsg.data);
    const includeTranscript = isTranscriptIncluded();
    const promptOutputDir = isDailyLimited ? resolve(params.directory, outputDir) : outputDir;
    const prompt = buildPrompt(template, params.sessionId, transcript, includeTranscript, promptOutputDir, now, usageTable);
    let createResult: unknown;
    try {
      createResult = await params.adapter.create(`${GENERATED_TITLE_PREFIX} ${date}`);
    } catch (error) {
      createResult = { error };
    }
    const parsedCreate = parseCreateResult(createResult);
    if (shouldAbortCreate(parsedCreate, params.sink)) return;
    const generatedId = parsedCreate.id as string;
    {
      let promptResult: unknown;
      try {
        promptResult = await params.adapter.prompt(generatedId, prompt);
      } catch (error) {
        promptResult = { error };
      }
      const typed = promptResult as { error?: unknown };
      if (shouldAbortPrompt(typed, params.sink)) return;
    }
    recentlyTriggeredAtBySessionId.set(params.sessionId, nowMs);
  } catch (error) {
    await params.sink.error("Unhandled error while generating daily logbook", error);
  } finally {
    inFlightSessionIds.delete(params.sessionId);
    if (isDailyLimited) dailyLimitInFlightByDate.delete(date);
  }
}

export const DailyLogbookPlugin: Plugin = async ({ client, directory }) => {
  await client.app.log({
    body: {
      service: SERVICE_NAME,
      level: "info",
      message: "daily-logbook plugin loaded",
    },
  });
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sink = createV1LogSink(client);
      const adapter: SessionAdapter = {
        get: (id) => client.session.get({ path: { id } }) as Promise<unknown>,
        getMessages: (id) => client.session.messages({ path: { id } }) as Promise<unknown>,
        create: (title) => client.session.create({ body: { title } }) as Promise<unknown>,
        prompt: (id, text) => client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } }) as Promise<unknown>,
      };
      await generateDailyLogbookCore({ sessionId: event.properties.sessionID, directory, sink, adapter });
    },
  };
};

// ---------------------------------------------------------------------------
// V2 Plugin
// ---------------------------------------------------------------------------

export async function handleV2IdleEvent(params: {
  sessionID: string;
  directory: string;
  sink: AppLogSink;
  session: {
    get: (input: { sessionID: string }) => Promise<unknown>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    messages?: (input: { path: { id: string } }) => Promise<unknown>;
    create: (input: { title: string }) => Promise<unknown>;
    prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    promptAsync?: (input: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => Promise<unknown>;
    generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  };
}): Promise<void> {
  const adapter: SessionAdapter = {
    get: (id) => params.session.get({ sessionID: id }),
    getMessages: async (id) => {
      if (params.session.context) return params.session.context({ sessionID: id });
      if (params.session.messages) return params.session.messages({ path: { id } });
      return { error: new Error("no messages method available") };
    },
    create: (title) => params.session.create({ title }),
    prompt: async (id, text) => {
      if (params.session.prompt) return params.session.prompt({ sessionID: id, text });
      if (params.session.generate) return params.session.generate({ sessionID: id, text });
      if (params.session.promptAsync) return params.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } });
      return { error: new Error("no prompt method available on session") };
    },
  };
  await generateDailyLogbookCore({ sessionId: params.sessionID, directory: params.directory, sink: params.sink, adapter });
}

async function v2Setup(ctx: unknown): Promise<(() => void) | void> {
  const anyCtx = ctx as {
    location?: { directory?: string };
    directory?: string;
    app?: { name?: string; version?: string; channel?: string };
    event?: {
      subscribe?: ((opts: { signal: AbortSignal }) => AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>) &
        ((type: string) => unknown);
    };
    session?: {
      get: (input: { sessionID: string }) => Promise<unknown>;
      context?: (input: { sessionID: string }) => Promise<unknown>;
      messages?: (input: { path: { id: string } }) => Promise<unknown>;
      create: (input: { title: string }) => Promise<unknown>;
      prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    };
  };
  const directory = anyCtx.location?.directory ?? anyCtx.directory ?? process.cwd();
  const sink = createV2LogSink();
  await sink.info?.(`daily-logbook plugin loaded (v2) app=${anyCtx.app?.name ?? "unknown"} ${anyCtx.app?.version ?? ""}`);
  const controller = new AbortController();
  void runV2EventLoop(anyCtx, sink, directory, controller);
  return () => controller.abort();
}

async function resolveV2Iterable(
  subscribe: unknown,
  signal: AbortSignal,
  sink: AppLogSink,
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  const sub = subscribe as unknown as ((opts: { signal: AbortSignal }) => unknown) & ((type: string) => unknown);
  if (!sub) return undefined;
  // Try promise style first: subscribe({ signal })
  try {
    const raw = (sub as (opts: { signal: AbortSignal }) => unknown)({ signal });
    if (isAsyncIterable(raw)) return raw as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
    // If raw is not iterable, it may be effect host returning non-iterable; try effect style as fallback
    const raw2 = trySubscribeEffect(sub, sink);
    if (raw2) return raw2;
  } catch {
    const raw2 = trySubscribeEffect(sub, sink);
    if (raw2) return raw2;
  }
  // If promise style threw or returned non-iterable, try effect style directly
  return trySubscribeEffect(sub, sink);
}

function trySubscribeEffect(
  sub: (type: string) => unknown,
  _sink: AppLogSink,
): AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined {
  try {
    const raw2 = (sub as (type: string) => unknown)("session.idle");
    if (isAsyncIterable(raw2)) return raw2 as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
  } catch {}
  return undefined;
}

function isAsyncIterable(value: unknown): boolean {
  return !!value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

async function runV2EventLoop(
  anyCtx: {
    event?: { subscribe?: unknown };
    session?: {
      get: (input: { sessionID: string }) => Promise<unknown>;
      context?: (input: { sessionID: string }) => Promise<unknown>;
      messages?: (input: { path: { id: string } }) => Promise<unknown>;
      create: (input: { title: string }) => Promise<unknown>;
      prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    };
  },
  sink: AppLogSink,
  directory: string,
  controller: AbortController,
): Promise<void> {
  try {
    const iterable = await resolveV2Iterable(anyCtx.event?.subscribe, controller.signal, sink);
    if (!iterable) {
      await sink.warn("event.subscribe did not return AsyncIterable; v2 plugin idle");
      return;
    }
    for await (const event of iterable as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>) {
        if (event.type !== "session.idle") continue;
        const data = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).data;
        const properties = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).properties;
        const sessionID = data?.sessionID ?? properties?.sessionID;
        if (!sessionID) {
          await sink.warn("session.idle event missing sessionID; skipping");
          continue;
        }
        if (!anyCtx.session) {
          await sink.warn("ctx.session not available; skipping idle handling");
          continue;
        }
        await handleV2IdleEvent({ sessionID, directory, sink, session: anyCtx.session });
      }
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "AbortError") return;
      await sink.error("v2 event loop error", error);
    }
}

function tryCreateV2Plugin(): unknown {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@opencode-ai/plugin") as { Plugin?: { define?: (p: { id: string; setup: (ctx: unknown) => Promise<unknown> }) => unknown } };
    const define = mod?.Plugin?.define;
    if (typeof define === "function") {
      return define({ id: "smapira.daily-logbook", setup: v2Setup });
    }
  } catch {}
  try {
    const require = createRequire(import.meta.url);
    const modEffect = require("@opencode-ai/plugin/effect") as { Plugin?: { define?: (p: { id: string; effect: (ctx: unknown) => unknown }) => unknown } };
    const defineEffect = modEffect?.Plugin?.define;
    if (typeof defineEffect === "function") {
      return defineEffect({ id: "smapira.daily-logbook", effect: v2Setup as unknown as (ctx: unknown) => unknown });
    }
  } catch {}
  return { id: "smapira.daily-logbook", setup: v2Setup, effect: v2Setup };
}

export const DailyLogbookPluginV2: unknown = tryCreateV2Plugin();

export default {
  id: "smapira.daily-logbook",
  setup: v2Setup,
  effect: v2Setup,
} as unknown as typeof DailyLogbookPlugin | typeof DailyLogbookPluginV2;
