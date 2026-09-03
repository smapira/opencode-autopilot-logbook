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

async function v2Setup(ctx: unknown): Promise<(() => void) | { event: (input: { event: { type: string; data?: unknown; properties?: unknown } }) => Promise<void> } | void> {
  const anyCtx = ctx as {
    location?: { directory?: string };
    directory?: string;
    worktree?: string;
    serverUrl?: URL | string;
    app?: { name?: string; version?: string; channel?: string };
    client?: { event?: { subscribe?: unknown }; session?: unknown };
    event?: {
      subscribe?: ((opts: { signal: AbortSignal }) => unknown) & ((type: string) => unknown);
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
  const directory = anyCtx.location?.directory ?? anyCtx.directory ?? anyCtx.worktree ?? process.cwd();
  const sink = createV2LogSink();
  // 恒久対応: ctx の形状を診断ログに出し、beta での event 位置の差異を可視化する
  const ctxKeys = (() => {
    try {
      return Object.keys(anyCtx as unknown as Record<string, unknown>).sort().join(",");
    } catch {
      return "unknown";
    }
  })();
  const hasEventSubscribe = typeof anyCtx.event?.subscribe === "function";
  const hasClientEventSubscribe = typeof anyCtx.client?.event?.subscribe === "function";
  const hasSession = !!anyCtx.session;
  await sink.info?.(
    `daily-logbook plugin loaded (v2) app=${anyCtx.app?.name ?? "unknown"} ${anyCtx.app?.version ?? ""} ctxKeys=[${ctxKeys}] event.subscribe=${hasEventSubscribe ? "yes" : "no"} client.event.subscribe=${hasClientEventSubscribe ? "yes" : "no"} session=${hasSession ? "yes" : "no"}`,
  );

  // 恒久対応: beta 18999 の PluginContext は {agent,aisdk,catalog,command,integration,options,plugin,reference,skill}
  // のみで event/session を持たない。ctx.event が無い場合は、ホストが旧来の
  // `return {event: async ({event})=>{}}` 形式をまだサポートしている可能性に賭け、
  // event フックを返すフォールバックを用意する。ホストが ctx.event.subscribe を
  // 持つ場合は従来通りそちらを優先する。
  const eventHost: { subscribe?: unknown } | undefined = (anyCtx.event as unknown as { subscribe?: unknown }) ?? (anyCtx.client?.event as unknown as { subscribe?: unknown } | undefined);

  if (eventHost?.subscribe) {
    const controller = new AbortController();
    // session が ctx に無い場合は SDK から自前で作るフォールバックを試みる
    const session = (anyCtx.session as unknown as {
      get: (input: { sessionID: string }) => Promise<unknown>;
      context?: (input: { sessionID: string }) => Promise<unknown>;
      messages?: (input: { path: { id: string } }) => Promise<unknown>;
      create: (input: { title: string }) => Promise<unknown>;
      prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    } | undefined) ?? (await createFallbackSessionAdapter(sink, anyCtx.serverUrl));
    if (!session) {
      await sink.warn("v2: no session adapter available (ctx.session missing and fallback failed); idle handling disabled");
      return;
    }
    void runV2EventLoop({ event: eventHost, session }, sink, directory, controller);
    return () => controller.abort();
  }

  // event 購読 API が無い beta では、SDK から自前で event 購読を試みる
  // （opencode2 の server は localhost:49374 などで待受）。成功すれば
  // そちらで idle を購読し、失敗すれば旧来の return {event} にフォールバックする。
  // session は SDK 依存を避け、ファイル直書きのフォールバックを使用する（SDK の session.create が 405 となる環境があるため）。
  const sdkFallback = await createFallbackSdkClient(sink);
  if (sdkFallback) {
    const controller = new AbortController();
    const sdkEventHost = sdkFallback.client.event as unknown as { subscribe?: unknown } | undefined;
    if (sdkEventHost?.subscribe) {
      await sink.info?.(`v2: using SDK fallback for event subscription via ${sdkFallback.url}`);
      const fileSession = await createFallbackSessionAdapter(sink, null);
      if (!fileSession) {
        await sink.warn("v2: SDK event fallback has no file session; idle handling disabled");
        return;
      }
      void runV2EventLoop({ event: sdkEventHost, session: fileSession }, sink, directory, controller);
      return () => controller.abort();
    }
  }

  // SDK フォールバックも不可の場合は、旧来の event フック返却でホストに配信を委ねる
  await sink.warn("v2: ctx.event.subscribe not found (ctxKeys=[" + ctxKeys + "]); falling back to return {event} hook. If idle is still not delivered, use opencode (v1) with 2.0.3.");
  const fallbackSession = (anyCtx.session as unknown as {
    get: (input: { sessionID: string }) => Promise<unknown>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    messages?: (input: { path: { id: string } }) => Promise<unknown>;
    create: (input: { title: string }) => Promise<unknown>;
    prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    promptAsync?: (input: unknown) => Promise<unknown>;
  } | undefined) ?? (await createFallbackSessionAdapter(sink, anyCtx.serverUrl));
  if (!fallbackSession) {
    await sink.warn("v2: no session adapter for fallback hook; idle handling disabled");
    return;
  }
  return {
    event: async ({ event }: { event: { type: string; data?: unknown; properties?: unknown } }) => {
      if (event.type !== "session.idle") return;
      const data = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).data;
      const properties = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).properties;
      const sessionID = (data as { sessionID?: string } | undefined)?.sessionID ?? (properties as { sessionID?: string } | undefined)?.sessionID;
      if (!sessionID) {
        await sink.warn("session.idle event missing sessionID; skipping");
        return;
      }
      await handleV2IdleEvent({ sessionID, directory, sink, session: fallbackSession });
    },
  };
}

async function createFallbackSessionAdapter(
  sink: AppLogSink,
  _serverUrl: unknown,
): Promise<
  | {
      get: (input: { sessionID: string }) => Promise<unknown>;
      context?: (input: { sessionID: string }) => Promise<unknown>;
      messages?: (input: { path: { id: string } }) => Promise<unknown>;
      create: (input: { title: string }) => Promise<unknown>;
      prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    }
  | undefined
> {
  // v2 beta で ctx.session が無い場合の最終手段: SDK 依存を断ち、直接ファイルに書き込むモック
  // opencode2 本体（49374）の session.create が 405 となる環境では SDK 経由が不安定なため、ファイル直書きで確実に日誌を生成する
  await sink.info?.("using file-direct fallback session adapter (no SDK)");
  return {
    get: async () => ({ data: { title: "fallback" } }),
    context: async () => ({ data: [] }),
    create: async (input: { title: string }) => ({ data: { id: `fallback-${Date.now()}` }, title: input.title }),
    prompt: async (input: { sessionID: string; text: string }) => {
      try {
        const match = input.text.match(/Create `([^`]+)`/);
        const filePath = match ? match[1] : `artifacts/daily/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_logbook.md`;
        const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
        const { resolve, dirname } = await import("node:path");
        const absPath = resolve(process.cwd(), filePath);
        mkdirSync(dirname(absPath), { recursive: true });
        const existing = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
        const content = `${existing ? existing + "\n\n" : ""}# Daily Logbook ${new Date().toISOString().slice(0, 10)}\n\n${input.text.slice(0, 2000)}\n`;
        writeFileSync(absPath, content);
        await sink.info?.(`fallback direct write to ${absPath}`);
      } catch (error) {
        await sink.warn(`fallback direct write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {};
    },
  } as unknown as {
          get: (input: { sessionID: string }) => Promise<unknown>;
          create: (input: { title: string }) => Promise<unknown>;
          prompt: (input: { sessionID: string; text: string }) => Promise<unknown>;
        };
}

async function resolveV2Iterable(
  subscribe: unknown,
  signal: AbortSignal,
  sink: AppLogSink,
  eventHost?: { subscribe?: unknown },
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  const sub = subscribe as unknown as ((opts: { signal: AbortSignal }) => unknown) & ((type: string) => unknown);
  if (!sub) {
    await sink.warn("resolveV2Iterable: subscribe is falsy");
    return undefined;
  }
  const host = (eventHost ?? {}) as { subscribe?: unknown };
  // Try promise style first: subscribe({ signal }) => AsyncIterable | Stream | Promise<{stream}>
  try {
    const raw = (host.subscribe as (opts: { signal: AbortSignal }) => unknown)?.call(host, { signal }) ?? (sub as (opts: { signal: AbortSignal }) => unknown)({ signal });
    await sink.info?.(`resolveV2Iterable: subscribe({signal}) returned ${raw instanceof Promise ? "Promise" : typeof raw} ${raw && typeof raw === "object" ? `keys=[${Object.keys(raw as Record<string, unknown>).join(",")}]` : ""} isAsyncIterable=${isAsyncIterable(raw as unknown)}`);
    const asIterable = await toAsyncIterable(raw, sink, signal);
    await sink.info?.(`resolveV2Iterable: toAsyncIterable => ${asIterable ? "AsyncIterable" : "undefined"}`);
    if (asIterable) return asIterable;
    const raw2 = await trySubscribeEffect(sub, sink, signal, host);
    if (raw2) return raw2;
  } catch (error) {
    await sink.warn(`resolveV2Iterable: subscribe({signal}) threw ${error instanceof Error ? error.message : String(error)}`);
    const raw2 = await trySubscribeEffect(sub, sink, signal, host);
    if (raw2) return raw2;
  }
  const fallback = await trySubscribeEffect(sub, sink, signal, host);
  if (!fallback) await sink.warn("resolveV2Iterable: both subscribe styles returned non-AsyncIterable");
  return fallback;
}

async function trySubscribeEffect(
  sub: (type: string) => unknown,
  _sink: AppLogSink,
  signal?: AbortSignal,
  host?: { subscribe?: unknown },
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  try {
    const h = (host ?? {}) as { subscribe?: unknown };
    const fn = (h.subscribe as (type: string) => unknown) ?? (sub as (type: string) => unknown);
    const raw2 = fn.call(h as unknown as { subscribe: (type: string) => unknown }, "session.idle");
    const asIterable = await toAsyncIterable(raw2, _sink, signal);
    if (asIterable) return asIterable;
  } catch {}
  return undefined;
}

function isAsyncIterable(value: unknown): boolean {
  return !!value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

function isEffectStream(value: unknown): boolean {
  // Effect の Stream は AsyncIterable ではなく、pipe/run などの effect 固有 API を持つ
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // Stream は effect の内部タグや pipe を持つ。AsyncIterable でないことと併せて判定
  if (isAsyncIterable(value)) return false;
  return typeof v["pipe"] === "function" || "_tag" in v || "effect" in v;
}

async function toAsyncIterable(
  value: unknown,
  sink: AppLogSink,
  signal?: AbortSignal,
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  if (!value) return undefined;
  if (isAsyncIterable(value)) return value as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
  // SDK の event.subscribe は Promise<{stream: AsyncIterable}> を返すことがある
  if (value && typeof value === "object" && "stream" in (value as Record<string, unknown>)) {
    const stream = (value as Record<string, unknown>)["stream"];
    if (isAsyncIterable(stream)) return stream as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
    // stream が Effect Stream の場合も考慮
    const asIterable = await toAsyncIterable(stream, sink, signal);
    if (asIterable) return asIterable;
    await sink.warn(`toAsyncIterable: stream property exists but not AsyncIterable (keys=${Object.keys(value as Record<string, unknown>).join(",")})`);
  }
  if (isEffectStream(value)) {
    // Effect Stream は AsyncIterable ではないため、直接 for-await できない。
    // 恒久対応では `effect/Stream.toAsyncIterable` への変換が必要だが、
    // バンドルサイズを抑えるため本ビルドでは未対応とし、呼び出し側で
    // 別経路（promise style の subscribe({signal})）を試す。
    // 将来 beta の effect ホストで Stream のみが返る場合は、別途
    // `effect` ランタイムを導入して変換する。
    return undefined;
  }
  // Promise<AsyncIterable|Stream|{stream: AsyncIterable}> の可能性
  if (value instanceof Promise) {
    try {
      const resolved = await value;
      return toAsyncIterable(resolved, sink, signal);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function createFallbackSdkClient(
  sink: AppLogSink,
): Promise<{ client: { event: { subscribe: (opts: { signal: AbortSignal }) => unknown }; session: unknown }; session: {
      get: (input: { sessionID: string }) => Promise<unknown>;
      context?: (input: { sessionID: string }) => Promise<unknown>;
      messages?: (input: { path: { id: string } }) => Promise<unknown>;
      create: (input: { title: string }) => Promise<unknown>;
      prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
      promptAsync?: (input: unknown) => Promise<unknown>;
    }; url: string } | undefined> {
  const candidates: string[] = [];
  for (const key of ["OPENCODE_SERVER_URL", "OPENCODE_API_URL", "OPENCODE_SERVER"]) {
    const v = process.env[key];
    if (v) candidates.push(v);
  }
  // opencode2 本体は 49374（lsof 実測）、ORCA_AGENT_HOOK_PORT(49353) は別サービスの可能性があるため 49374 を優先
  candidates.push("http://localhost:49374");
  const envPort = process.env.ORCA_AGENT_HOOK_PORT;
  if (envPort) candidates.push(`http://localhost:${envPort}`);
  candidates.push("http://localhost:4096", "http://localhost:8080");
  const unique = [...new Set(candidates)];
  for (const url of unique) {
    // 同じ URL で v2 と v1 の両 SDK を試す（server が v1/v2 どちらでも対応できるように）
    const sdkSpecs = ["@opencode-ai/sdk/v2", "@opencode-ai/sdk"] as const;
    for (const spec of sdkSpecs) {
      try {
        let createOpencodeClient: ((opts: unknown) => unknown) | null = null;
        try {
          const m = await import(spec).catch(() => null) as unknown as { createOpencodeClient?: (opts: unknown) => unknown } | null;
          createOpencodeClient = (m?.createOpencodeClient as unknown as (opts: unknown) => unknown) ?? null;
        } catch {}
        if (!createOpencodeClient) continue;
        const client = (createOpencodeClient as (opts: unknown) => unknown)({ baseUrl: url }) as unknown as {
          event: { subscribe: (opts: { signal: AbortSignal }) => unknown };
          session: {
            get: (input: { sessionID: string }) => Promise<unknown>;
            context?: (input: { sessionID: string }) => Promise<unknown>;
            messages?: (input: { path: { id: string } }) => Promise<unknown>;
            create: (input: { title: string }) => Promise<unknown>;
            prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
            generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
            promptAsync?: (input: unknown) => Promise<unknown>;
          };
        };
        // 疎通確認: session.list と event.subscribe の両方が使えるか
        try {
          await ((client as unknown) as { session: { list: (p: unknown) => Promise<unknown> } }).session.list({ limit: 1 } as unknown as Record<string, unknown>);
          const hasEvent = typeof (client as unknown as { event: { subscribe?: unknown } }).event?.subscribe === "function";
          if (!hasEvent) throw new Error("no event.subscribe");
        } catch {
          continue;
        }
      const session = client.session as unknown as {
        get: (input: { sessionID: string }) => Promise<unknown>;
        context?: (input: { sessionID: string }) => Promise<unknown>;
        messages?: (input: { path: { id: string } }) => Promise<unknown>;
        create: (input: { title: string }) => Promise<unknown>;
        prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
        generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
        promptAsync?: (input: unknown) => Promise<unknown>;
      };
      return { client: client as unknown as { event: { subscribe: (opts: { signal: AbortSignal }) => unknown }; session: unknown }, session, url };
      } catch {}
    }
  }
  await sink.warn(`fallback SDK client: all candidates failed (${unique.join(", ")})`);
  return undefined;
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
    const iterable = await resolveV2Iterable(anyCtx.event?.subscribe, controller.signal, sink, anyCtx.event);
    if (!iterable) {
      await sink.warn(
        `event.subscribe did not return AsyncIterable (event.subscribe=${typeof anyCtx.event?.subscribe}) — trying fallback poll; v2 plugin idle subscription failed. ctx.event keys=${anyCtx.event ? Object.keys(anyCtx.event as Record<string, unknown>).join(",") : "no-event"}`,
      );
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
  // 恒久対応: @opencode-ai/plugin の v2 エントリは 1.18.x では
  // "./v2/effect" / "./v2/promise" / "." の順で提供される。
  // stable (1.18.27) と beta の両方で解決できるよう全経路を試す。
  const candidates: Array<{ spec: string; kind: "setup" | "effect" }> = [
    { spec: "@opencode-ai/plugin", kind: "setup" },
    { spec: "@opencode-ai/plugin/v2/promise", kind: "setup" },
    { spec: "@opencode-ai/plugin/v2/effect", kind: "effect" },
    { spec: "@opencode-ai/plugin/effect", kind: "effect" },
  ];
  for (const { spec, kind } of candidates) {
    try {
      const require = createRequire(import.meta.url);
      const mod = require(spec) as {
        Plugin?: { define?: (p: { id: string; setup?: unknown; effect?: unknown }) => unknown };
        define?: (p: { id: string; setup?: unknown; effect?: unknown }) => unknown;
      };
      const define = mod?.Plugin?.define ?? mod?.define;
      if (typeof define === "function") {
        if (kind === "setup") return define({ id: "smapira.daily-logbook", setup: v2Setup });
        return define({ id: "smapira.daily-logbook", effect: v2Setup as unknown as (ctx: unknown) => unknown });
      }
    } catch {}
  }
  return { id: "smapira.daily-logbook", setup: v2Setup, effect: v2Setup };
}

export const DailyLogbookPluginV2: unknown = tryCreateV2Plugin();

export default {
  id: "smapira.daily-logbook",
  setup: v2Setup,
  effect: v2Setup,
} as unknown as typeof DailyLogbookPlugin | typeof DailyLogbookPluginV2;
