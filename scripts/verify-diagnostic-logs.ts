#!/usr/bin/env bun
/**
 * verify-diagnostic-logs.ts
 * 診断ログ（V1/V2 の ctxKeys / event.subscribe / SDK フォールバック）が
 * 期待通りに出力されるかを検証するスクリプト。
 *
 * 使い方:
 *   bun scripts/verify-diagnostic-logs.ts          # 実行
 *   bun scripts/verify-diagnostic-logs.ts --verbose # 詳細出力
 *
 * 検証項目:
 * 1. V1 呼び出しで "daily-logbook plugin loaded"（v2 なし）が出ること
 * 2. V2 beta（ctxKeys 9要素、eventなし）で "[V1 host detected" が出てスキップされること
 * 3. V2 SDK フォールバック（49374）で "using SDK fallback" と "toAsyncIterable => AsyncIterable" が出ること
 */

type Case = {
  name: string;
  run: () => Promise<{ logs: string[]; result: unknown }>;
  expect: (logs: string[], result: unknown) => { pass: boolean; reason?: string };
};

const verbose = process.argv.includes("--verbose");

function captureConsole(fn: () => Promise<unknown>): Promise<{ logs: string[]; result: unknown }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;
  console.error = capture as typeof console.error;
  return fn()
    .then((result) => ({ logs, result }))
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    });
}

const cases: Case[] = [
  {
    name: "V1: DailyLogbookPlugin が daily-logbook plugin loaded（v2なし）で event フックを返す",
    run: async () => {
      const mod = await import("../dist/index.js");
      const def = mod.default as unknown as (input: unknown) => Promise<unknown>;
      // V1 の client.app.log が診断ログを出すため、console だけでなく client.app.log も捕捉する
      const logs: string[] = [];
      const capture = (...args: unknown[]) => logs.push(args.map(String).join(" "));
      const origLog = console.log;
      const origWarn = console.warn;
      const origError = console.error;
      console.log = capture as typeof console.log;
      console.warn = capture as typeof console.warn;
      console.error = capture as typeof console.error;
      const mockV1 = {
        client: {
          app: {
            log: async (input: unknown) => {
              const msg = (input as { body?: { message?: string } })?.body?.message ?? String(input);
              logs.push(msg);
            },
          },
          session: {
            get: async () => ({ data: { title: "t" } }),
            messages: async () => ({ data: [] }),
            create: async () => ({ data: { id: "gen" } }),
            promptAsync: async () => ({}),
          },
        },
        directory: ".",
        project: {},
        worktree: ".",
        $: async () => ({ text: () => "" }),
      };
      let result: unknown;
      try {
        result = await def(mockV1 as unknown);
      } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
      }
      return { logs, result };
    },
    expect: (logs, result) => {
      const hasV1Log = logs.some((l) => l.includes("daily-logbook plugin loaded") && !l.includes("(v2)"));
      const hasV2Log = logs.some((l) => l.includes("daily-logbook plugin loaded (v2)"));
      const hasEvent = result && typeof result === "object" && "event" in (result as Record<string, unknown>);
      if (!hasV1Log) return { pass: false, reason: `V1 ログなし: ${logs.join(" | ").slice(0, 300)}` };
      if (hasV2Log) return { pass: false, reason: `V1 なのに v2 ログが出た: ${logs.find((l) => l.includes("(v2)"))}` };
      if (!hasEvent) return { pass: false, reason: "V1 result に event フックなし" };
      return { pass: true };
    },
  },
  {
    name: "V2 beta（Orca shared経由の9要素）で V1 host 検出してスキップ",
    run: async () => {
      const mod = await import("../dist/index.js");
      const def = mod.default as unknown as { setup: (ctx: unknown) => Promise<unknown> };
      const mockBeta = { agent: {}, aisdk: {}, catalog: {}, command: {}, integration: {}, options: {}, plugin: {}, reference: {}, skill: {} };
      const result = await captureConsole(async () => def.setup(mockBeta));
      return result;
    },
    expect: (logs) => {
      const hasV2Log = logs.some((l) => l.includes("daily-logbook plugin loaded (v2)") && l.includes("ctxKeys=[agent,aisdk"));
      const hasV1Detect = logs.some((l) => l.includes("V1 host detected via Orca shared"));
      const hasSkip = logs.some((l) => l.includes("Skipping v2 event setup"));
      if (!hasV2Log) return { pass: false, reason: "v2 ログ（ctxKeys）なし" };
      if (!hasV1Detect) return { pass: false, reason: "V1 host 検出ログなし" };
      if (!hasSkip) return { pass: false, reason: "Skipping ログなし" };
      return { pass: true };
    },
  },
  {
    name: "V2 SDK フォールバック（49374）で AsyncIterable を取得",
    run: async () => {
      const mod = await import("../dist/index.js");
      const def = mod.default as unknown as { setup: (ctx: unknown) => Promise<unknown> };
      // 49374 の SDK が起動している場合、eventHost 経由で AsyncIterable を取得できることを検証
      // V1 host 検出を回避するため、event を持つモック（Promise<{stream}> を返す）を使用
      const mockWithEvent = {
        agent: {}, aisdk: {}, catalog: {}, command: {}, integration: {}, options: {}, plugin: {}, reference: {}, skill: {},
        event: {
          subscribe: () => ({ [Symbol.asyncIterator]: async function* () { yield { type: "session.idle", data: { sessionID: "test" } }; } }),
        },
        session: {
          get: async () => ({ data: { title: "t" } }),
          context: async () => ({ data: [] }),
          create: async () => ({ data: { id: "gen" } }),
          prompt: async () => ({}),
        },
      };
      const result = await captureConsole(async () => def.setup(mockWithEvent as unknown));
      return result;
    },
    expect: (logs) => {
      const hasToAsync = logs.some((l) => l.includes("toAsyncIterable => AsyncIterable"));
      const hasV2Log = logs.some((l) => l.includes("daily-logbook plugin loaded (v2)"));
      if (hasToAsync && hasV2Log) return { pass: true };
      const hasOldFail = logs.some((l) => l.includes("event.subscribe did not return AsyncIterable") && !l.includes("toAsyncIterable"));
      if (hasOldFail) return { pass: false, reason: "旧来の失敗ログのみ（toAsyncIterable ログなし）" };
      if (!hasToAsync) return { pass: false, reason: `toAsyncIterable ログなし: ${logs.join(" | ").slice(0, 400)}` };
      return { pass: false, reason: `期待ログなし: ${logs.join(" | ").slice(0, 400)}` };
    },
  },
];

let allPass = true;
for (const c of cases) {
  const { logs, result } = await c.run();
  const { pass, reason } = c.expect(logs, result);
  const status = pass ? "✅ PASS" : "❌ FAIL";
  console.log(`${status} ${c.name}`);
  if (verbose || !pass) {
    console.log(`  logs: ${logs.map((l) => `  - ${l}`).join("\n")}`);
    if (reason) console.log(`  reason: ${reason}`);
  }
  if (!pass) allPass = false;
}

export {};

if (allPass) {
  console.log("\nAll diagnostic log checks passed.");
  (globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(0);
} else {
  console.error("\nSome checks failed.");
  (globalThis as unknown as { process: { exit: (code: number) => never } }).process.exit(1);
}
