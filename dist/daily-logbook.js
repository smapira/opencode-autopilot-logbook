// @bun
// .github/plugins/daily-logbook.ts
import { readFileSync } from "fs";
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
var SAMPLE_TEMPLATE = `\u30BB\u30C3\u30B7\u30E7\u30F3 {{ sessionId }} \u306E\u5185\u5BB9\u3092\u5143\u306B\u3001\u65E5\u5831\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002

## \u624B\u9806

1. \u4ECA\u65E5\u306E\u65E5\u4ED8\uFF08{{ dateJp }}\uFF09\u3092\u78BA\u8A8D\u3059\u308B
2. \`{{ outputDir }}/{{ date }}_\u65E5\u5831.md\` \u3092\u4F5C\u6210\uFF08\u65E2\u5B58\u304C\u3042\u308C\u3070\u8FFD\u8A18\u30FB\u66F4\u65B0\uFF09
3. \u4F5C\u6210\u3057\u305F\u30D5\u30A1\u30A4\u30EB\u540D\u3092\u5831\u544A\u3059\u308B

## \u6CE8\u610F\u4E8B\u9805

- \u65E2\u5B58\u30D5\u30A1\u30A4\u30EB\u304C\u3042\u308B\u5834\u5408\u306F\u4E0A\u66F8\u304D\u305B\u305A\u3001\u8FFD\u8A18\u30FB\u66F4\u65B0\u3059\u308B
- \u65E5\u5831\u306F\u77ED\u304F\u8981\u70B9\u3092\u7D5E\u3063\u3066\u66F8\u304F
- \u3084\u308A\u3068\u308A\u306E\u8981\u70B9\u3001\u6C7A\u307E\u3063\u305F\u65B9\u91DD\u3001\u6B21\u30A2\u30AF\u30B7\u30E7\u30F3\u3092\u512A\u5148\u3059\u308B
- \u4E8B\u5B9F\u3068\u610F\u898B\uFF08\u63A8\u6E2C\u30FB\u8A55\u4FA1\uFF09\u306F\u660E\u78BA\u306B\u5206\u3051\u3066\u66F8\u304F`;
function isPluginDisabled() {
  return process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true";
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
...\uFF08\u9577\u3044\u305F\u3081\u7701\u7565\uFF09`;
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
    return "\uFF08\u5143\u30BB\u30C3\u30B7\u30E7\u30F3\u306B\u8981\u7D04\u53EF\u80FD\u306A\u30C6\u30AD\u30B9\u30C8\u5C65\u6B74\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\uFF09";
  }
  return truncateText(transcriptLines, TRANSCRIPT_MAX_CHARS);
}
function buildPrompt(template, sessionId, transcript) {
  const now = new Date;
  const replacedTemplate = replaceTemplateVariables(template, sessionId, now);
  return `${replacedTemplate}

---
\u4EE5\u4E0B\u306F\u30BB\u30C3\u30B7\u30E7\u30F3 ${sessionId} \u306E\u5C65\u6B74\u629C\u7C8B\u3067\u3059\u3002\u5C65\u6B74\u306B\u57FA\u3065\u3044\u3066\u65E5\u5831\u3092\u4F5C\u6210\u3057\u3066\u304F\u3060\u3055\u3044\u3002

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
function isDuplicateTrigger(sessionId, nowMs) {
  const lastTriggeredAt = recentlyTriggeredAtBySessionId.get(sessionId);
  if (!lastTriggeredAt) {
    return false;
  }
  return nowMs - lastTriggeredAt < DUPLICATE_WINDOW_MS;
}
function pruneExpiredGuards(nowMs) {
  for (const [sessionId, timestamp] of recentlyTriggeredAtBySessionId.entries()) {
    if (nowMs - timestamp >= DUPLICATE_WINDOW_MS * 2) {
      recentlyTriggeredAtBySessionId.delete(sessionId);
    }
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
      if (event.type !== "session.idle") {
        return;
      }
      if (isPluginDisabled()) {
        return;
      }
      const originalSessionId = event.properties.sessionID;
      const nowMs = Date.now();
      pruneExpiredGuards(nowMs);
      if (inFlightSessionIds.has(originalSessionId) || isDuplicateTrigger(originalSessionId, nowMs)) {
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
        const transcript = buildTranscript(messagesResult.data);
        const prompt = buildPrompt(template, originalSessionId, transcript);
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
  daily_logbook_default as default,
  DailyLogbookPlugin
};
