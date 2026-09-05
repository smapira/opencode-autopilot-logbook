// @bun
var __require = import.meta.require;

// src/application/generate-logbook.usecase.ts
import { basename, resolve as resolve4 } from "path";

// src/domain/masking.ts
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
function isRedactEnabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_REDACT !== "false";
}
function maskSecrets(value) {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
}

// src/domain/transcript.ts
var TRANSCRIPT_MAX_MESSAGES = 80;
var TRANSCRIPT_MAX_CHARS = 12000;
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

// src/domain/formatting.ts
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

// src/infrastructure/usage/getUsageStats.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";

// src/infrastructure/usage/resolveProjectId.ts
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

// src/infrastructure/usage/queryDailyStats.ts
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

// src/infrastructure/usage/getUsageStats.ts
function getDbPath() {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH;
  if (custom && custom.trim() !== "") {
    return custom;
  }
  return join(homedir(), ".local/share/opencode/opencode.db");
}
function isUsageProjectOnly() {
  return process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY !== "false";
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

// src/application/guards.ts
import { existsSync as existsSync2 } from "fs";
import { resolve as resolve2 } from "path";
function isWithinWindow(lastTriggeredAt, nowMs, windowMs) {
  if (lastTriggeredAt === undefined)
    return false;
  return nowMs - lastTriggeredAt < windowMs;
}
function isDailyLogbookExists(directory, outputDir, date) {
  const p = resolve2(directory, outputDir, `${date}_logbook.md`);
  return existsSync2(p);
}
function isDuplicateTrigger(sessionId, nowMs, windowMs, recentMap) {
  return isWithinWindow(recentMap.get(sessionId), nowMs, windowMs);
}
function pruneExpiredGuards(nowMs, windowMs, recentMap) {
  for (const [sid, ts] of recentMap.entries()) {
    if (nowMs - ts >= windowMs * 2)
      recentMap.delete(sid);
  }
}
function isThrottled(sessionId, nowMs, windowMs, inFlight, recentMap) {
  return inFlight.has(sessionId) || isDuplicateTrigger(sessionId, nowMs, windowMs, recentMap);
}
function isDailyLimitedInFlight(date, isDailyLimited, inFlightDates) {
  return isDailyLimited && inFlightDates.has(date);
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

// src/application/config.ts
var DEFAULT_OUTPUT_DIR = "artifacts/daily";
var DUPLICATE_WINDOW_MS = 90000;
function getOutputDir() {
  return process.env.OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}
function isPluginDisabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true";
}
function isTranscriptIncluded() {
  return process.env.OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT !== "false";
}
function isDailyLimitEnabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT === "true";
}
function getThrottleWindowMs() {
  const raw = process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
  if (raw === undefined || raw === "")
    return DUPLICATE_WINDOW_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0)
    return DUPLICATE_WINDOW_MS;
  return parsed;
}

// src/application/template-loader.ts
import { readFileSync } from "fs";
import { resolve as resolve3 } from "path";
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
function formatDateTokens(now) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return {
    date: `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`,
    dateJp: `${y}\u5E74${m}\u6708${d}\u65E5`
  };
}
function replaceTemplateVariables(template, sessionId, now, outputDir, usageTable) {
  const { date, dateJp } = formatDateTokens(now);
  return template.replace(/\{\{\s*sessionId\s*\}\}/g, () => sessionId).replace(/\{\{\s*date\s*\}\}/g, () => date).replace(/\{\{\s*dateJp\s*\}\}/g, () => dateJp).replace(/\{\{\s*outputDir\s*\}\}/g, () => outputDir).replace(/\{\{\s*usage\s*\}\}/g, () => usageTable ?? "").replace(/\{\{\s*usageTable\s*\}\}/g, () => usageTable ?? "");
}
function loadTemplate(directory) {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
  if (!custom)
    return SAMPLE_TEMPLATE;
  const resolved = resolve3(directory, custom);
  return readFileSync(resolved, "utf-8");
}
function buildPrompt(template, sessionId, transcript, includeTranscript, outputDir, now, usageTable) {
  const replaced = replaceTemplateVariables(template, sessionId, now, outputDir, usageTable);
  if (!includeTranscript || !transcript)
    return replaced;
  return `${replaced}

---
Below is an excerpt of the session ${sessionId} history. Create the daily logbook based on this history.

${transcript}`;
}

// src/application/generate-logbook.usecase.ts
var GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
var inFlightSessionIds = new Set;
var dailyLimitInFlightByDate = new Set;
var recentlyTriggeredAtBySessionId = new Map;
function resetForTest() {
  inFlightSessionIds.clear();
  dailyLimitInFlightByDate.clear();
  recentlyTriggeredAtBySessionId.clear();
}
var __resetGlobalStateForTest = resetForTest;
var usagePort = {
  getUsageStats,
  isUsageProjectOnly,
  formatUsageTable
};
var transcriptPort = {
  buildTranscript,
  isTranscriptIncluded
};
var configPort = {
  getOutputDir,
  isPluginDisabled,
  isDailyLimitEnabled,
  getThrottleWindowMs
};
var templatePort = {
  loadTemplate,
  sampleTemplate: SAMPLE_TEMPLATE
};
function formatDateTokens2(now) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return { date: `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}` };
}
function resolveUsageTable(directory, sessionId, date) {
  const stats = usagePort.getUsageStats({
    directory,
    sessionId,
    date,
    projectOnly: usagePort.isUsageProjectOnly()
  });
  if (!stats)
    return;
  const projectDisplayName = basename(resolve4(directory));
  const displayDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const table = usagePort.formatUsageTable(stats, displayDate, projectDisplayName);
  return table || undefined;
}
function resolveTemplate(directory) {
  return templatePort.loadTemplate(directory);
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
function buildTranscriptFromData(data) {
  return transcriptPort.isTranscriptIncluded() ? transcriptPort.buildTranscript(data) : "";
}
function getUsageAndTemplate(directory, sessionId, date, sink) {
  let usageTable;
  try {
    usageTable = resolveUsageTable(directory, sessionId, date);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sink.warn(`Failed to get usage stats: ${msg}`);
  }
  let template;
  try {
    template = resolveTemplate(directory);
  } catch (error) {
    const custom = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
    sink.warn(`Template load failed (${custom ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`);
    sink.error("Template load error", error);
    template = templatePort.sampleTemplate;
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
async function fetchSourceSession(adapter, sessionId, sink) {
  let getResult;
  try {
    getResult = await adapter.get(sessionId);
  } catch (error) {
    getResult = { error };
  }
  const parsed = parseSourceResult(getResult);
  if (shouldAbortSource(parsed, sink))
    return { aborted: true };
  return { aborted: false };
}
async function fetchMessages(adapter, sessionId, sink) {
  let msgResult;
  try {
    msgResult = await adapter.getMessages(sessionId);
  } catch (error) {
    msgResult = { error };
  }
  const parsed = parseMessagesResult(msgResult);
  if (shouldAbortMessages(parsed, sink))
    return { aborted: true, data: [] };
  return { aborted: false, data: parsed.data };
}
async function createGeneratedSession(adapter, date, sink) {
  let createResult;
  try {
    createResult = await adapter.create(`${GENERATED_TITLE_PREFIX} ${date}`);
  } catch (error) {
    createResult = { error };
  }
  const parsed = parseCreateResult(createResult);
  if (shouldAbortCreate(parsed, sink))
    return { aborted: true };
  return { aborted: false, id: parsed.id };
}
async function sendPrompt(adapter, generatedId, prompt, sink) {
  let promptResult;
  try {
    promptResult = await adapter.prompt(generatedId, prompt);
  } catch (error) {
    promptResult = { error };
  }
  const typed = promptResult;
  if (shouldAbortPrompt(typed, sink))
    return { aborted: true };
  return { aborted: false };
}
async function generateDailyLogbookCore(params) {
  if (configPort.isPluginDisabled())
    return;
  const nowMs = Date.now();
  const throttleWindowMs = configPort.getThrottleWindowMs();
  pruneExpiredGuards(nowMs, throttleWindowMs, recentlyTriggeredAtBySessionId);
  if (isThrottled(params.sessionId, nowMs, throttleWindowMs, inFlightSessionIds, recentlyTriggeredAtBySessionId))
    return;
  const now = new Date;
  const { date } = formatDateTokens2(now);
  const outputDir = configPort.getOutputDir();
  const isDailyLimited = configPort.isDailyLimitEnabled();
  if (isDailyLimitedInFlight(date, isDailyLimited, dailyLimitInFlightByDate)) {
    await params.sink.warn(`Daily logbook for ${date} is already being generated. Skipping (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
    return;
  }
  inFlightSessionIds.add(params.sessionId);
  if (isDailyLimited)
    dailyLimitInFlightByDate.add(date);
  try {
    const source = await fetchSourceSession(params.adapter, params.sessionId, params.sink);
    if (source.aborted)
      return;
    const action = getDailyFileAction(isDailyLimited, params.directory, outputDir, date);
    if (handleDailyFileAction(action, params.sink, date))
      return;
    const { usageTable, template } = getUsageAndTemplate(params.directory, params.sessionId, date, params.sink);
    const msg = await fetchMessages(params.adapter, params.sessionId, params.sink);
    if (msg.aborted)
      return;
    const transcript = buildTranscriptFromData(msg.data);
    const includeTranscript = transcriptPort.isTranscriptIncluded();
    const promptOutputDir = isDailyLimited ? resolve4(params.directory, outputDir) : outputDir;
    const prompt = buildPrompt(template, params.sessionId, transcript, includeTranscript, promptOutputDir, now, usageTable);
    const created = await createGeneratedSession(params.adapter, date, params.sink);
    if (created.aborted || !created.id)
      return;
    const sent = await sendPrompt(params.adapter, created.id, prompt, params.sink);
    if (sent.aborted)
      return;
    recentlyTriggeredAtBySessionId.set(params.sessionId, nowMs);
  } catch (error) {
    await params.sink.error("Unhandled error while generating daily logbook", error);
  } finally {
    inFlightSessionIds.delete(params.sessionId);
    if (isDailyLimited)
      dailyLimitInFlightByDate.delete(date);
  }
}

// src/adapters/v1/log-sink.v1.ts
var SERVICE_NAME = "daily-logbook-plugin";
function createV1LogSink(client) {
  return {
    warn: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "warn", message } });
      } catch {}
    },
    error: async (message, error) => {
      const msg = error instanceof Error ? error.message : String(error ?? "");
      const full = msg ? `${message}: ${msg}` : message;
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "error", message: full } });
      } catch {}
    },
    info: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "info", message } });
      } catch {}
    }
  };
}

// src/adapters/v1/session.v1.ts
async function createV1FallbackSessionPort(sink, directory) {
  await sink.info?.(`v1: using file-direct fallback session adapter directory=${directory}`);
  return {
    get: async () => ({ data: { title: "fallback" } }),
    getMessages: async () => ({ data: [] }),
    create: async (title) => ({ data: { id: `fallback-v1-${Date.now()}` }, title }),
    prompt: async (_id, text) => {
      await writeDirectFileV1(text, sink, directory);
      return {};
    }
  };
}
async function writeDirectFileV1(text, sink, directory) {
  try {
    const match = text.match(/Create `([^`]+)`/);
    const filePath = match ? match[1] : `artifacts/daily/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_logbook.md`;
    const { writeFileSync, mkdirSync, existsSync: existsSync3, readFileSync: readFileSync2 } = await import("fs");
    const { resolve: resolve5, dirname, isAbsolute } = await import("path");
    const absPath = isAbsolute(filePath) ? filePath : resolve5(directory, filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    const existing = existsSync3(absPath) ? readFileSync2(absPath, "utf-8") : "";
    const content = `${existing ? existing + `

` : ""}# Daily Logbook ${new Date().toISOString().slice(0, 10)}

${text.slice(0, 2000)}
`;
    writeFileSync(absPath, content);
    await sink.info?.(`v1 fallback direct write to ${absPath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.warn(`v1 fallback direct write failed: ${msg}`);
  }
}
function createV1SessionPort(client) {
  return {
    get: (id) => client.session.get({ path: { id } }),
    getMessages: (id) => client.session.messages({ path: { id } }),
    create: (title) => client.session.create({ body: { title } }),
    prompt: (id, text) => client.session.promptAsync({
      path: { id },
      body: { parts: [{ type: "text", text }] }
    })
  };
}

// src/adapters/v1/plugin.v1.ts
var SERVICE_NAME2 = "daily-logbook-plugin";
async function handleV1IdleEvent(params) {
  await generateDailyLogbookCore({
    sessionId: params.sessionID,
    directory: params.directory,
    sink: params.sink,
    adapter: params.session
  });
}
async function createV1FallbackAdapter(sink, directory) {
  return createV1FallbackSessionPort(sink, directory);
}
var DailyLogbookPlugin = async ({ client, directory }) => {
  await client.app.log({
    body: { service: SERVICE_NAME2, level: "info", message: "daily-logbook plugin loaded" }
  });
  console.log("daily-logbook plugin loaded");
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle")
        return;
      const sink = createV1LogSink(client);
      const adapter = createV1SessionPort(client);
      await generateDailyLogbookCore({
        sessionId: event.properties.sessionID,
        directory,
        sink,
        adapter
      });
    }
  };
};
// src/adapters/v2/log-sink.v2.ts
var SERVICE_NAME3 = "daily-logbook-plugin";
function createV2LogSink() {
  return {
    warn: (message) => {
      console.warn(`[${SERVICE_NAME3}] ${message}`);
    },
    error: (message, error) => {
      const msg = error instanceof Error ? error.message : error !== undefined ? String(error) : "";
      const full = msg ? `${message}: ${msg}` : message;
      console.error(`[${SERVICE_NAME3}] ${full}`);
    },
    info: (message) => {
      console.log(`[${SERVICE_NAME3}] ${message}`);
    }
  };
}

// src/adapters/v2/session.v2.ts
function toSessionPort(session) {
  return {
    get: (id) => session.get({ sessionID: id }),
    getMessages: async (id) => {
      if (session.context)
        return session.context({ sessionID: id });
      if (session.messages)
        return session.messages({ path: { id } });
      return { error: new Error("no messages method available") };
    },
    create: (title) => session.create({ title }),
    prompt: async (id, text) => {
      if (session.prompt)
        return session.prompt({ sessionID: id, text });
      if (session.generate)
        return session.generate({ sessionID: id, text });
      if (session.promptAsync) {
        return session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } });
      }
      return { error: new Error("no prompt method available on session") };
    }
  };
}
async function createFallbackSessionAdapter(sink, _serverUrl, directory = process.cwd()) {
  await sink.info?.(`using file-direct fallback session adapter (no SDK) directory=${directory}`);
  return {
    get: async () => ({ data: { title: "fallback" } }),
    context: async () => ({ data: [] }),
    create: async (input) => ({ data: { id: `fallback-${Date.now()}` }, title: input.title }),
    prompt: async (input) => {
      await writeDirectFile(input.text, sink, directory);
      return {};
    }
  };
}
async function writeDirectFile(text, sink, directory) {
  try {
    const match = text.match(/Create `([^`]+)`/);
    const filePath = match ? match[1] : `artifacts/daily/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_logbook.md`;
    const { writeFileSync, mkdirSync, existsSync: existsSync3, readFileSync: readFileSync2 } = await import("fs");
    const { resolve: resolve5, dirname, isAbsolute } = await import("path");
    const absPath = isAbsolute(filePath) ? filePath : resolve5(directory, filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    const existing = existsSync3(absPath) ? readFileSync2(absPath, "utf-8") : "";
    const content = `${existing ? existing + `

` : ""}# Daily Logbook ${new Date().toISOString().slice(0, 10)}

${text.slice(0, 2000)}
`;
    writeFileSync(absPath, content);
    await sink.info?.(`fallback direct write to ${absPath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.warn(`fallback direct write failed: ${msg}`);
  }
}

// src/adapters/v2/event-source.v2.ts
function isAsyncIterable(value) {
  return !!value && typeof value[Symbol.asyncIterator] === "function";
}
function isEffectStream(value) {
  if (!value || typeof value !== "object")
    return false;
  const v = value;
  if (isAsyncIterable(value))
    return false;
  return typeof v["pipe"] === "function" || "_tag" in v || "effect" in v;
}
async function toAsyncIterable(value, sink, signal) {
  if (!value)
    return;
  if (isAsyncIterable(value))
    return value;
  const streamResult = await tryStreamProperty(value, sink, signal);
  if (streamResult)
    return streamResult;
  if (isEffectStream(value))
    return;
  if (value instanceof Promise)
    return awaitFromPromise(value, sink, signal);
  return;
}
async function tryStreamProperty(value, sink, signal) {
  if (!value || typeof value !== "object" || !("stream" in value))
    return;
  const stream = value["stream"];
  if (isAsyncIterable(stream))
    return stream;
  const asIterable = await toAsyncIterable(stream, sink, signal);
  if (asIterable)
    return asIterable;
  await sink.warn(`toAsyncIterable: stream property exists but not AsyncIterable (keys=${Object.keys(value).join(",")})`);
  return;
}
async function awaitFromPromise(value, sink, signal) {
  try {
    const resolved = await value;
    return toAsyncIterable(resolved, sink, signal);
  } catch {
    return;
  }
}
async function trySubscribeEffect(sub, sink, signal, host) {
  try {
    const h = host ?? {};
    const fn = h.subscribe ?? sub;
    const raw = fn.call(h, "session.idle");
    const asIterable = await toAsyncIterable(raw, sink, signal);
    if (asIterable)
      return asIterable;
  } catch {}
  return;
}
async function resolveV2Iterable(subscribe, signal, sink, eventHost) {
  const sub = subscribe;
  if (!sub) {
    await sink.warn("resolveV2Iterable: subscribe is falsy");
    return;
  }
  const host = eventHost ?? {};
  try {
    const raw = callSubscribeWithSignal(host, sub, signal, sink);
    const logged = await logSubscribeResult(raw, sink);
    const asIterable = await toAsyncIterable(logged, sink, signal);
    await sink.info?.(`resolveV2Iterable: toAsyncIterable => ${asIterable ? "AsyncIterable" : "undefined"}`);
    if (asIterable)
      return asIterable;
    const viaEffect = await trySubscribeEffect(sub, sink, signal, host);
    if (viaEffect)
      return viaEffect;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.warn(`resolveV2Iterable: subscribe({signal}) threw ${msg}`);
    const viaEffect = await trySubscribeEffect(sub, sink, signal, host);
    if (viaEffect)
      return viaEffect;
  }
  const fallback = await trySubscribeEffect(sub, sink, signal, host);
  if (!fallback)
    await sink.warn("resolveV2Iterable: both subscribe styles returned non-AsyncIterable");
  return fallback;
}
function callSubscribeWithSignal(host, sub, signal, _sink) {
  const hostFn = host.subscribe;
  if (hostFn)
    return hostFn.call(host, { signal });
  return sub({ signal });
}
async function logSubscribeResult(raw, sink) {
  const typeLabel = raw instanceof Promise ? "Promise" : typeof raw;
  const keys = raw && typeof raw === "object" ? `keys=[${Object.keys(raw).join(",")}]` : "";
  await sink.info?.(`resolveV2Iterable: subscribe({signal}) returned ${typeLabel} ${keys} isAsyncIterable=${isAsyncIterable(raw)}`);
  return raw;
}

// src/adapters/v2/sdk-fallback.ts
function getCandidateUrls() {
  const candidates = [];
  for (const key of ["OPENCODE_SERVER_URL", "OPENCODE_API_URL", "OPENCODE_SERVER"]) {
    const v = process.env[key];
    if (v)
      candidates.push(v);
  }
  candidates.push("http://localhost:49374");
  const envPort = process.env.ORCA_AGENT_HOOK_PORT;
  if (envPort)
    candidates.push(`http://localhost:${envPort}`);
  candidates.push("http://localhost:4096", "http://localhost:8080");
  return [...new Set(candidates)];
}
async function tryCreateForSpec(url, spec) {
  let createOpencodeClient = null;
  try {
    const m = await import(spec).catch(() => null);
    createOpencodeClient = m?.createOpencodeClient ?? null;
  } catch {}
  if (!createOpencodeClient)
    return;
  return tryCreateClientInstance(createOpencodeClient, url);
}
async function tryCreateClientInstance(factory, url) {
  try {
    const client = factory({ baseUrl: url });
    await verifyClient(client);
    return { client, session: client.session, url };
  } catch {}
  return;
}
async function verifyClient(client) {
  await (client.session.list?.({ limit: 1 }) ?? Promise.resolve());
  const hasEvent = typeof client.event?.subscribe === "function";
  if (!hasEvent)
    throw new Error("no event.subscribe");
}
async function createFallbackSdkClient(sink) {
  const urls = getCandidateUrls();
  for (const url of urls) {
    const specs = ["@opencode-ai/sdk/v2", "@opencode-ai/sdk"];
    for (const spec of specs) {
      const result = await tryCreateForSpec(url, spec);
      if (result)
        return result;
    }
  }
  await sink.warn(`fallback SDK client: all candidates failed (${urls.join(", ")})`);
  return;
}

// src/adapters/v2/plugin.v2.ts
async function handleV2IdleEvent(params) {
  const adapter = toSessionPort(params.session);
  await generateDailyLogbookCore({
    sessionId: params.sessionID,
    directory: params.directory,
    sink: params.sink,
    adapter
  });
}
function getV2Directory(anyCtx) {
  return anyCtx.location?.directory ?? anyCtx.directory ?? anyCtx.worktree ?? process.cwd();
}
function getV2CtxKeys(anyCtx) {
  try {
    return Object.keys(anyCtx).sort().join(",");
  } catch {
    return "unknown";
  }
}
function detectV1Host(ctxKeys, hasEventSubscribe, hasSession) {
  try {
    return ctxKeys.includes("agent") && ctxKeys.includes("skill") && !hasEventSubscribe && !hasSession;
  } catch {
    return false;
  }
}
function resolveEventHost(anyCtx) {
  return anyCtx.event ?? anyCtx.client?.event;
}
async function tryHandleEventHost(eventHost, anyCtx, sink, directory) {
  if (!eventHost?.subscribe)
    return;
  const controller = new AbortController;
  const session = anyCtx.session ?? await createFallbackSessionAdapter(sink, anyCtx.serverUrl, directory);
  if (!session) {
    await sink.warn("v2: no session adapter available (ctx.session missing and fallback failed); idle handling disabled");
    return;
  }
  runV2EventLoop({ event: eventHost, session }, sink, directory, controller);
  return () => controller.abort();
}
async function tryHandleSdkFallback(sink, directory) {
  const sdkFallback = await createFallbackSdkClient(sink);
  if (!sdkFallback)
    return;
  const sdkEventHost = sdkFallback.client.event;
  if (!sdkEventHost?.subscribe)
    return;
  await sink.info?.(`v2: using SDK fallback for event subscription via ${sdkFallback.url}`);
  const fileSession = await createFallbackSessionAdapter(sink, null, directory);
  if (!fileSession) {
    await sink.warn("v2: SDK event fallback has no file session; idle handling disabled");
    return;
  }
  const controller = new AbortController;
  runV2EventLoop({ event: sdkEventHost, session: fileSession }, sink, directory, controller);
  return () => controller.abort();
}
function buildV2FallbackHook(fallbackSession, sink, directory) {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle")
        return;
      const data = event.data;
      const properties = event.properties;
      const sessionID = data?.sessionID ?? properties?.sessionID;
      if (!sessionID) {
        await sink.warn("session.idle event missing sessionID; skipping");
        return;
      }
      await handleV2IdleEvent({ sessionID, directory, sink, session: fallbackSession });
    }
  };
}
async function logV2Startup(sink, anyCtx, ctxKeys, hasEventSubscribe, hasClientEventSubscribe, hasSession, isV1Host) {
  const v2Message = `daily-logbook plugin loaded (v2) app=${anyCtx.app?.name ?? "unknown"} ${anyCtx.app?.version ?? ""} ctxKeys=[${ctxKeys}] event.subscribe=${hasEventSubscribe ? "yes" : "no"} client.event.subscribe=${hasClientEventSubscribe ? "yes" : "no"} session=${hasSession ? "yes" : "no"}${isV1Host ? " [V1 host detected via Orca shared \u2014 delegating to V1]" : ""}`;
  await sink.info?.(v2Message);
  console.log(v2Message);
  if (isV1Host) {
    await sink.warn("v2Setup called on V1 host (ctxKeys without event/session). This is Orca shared's plugins being loaded by opencode 1.18.x. Daily-logbook will be handled by V1 DailyLogbookPlugin, not v2. Skipping v2 event setup.");
  }
}
async function handleFallbackHook(anyCtx, sink, directory, ctxKeys) {
  await sink.warn(`v2: ctx.event.subscribe not found (ctxKeys=[${ctxKeys}]); falling back to return {event} hook. If idle is still not delivered, use opencode (v1) with 2.0.3.`);
  const fallbackSession = anyCtx.session ?? await createFallbackSessionAdapter(sink, anyCtx.serverUrl, directory);
  if (!fallbackSession) {
    await sink.warn("v2: no session adapter for fallback hook; idle handling disabled");
    return;
  }
  return buildV2FallbackHook(fallbackSession, sink, directory);
}
async function v2Setup(ctx) {
  const anyCtx = ctx;
  const directory = getV2Directory(anyCtx);
  const sink = createV2LogSink();
  const ctxKeys = getV2CtxKeys(anyCtx);
  const hasEventSubscribe = typeof anyCtx.event?.subscribe === "function";
  const hasClientEventSubscribe = typeof anyCtx.client?.event?.subscribe === "function";
  const hasSession = !!anyCtx.session;
  const isV1Host = detectV1Host(ctxKeys, hasEventSubscribe, hasSession);
  await logV2Startup(sink, anyCtx, ctxKeys, hasEventSubscribe, hasClientEventSubscribe, hasSession, isV1Host);
  if (isV1Host)
    return;
  const eventHost = resolveEventHost(anyCtx);
  const hostResult = await tryHandleEventHost(eventHost, anyCtx, sink, directory);
  if (hostResult)
    return hostResult;
  const sdkResult = await tryHandleSdkFallback(sink, directory);
  if (sdkResult)
    return sdkResult;
  return handleFallbackHook(anyCtx, sink, directory, ctxKeys);
}
async function runV2EventLoop(anyCtx, sink, directory, controller) {
  try {
    const iterable = await resolveV2Iterable(anyCtx.event?.subscribe, controller.signal, sink, anyCtx.event);
    if (!iterable) {
      await sink.warn(`event.subscribe did not return AsyncIterable (event.subscribe=${typeof anyCtx.event?.subscribe}) \u2014 trying fallback poll; v2 plugin idle subscription failed. ctx.event keys=${anyCtx.event ? Object.keys(anyCtx.event).join(",") : "no-event"}`);
      return;
    }
    for await (const event of iterable) {
      if (event.type !== "session.idle")
        continue;
      const sessionID = extractSessionId(event);
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
}
function extractSessionId(event) {
  const data = event.data;
  const properties = event.properties;
  return data?.sessionID ?? properties?.sessionID;
}
// src/adapters/hybrid.ts
import { createRequire } from "module";
function getEffectWrappedSetup() {
  try {
    const require2 = createRequire(import.meta.url);
    const mod = require2("effect");
    if (mod.Effect && typeof mod.Effect.promise === "function") {
      return (ctx) => mod.Effect.promise(() => v2Setup(ctx));
    }
  } catch {}
  return;
}
function loadDefine(spec) {
  try {
    const require2 = createRequire(import.meta.url);
    const mod = require2(spec);
    const define = mod?.Plugin?.define ?? mod?.define;
    if (typeof define === "function")
      return define;
  } catch {}
  return;
}
function tryCreateV2Plugin() {
  const setupSpecs = ["@opencode-ai/plugin", "@opencode-ai/plugin/v2/promise"];
  for (const spec of setupSpecs) {
    const define = loadDefine(spec);
    if (define) {
      try {
        return define({ id: "smapira.daily-logbook", setup: v2Setup });
      } catch {}
    }
  }
  const wrapped = getEffectWrappedSetup();
  if (wrapped) {
    const effectSpecs = ["@opencode-ai/plugin/v2/effect", "@opencode-ai/plugin/effect"];
    for (const spec of effectSpecs) {
      const define = loadDefine(spec);
      if (define) {
        try {
          return define({ id: "smapira.daily-logbook", effect: wrapped });
        } catch {}
      }
    }
  }
  return { id: "smapira.daily-logbook", setup: v2Setup };
}
var DailyLogbookPluginV2 = tryCreateV2Plugin();
function createHybridDefault() {
  const wrapped = getEffectWrappedSetup();
  if (wrapped) {
    return { id: "smapira.daily-logbook", setup: v2Setup, effect: wrapped };
  }
  return { id: "smapira.daily-logbook", setup: v2Setup };
}
var hybridDefault = createHybridDefault();
var hybrid_default = hybridDefault;
// src/plugin.ts
var plugin_default = hybrid_default;
export {
  v2Setup,
  truncateText,
  toSessionPort,
  toAsyncIterable,
  runV2EventLoop,
  resolveV2Iterable,
  resetForTest,
  replaceTemplateVariables,
  maskSecrets,
  isWithinWindow,
  isUsageProjectOnly,
  isRedactEnabled,
  isEffectStream,
  isDailyLogbookExists,
  isAsyncIterable,
  handleV2IdleEvent,
  handleV1IdleEvent,
  getUsageStats,
  getThrottleWindowMs,
  getDbPath,
  getCandidateUrls,
  generateDailyLogbookCore,
  formatUsageTable,
  formatTokens,
  formatCost,
  extractReadableText,
  plugin_default as default,
  createV2LogSink,
  createV1SessionPort,
  createV1LogSink,
  createV1FallbackSessionPort,
  createV1FallbackAdapter,
  createFallbackSessionAdapter,
  createFallbackSdkClient,
  buildTranscript,
  buildPrompt,
  __resetGlobalStateForTest,
  SECRET_PATTERNS,
  SAMPLE_TEMPLATE,
  DailyLogbookPluginV2,
  DailyLogbookPlugin
};
