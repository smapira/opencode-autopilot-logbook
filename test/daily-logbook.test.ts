import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTranscript,
  getThrottleWindowMs,
  isDailyLogbookExists,
  isWithinWindow,
  maskSecrets,
} from "../daily-logbook";

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
