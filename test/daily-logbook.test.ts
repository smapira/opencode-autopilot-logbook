import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildTranscript,
  getThrottleWindowMs,
  isDailyLogbookExists,
  isWithinWindow,
  maskSecrets,
} from "../daily-logbook";
import { DailyLogbookPlugin } from "../daily-logbook";

type Message = {
  info: { role: "user" | "assistant" };
  parts: Array<{ type: string; [key: string]: unknown }>;
};

function messageOf(role: "user" | "assistant", text: string): Message {
  return { info: { role }, parts: [{ type: "text", text }] };
}

describe("maskSecrets", () => {
  test("masks OpenAI-style keys", () => {
    expect(maskSecrets("my key is sk-abcdefgh1234")).toBe("my key is ***");
  });

  test("masks uppercase SK- keys (fail-safe hardening)", () => {
    expect(maskSecrets("my key is SK-ABCDEFGH1234")).toBe("my key is ***");
  });

  test("masks Bearer tokens", () => {
    expect(maskSecrets("Authorization: Bearer abcdef1234567890")).toBe("Authorization: ***");
  });

  test("masks AWS access key IDs", () => {
    expect(maskSecrets("access key AKIAIOSFODNN7EXAMPLE used")).toBe("access key *** used");
  });

  test("masks GitHub tokens", () => {
    expect(maskSecrets("token ghp_1234567890abcdefghijklmnopqrstuvwx")).toBe("token ***");
  });

  test("masks GitHub fine-grained PATs", () => {
    expect(maskSecrets("token github_pat_11ABCdefghijklmnopqrstuvwx")).toBe("token ***");
  });

  test("masks Slack tokens", () => {
    expect(maskSecrets("slack xoxb-1234567890-abcdefghij")).toBe("slack ***");
  });

  test("masks JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(maskSecrets(`token ${jwt}`)).toBe("token ***");
  });

  test("masks password-style key/value pairs", () => {
    expect(maskSecrets("db password: hunter2")).toBe("db ***");
    expect(maskSecrets("api_key=\"abc123\"").includes("abc123")).toBe(false);
  });

  test("masks PEM private key blocks", () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    expect(maskSecrets(pem)).toBe("***");
  });

  test("masks multiple secrets in one text", () => {
    const input = "sk-abcdefgh1234 and ghp_1234567890abcdefghijklmnopqrstuvwx";
    expect(maskSecrets(input)).toBe("*** and ***");
  });

  test("leaves text without secrets unchanged", () => {
    const input = "This is a plain conversation about the weather.";
    expect(maskSecrets(input)).toBe(input);
  });

  test("leaves empty string unchanged", () => {
    expect(maskSecrets("")).toBe("");
  });
});

describe("buildTranscript", () => {
  const REDACT_ENV = "OPENCODE_DAILY_LOGBOOK_REDACT";

  beforeEach(() => {
    delete process.env[REDACT_ENV];
  });

  afterEach(() => {
    delete process.env[REDACT_ENV];
  });

  test("masks secrets in transcript by default", () => {
    const messages = [messageOf("user", "my token is sk-abcdefgh1234")];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain("***");
    expect(transcript).not.toContain("sk-abcdefgh1234");
  });

  test("masks secrets before truncation so a secret split at the cut point is not leaked", () => {
    // transcript は `[User]\n`(7) + filler + スペース(1) + シークレット(15) で構成される。
    // filler = 11_990 のときシークレット先頭は 11_998 文字目(0始まり)から始まり、
    // 12_000 文字の切り口で先頭 2 文字 "sk" が分割されて残る。
    // truncate 後にマスクする実装だとこの断片がマスクされずに残るため、
    // `not.toContain("sk")` の失敗で「truncate 前適用」を検証できる。
    // （filler は "a" のみなので "sk" はシークレット由来と確定できる）
    const filler = "a".repeat(11_990);
    const messages = [messageOf("user", `${filler} sk-abcdefgh1234`)];
    const transcript = buildTranscript(messages);

    expect(transcript.endsWith("...(truncated)")).toBe(true);
    expect(transcript).not.toContain("sk");
  });

  test("does not mask when OPENCODE_DAILY_LOGBOOK_REDACT=false", () => {
    process.env[REDACT_ENV] = "false";
    const messages = [messageOf("user", "my token is sk-abcdefgh1234")];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain("sk-abcdefgh1234");
  });

  test("returns a notice when there is no text history", () => {
    const messages: Message[] = [
      { info: { role: "user" }, parts: [{ type: "tool", text: "ignored" }] },
    ];
    expect(buildTranscript(messages)).toBe("(No summarizable text history found in the source session)");
  });
});

describe("isWithinWindow", () => {
  test("returns true inside the window", () => {
    expect(isWithinWindow(1_000, 1_099, 100)).toBe(true);
  });

  test("returns false exactly at the window boundary", () => {
    expect(isWithinWindow(1_000, 1_100, 100)).toBe(false);
  });

  test("returns false outside the window", () => {
    expect(isWithinWindow(1_000, 2_000, 100)).toBe(false);
  });

  test("returns false when lastTriggeredAt is undefined", () => {
    expect(isWithinWindow(undefined, 2_000, 100)).toBe(false);
  });
});

describe("getThrottleWindowMs", () => {
  const THROTTLE_ENV = "OPENCODE_DAILY_LOGBOOK_THROTTLE_MS";

  beforeEach(() => {
    delete process.env[THROTTLE_ENV];
  });

  afterEach(() => {
    delete process.env[THROTTLE_ENV];
  });

  test("falls back to the default window when unset", () => {
    expect(getThrottleWindowMs()).toBe(90_000);
  });

  test("parses a positive integer", () => {
    process.env[THROTTLE_ENV] = "5000";
    expect(getThrottleWindowMs()).toBe(5_000);
  });

  test("falls back to the default window on NaN", () => {
    process.env[THROTTLE_ENV] = "not-a-number";
    expect(getThrottleWindowMs()).toBe(90_000);
  });

  test("falls back to the default window on negative values", () => {
    process.env[THROTTLE_ENV] = "-1000";
    expect(getThrottleWindowMs()).toBe(90_000);
  });
});

describe("isDailyLogbookExists", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logbook-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns true when the daily logbook file exists", () => {
    const outputDir = "artifacts/daily";
    mkdirSync(join(tempDir, outputDir), { recursive: true });
    writeFileSync(join(tempDir, outputDir, "20260819_logbook.md"), "content");

    expect(isDailyLogbookExists(tempDir, outputDir, "20260819")).toBe(true);
  });

  test("returns false when the daily logbook file does not exist", () => {
    expect(isDailyLogbookExists(tempDir, "artifacts/daily", "20260819")).toBe(false);
  });

  test("returns false when the output directory itself does not exist", () => {
    expect(isDailyLogbookExists(tempDir, "no/such/dir", "20260819")).toBe(false);
  });

  test("resolves the path relative to directory, not the current working directory", () => {
    // 別の場所に同名ファイルを置いても directory 基準では見つからないことを確認する。
    const elsewhere = mkdtempSync(join(tmpdir(), "logbook-elsewhere-"));
    try {
      mkdirSync(join(elsewhere, "artifacts/daily"), { recursive: true });
      writeFileSync(join(elsewhere, "artifacts/daily", "20260819_logbook.md"), "content");

      expect(isDailyLogbookExists(tempDir, "artifacts/daily", "20260819")).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// プラグインの event フックをモッククライアントで駆動する統合テスト。
// モジュールレベルの in-flight ガード（inFlightSessionIds /
// dailyLimitInFlightByDate）と prompt へ渡す outputDir の解決を検証する。
// ---------------------------------------------------------------------------

const DAILY_LIMIT_ENV = "OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT";
const THROTTLE_ENV = "OPENCODE_DAILY_LOGBOOK_THROTTLE_MS";

const PLUGIN_ENV_KEYS = [
  "OPENCODE_DAILY_LOGBOOK_DISABLED",
  DAILY_LIMIT_ENV,
  THROTTLE_ENV,
  "OPENCODE_DAILY_LOGBOOK_TEMPLATE",
  "OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR",
  "OPENCODE_DAILY_LOGBOOK_REDACT",
  "OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT",
] as const;

function snapshotPluginEnv(): Array<[string, string | undefined]> {
  return PLUGIN_ENV_KEYS.map((key) => [key, process.env[key]]);
}

function restorePluginEnv(snapshot: Array<[string, string | undefined]>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

type IdleEventInput = {
  event: {
    type: "session.idle";
    properties: { sessionID: string };
  };
};

type MockClient = {
  app: {
    log: (input: unknown) => Promise<void>;
  };
  session: {
    get: (input: unknown) => Promise<{ data: { id: string; title: string }; error?: unknown }>;
    messages: (input: unknown) => Promise<{ data: unknown[]; error?: unknown }>;
    create: (input: unknown) => Promise<{ data: { id: string }; error?: unknown }>;
    promptAsync: (input: { body: { parts: Array<{ text: string }> } }) => Promise<{ data: unknown; error?: unknown }>;
  };
};

function createMockClient(gatePrompt?: () => Promise<void>) {
  const promptTexts: string[] = [];
  let promptCount = 0;

  const client: MockClient = {
    app: { log: async () => {} },
    session: {
      get: async () => ({ data: { id: "src-session", title: "test session" }, error: undefined }),
      messages: async () => ({ data: [], error: undefined }),
      create: async () => ({ data: { id: "generated-session" }, error: undefined }),
      promptAsync: async (input) => {
        promptCount += 1;
        promptTexts.push(input.body.parts[0].text);
        if (gatePrompt) {
          await gatePrompt();
        }
        return { data: {}, error: undefined };
      },
    },
  };

  return { client, promptTexts, getPromptCount: () => promptCount };
}

async function createPluginHarness(directory: string, gatePrompt?: () => Promise<void>) {
  const { client, promptTexts, getPromptCount } = createMockClient(gatePrompt);

  const plugin = await DailyLogbookPlugin({
    client,
    directory,
  } as unknown as Parameters<typeof DailyLogbookPlugin>[0]);

  const eventHandler = plugin.event as unknown as ((input: IdleEventInput) => Promise<void>) | undefined;
  if (!eventHandler) {
    throw new Error("plugin.event is not defined");
  }

  return { eventHandler, client, promptTexts, getPromptCount };
}

function idleEvent(eventHandler: (input: IdleEventInput) => Promise<void>, sessionId: string): Promise<void> {
  return eventHandler({ event: { type: "session.idle", properties: { sessionID: sessionId } } });
}

function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

describe("DailyLogbookPlugin daily-limit integration", () => {
  let tempDir: string;
  let envSnapshot: Array<[string, string | undefined]>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logbook-plugin-test-"));
    envSnapshot = snapshotPluginEnv();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    restorePluginEnv(envSnapshot);
  });

  test("suppresses a second concurrent generation for the same date (daily-limit enabled)", async () => {
    process.env[DAILY_LIMIT_ENV] = "true";
    process.env[THROTTLE_ENV] = "0";

    // 1 回目の生成を prompt 送出後に保留し、「同一日付の生成が in-flight」状態を作る。
    let releaseFirst!: () => void;
    const firstPromptGate = new Promise<void>((release) => {
      releaseFirst = release;
    });
    let gateCount = 0;
    const { eventHandler, getPromptCount } = await createPluginHarness(tempDir, () => {
      gateCount += 1;
      return gateCount === 1 ? firstPromptGate : Promise.resolve();
    });

    const firstCall = idleEvent(eventHandler, "session-a");
    await idleEvent(eventHandler, "session-b");

    // 2 回目は日付キーの in-flight ガードで抑制され、prompt は 1 回目のみ送出済み。
    expect(getPromptCount()).toBe(1);

    releaseFirst();
    await firstCall;

    // 1 回目が完了しても二重生成されていない。
    expect(getPromptCount()).toBe(1);
  });

  test("allows concurrent generations for different sessions when daily-limit is disabled (backward compat)", async () => {
    // DAILY_LIMIT 未設定 = 無効。日付キーのガードは使われず、セッション単位のガードのみ。
    process.env[THROTTLE_ENV] = "0";

    const { eventHandler, getPromptCount } = await createPluginHarness(tempDir);

    await idleEvent(eventHandler, "session-a");
    await idleEvent(eventHandler, "session-b");

    expect(getPromptCount()).toBe(2);
  });

  test("skips generation when today's logbook file already exists (daily-limit enabled)", async () => {
    process.env[DAILY_LIMIT_ENV] = "true";
    process.env[THROTTLE_ENV] = "0";

    const outputDir = join("artifacts", "daily");
    mkdirSync(join(tempDir, outputDir), { recursive: true });
    writeFileSync(join(tempDir, outputDir, `${todayDateString()}_logbook.md`), "existing");

    const { eventHandler, getPromptCount } = await createPluginHarness(tempDir);
    await idleEvent(eventHandler, "session-a");

    expect(getPromptCount()).toBe(0);
  });

  test("passes an absolute outputDir to the prompt when daily-limit is enabled", async () => {
    process.env[DAILY_LIMIT_ENV] = "true";
    process.env[THROTTLE_ENV] = "0";

    const { eventHandler, promptTexts } = await createPluginHarness(tempDir);
    await idleEvent(eventHandler, "session-a");

    const prompt = promptTexts[0];
    expect(prompt).toContain(resolve(tempDir, "artifacts", "daily"));
  });

  test("keeps the relative outputDir in the prompt when daily-limit is disabled (backward compat)", async () => {
    process.env[THROTTLE_ENV] = "0";

    const { eventHandler, promptTexts } = await createPluginHarness(tempDir);
    await idleEvent(eventHandler, "session-a");

    const prompt = promptTexts[0];
    expect(prompt).toContain("artifacts/daily");
    expect(prompt).not.toContain(resolve(tempDir, "artifacts", "daily"));
  });
});
