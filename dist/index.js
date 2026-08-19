// @bun
// daily-logbook.ts
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
var SERVICE_NAME = "daily-logbook-plugin";
var GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
var DUPLICATE_WINDOW_MS = 90000;
var TRANSCRIPT_MAX_MESSAGES = 80;
var TRANSCRIPT_MAX_CHARS = 12000;
var inFlightSessionIds = new Set;
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
- If the session contains mixed Japanese/English, prefer English in the logbook
- Clearly separate facts from opinions (speculation/evaluation)`;
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi
];
function maskSecrets(value) {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
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
function formatDateTokens(now) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return {
    date: `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
    dateJp: `${year}\u5E74${month}\u6708${day}\u65E5`
  };
}
function replaceTemplateVariables(template, sessionId, now) {
  const { date, dateJp } = formatDateTokens(now);
  return template.replace(/\{\{\s*sessionId\s*\}\}/g, sessionId).replace(/\{\{\s*date\s*\}\}/g, date).replace(/\{\{\s*dateJp\s*\}\}/g, dateJp).replace(/\{\{\s*outputDir\s*\}\}/g, getOutputDir());
}
function loadTemplate(directory) {
  const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
  if (!customTemplatePath) {
    return SAMPLE_TEMPLATE;
  }
  const resolvedTemplatePath = resolve(directory, customTemplatePath);
  return readFileSync(resolvedTemplatePath, "utf-8");
}
async function logWarn(client, message) {
  try {
    await client.app.log({
      body: {
        service: SERVICE_NAME,
        level: "warn",
        message
      }
    });
  } catch {}
}
function truncateText(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}
...(truncated)`;
}
function extractReadableText(part) {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  return "";
}
function buildTranscript(messages) {
  const recentMessages = messages.slice(-TRANSCRIPT_MAX_MESSAGES);
  const transcriptLines = recentMessages.map(({ info, parts }) => {
    const roleLabel = info.role === "user" ? "User" : "Assistant";
    const text = parts.map((part) => extractReadableText(part)).join(`
`).trim();
    if (!text) {
      return "";
    }
    return `[${roleLabel}]
${text}`;
  }).filter((line) => line.length > 0).join(`

`);
  if (!transcriptLines) {
    return "(No summarizable text history found in the source session)";
  }
  const maskedTranscript = isRedactEnabled() ? maskSecrets(transcriptLines) : transcriptLines;
  return truncateText(maskedTranscript, TRANSCRIPT_MAX_CHARS);
}
function buildPrompt(template, sessionId, transcript, includeTranscript) {
  const now = new Date;
  const replacedTemplate = replaceTemplateVariables(template, sessionId, now);
  if (!includeTranscript || !transcript) {
    return replacedTemplate;
  }
  return `${replacedTemplate}

---
Below is an excerpt of the session ${sessionId} history. Create the daily logbook based on this history.

${transcript}`;
}
async function logError(client, message, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  try {
    await client.app.log({
      body: {
        service: SERVICE_NAME,
        level: "error",
        message: `${message}: ${errorMessage}`
      }
    });
  } catch {}
}
function isWithinWindow(lastTriggeredAt, nowMs, windowMs) {
  if (lastTriggeredAt === undefined) {
    return false;
  }
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
      inFlightSessionIds.add(originalSessionId);
      try {
        const currentSessionResult = await client.session.get({
          path: { id: originalSessionId }
        });
        if (currentSessionResult.error) {
          await logError(client, "Failed to fetch source session", currentSessionResult.error);
          return;
        }
        const currentSessionTitle = currentSessionResult.data.title ?? "";
        if (currentSessionTitle.startsWith(GENERATED_TITLE_PREFIX)) {
          return;
        }
        const date = formatDateTokens(new Date).date;
        if (isDailyLimitEnabled()) {
          const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
          if (customTemplatePath) {
            await logWarn(client, "OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT is not supported together with OPENCODE_DAILY_LOGBOOK_TEMPLATE (file name pattern is unknown). Daily limit check is skipped.");
          } else if (isDailyLogbookExists(directory, getOutputDir(), date)) {
            await logWarn(client, `Daily logbook for ${date} already exists. Skipping generation (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`);
            return;
          }
        }
        let template = SAMPLE_TEMPLATE;
        try {
          template = loadTemplate(directory);
        } catch (error) {
          const customTemplatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
          await logWarn(client, `Template load failed (${customTemplatePath ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`);
          await logError(client, "Template load error", error);
        }
        const messagesResult = await client.session.messages({
          path: { id: originalSessionId }
        });
        if (messagesResult.error) {
          await logError(client, "Failed to load source session messages", messagesResult.error);
          return;
        }
        const includeTranscript = isTranscriptIncluded();
        const transcript = includeTranscript ? buildTranscript(messagesResult.data) : "";
        const prompt = buildPrompt(template, originalSessionId, transcript, includeTranscript);
        const generatedSessionResult = await client.session.create({
          body: {
            title: `${GENERATED_TITLE_PREFIX} ${formatDateTokens(new Date).date}`
          }
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
                text: prompt
              }
            ]
          }
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
      }
    }
  };
};
var daily_logbook_default = DailyLogbookPlugin;
export {
  maskSecrets,
  isWithinWindow,
  isDailyLogbookExists,
  getThrottleWindowMs,
  daily_logbook_default as default,
  buildTranscript,
  DailyLogbookPlugin
};
