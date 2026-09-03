// @bun
// daily-logbook.ts
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { Database } from "bun:sqlite";
var SERVICE_NAME = "daily-logbook-plugin";
var GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
var DUPLICATE_WINDOW_MS = 90000;
var TRANSCRIPT_MAX_MESSAGES = 80;
var TRANSCRIPT_MAX_CHARS = 12000;
var inFlightSessionIds = new Set;
var dailyLimitInFlightByDate = new Set;
var recentlyTriggeredAtBySessionId = new Map;
var DEFAULT_OUTPUT_DIR = "artifacts/daily";
function getOutputDir() {
  return process.env.OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}
var SAMPLE_TEMPLATE = `Create a daily logbook based on the session {{ sessionId }}.

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
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[sS][kK]-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\b/g,
  /(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi
];
function maskSecrets(value) {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
}
function createV1LogSink(client) {
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
    }
  };
}
function createV2LogSink() {
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
    }
  };
}
function isPluginDisabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true";
}
function isRedactEnabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_REDACT !== "false";
}
function isTranscriptIncluded() {
  return process.env.OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT !== "false";
}
function isDailyLimitEnabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT === "true";
}
function getThrottleWindowMs() {
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
function isUsageProjectOnly() {
  return process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY !== "false";
}
function getDbPath() {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH;
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return join(homedir(), ".local/share/opencode/opencode.db");
}
function resolveProjectId(db, normalizedDir) {
  try {
    const stmt = db.prepare("SELECT id FROM project WHERE worktree = ?");
    const row = stmt.get(normalizedDir);
    if (row)
      return row.id;
    return null;
  } catch {
    return null;
  }
}
function toYyyyMmDd(date) {
  if (date.length === 8) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  return date;
}
function queryDailyStats(db, projectId, dateStr, projectOnly) {
  const useProject = projectId !== null && projectOnly;
  if (useProject) {
    const stmt2 = db.prepare(`SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE project_id = ? AND date(datetime(time_created/1000,'unixepoch','localtime')) = ?`);
    return stmt2.get(projectId, dateStr);
  }
  const stmt = db.prepare(`SELECT count(*) as sessionsToday, coalesce(sum(cost),0) as dayCost, coalesce(sum(tokens_input),0) as tokensInput, coalesce(sum(tokens_output),0) as tokensOutput, coalesce(sum(tokens_cache_read),0) as cacheRead FROM session WHERE date(datetime(time_created/1000,'unixepoch','localtime')) = ?`);
  return stmt.get(dateStr);
}
function queryTotalStats(db, projectId, projectOnly) {
  const useProject = projectId !== null && projectOnly;
  if (useProject) {
    const stmt2 = db.prepare(`SELECT coalesce(sum(cost),0) as totalCost FROM session WHERE project_id = ?`);
    return stmt2.get(projectId);
  }
  const stmt = db.prepare(`SELECT coalesce(sum(cost),0) as totalCost FROM session`);
  return stmt.get();
}
function querySessionCost(db, sessionId) {
  try {
    const stmt = db.prepare(`SELECT cost FROM session WHERE id = ?`);
    const row = stmt.get(sessionId);
    if (row && row.cost !== null && row.cost !== undefined)
      return Number(row.cost);
    return null;
  } catch {
    return null;
  }
}
function getUsageStats(params) {
  const dbPath = params.dbPath ?? getDbPath();
  if (!existsSync(dbPath))
    return null;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true });
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
      sessionCost
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
function formatCost(value) {
  return `$${value.toFixed(2)}`;
}
function formatTokens(value) {
  if (value >= 1e9)
    return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6)
    return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1000)
    return `${(value / 1000).toFixed(1)}K`;
  return `${value}`;
}
function formatUsageTable(stats, date, projectDisplayName) {
  if (!stats)
    return "";
  const displayDate = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  const heading = projectDisplayName ? `## Usage \u2014 ${displayDate} (project: ${projectDisplayName})` : `## Usage \u2014 ${displayDate}`;
  const hasSessionCost = stats.sessionCost !== null && stats.sessionCost !== undefined;
  const costLabel = hasSessionCost ? "Cost (\u672C\u65E5/\u30BB\u30C3\u30B7\u30E7\u30F3)" : "Cost (\u672C\u65E5)";
  const costValue = hasSessionCost ? `${formatCost(stats.dayCost)} / ${formatCost(stats.sessionCost)}` : formatCost(stats.dayCost);
  const tokensValue = `${formatTokens(stats.tokensInput)} / ${formatTokens(stats.tokensOutput)} / ${formatTokens(stats.cacheRead)}`;
  return `${heading}
| \u9805\u76EE | \u5024 |
|---|---|
| ${costLabel} | ${costValue} |
| Tokens Input / Output / Cache Read | ${tokensValue} |
| Sessions (\u672C\u65E5) | ${stats.sessionsToday} |
| Total Cost (\u7D2F\u8A08) | ${formatCost(stats.totalCost)} |`;
}
function formatDateTokens(now) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return {
    date: `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
    dateJp: `${year}\u5E74${month}\u6708${day}\u65E5`
  };
}
function replaceTemplateVariables(template, sessionId, now, outputDir, usageTable) {
  const { date, dateJp } = formatDateTokens(now);
  return template.replace(/\{\{\s*sessionId\s*\}\}/g, () => sessionId).replace(/\{\{\s*date\s*\}\}/g, () => date).replace(/\{\{\s*dateJp\s*\}\}/g, () => dateJp).replace(/\{\{\s*outputDir\s*\}\}/g, () => outputDir).replace(/\{\{\s*usage\s*\}\}/g, () => usageTable ?? "").replace(/\{\{\s*usageTable\s*\}\}/g, () => usageTable ?? "");
}
function loadTemplate(directory) {
  const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
  if (!customTemplatePath)
    return SAMPLE_TEMPLATE;
  const resolvedTemplatePath = resolve(directory, customTemplatePath);
  return readFileSync(resolvedTemplatePath, "utf-8");
}
function truncateText(value, maxChars) {
  if (value.length <= maxChars)
    return value;
  return `${value.slice(0, maxChars)}
...(truncated)`;
}
function extractReadableText(part) {
  if (part.type === "text" && typeof part.text === "string")
    return part.text;
  return "";
}
function buildTranscript(messages) {
  const recentMessages = messages.slice(-TRANSCRIPT_MAX_MESSAGES);
  const transcriptLines = recentMessages.map(({ info, parts }) => {
    const roleLabel = info.role === "user" ? "User" : "Assistant";
    const text = parts.map((part) => extractReadableText(part)).join(`
`).trim();
    if (!text)
      return "";
    return `[${roleLabel}]
${text}`;
  }).filter((line) => line.length > 0).join(`

`);
  if (!transcriptLines)
    return "(No summarizable text history found in the source session)";
  const maskedTranscript = isRedactEnabled() ? maskSecrets(transcriptLines) : transcriptLines;
  return truncateText(maskedTranscript, TRANSCRIPT_MAX_CHARS);
}
function buildPrompt(template, sessionId, transcript, includeTranscript, outputDir, now, usageTable) {
  const replacedTemplate = replaceTemplateVariables(template, sessionId, now, outputDir, usageTable);
  let basePrompt;
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
function isWithinWindow(lastTriggeredAt, nowMs, windowMs) {
  if (lastTriggeredAt === undefined)
    return false;
  return nowMs - lastTriggeredAt < windowMs;
}
function isDuplicateTrigger(sessionId, nowMs, windowMs) {
  return isWithinWindow(recentlyTriggeredAtBySessionId.get(sessionId), nowMs, windowMs);
}
function pruneExpiredGuards(nowMs, windowMs) {
  for (const [sessionId, timestamp] of recentlyTriggeredAtBySessionId.entries()) {
    if (nowMs - timestamp >= windowMs * 2) {
      recentlyTriggeredAtBySessionId.delete(sessionId);
    }
  }
}
function isDailyLogbookExists(directory, outputDir, date) {
  const dailyLogbookPath = resolve(directory, outputDir, `${date}_logbook.md`);
  return existsSync(dailyLogbookPath);
}
function resolveUsageTable(directory, sessionId, date) {
  const stats = getUsageStats({ directory, sessionId, date, projectOnly: isUsageProjectOnly() });
  if (!stats)
    return;
  const projectDisplayName = basename(resolve(directory));
  const displayDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const table = formatUsageTable(stats, displayDate, projectDisplayName);
  return table || undefined;
}
function resolveTemplate(directory) {
  return loadTemplate(directory);
}
function parseSourceResult(result) {
  const typed = result;
  if (typed?.error)
    return { ok: false, error: typed.error };
  const title = typed?.data?.title ?? typed?.title ?? "";
  if (title.startsWith(GENERATED_TITLE_PREFIX))
    return { ok: false, isGenerated: true };
  return { ok: true };
}
function parseMessagesResult(result) {
  const typed = result;
  if (typed?.error)
    return { error: typed.error, data: [] };
  const data = typed?.data ?? typed?.messages ?? typed ?? [];
  const safe = Array.isArray(data) ? data : [];
  return { data: safe };
}
function parseCreateResult(result) {
  const typed = result;
  if (typed?.error)
    return { error: typed.error };
  const id = typed?.data?.id ?? typed?.id ?? typed?.sessionID;
  if (!id)
    return { error: "missing session id" };
  return { id };
}
function isThrottled(sessionId, nowMs, windowMs) {
  return inFlightSessionIds.has(sessionId) || isDuplicateTrigger(sessionId, nowMs, windowMs);
}
function isDailyLimitedInFlight(date, isDailyLimited) {
  return isDailyLimited && dailyLimitInFlightByDate.has(date);
}
function getDailyFileAction(isDailyLimited, directory, outputDir, date) {
  if (!isDailyLimited)
    return "continue";
  if (process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE)
    return "warnCustom";
  if (isDailyLogbookExists(directory, outputDir, date))
    return "skip";
  return "continue";
}
function buildTranscriptFromData(data) {
  return isTranscriptIncluded() ? buildTranscript(data) : "";
}
function handleDailyFileAction(action, sink, date) {
  if (action === "warnCustom") {
    sink.warn("OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT is not supported together with OPENCODE_DAILY_LOGBOOK_TEMPLATE (file name pattern is unknown). Daily limit check is skipped.");
    return false;
  }
  if (action === "skip") {
    sink.warn(`Daily logbook for ${date} already exists. Skipping generation (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
    return true;
  }
  return false;
}
function getUsageAndTemplate(directory, sessionId, date, sink) {
  let usageTable;
  try {
    usageTable = resolveUsageTable(directory, sessionId, date);
  } catch (error) {
    sink.warn(`Failed to get usage stats: ${error instanceof Error ? error.message : String(error)}`);
  }
  let template;
  try {
    template = resolveTemplate(directory);
  } catch (error) {
    const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
    sink.warn(`Template load failed (${customTemplatePath ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`);
    sink.error("Template load error", error);
    template = SAMPLE_TEMPLATE;
  }
  return { usageTable, template };
}
function shouldAbortSource(parsed, sink) {
  if (parsed.error) {
    sink.error("Failed to fetch source session", parsed.error);
    return true;
  }
  if (parsed.isGenerated)
    return true;
  return false;
}
function shouldAbortMessages(parsed, sink) {
  if (parsed.error) {
    sink.error("Failed to load source session messages", parsed.error);
    return true;
  }
  return false;
}
function shouldAbortCreate(parsed, sink) {
  if (parsed.error) {
    sink.error("Failed to create daily logbook session", parsed.error);
    return true;
  }
  return false;
}
function shouldAbortPrompt(result, sink) {
  if (result.error) {
    sink.error("Failed to send daily logbook prompt", result.error);
    return true;
  }
  return false;
}
async function generateDailyLogbookCore(params) {
  if (isPluginDisabled())
    return;
  const nowMs = Date.now();
  const throttleWindowMs = getThrottleWindowMs();
  pruneExpiredGuards(nowMs, throttleWindowMs);
  if (isThrottled(params.sessionId, nowMs, throttleWindowMs))
    return;
  const now = new Date;
  const { date } = formatDateTokens(now);
  const outputDir = getOutputDir();
  const isDailyLimited = isDailyLimitEnabled();
  if (isDailyLimitedInFlight(date, isDailyLimited)) {
    await params.sink.warn(`Daily logbook for ${date} is already being generated. Skipping (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
    return;
  }
  inFlightSessionIds.add(params.sessionId);
  if (isDailyLimited)
    dailyLimitInFlightByDate.add(date);
  try {
    {
      let getResult;
      try {
        getResult = await params.adapter.get(params.sessionId);
      } catch (error) {
        getResult = { error };
      }
      const parsed = parseSourceResult(getResult);
      if (shouldAbortSource(parsed, params.sink))
        return;
    }
    {
      const action = getDailyFileAction(isDailyLimited, params.directory, outputDir, date);
      if (handleDailyFileAction(action, params.sink, date))
        return;
    }
    const { usageTable, template } = getUsageAndTemplate(params.directory, params.sessionId, date, params.sink);
    let msgResult;
    try {
      msgResult = await params.adapter.getMessages(params.sessionId);
    } catch (error) {
      msgResult = { error };
    }
    const parsedMsg = parseMessagesResult(msgResult);
    if (shouldAbortMessages(parsedMsg, params.sink))
      return;
    const transcript = buildTranscriptFromData(parsedMsg.data);
    const includeTranscript = isTranscriptIncluded();
    const promptOutputDir = isDailyLimited ? resolve(params.directory, outputDir) : outputDir;
    const prompt = buildPrompt(template, params.sessionId, transcript, includeTranscript, promptOutputDir, now, usageTable);
    let createResult;
    try {
      createResult = await params.adapter.create(`${GENERATED_TITLE_PREFIX} ${date}`);
    } catch (error) {
      createResult = { error };
    }
    const parsedCreate = parseCreateResult(createResult);
    if (shouldAbortCreate(parsedCreate, params.sink))
      return;
    const generatedId = parsedCreate.id;
    {
      let promptResult;
      try {
        promptResult = await params.adapter.prompt(generatedId, prompt);
      } catch (error) {
        promptResult = { error };
      }
      const typed = promptResult;
      if (shouldAbortPrompt(typed, params.sink))
        return;
    }
    recentlyTriggeredAtBySessionId.set(params.sessionId, nowMs);
  } catch (error) {
    await params.sink.error("Unhandled error while generating daily logbook", error);
  } finally {
    inFlightSessionIds.delete(params.sessionId);
    if (isDailyLimited)
      dailyLimitInFlightByDate.delete(date);
  }
}
var DailyLogbookPlugin = async ({ client, directory }) => {
  await client.app.log({
    body: {
      service: SERVICE_NAME,
      level: "info",
      message: "daily-logbook plugin loaded"
    }
  });
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle")
        return;
      const sink = createV1LogSink(client);
      const adapter = {
        get: (id) => client.session.get({ path: { id } }),
        getMessages: (id) => client.session.messages({ path: { id } }),
        create: (title) => client.session.create({ body: { title } }),
        prompt: (id, text) => client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } })
      };
      await generateDailyLogbookCore({ sessionId: event.properties.sessionID, directory, sink, adapter });
    }
  };
};
async function handleV2IdleEvent(params) {
  const adapter = {
    get: (id) => params.session.get({ sessionID: id }),
    getMessages: async (id) => {
      if (params.session.context)
        return params.session.context({ sessionID: id });
      if (params.session.messages)
        return params.session.messages({ path: { id } });
      return { error: new Error("no messages method available") };
    },
    create: (title) => params.session.create({ title }),
    prompt: async (id, text) => {
      if (params.session.prompt)
        return params.session.prompt({ sessionID: id, text });
      if (params.session.generate)
        return params.session.generate({ sessionID: id, text });
      if (params.session.promptAsync)
        return params.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } });
      return { error: new Error("no prompt method available on session") };
    }
  };
  await generateDailyLogbookCore({ sessionId: params.sessionID, directory: params.directory, sink: params.sink, adapter });
}
async function v2Setup(ctx) {
  const anyCtx = ctx;
  const directory = anyCtx.location?.directory ?? anyCtx.directory ?? process.cwd();
  const sink = createV2LogSink();
  await sink.info?.(`daily-logbook plugin loaded (v2) app=${anyCtx.app?.name ?? "unknown"} ${anyCtx.app?.version ?? ""}`);
  const controller = new AbortController;
  (async () => {
    try {
      const subscribe = anyCtx.event?.subscribe;
      if (!subscribe) {
        await sink.warn("event.subscribe not available; v2 plugin idle");
        return;
      }
      let iterable;
      try {
        const raw = subscribe({ signal: controller.signal });
        iterable = raw;
      } catch {
        await sink.warn("event.subscribe({signal}) failed; v2 plugin idle");
        return;
      }
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
        await sink.warn("event.subscribe did not return AsyncIterable; v2 plugin idle");
        return;
      }
      for await (const event of iterable) {
        if (event.type !== "session.idle")
          continue;
        const data = event.data;
        const properties = event.properties;
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
      const name = error?.name;
      if (name === "AbortError")
        return;
      await sink.error("v2 event loop error", error);
    }
  })();
  return () => controller.abort();
}
function tryCreateV2Plugin() {
  try {
    const require2 = createRequire(import.meta.url);
    const mod = require2("@opencode-ai/plugin");
    const define = mod?.Plugin?.define;
    if (typeof define === "function") {
      return define({ id: "smapira.daily-logbook", setup: v2Setup });
    }
  } catch {}
  return { id: "smapira.daily-logbook", setup: v2Setup };
}
var DailyLogbookPluginV2 = tryCreateV2Plugin();
var _hybridDefault = (() => {
  const fn = DailyLogbookPlugin;
  fn["id"] = "smapira.daily-logbook";
  fn["setup"] = v2Setup;
  fn["effect"] = v2Setup;
  return fn;
})();
var daily_logbook_default = _hybridDefault;
export {
  replaceTemplateVariables,
  maskSecrets,
  isWithinWindow,
  isUsageProjectOnly,
  isDailyLogbookExists,
  handleV2IdleEvent,
  getUsageStats,
  getThrottleWindowMs,
  getDbPath,
  generateDailyLogbookCore,
  formatUsageTable,
  formatTokens,
  formatCost,
  daily_logbook_default as default,
  buildTranscript,
  buildPrompt,
  SAMPLE_TEMPLATE,
  DailyLogbookPluginV2,
  DailyLogbookPlugin
};
