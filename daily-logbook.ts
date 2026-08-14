import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const SERVICE_NAME = "daily-logbook-plugin";
const GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
const DUPLICATE_WINDOW_MS = 90_000;
const TRANSCRIPT_MAX_MESSAGES = 80;
const TRANSCRIPT_MAX_CHARS = 12_000;

const inFlightSessionIds = new Set<string>();
const recentlyTriggeredAtBySessionId = new Map<string, number>();

const DEFAULT_OUTPUT_DIR = "artifacts/daily";

function getOutputDir(): string {
  return process.env.OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}

const SAMPLE_TEMPLATE = `セッション {{ sessionId }} の内容を元に、日報を作成してください。

## 手順

1. 今日の日付（{{ dateJp }}）を確認する
2. \`{{ outputDir }}/{{ date }}_logbook.md\` を作成（既存があれば追記・更新）
3. 作成したファイル名を報告する

## 注意事項

- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く要点を絞って書く
- やりとりの要点、決まった方針、次アクションを優先する
- 事実と意見（推測・評価）は明確に分けて書く`;

type Logger = PluginInput["client"];

function isPluginDisabled(): boolean {
  return process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true";
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

function replaceTemplateVariables(template: string, sessionId: string, now: Date): string {
  const { date, dateJp } = formatDateTokens(now);

  return template
    .replace(/\{\{\s*sessionId\s*\}\}/g, sessionId)
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*dateJp\s*\}\}/g, dateJp)
    .replace(/\{\{\s*outputDir\s*\}\}/g, getOutputDir());
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
    // ログ出力失敗で本処理を壊さないため、ここでは no-op とする。
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...（長いため省略）`;
}

function extractReadableText(part: { type: string; [key: string]: unknown }): string {
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }

  return "";
}

function buildTranscript(
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
    return "（元セッションに要約可能なテキスト履歴が見つかりませんでした）";
  }

  return truncateText(transcriptLines, TRANSCRIPT_MAX_CHARS);
}

function buildPrompt(template: string, sessionId: string, transcript: string): string {
  const now = new Date();
  const replacedTemplate = replaceTemplateVariables(template, sessionId, now);

  return `${replacedTemplate}

---
以下はセッション ${sessionId} の履歴抜粋です。履歴に基づいて日報を作成してください。

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
    // ログ出力失敗で本処理を壊さないため、ここでは no-op とする。
  }
}

function isDuplicateTrigger(sessionId: string, nowMs: number): boolean {
  const lastTriggeredAt = recentlyTriggeredAtBySessionId.get(sessionId);
  if (!lastTriggeredAt) {
    return false;
  }

  return nowMs - lastTriggeredAt < DUPLICATE_WINDOW_MS;
}

function pruneExpiredGuards(nowMs: number): void {
  for (const [sessionId, timestamp] of recentlyTriggeredAtBySessionId.entries()) {
    if (nowMs - timestamp >= DUPLICATE_WINDOW_MS * 2) {
      recentlyTriggeredAtBySessionId.delete(sessionId);
    }
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

        const transcript = buildTranscript(messagesResult.data);
        const prompt = buildPrompt(template, originalSessionId, transcript);

        const generatedSessionResult = await client.session.create({
          body: {
            title: `${GENERATED_TITLE_PREFIX} ${formatDateTokens(new Date()).date}`,
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
      }
    },
  };
};

export default DailyLogbookPlugin;
