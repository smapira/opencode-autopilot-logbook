import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const SAMPLE_TEMPLATE = `Create a daily logbook based on the session {{ sessionId }}.

## Steps

1. Check today's date ({{ dateJp }})
2. Create \`{{ outputDir }}/{{ date }}_logbook.md\` (append or update if it exists)
3. Report the created filename

## Guidelines

- Do not overwrite existing files; append or update instead
- Keep the logbook concise and focused on key points
- Prioritize discussion highlights, decisions made, and next actions
- Output language is template-driven (this default template uses English)
- Clearly separate facts from opinions (speculation/evaluation)`;

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

function formatDateTokens(now: Date): { date: string; dateJp: string } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  return {
    date: `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`,
    dateJp: `${year}年${month}月${day}日`,
  };
}

function replaceTemplateVariables(template: string, sessionId: string, now: Date, outputDir: string): string {
  const { date, dateJp } = formatDateTokens(now);

  return template
    .replace(/\{\{\s*sessionId\s*\}\}/g, sessionId)
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*dateJp\s*\}\}/g, dateJp)
    .replace(/\{\{\s*outputDir\s*\}\}/g, outputDir);
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
): string {
  const replacedTemplate = replaceTemplateVariables(template, sessionId, now, outputDir);

  // When INCLUDE_TRANSCRIPT is false, omit the transcript section entirely.
  // The transcript never enters the prompt, regardless of the REDACT setting.
  if (!includeTranscript || !transcript) {
    return replacedTemplate;
  }

  return `${replacedTemplate}

---
Below is an excerpt of the session ${sessionId} history. Create the daily logbook based on this history.

${transcript}`;
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
        const prompt = buildPrompt(template, originalSessionId, transcript, includeTranscript, promptOutputDir, now);

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

export default DailyLogbookPlugin;
