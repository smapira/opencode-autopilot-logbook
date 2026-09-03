import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const SERVICE_NAME = "daily-logbook-plugin";
const GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
const DUPLICATE_WINDOW_MS = 90_000;
const TRANSCRIPT_MAX_MESSAGES = 80;
const TRANSCRIPT_MAX_CHARS = 12_000;

const inFlightSessionIds = new Set<string>();
// Date-keyed in-flight guard used only when daily-limit is enabled.
// inFlightSessionIds is per-session, so two different sessions idling at the same time
// could both pass the existence check and generate duplicates. Guarding by date prevents that.
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

// Known secret patterns. Replacement follows array order.
// The private-key block spans multiple lines, so it must be processed before other patterns
// to avoid masking only part of the block and leaving the key body exposed.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[sS][kK]-[A-Za-z0-9_-]{8,}\b/g, // OpenAI-style keys (sk-.../SK-.../sk-ant-...)
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <token>
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PATs (github_pat_...)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens (xoxb-, xoxa-, xoxp-, ...)
  // JWTs start with eyJ and have a 3-segment structure. Cap each segment to prevent
  // polynomial backtracking on long continuous strings.
  // Practical base64url segments are well below 120 characters (cap is a safety margin).
  /\beyJ[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\b/g, // JWTs (eyJ...)
  /(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
];

/**
 * Replace known secret patterns with `***`.
 *
 * This is a fail-safe to reduce accidental disclosure and does not guarantee
 * complete secrecy. Avoid including sensitive information in prompts in the first place.
 */
export function maskSecrets(value: string): string {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
}

type Logger = PluginInput["client"];

// ---------------------------------------------------------------------------
// Logger abstraction (TASK-4)
// V1: Logger = PluginInput["client"] で client.app.log が存在する。
// V2: ctx.app は { name, version, channel } のみで log メソッドを持たない。
//     代替として console.warn / console.error を用いる。
//     既存の Logger 型を直接使わず、AppLogSink に抽象化して V1/V2 両対応する。
// ---------------------------------------------------------------------------
type AppLogSink = {
  warn: (message: string) => Promise<void> | void;
  error: (message: string, error?: unknown) => Promise<void> | void;
  info?: (message: string) => Promise<void> | void;
};

// V1 log sink — retained for V1 host; not used in V2 console path but kept for hybrid compatibility.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createV1LogSink(client: Logger): AppLogSink {
  return {
    warn: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "warn", message } });
      } catch {
        // Do not let logging failures break the main flow; no-op here.
      }
    },
    error: async (message, error) => {
      const errorMessage = error instanceof Error ? error.message : String(error ?? "");
      const fullMessage = errorMessage ? `${message}: ${errorMessage}` : message;
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "error", message: fullMessage } });
      } catch {
        // Do not let logging failures break the main flow; no-op here.
      }
    },
    info: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "info", message } });
      } catch {
        // ignore
      }
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
  // Enabled by default (fail-safe). Only the exact string "false" disables it.
  return process.env.OPENCODE_DAILY_LOGBOOK_REDACT !== "false";
}

function isTranscriptIncluded(): boolean {
  // Included by default. Only the exact string "false" disables it.
  return process.env.OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT !== "false";
}

function isDailyLimitEnabled(): boolean {
  // Disabled by default. Only the exact string "true" enables it (same convention as DISABLED).
  return process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT === "true";
}

export function getThrottleWindowMs(): number {
  const rawValue = process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
  if (rawValue === undefined || rawValue === "") {
    return DUPLICATE_WINDOW_MS;
  }

  const parsedMs = Number.parseInt(rawValue, 10);
  // Fall back to the default (for backward compatibility) when the value cannot be parsed as an integer or is negative.
  if (Number.isNaN(parsedMs) || parsedMs < 0) {
    return DUPLICATE_WINDOW_MS;
  }

  return parsedMs;
}

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

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

export function getUsageStats(params: {
  directory: string;
  sessionId: string;
  date: string;
  projectOnly: boolean;
  dbPath?: string;
}): UsageStats | null {
  const dbPath = params.dbPath ?? getDbPath();

  if (!existsSync(dbPath)) {
    return null;
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true } as unknown as Record<string, unknown>);

    const normalizedDir = resolve(params.directory);
    let projectId: string | null = null;
    try {
      const projStmt = db.prepare("SELECT id FROM project WHERE worktree = ?");
      const projRow = projStmt.get(normalizedDir) as { id: string } | undefined;
      if (projRow) {
        projectId = projRow.id;
      }
    } catch {
      // Fallback to whole aggregation when project lookup fails.
    }

    const yyyyMmDd =
      params.date.length === 8
        ? `${params.date.slice(0, 4)}-${params.date.slice(4, 6)}-${params.date.slice(6, 8)}`
        : params.date;

    let dailyRow: {
      sessionsToday: number;
      dayCost: number;
      tokensInput: number;
      tokensOutput: number;
      cacheRead: number;
    } | undefined;

    if (projectId && params.projectOnly) {
      const stmt = db.prepare(
        `SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE project_id = ? AND date(datetime(time_created/1000,'unixepoch','localtime')) = ?`,
      );
      dailyRow = stmt.get(projectId, yyyyMmDd) as typeof dailyRow;
    } else {
      const stmt = db.prepare(
        `SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE date(datetime(time_created/1000,'unixepoch','localtime')) = ?`,
      );
      dailyRow = stmt.get(yyyyMmDd) as typeof dailyRow;
    }

    let totalRow: { totalCost: number } | undefined;
    if (projectId && params.projectOnly) {
      const stmt = db.prepare(`SELECT coalesce(sum(cost),0) as totalCost FROM session WHERE project_id = ?`);
      totalRow = stmt.get(projectId) as typeof totalRow;
    } else {
      const stmt = db.prepare(`SELECT coalesce(sum(cost),0) as totalCost FROM session`);
      totalRow = stmt.get() as typeof totalRow;
    }

    let sessionCost: number | null = null;
    try {
      const stmt = db.prepare(`SELECT cost FROM session WHERE id = ?`);
      const row = stmt.get(params.sessionId) as { cost: number | null } | undefined;
      if (row && row.cost !== null && row.cost !== undefined) {
        sessionCost = Number(row.cost);
      }
    } catch {
      sessionCost = null;
    }

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
    } catch {
      // ignore close errors
    }
  }
}

export function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return `${value}`;
}

export function formatUsageTable(
  stats: UsageStats | null,
  date: string,
  projectDisplayName?: string,
): string {
  if (!stats) {
    return "";
  }
  const displayDate =
    date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  const heading = projectDisplayName
    ? `## Usage — ${displayDate} (project: ${projectDisplayName})`
    : `## Usage — ${displayDate}`;
  const hasSessionCost = stats.sessionCost !== null && stats.sessionCost !== undefined;
  const costLabel = hasSessionCost ? "Cost (本日/セッション)" : "Cost (本日)";
  const costValue = hasSessionCost
    ? `${formatCost(stats.dayCost)} / ${formatCost(stats.sessionCost as number)}`
    : formatCost(stats.dayCost);
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
  if (!customTemplatePath) {
    return SAMPLE_TEMPLATE;
  }

  const resolvedTemplatePath = resolve(directory, customTemplatePath);
  return readFileSync(resolvedTemplatePath, "utf-8");
}

async function logWarn(client: Logger, message: string): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: SERVICE_NAME,
        level: "warn",
        message,
      },
    });
  } catch {
    // Do not let logging failures break the main flow; no-op here.
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...(truncated)`;
}

function extractReadableText(part: { type: string; [key: string]: unknown }): string {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }

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

      if (!text) {
        return "";
      }

      return `[${roleLabel}]\n${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");

  if (!transcriptLines) {
    return "(No summarizable text history found in the source session)";
  }

  // Masking must happen before truncation.
  // If applied after truncation, a secret split at the cut point would be missed.
  const maskedTranscript = isRedactEnabled() ? maskSecrets(transcriptLines) : transcriptLines;

  return truncateText(maskedTranscript, TRANSCRIPT_MAX_CHARS);
}

/**
 * Build the prompt by appending the transcript to the template.
 *
 * `now` is the time resolved in the event handler and injected here. Avoid calling `new Date()`
 * again inside to prevent `{{ date }}` from drifting to a different day across midnight,
 * which would break the daily-limit date-key consistency.
 */
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
  // When INCLUDE_TRANSCRIPT is false, omit the transcript section entirely.
  // The transcript never enters the prompt, regardless of the REDACT setting.
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

async function logError(client: Logger, message: string, error: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  try {
    await client.app.log({
      body: {
        service: SERVICE_NAME,
        level: "error",
        message: `${message}: ${errorMessage}`,
      },
    });
  } catch {
    // Do not let logging failures break the main flow; no-op here.
  }
}

/**
 * Pure predicate for whether the last trigger is within `windowMs`.
 * Does not depend on the module-level Map, so it is easy to unit-test.
 */
export function isWithinWindow(
  lastTriggeredAt: number | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  if (lastTriggeredAt === undefined) {
    return false;
  }

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

/**
 * File-based check for whether the default file `{{ outputDir }}/{{ date }}_logbook.md` already exists
 * (survives process restarts).
 *
 * Path resolution follows the same `directory` (plugin launch directory) basis as loadTemplate.
 * Independent of CWD, so it is consistent no matter where it is launched from.
 */
export function isDailyLogbookExists(directory: string, outputDir: string, date: string): boolean {
  const dailyLogbookPath = resolve(directory, outputDir, `${date}_logbook.md`);
  return existsSync(dailyLogbookPath);
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
      if (event.type !== "session.idle") {
        return;
      }

      if (isPluginDisabled()) {
        return;
      }

      const originalSessionId = event.properties.sessionID;
      const nowMs = Date.now();
      const throttleWindowMs = getThrottleWindowMs();
      pruneExpiredGuards(nowMs, throttleWindowMs);

      if (inFlightSessionIds.has(originalSessionId) || isDuplicateTrigger(originalSessionId, nowMs, throttleWindowMs)) {
        return;
      }

      // Resolve date and output directory once for the entire event handling,
      // and reuse the same values for the existence check, prompt, and title.
      // Passing `now` through to buildPrompt keeps the prompt date consistent with the check and title across midnight.
      const now = new Date();
      const { date } = formatDateTokens(now);
      const outputDir = getOutputDir();
      const isDailyLimited = isDailyLimitEnabled();

      // When daily-limit is enabled, check the date-keyed global in-flight guard.
      // Without this, two different sessions idling at the same time could both pass the existence check
      // and trigger duplicate generation for the same date.
      if (isDailyLimited && dailyLimitInFlightByDate.has(date)) {
        await logWarn(
          client,
          `Daily logbook for ${date} is already being generated. Skipping (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`,
        );
        return;
      }

      inFlightSessionIds.add(originalSessionId);
      if (isDailyLimited) {
        dailyLimitInFlightByDate.add(date);
      }

      try {
        const currentSessionResult = await client.session.get({
          path: { id: originalSessionId },
        });

        if (currentSessionResult.error) {
          await logError(client, "Failed to fetch source session", currentSessionResult.error);
          return;
        }

        const currentSessionTitle = currentSessionResult.data.title ?? "";
        if (currentSessionTitle.startsWith(GENERATED_TITLE_PREFIX)) {
          return;
        }

        // Daily-limit: skip regeneration for the day if the default file already exists.
        // File-based check so it survives process restarts.
        // Not supported with a custom template because the file name pattern becomes unknown.
        if (isDailyLimited) {
          const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
          if (customTemplatePath) {
            await logWarn(
              client,
              "OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT is not supported together with OPENCODE_DAILY_LOGBOOK_TEMPLATE (file name pattern is unknown). Daily limit check is skipped.",
            );
          } else if (isDailyLogbookExists(directory, outputDir, date)) {
            await logWarn(
              client,
              `Daily logbook for ${date} already exists. Skipping generation (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`,
            );
            return;
          }
        }

        // Usage stats retrieval (always). Must be after daily-limit guards to avoid
        // unnecessary I/O and warn logs when generation is suppressed.
        let usageTable: string | undefined;
        try {
          const stats = getUsageStats({
            directory,
            sessionId: originalSessionId,
            date,
            projectOnly: isUsageProjectOnly(),
          });
          if (stats) {
            const projectDisplayName = basename(resolve(directory));
            const displayDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
            const table = formatUsageTable(stats, displayDate, projectDisplayName);
            if (table) {
              usageTable = table;
            }
          }
        } catch (error) {
          await logWarn(
            client,
            `Failed to get usage stats: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        let template = SAMPLE_TEMPLATE;
        try {
          template = loadTemplate(directory);
        } catch (error) {
          const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
          await logWarn(
            client,
            `Template load failed (${customTemplatePath ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`,
          );
          await logError(client, "Template load error", error);
        }

        const messagesResult = await client.session.messages({
          path: { id: originalSessionId },
        });

        if (messagesResult.error) {
          await logError(client, "Failed to load source session messages", messagesResult.error);
          return;
        }

        const includeTranscript = isTranscriptIncluded();
        const transcript = includeTranscript ? buildTranscript(messagesResult.data) : "";

        // When daily-limit is enabled, the agent (a separate process) writes files relative to its CWD,
        // so pass an absolute path resolved against `directory` to keep the prompt and the existence check aligned.
        // When disabled, keep the relative string for backward compatibility.
        const promptOutputDir = isDailyLimited ? resolve(directory, outputDir) : outputDir;
        const prompt = buildPrompt(
          template,
          originalSessionId,
          transcript,
          includeTranscript,
          promptOutputDir,
          now,
          usageTable,
        );

        const generatedSessionResult = await client.session.create({
          body: {
            title: `${GENERATED_TITLE_PREFIX} ${date}`,
          },
        });

        if (generatedSessionResult.error) {
          await logError(client, "Failed to create daily logbook session", generatedSessionResult.error);
          return;
        }

        const generatedSessionId = generatedSessionResult.data.id;

        const promptResult = await client.session.promptAsync({
          path: { id: generatedSessionId },
          body: {
            parts: [
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        });

        if (promptResult.error) {
          await logError(client, "Failed to send daily logbook prompt", promptResult.error);
          return;
        }

        recentlyTriggeredAtBySessionId.set(originalSessionId, nowMs);
      } catch (error) {
        await logError(client, "Unhandled error while generating daily logbook", error);
      } finally {
        inFlightSessionIds.delete(originalSessionId);
        if (isDailyLimited) {
          dailyLimitInFlightByDate.delete(date);
        }
      }
    },
  };
};

// ---------------------------------------------------------------------------
// V2 Plugin (TASK-1〜4)
// V1は `export const DailyLogbookPlugin: Plugin = async ({client,directory})=>({event})`
// でイベントを `event.properties.sessionID` / `client.session.*` / `client.app.log` で扱う。
// V2は `Plugin.define({ id, setup(ctx) })` で `ctx.event.subscribe` + `ctx.session.*` +
// `ctx.location.directory` + consoleログへ全面的に置換される。詳細は下記対照表を参照。
//
// V1→V2 API対照（beta promise形状）:
// | V1                                      | V2 beta (promise)                          |
// |-----------------------------------------|--------------------------------------------|
// | client.session.get({ path:{id} })       | ctx.session.get({ sessionID })             |
// | client.session.messages({ path:{id} })  | ctx.session.context({ sessionID })         |
// | client.session.create({ body:{title} }) | ctx.session.create({ title })              |
// | client.session.promptAsync({ path:{id}, body:{parts:[{type,text}]} }) | ctx.session.prompt({ sessionID, text }) / ctx.session.generate |
// | event.properties.sessionID              | event.data.sessionID                       |
// | client.app.log                          | なし（ctx.appは {name,version,channel} のみ。要代替: console.warn/error） |
// | directory                               | ctx.location.directory                     |
//
// イベント購読の差異 (TASK-2):
// - promise版: ctx.event.subscribe({ signal }) => AsyncIterable<V2Event> で全イベントが流れ、
//   ループ内で `if (event.type==="session.idle")` フィルタする。
// - effect版: ctx.event.subscribe("session.idle") => Stream で型引数でフィルタする。
//   本実装は promise版（beta）に準拠し、effect差異をコメントで明記する。
// セッション操作はフラット形状 (TASK-3): ctx.session.* は path/body ネストなし。
// ログは ctx.app.log が存在しないため console 代替 (TASK-4)。
// ---------------------------------------------------------------------------

/**
 * V2 idle handling extracted to a testable function.
 * Uses flat V2 session shapes and AppLogSink.
 */
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
  const { sessionID: originalSessionId, directory, sink, session } = params;

  if (isPluginDisabled()) {
    return;
  }

  const nowMs = Date.now();
  const throttleWindowMs = getThrottleWindowMs();
  pruneExpiredGuards(nowMs, throttleWindowMs);

  if (inFlightSessionIds.has(originalSessionId) || isDuplicateTrigger(originalSessionId, nowMs, throttleWindowMs)) {
    return;
  }

  const now = new Date();
  const { date } = formatDateTokens(now);
  const outputDir = getOutputDir();
  const isDailyLimited = isDailyLimitEnabled();

  if (isDailyLimited && dailyLimitInFlightByDate.has(date)) {
    await sink.warn(`Daily logbook for ${date} is already being generated. Skipping (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
    return;
  }

  inFlightSessionIds.add(originalSessionId);
  if (isDailyLimited) {
    dailyLimitInFlightByDate.add(date);
  }

  try {
    // V1: client.session.get({ path:{id} }) -> V2: ctx.session.get({ sessionID })
    let getResult: unknown;
    try {
      getResult = await session.get({ sessionID: originalSessionId });
    } catch (error) {
      getResult = { error };
    }
    const getTyped = getResult as { data?: { title?: string }; title?: string; error?: unknown };
    if (getTyped?.error) {
      await sink.error("Failed to fetch source session", getTyped.error);
      return;
    }
    const currentSessionTitle = getTyped?.data?.title ?? getTyped?.title ?? "";
    if (currentSessionTitle.startsWith(GENERATED_TITLE_PREFIX)) {
      return;
    }

    if (isDailyLimited) {
      const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
      if (customTemplatePath) {
        await sink.warn(
          "OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT is not supported together with OPENCODE_DAILY_LOGBOOK_TEMPLATE (file name pattern is unknown). Daily limit check is skipped.",
        );
      } else if (isDailyLogbookExists(directory, outputDir, date)) {
        await sink.warn(`Daily logbook for ${date} already exists. Skipping generation (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
        return;
      }
    }

    let usageTable: string | undefined;
    try {
      const stats = getUsageStats({
        directory,
        sessionId: originalSessionId,
        date,
        projectOnly: isUsageProjectOnly(),
      });
      if (stats) {
        const projectDisplayName = basename(resolve(directory));
        const displayDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
        const table = formatUsageTable(stats, displayDate, projectDisplayName);
        if (table) {
          usageTable = table;
        }
      }
    } catch (error) {
      await sink.warn(`Failed to get usage stats: ${error instanceof Error ? error.message : String(error)}`);
    }

    let template = SAMPLE_TEMPLATE;
    try {
      template = loadTemplate(directory);
    } catch (error) {
      const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
      await sink.warn(`Template load failed (${customTemplatePath ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`);
      await sink.error("Template load error", error);
    }

    // V1: client.session.messages({ path:{id} }) -> V2: ctx.session.context({ sessionID })
    let messagesResult: unknown;
    try {
      if (session.context) {
        messagesResult = await session.context({ sessionID: originalSessionId });
      } else if (session.messages) {
        messagesResult = await session.messages({ path: { id: originalSessionId } });
      } else {
        messagesResult = { error: new Error("no messages method available") };
      }
    } catch (error) {
      messagesResult = { error };
    }
    const messagesTyped = messagesResult as { data?: unknown[]; messages?: unknown[]; error?: unknown };
    if (messagesTyped?.error) {
      await sink.error("Failed to load source session messages", messagesTyped.error);
      return;
    }
    const messagesData = (messagesTyped?.data ?? messagesTyped?.messages ?? messagesTyped ?? []) as Array<{
      info: { role: "user" | "assistant" };
      parts: Array<{ type: string; [key: string]: unknown }>;
    }>;
    const safeMessages = Array.isArray(messagesData) ? messagesData : [];

    const includeTranscript = isTranscriptIncluded();
    const transcript = includeTranscript ? buildTranscript(safeMessages) : "";

    const promptOutputDir = isDailyLimited ? resolve(directory, outputDir) : outputDir;
    const prompt = buildPrompt(template, originalSessionId, transcript, includeTranscript, promptOutputDir, now, usageTable);

    // V1: client.session.create({ body:{title} }) -> V2: ctx.session.create({ title })
    let createResult: unknown;
    try {
      createResult = await session.create({ title: `${GENERATED_TITLE_PREFIX} ${date}` });
    } catch (error) {
      createResult = { error };
    }
    const createTyped = createResult as { data?: { id: string }; id?: string; sessionID?: string; error?: unknown };
    if (createTyped?.error) {
      await sink.error("Failed to create daily logbook session", createTyped.error);
      return;
    }
    const generatedSessionId = createTyped?.data?.id ?? createTyped?.id ?? createTyped?.sessionID;
    if (!generatedSessionId) {
      await sink.error("Failed to create daily logbook session", "missing session id");
      return;
    }

    // V1: client.session.promptAsync({ path:{id}, body:{parts:[{type,text}]} }) -> V2: ctx.session.prompt({ sessionID, text })
    let promptResult: unknown;
    try {
      if (session.prompt) {
        promptResult = await session.prompt({ sessionID: generatedSessionId, text: prompt });
      } else if (session.generate) {
        promptResult = await session.generate({ sessionID: generatedSessionId, text: prompt });
      } else if (session.promptAsync) {
        promptResult = await session.promptAsync({
          path: { id: generatedSessionId },
          body: { parts: [{ type: "text", text: prompt }] },
        });
      } else {
        promptResult = { error: new Error("no prompt method available on session") };
      }
    } catch (error) {
      promptResult = { error };
    }
    const promptTyped = promptResult as { error?: unknown };
    if (promptTyped?.error) {
      await sink.error("Failed to send daily logbook prompt", promptTyped.error);
      return;
    }

    recentlyTriggeredAtBySessionId.set(originalSessionId, nowMs);
  } catch (error) {
    await sink.error("Unhandled error while generating daily logbook", error);
  } finally {
    inFlightSessionIds.delete(originalSessionId);
    if (isDailyLimited) {
      dailyLimitInFlightByDate.delete(date);
    }
  }
}

async function v2Setup(ctx: unknown): Promise<(() => void) | void> {
  const anyCtx = ctx as {
    location?: { directory?: string };
    directory?: string;
    app?: { name?: string; version?: string; channel?: string };
    event?: { subscribe?: (opts: { signal: AbortSignal }) => AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> };
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

  // V2 promise版は subscribe({signal}) => AsyncIterable<V2Event>
  // effect版は subscribe(type): Stream で形状が異なることに注意。
  void (async () => {
    try {
      const subscribe = anyCtx.event?.subscribe;
      if (!subscribe) {
        await sink.warn("event.subscribe not available; v2 plugin idle");
        return;
      }
      // promise版は type引数なし、effect版は type引数あり。両対応のためまずは signal 付きで試す。
      let iterable: AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined;
      try {
        const raw = (subscribe as (opts: { signal: AbortSignal }) => unknown)({ signal: controller.signal });
        iterable = raw as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
      } catch {
        // effect版では subscribe("session.idle") の形かもしれないが、本実装は promise版を優先
        await sink.warn("event.subscribe({signal}) failed; v2 plugin idle");
        return;
      }
      if (!iterable || typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
        await sink.warn("event.subscribe did not return AsyncIterable; v2 plugin idle");
        return;
      }
      for await (const event of iterable as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>) {
        // V1: event.properties.sessionID -> V2: event.data.sessionID
        if (event.type !== "session.idle") {
          continue;
        }
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
      if (name === "AbortError") {
        return;
      }
      await sink.error("v2 event loop error", error);
    }
  })();

  // setupは Promise<Cleanup|void>, Cleanup = () => Promise<void>|void
  return () => controller.abort();
}

// Retained for future beta detection — not used in hybrid default but kept for explicit V1/V2 branching if needed.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isBetaPluginAvailable(): boolean {
  // ESM-only beta (0.0.0-beta-*) は `require("@opencode-ai/plugin")` が
  // `No "exports" main defined` で失敗するため、package.json の version で判定する。
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const candidates = [
      join(dirname(currentFile), "..", "node_modules", "@opencode-ai", "plugin", "package.json"),
      join(dirname(currentFile), "..", "..", "node_modules", "@opencode-ai", "plugin", "package.json"),
      join(process.cwd(), "node_modules", "@opencode-ai", "plugin", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
        if (typeof pkg.version === "string" && pkg.version.includes("beta")) {
          return true;
        }
        // stable 1.x は V1
        if (typeof pkg.version === "string" && pkg.version.startsWith("1.")) {
          return false;
        }
      }
    }
  } catch {
    // ignore
  }
  // フォールバック: 旧来の require 判定（stable 1.x の CJS では成功する）
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@opencode-ai/plugin") as { Plugin?: { define?: unknown } };
    if (mod?.Plugin?.define) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function tryCreateV2Plugin(): unknown {
  // beta 環境では ESM のため require が失敗するが、Plugin.define は identity なので
  // plain object を返しても V2 ホストは受け付ける。可能なら define でラップを試みる。
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@opencode-ai/plugin") as { Plugin?: { define?: (p: { id: string; setup: (ctx: unknown) => Promise<unknown> }) => unknown } };
    const define = mod?.Plugin?.define;
    if (typeof define === "function") {
      return define({ id: "smapira.daily-logbook", setup: v2Setup });
    }
  } catch {
    // ignore – ESM-only beta では require が失敗するためフォールバックへ
  }
  // フォールバック: plain object（テストやV2未対応環境でも setup を検証可能、beta ホストでも受理される）
  return { id: "smapira.daily-logbook", setup: v2Setup };
}

export const DailyLogbookPluginV2: unknown = tryCreateV2Plugin();

// デュアル対応: V1の DailyLogbookPlugin は温存し、V2は DailyLogbookPluginV2 として提供。
// default export は V1/V2 両ホストで受理されるハイブリッドにする。
// V1ホストは `default` を `async ({client,directory})=>({event})` として呼び出し、
// V2ホストは `default.id` + `default.setup`/`default.effect` を持つ定義として検証する。
// 関数に `id`/`setup` を付与すれば、V1では関数として、V2では定義オブジェクトとして
// 両方のチェックを通過する（`Failed to check Server plugin` 対策）。
// さらにキャッシュ環境（~/.cache/.../dist/index.js）では beta の package.json が
//見つからず isBetaPluginAvailable() が false になるため、ハイブリッドで確実に V2 を提供する。
const _hybridDefault: unknown = (() => {
  const fn = DailyLogbookPlugin as unknown as Record<string, unknown> & typeof DailyLogbookPlugin;
  // V2 識別子を付与（V2 ホストの id/setup 検証を通過）
  (fn as Record<string, unknown>)["id"] = "smapira.daily-logbook";
  (fn as Record<string, unknown>)["setup"] = v2Setup;
  // effect 版も念のため（V2 effect ホストは setup/effect どちらか）
  (fn as Record<string, unknown>)["effect"] = v2Setup;
  return fn;
})();

// 後方互換: 旧来の分岐も温存しつつ、最終的な default はハイブリッドを返す。
// これにより stable 1.18.x でも `bun test` は V1 関数として動作し、
// beta 0.0.0-beta-* の opencode2 でも id/setup を持つため検証を通過する。
export default _hybridDefault as unknown as typeof DailyLogbookPlugin | typeof DailyLogbookPluginV2;
