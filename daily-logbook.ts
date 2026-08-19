import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const SERVICE_NAME = "daily-logbook-plugin";
const GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";
const DUPLICATE_WINDOW_MS = 90_000;
const TRANSCRIPT_MAX_MESSAGES = 80;
const TRANSCRIPT_MAX_CHARS = 12_000;

const inFlightSessionIds = new Set<string>();
// daily-limit 有効時のみ使う日付キーの in-flight ガード。
// inFlightSessionIds はセッション単位のため、別セッションが同時に idle すると
// 両方が存在チェックを通過して二重生成され得る。日付キーでそれを防ぐ。
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
- If the session contains mixed Japanese/English, prefer English in the logbook
- Clearly separate facts from opinions (speculation/evaluation)`;

// 既知のシークレットパターン。置換は配列の順序で行う。
// 秘密鍵ブロックは複数行にまたがるため、他のパターンより先に処理しないと
// ブロックの一部だけがマスクされ、鍵の中身が残ってしまう。
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b[sS][kK]-[A-Za-z0-9_-]{8,}\b/g, // OpenAI-style keys (sk-.../SK-.../sk-ant-...)
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <token>
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PATs (github_pat_...)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens (xoxb-, xoxa-, xoxp-, ...)
  // JWT は eyJ で始まる 3 セグメント構造。各セグメントに上限を付与し、
  // 長大な連続文字列での polynomial バックトラッキングを予防する。
  // 実用上の base64url セグメントは 120 文字を大きく下回る（上限は安全マージン）。
  /\beyJ[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\.[A-Za-z0-9_-]{10,120}\b/g, // JWTs (eyJ...)
  /(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi,
];

/**
 * 既知のシークレットパターンを `***` に置換する。
 *
 * これは「転送事故を減らす」ためのフェイルセーフであり、完全な秘密保護を
 * 保証するものではない。機密情報を prompt に含めない運用が前提。
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
  // 既定で有効（フェイルセーフ）。無効化は "false" の厳密一致のみ受け付ける。
  return process.env.OPENCODE_DAILY_LOGBOOK_REDACT !== "false";
}

function isTranscriptIncluded(): boolean {
  // 既定で埋め込み。無効化は "false" の厳密一致のみ受け付ける。
  return process.env.OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT !== "false";
}

function isDailyLimitEnabled(): boolean {
  // 既定で無効。有効化は "true" の厳密一致のみ（既存 DISABLED と同じ規約）。
  return process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT === "true";
}

export function getThrottleWindowMs(): number {
  const rawValue = process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
  if (rawValue === undefined || rawValue === "") {
    return DUPLICATE_WINDOW_MS;
  }

  const parsedMs = Number.parseInt(rawValue, 10);
  // 整数として解釈できない値・負値は意味のある設定ではないため既定（後方互換）にフォールバック。
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
    // ログ出力失敗で本処理を壊さないため、ここでは no-op とする。
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

  // マスキングは truncate の前に行う。
  // truncate 後に適用すると切り口でシークレットが分割され、マスク漏れするため。
  const maskedTranscript = isRedactEnabled() ? maskSecrets(transcriptLines) : transcriptLines;

  return truncateText(maskedTranscript, TRANSCRIPT_MAX_CHARS);
}

/**
 * テンプレートに transcript を付加して prompt を組み立てる。
 *
 * `now` はイベントハンドラで解決した時刻を注入する。内部で `new Date()` を
 * 再実行しないことで、0 時跨ぎに `{{ date }}` が存在チェック・タイトルと
 * 別の日付へずれることを防ぐ（daily-limit の日付キーを 1 回に統一する）。
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

  // INCLUDE_TRANSCRIPT=false 時は transcript セクションごと省く。
  // REDACT の設定に関わらず transcript 自体が prompt に入らない。
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
    // ログ出力失敗で本処理を壊さないため、ここでは no-op とする。
  }
}

/**
 * 前回トリガーから `windowMs` 以内かどうかの純粋述語。
 * モジュール内 Map に依存しないため、単体テストが容易。
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
 * 既定ファイル名 `{{ outputDir }}/{{ date }}_logbook.md` が既に存在するかを
 * ファイルベースで判定する（プロセス再起動を跨いで機能する）。
 *
 * パス解決は loadTemplate と同じく `directory`（プラグイン起動ディレクトリ）
 * 基準。CWD に依存しないため、どのディレクトリから起動しても一貫する。
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

      // 日付・出力先はこのイベント処理全体で1回だけ解決し、daily-limit の
      // 存在チェック・プロンプト・タイトル生成で同じ値を使い回す。
      // `now` をそのまま buildPrompt へ渡すことで、0 時跨ぎでも prompt 内の
      // 日付が存在チェック・タイトルと一致し続ける。
      const now = new Date();
      const { date } = formatDateTokens(now);
      const outputDir = getOutputDir();
      const isDailyLimited = isDailyLimitEnabled();

      // daily-limit 有効時のみ、日付キーのグローバル in-flight ガードを確認する。
      // 別セッションが同時に idle した場合、両方が存在チェックを通過すると
      // 同日付の生成が二重に走ってしまうため、ここで抑制する。
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

        // daily-limit: 既定ファイル名が既に存在すれば当日中の再生成をスキップする。
        // ファイルベース判定のためプロセス再起動を跨いで機能する。
        // カスタムテンプレート使用時はファイル名パターンが変わって判定不能になるため非対応。
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

        // daily-limit 有効時は、エージェント（別プロセス）が CWD 基準でファイルを
        // 書くため、存在チェックと同じ `directory` 基準の絶対パスを prompt に渡す。
        // 無効時は従来どおり相対文字列を渡す（後方互換）。
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
