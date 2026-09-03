import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import {
  buildPrompt,
  buildTranscript,
  formatCost,
  formatTokens,
  formatUsageTable,
  getDbPath,
  getThrottleWindowMs,
  getUsageStats,
  isDailyLogbookExists,
  isUsageProjectOnly,
  isWithinWindow,
  maskSecrets,
  replaceTemplateVariables,
  SAMPLE_TEMPLATE,
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

describe("buildPrompt", () => {
  test("uses the injected date instead of re-resolving the clock", () => {
    // 0 時跨ぎの再現: イベントハンドラで解決した 23:59:59 の日付を注入しても、
    // prompt 内の {{ date }} / {{ dateJp }} は注入された日付のまま再解決されない。
    // 実装が内部で `new Date()` を呼ぶと今日の日付（20260819）に化けるため、
    // 今日と異なる日付（20260105）で固定して回帰を検出する。
    const fixedNow = new Date(2026, 0, 5, 23, 59, 59); // 2026-01-05 23:59:59（ローカル時刻）
    const template = "Session {{ sessionId }} | date={{ date }} | dateJp={{ dateJp }} | dir={{ outputDir }}";

    const prompt = buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow);

    expect(prompt).toContain("date=20260105");
    expect(prompt).toContain("dateJp=2026年1月5日");
    expect(prompt).toContain("Session sess-1");
    expect(prompt).toContain("dir=artifacts/daily");
  });

  test("appends the transcript section when includeTranscript is true", () => {
    const fixedNow = new Date(2026, 0, 5, 23, 59, 59);
    const template = "Session {{ sessionId }} | date={{ date }}";

    const prompt = buildPrompt(template, "sess-1", "[User]\nhello", true, "artifacts/daily", fixedNow);

    expect(prompt).toContain("[User]\nhello");
    expect(prompt).toContain("Below is an excerpt of the session sess-1 history.");
  });

  test("omits the transcript section when includeTranscript is false", () => {
    const fixedNow = new Date(2026, 0, 5, 23, 59, 59);
    const template = "Session {{ sessionId }} | date={{ date }}";

    const prompt = buildPrompt(template, "sess-1", "[User]\nhello", false, "artifacts/daily", fixedNow);

    expect(prompt).not.toContain("[User]\nhello");
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
  "OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY",
  "OPENCODE_DAILY_LOGBOOK_DB_PATH",
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

// 各 API 呼び出しで「error を返す」または「例外を投げる」失敗経路を再現する。
// プラグインの finally クリーンアップ（in-flight ガード解除）を検証するために使う。
type MockFailure = {
  path: "get" | "messages" | "create" | "promptAsync";
  mode: "error" | "throw";
};

function createMockClient(options: { gatePrompt?: () => Promise<void>; failure?: MockFailure } = {}) {
  const promptTexts: string[] = [];
  let promptCount = 0;
  const mockError = new Error("mock failure");
  // failure は 1 回だけ発火させる（ワンショット）。エラー経路テストでは
  // 1 回目のイベントだけ失敗させ、2 回目のイベントが生成を通過できることを
  // 検証したいため、以降の呼び出しは正常系に戻す。
  const failureFired = new Set<MockFailure["path"]>();

  const failWith = <T>(path: MockFailure["path"], onError: () => T, onContinue: () => T): T => {
    if (options.failure?.path === path && !failureFired.has(path)) {
      failureFired.add(path);
      if (options.failure.mode === "throw") {
        throw mockError;
      }
      return onError();
    }
    return onContinue();
  };

  const client: MockClient = {
    app: { log: async () => {} },
    session: {
      get: () =>
        failWith(
          "get",
          () => ({ data: undefined as never, error: mockError }),
          () => ({ data: { id: "src-session", title: "test session" }, error: undefined }),
        ),
      messages: () =>
        failWith(
          "messages",
          () => ({ data: undefined as never, error: mockError }),
          () => ({ data: [], error: undefined }),
        ),
      create: () =>
        failWith(
          "create",
          () => ({ data: undefined as never, error: mockError }),
          () => ({ data: { id: "generated-session" }, error: undefined }),
        ),
      // promptAsync は失敗経路を先に判定する。失敗した prompt は「送出済み」に
      // 数えないため、エラー経路テストで成功回数（= ガード解除後の生成通過）を
      // 一貫して `getPromptCount()` で検証できる。
      promptAsync: async (input) => {
        if (options.failure?.path === "promptAsync" && !failureFired.has("promptAsync")) {
          failureFired.add("promptAsync");
          if (options.failure.mode === "throw") {
            throw mockError;
          }
          return { data: undefined, error: mockError };
        }
        promptCount += 1;
        promptTexts.push(input.body.parts[0].text);
        if (options.gatePrompt) {
          await options.gatePrompt();
        }
        return { data: {}, error: undefined };
      },
    },
  };

  return { client, promptTexts, getPromptCount: () => promptCount };
}

async function createPluginHarness(
  directory: string,
  options: { gatePrompt?: () => Promise<void>; failure?: MockFailure } = {},
) {
  const { client, promptTexts, getPromptCount } = createMockClient(options);

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
    const { eventHandler, getPromptCount } = await createPluginHarness(tempDir, {
      gatePrompt: () => {
        gateCount += 1;
        return gateCount === 1 ? firstPromptGate : Promise.resolve();
      },
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

// ---------------------------------------------------------------------------
// エラー経路での in-flight ガード解除を検証する統合テスト。
// dailyLimitInFlightByDate の finally クリーンアップが失われると、エラー後の
// 当日中すべてのセッション生成がプロセス再起動まで永久ブロックされるため、
// 各エラー経路ごとに「エラー後の別セッションが生成を通過できる」ことを確認する。
// ---------------------------------------------------------------------------

describe("DailyLogbookPlugin error-path guard release", () => {
  let tempDir: string;
  let envSnapshot: Array<[string, string | undefined]>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "logbook-plugin-test-"));
    envSnapshot = snapshotPluginEnv();
    process.env[DAILY_LIMIT_ENV] = "true";
    process.env[THROTTLE_ENV] = "0";
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    restorePluginEnv(envSnapshot);
  });

  const errorPaths: MockFailure["path"][] = ["get", "messages", "create", "promptAsync"];

  test.each(errorPaths)("releases the daily-limit guard after a %s error so a later session can generate", async (path) => {
    const { eventHandler, getPromptCount } = await createPluginHarness(tempDir, {
      failure: { path, mode: "error" },
    });

    // 1 回目: エラー経路でガードが設定された後、finally で解除される。
    await idleEvent(eventHandler, "session-a");

    // 2 回目: 別セッションが生成を通過できる（ガードが解除されている）。
    await idleEvent(eventHandler, "session-b");

    expect(getPromptCount()).toBe(1);
  });

  test.each(errorPaths)("releases the daily-limit guard after a %s throw so a later session can generate", async (path) => {
    const { eventHandler, getPromptCount } = await createPluginHarness(tempDir, {
      failure: { path, mode: "throw" },
    });

    await idleEvent(eventHandler, "session-a");
    await idleEvent(eventHandler, "session-b");

    expect(getPromptCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 4,5,2,3,1 : usage-append 追加機能
// ---------------------------------------------------------------------------

describe("env helpers", () => {
  let envSnapshot: Array<[string, string | undefined]>;

  beforeEach(() => {
    envSnapshot = snapshotPluginEnv();
  });

  afterEach(() => {
    restorePluginEnv(envSnapshot);
  });

  test("isUsageProjectOnly returns false only for exact 'false'", () => {
    delete process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY;
    expect(isUsageProjectOnly()).toBe(true);
    process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY = "false";
    expect(isUsageProjectOnly()).toBe(false);
    process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY = "true";
    expect(isUsageProjectOnly()).toBe(true);
    process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY = "False";
    expect(isUsageProjectOnly()).toBe(true);
    process.env.OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY = "";
    expect(isUsageProjectOnly()).toBe(true);
  });

  test("getDbPath returns custom path when env is set, otherwise default", () => {
    delete process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH;
    expect(getDbPath()).toBe(join(homedir(), ".local/share/opencode/opencode.db"));
    process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH = "/tmp/custom.db";
    expect(getDbPath()).toBe("/tmp/custom.db");
    process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH = "";
    expect(getDbPath()).toBe(join(homedir(), ".local/share/opencode/opencode.db"));
    process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH = "   ";
    expect(getDbPath()).toBe(join(homedir(), ".local/share/opencode/opencode.db"));
  });
});

describe("formatCost / formatTokens", () => {
  test("formatCost formats to $x.xx", () => {
    expect(formatCost(2.31)).toBe("$2.31");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1314.5)).toBe("$1314.50");
  });

  test("formatTokens formats with K/M/B suffix", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(45_000)).toBe("45.0K");
    expect(formatTokens(890_000)).toBe("890.0K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(1_500_000_000)).toBe("1.5B");
  });
});

describe("formatUsageTable", () => {
  test("returns empty string when stats is null", () => {
    expect(formatUsageTable(null, "20260902")).toBe("");
    expect(formatUsageTable(null, "2026-09-02")).toBe("");
  });

  test("formats table with session cost and project name", () => {
    const stats = {
      dayCost: 2.31,
      sessionCost: 0.21,
      tokensInput: 1_200_000,
      tokensOutput: 45_000,
      cacheRead: 890_000,
      sessionsToday: 3,
      totalCost: 1314.5,
    };
    const table = formatUsageTable(stats, "20260902", "opencode-autopilot-logbook");
    expect(table).toContain("## Usage — 2026-09-02 (project: opencode-autopilot-logbook)");
    expect(table).toContain("| Cost (本日/セッション) | $2.31 / $0.21 |");
    expect(table).toContain("| Tokens Input / Output / Cache Read | 1.2M / 45.0K / 890.0K |");
    expect(table).toContain("| Sessions (本日) | 3 |");
    expect(table).toContain("| Total Cost (累計) | $1314.50 |");
    expect(table).toContain("| 項目 | 値 |");
  });

  test("formats table without session cost (omits session part)", () => {
    const stats = {
      dayCost: 2.31,
      sessionCost: null,
      tokensInput: 500,
      tokensOutput: 200,
      cacheRead: 0,
      sessionsToday: 1,
      totalCost: 10,
    };
    const table = formatUsageTable(stats, "20260902");
    expect(table).toContain("## Usage — 2026-09-02");
    expect(table).not.toContain("(project:");
    expect(table).toContain("| Cost (本日) | $2.31 |");
    expect(table).not.toContain("Cost (本日/セッション)");
  });

  test("accepts already hyphenated date", () => {
    const stats = {
      dayCost: 1,
      sessionCost: null,
      tokensInput: 0,
      tokensOutput: 0,
      cacheRead: 0,
      sessionsToday: 0,
      totalCost: 0,
    };
    const table = formatUsageTable(stats, "2026-09-02", "myproj");
    expect(table).toContain("## Usage — 2026-09-02 (project: myproj)");
  });
});

describe("replaceTemplateVariables with usage", () => {
  const fixedNow = new Date(2026, 8, 2, 10, 0, 0); // 2026-09-02

  test("replaces {{ usage }} and {{ usageTable }} with usageTable (including $)", () => {
    const template = "hello {{ usage }} world";
    const result = replaceTemplateVariables(template, "sess-1", fixedNow, "artifacts/daily", "| Cost | $2.31 |");
    expect(result).toBe("hello | Cost | $2.31 | world");
    // $ が capture 参照で壊れないこと
    expect(result).toContain("$2.31");
  });

  test("replaces {{ usageTable }} alias", () => {
    const template = "hello {{ usageTable }} world";
    const result = replaceTemplateVariables(template, "sess-1", fixedNow, "artifacts/daily", "| Cost | $2.31 |");
    expect(result).toBe("hello | Cost | $2.31 | world");
  });

  test("replaces multiple occurrences of usage placeholders", () => {
    const template = "{{ usage }} and {{ usageTable }} and {{ usage }}";
    const result = replaceTemplateVariables(template, "sess-1", fixedNow, "artifacts/daily", "X $1.00");
    expect(result).toBe("X $1.00 and X $1.00 and X $1.00");
  });

  test("replaces with empty string when usageTable is undefined", () => {
    const template = "hello {{ usage }} world";
    const result = replaceTemplateVariables(template, "sess-1", fixedNow, "artifacts/daily", undefined);
    expect(result).toBe("hello  world");
  });

  test("replaces with empty string when usageTable is empty", () => {
    const template = "hello {{ usage }} world";
    const result = replaceTemplateVariables(template, "sess-1", fixedNow, "artifacts/daily", "");
    expect(result).toBe("hello  world");
  });

  test("function form prevents $ expansion for existing vars", () => {
    // sessionId に $ を含むと従来の string 置換では壊れるが、関数形式なら安全
    const template = "id={{ sessionId }}";
    const result = replaceTemplateVariables(template, "$2.31", fixedNow, "artifacts/daily");
    expect(result).toBe("id=$2.31");
  });

  test("replaces all placeholders including date and usage together", () => {
    const template = "{{ date }} {{ usage }} {{ sessionId }}";
    const result = replaceTemplateVariables(template, "sess-abc", fixedNow, "out", "U $5.00");
    expect(result).toContain("20260902");
    expect(result).toContain("U $5.00");
    expect(result).toContain("sess-abc");
  });
});

describe("SAMPLE_TEMPLATE", () => {
  test("contains {{ usage }} placeholder", () => {
    expect(SAMPLE_TEMPLATE).toContain("{{ usage }}");
    expect(SAMPLE_TEMPLATE).toContain("## Usage");
  });
});

describe("buildPrompt with usage", () => {
  const fixedNow = new Date(2026, 8, 2, 10, 0, 0); // 2026-09-02 local

  test("replaces {{ usage }} with usageTable via template", () => {
    const template = "Hello {{ usage }}";
    const usageTable = "## Usage — 2026-09-02\n| Cost | $2.31 |";
    const prompt = buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, usageTable);
    expect(prompt).toBe("Hello ## Usage — 2026-09-02\n| Cost | $2.31 |");
  });

  test("replaces {{ usageTable }} alias", () => {
    const template = "Hello {{ usageTable }}";
    const usageTable = "TABLE $1.00";
    const prompt = buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, usageTable);
    expect(prompt).toBe("Hello TABLE $1.00");
  });

  test("replaces with empty string when usageTable is empty or undefined", () => {
    const template = "Hello {{ usage }} world";
    expect(buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, "",)).toBe("Hello  world");
    expect(buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, undefined)).toBe("Hello  world");
  });

  test("usage placeholder replacement preserves $ via function form", () => {
    const template = "Hi {{ usage }}";
    const usageTable = "| Cost | $2.31 / $0.21 |";
    const prompt = buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, usageTable);
    expect(prompt).toContain("$2.31 / $0.21");
  });

  test("detects placeholder with spaces", () => {
    const template = "Hello {{  usage  }}";
    const usageTable = "TABLE";
    const prompt = buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, usageTable);
    expect(prompt).toBe("Hello TABLE");
  });

  test("template without usage placeholder renders without usage", () => {
    const template = "Hello {{ sessionId }}";
    const usageTable = "## Usage — 2026-09-02\n| Cost | $2.31 |";
    const prompt = buildPrompt(template, "sess-1", "", false, "artifacts/daily", fixedNow, usageTable);
    // usageTable があってもテンプレに placeholder がなければ含まれない（自動追記はしない）
    expect(prompt).toBe("Hello sess-1");
    expect(prompt).not.toContain("## Usage");
  });

  test("includes usage when template has placeholder and transcript is included", () => {
    const template = "Template {{ date }} {{ usage }}";
    const usageTable = "## Usage — 2026-09-02 | $1.00";
    const prompt = buildPrompt(template, "sess-1", "[User]\nhello", true, "artifacts/daily", fixedNow, usageTable);
    expect(prompt).toContain("[User]\nhello");
    expect(prompt).toContain("## Usage — 2026-09-02");
  });
});

// ---------------------------------------------------------------------------
// getUsageStats with tmp file DB
// ---------------------------------------------------------------------------

function createTmpDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_cache_read INTEGER,
      time_created INTEGER
    );
  `);
  db.close();
}

function insertProject(dbPath: string, id: string, worktree: string): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run(id, worktree);
  db.close();
}

function insertSession(
  dbPath: string,
  row: {
    id: string;
    project_id: string | null;
    cost: number;
    tokens_input: number;
    tokens_output: number;
    tokens_cache_read: number;
    time_created: number;
  },
): void {
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO session (id, project_id, cost, tokens_input, tokens_output, tokens_cache_read, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.project_id, row.cost, row.tokens_input, row.tokens_output, row.tokens_cache_read, row.time_created);
  db.close();
}

describe("getUsageStats", () => {
  let tmpDir: string;
  let dbPath: string;
  let envSnapshot: Array<[string, string | undefined]>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-stats-test-"));
    dbPath = join(tmpDir, "test.db");
    envSnapshot = snapshotPluginEnv();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restorePluginEnv(envSnapshot);
  });

  test("returns null when DB file does not exist", () => {
    const stats = getUsageStats({
      directory: "/tmp/foo",
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: true,
      dbPath: join(tmpDir, "nonexistent.db"),
    });
    expect(stats).toBeNull();
  });

  test("returns null when DB file does not exist via env path", () => {
    process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH = join(tmpDir, "nonexistent2.db");
    const stats = getUsageStats({
      directory: "/tmp/foo",
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: true,
    });
    expect(stats).toBeNull();
  });

  test("aggregates daily and total for projectOnly true", () => {
    createTmpDb(dbPath);
    const worktree = join(tmpDir, "myproj");
    mkdirSync(worktree, { recursive: true });
    const projectId = "proj-1";
    insertProject(dbPath, projectId, resolve(worktree));

    // today local noon
    const todayMs = new Date(2026, 8, 2, 12, 0, 0).getTime();
    const yesterdayMs = new Date(2026, 8, 1, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-1",
      project_id: projectId,
      cost: 0.21,
      tokens_input: 1_200_000,
      tokens_output: 45_000,
      tokens_cache_read: 890_000,
      time_created: todayMs,
    });
    insertSession(dbPath, {
      id: "sess-2",
      project_id: projectId,
      cost: 2.1,
      tokens_input: 500,
      tokens_output: 200,
      tokens_cache_read: 0,
      time_created: todayMs + 1000,
    });
    // different day, same project
    insertSession(dbPath, {
      id: "sess-3",
      project_id: projectId,
      cost: 5.0,
      tokens_input: 100,
      tokens_output: 100,
      tokens_cache_read: 100,
      time_created: yesterdayMs,
    });
    // other project today (should be excluded when projectOnly true)
    const otherProjectId = "proj-other";
    insertProject(dbPath, otherProjectId, "/other/worktree");
    insertSession(dbPath, {
      id: "sess-other",
      project_id: otherProjectId,
      cost: 99.0,
      tokens_input: 999,
      tokens_output: 999,
      tokens_cache_read: 999,
      time_created: todayMs,
    });

    const stats = getUsageStats({
      directory: worktree,
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: true,
      dbPath,
    });

    expect(stats).not.toBeNull();
    expect(stats!.sessionsToday).toBe(2);
    expect(stats!.dayCost).toBeCloseTo(2.31, 5);
    expect(stats!.tokensInput).toBe(1_200_500);
    expect(stats!.tokensOutput).toBe(45_200);
    expect(stats!.cacheRead).toBe(890_000);
    // totalCost is project-scoped when projectOnly true: 0.21+2.1+5.0 = 7.31
    expect(stats!.totalCost).toBeCloseTo(7.31, 5);
    expect(stats!.sessionCost).toBeCloseTo(0.21, 5);
  });

  test("aggregates whole DB when projectOnly false", () => {
    createTmpDb(dbPath);
    const worktree = join(tmpDir, "myproj2");
    mkdirSync(worktree, { recursive: true });
    const projectId = "proj-1";
    insertProject(dbPath, projectId, resolve(worktree));
    const todayMs = new Date(2026, 8, 2, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-1",
      project_id: projectId,
      cost: 1,
      tokens_input: 100,
      tokens_output: 100,
      tokens_cache_read: 100,
      time_created: todayMs,
    });
    const otherProjectId = "proj-other";
    insertProject(dbPath, otherProjectId, "/other2");
    insertSession(dbPath, {
      id: "sess-other",
      project_id: otherProjectId,
      cost: 99,
      tokens_input: 999,
      tokens_output: 999,
      tokens_cache_read: 999,
      time_created: todayMs,
    });

    const stats = getUsageStats({
      directory: worktree,
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: false,
      dbPath,
    });

    expect(stats!.sessionsToday).toBe(2);
    expect(stats!.dayCost).toBeCloseTo(100, 5);
    expect(stats!.totalCost).toBeCloseTo(100, 5);
  });

  test("falls back to whole aggregation when project not found (unknown directory)", () => {
    createTmpDb(dbPath);
    const todayMs = new Date(2026, 8, 2, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-1",
      project_id: null,
      cost: 1.5,
      tokens_input: 10,
      tokens_output: 10,
      tokens_cache_read: 10,
      time_created: todayMs,
    });
    insertSession(dbPath, {
      id: "sess-2",
      project_id: null,
      cost: 2.5,
      tokens_input: 20,
      tokens_output: 20,
      tokens_cache_read: 20,
      time_created: todayMs,
    });

    const stats = getUsageStats({
      directory: "/unknown/path/that/does/not/exist",
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: true,
      dbPath,
    });

    expect(stats!.sessionsToday).toBe(2);
    expect(stats!.dayCost).toBeCloseTo(4.0, 5);
  });

  test("normalizes directory with trailing slash", () => {
    createTmpDb(dbPath);
    const worktree = join(tmpDir, "myproj3");
    mkdirSync(worktree, { recursive: true });
    const projectId = "proj-1";
    // DB に保存される worktree は resolve 済み（末尾スラッシュなし）
    insertProject(dbPath, projectId, resolve(worktree));
    const todayMs = new Date(2026, 8, 2, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-1",
      project_id: projectId,
      cost: 1,
      tokens_input: 100,
      tokens_output: 100,
      tokens_cache_read: 100,
      time_created: todayMs,
    });
    // 末尾スラッシュ付きで問い合わせても一致すること
    const stats = getUsageStats({
      directory: worktree + "/",
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: true,
      dbPath,
    });
    expect(stats!.sessionsToday).toBe(1);
    expect(stats!.totalCost).toBeCloseTo(1, 5);
  });

  test("returns sessionCost null when sessionId not found", () => {
    createTmpDb(dbPath);
    const worktree = join(tmpDir, "myproj4");
    mkdirSync(worktree, { recursive: true });
    insertProject(dbPath, "proj-1", resolve(worktree));
    const todayMs = new Date(2026, 8, 2, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-existing",
      project_id: "proj-1",
      cost: 1,
      tokens_input: 10,
      tokens_output: 10,
      tokens_cache_read: 10,
      time_created: todayMs,
    });

    const stats = getUsageStats({
      directory: worktree,
      sessionId: "nonexistent",
      date: "20260902",
      projectOnly: true,
      dbPath,
    });
    expect(stats!.sessionCost).toBeNull();
    expect(stats!.dayCost).toBeCloseTo(1, 5);
  });

  test("returns zero values when no sessions for today", () => {
    createTmpDb(dbPath);
    const worktree = join(tmpDir, "myproj5");
    mkdirSync(worktree, { recursive: true });
    insertProject(dbPath, "proj-1", resolve(worktree));
    const yesterdayMs = new Date(2026, 8, 1, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-old",
      project_id: "proj-1",
      cost: 5,
      tokens_input: 10,
      tokens_output: 10,
      tokens_cache_read: 10,
      time_created: yesterdayMs,
    });

    const stats = getUsageStats({
      directory: worktree,
      sessionId: "sess-old",
      date: "20260902",
      projectOnly: true,
      dbPath,
    });
    expect(stats!.sessionsToday).toBe(0);
    expect(stats!.dayCost).toBe(0);
    expect(stats!.tokensInput).toBe(0);
    // totalCost は累計なので 5
    expect(stats!.totalCost).toBeCloseTo(5, 5);
  });

  test("uses env DB path when dbPath param omitted", () => {
    createTmpDb(dbPath);
    const worktree = join(tmpDir, "myproj6");
    mkdirSync(worktree, { recursive: true });
    insertProject(dbPath, "proj-1", resolve(worktree));
    const todayMs = new Date(2026, 8, 2, 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "sess-1",
      project_id: "proj-1",
      cost: 3.14,
      tokens_input: 100,
      tokens_output: 100,
      tokens_cache_read: 100,
      time_created: todayMs,
    });
    process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH = dbPath;

    const stats = getUsageStats({
      directory: worktree,
      sessionId: "sess-1",
      date: "20260902",
      projectOnly: true,
    });
    expect(stats!.dayCost).toBeCloseTo(3.14, 5);
  });
});

// ---------------------------------------------------------------------------
// Plugin integration with usage (integration but via mocked client + tmp DB)
// ---------------------------------------------------------------------------

describe("DailyLogbookPlugin usage integration", () => {
  let tmpDir: string;
  let envSnapshot: Array<[string, string | undefined]>;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logbook-usage-plugin-test-"));
    envSnapshot = snapshotPluginEnv();
    dbPath = join(tmpDir, "usage.db");
    process.env[THROTTLE_ENV] = "0";
    process.env.OPENCODE_DAILY_LOGBOOK_DB_PATH = dbPath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restorePluginEnv(envSnapshot);
  });

  test("appends usage table to prompt when DB exists (projectOnly true, via default template)", async () => {
    createTmpDb(dbPath);
    const projectId = "proj-1";
    insertProject(dbPath, projectId, resolve(tmpDir));
    const today = new Date();
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "session-a",
      project_id: projectId,
      cost: 0.5,
      tokens_input: 1000,
      tokens_output: 500,
      tokens_cache_read: 200,
      time_created: todayMs,
    });

    const { eventHandler, promptTexts } = await createPluginHarness(tmpDir);
    await idleEvent(eventHandler, "session-a");
    expect(promptTexts.length).toBe(1);
    const prompt = promptTexts[0];
    expect(prompt).toContain("## Usage —");
    expect(prompt).toContain("$0.50");
    // basename が含まれるか
    expect(prompt).toContain(basename(resolve(tmpDir)));
  });

  test("still generates logbook when DB is missing (graceful fallback)", async () => {
    // DB を作らない
    const { eventHandler, promptTexts } = await createPluginHarness(tmpDir);
    await idleEvent(eventHandler, "session-a");
    expect(promptTexts.length).toBe(1);
    // usage がないので Usage 見出しは含まない（{{ usage }} は空文字に置換）
    expect(promptTexts[0]).not.toContain("## Usage —");
  });

  test("respects usage template placeholder (custom template)", async () => {
    createTmpDb(dbPath);
    const projectId = "proj-1";
    insertProject(dbPath, projectId, resolve(tmpDir));
    const today = new Date();
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0).getTime();
    insertSession(dbPath, {
      id: "session-a",
      project_id: projectId,
      cost: 1.23,
      tokens_input: 100,
      tokens_output: 100,
      tokens_cache_read: 100,
      time_created: todayMs,
    });
    // カスタムテンプレートに {{ usage }} を配置
    const templatePath = join(tmpDir, "template.md");
    writeFileSync(templatePath, "Header {{ usage }} Footer");
    process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE = templatePath;

    const { eventHandler, promptTexts } = await createPluginHarness(tmpDir);
    await idleEvent(eventHandler, "session-a");
    const prompt = promptTexts[0];
    // 置換されている
    expect(prompt).toContain("## Usage —");
    // 二重に現れない（出現回数 1）
    const usageCount = (prompt.match(/## Usage —/g) || []).length;
    expect(usageCount).toBe(1);
  });

  test("does not open DB when daily-limit suppresses generation", async () => {
    // daily-limit で suppress されるケースでは DB を開かない（不要な warn を出さない）
    // ここでは既存ファイルを作って suppress させる
    createTmpDb(dbPath);
    const outputDir = join("artifacts", "daily");
    mkdirSync(join(tmpDir, outputDir), { recursive: true });
    const dateStr = todayDateString();
    writeFileSync(join(tmpDir, outputDir, `${dateStr}_logbook.md`), "existing");
    process.env[DAILY_LIMIT_ENV] = "true";

    const { eventHandler, getPromptCount } = await createPluginHarness(tmpDir);
    await idleEvent(eventHandler, "session-a");

    expect(getPromptCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// V2 Plugin (TASK-1〜4) – dual compatibility: handles flat shapes and data vs properties
// ---------------------------------------------------------------------------

import { DailyLogbookPluginV2, handleV2IdleEvent } from "../daily-logbook";

describe("DailyLogbookPluginV2", () => {
  test("exports V2 plugin with id smapira.daily-logbook and setup", async () => {
    const v2 = DailyLogbookPluginV2 as { id?: string; setup?: unknown };
    expect(v2.id).toBe("smapira.daily-logbook");
    expect(typeof v2.setup).toBe("function");
  });

  test("handleV2IdleEvent uses flat V2 session shapes (get/context/create/prompt) and console sink", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "v2-flat-"));
    const envSnapshot = snapshotPluginEnv();
    process.env[THROTTLE_ENV] = "0";
    delete process.env[DAILY_LIMIT_ENV];
    try {
      const promptTexts: string[] = [];
      const sink = { warn: async () => {}, error: async () => {}, info: async () => {} };
      const session = {
        get: async (_input: { sessionID: string }) => ({ data: { title: "user session" } }),
        context: async (_input: { sessionID: string }) => ({ data: [] as unknown[] }),
        create: async (_input: { title: string }) => ({ data: { id: "gen-1" } }),
        prompt: async (input: { sessionID: string; text: string }) => {
          promptTexts.push(input.text);
          return { data: {} };
        },
      };
      await handleV2IdleEvent({ sessionID: "sess-v2-1", directory: tmpDir, sink, session });
      expect(promptTexts.length).toBe(1);
      // prompt は flat text で渡され、path/body ネストではない
      expect(promptTexts[0]).toContain("sess-v2-1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restorePluginEnv(envSnapshot);
    }
  });

  test("handleV2IdleEvent falls back to messages when context is absent (compat)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "v2-compat-"));
    const envSnapshot = snapshotPluginEnv();
    process.env[THROTTLE_ENV] = "0";
    try {
      const promptTexts: string[] = [];
      const sink = { warn: async () => {}, error: async () => {} };
      const session: Parameters<typeof handleV2IdleEvent>[0]["session"] = {
        get: async () => ({ data: { title: "t" } }),
        // context なし
        messages: async () => ({ data: [] }),
        create: async () => ({ data: { id: "gen-2" } }),
        prompt: async (input) => {
          promptTexts.push(input.text);
          return {};
        },
      } as unknown as Parameters<typeof handleV2IdleEvent>[0]["session"];
      await handleV2IdleEvent({ sessionID: "sess-v2-2", directory: tmpDir, sink, session });
      expect(promptTexts.length).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restorePluginEnv(envSnapshot);
    }
  });

  test("handleV2IdleEvent respects daily-limit via existsSync (V2 path same as V1)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "v2-daily-"));
    const envSnapshot = snapshotPluginEnv();
    process.env[DAILY_LIMIT_ENV] = "true";
    process.env[THROTTLE_ENV] = "0";
    try {
      const outputDir = join("artifacts", "daily");
      mkdirSync(join(tmpDir, outputDir), { recursive: true });
      const dateStr = todayDateString();
      writeFileSync(join(tmpDir, outputDir, `${dateStr}_logbook.md`), "existing");
      const sinkWarns: string[] = [];
      const sink = { warn: async (m: string) => sinkWarns.push(m), error: async () => {} };
      const session = {
        get: async () => ({ data: { title: "t" } }),
        context: async () => ({ data: [] }),
        create: async () => ({ data: { id: "gen-3" } }),
        prompt: async () => ({ data: {} }),
      };
      let createCalled = false;
      const trackingSession = {
        ...session,
        create: async (input: { title: string }) => {
          createCalled = true;
          return { data: { id: "gen-3" } };
        },
      };
      await handleV2IdleEvent({ sessionID: "sess-v2-3", directory: tmpDir, sink, session: trackingSession });
      expect(createCalled).toBe(false);
      expect(sinkWarns.some((m) => m.includes("already exists"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      restorePluginEnv(envSnapshot);
    }
  });
});
