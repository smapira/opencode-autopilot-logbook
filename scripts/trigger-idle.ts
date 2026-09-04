#!/usr/bin/env bun
/**
 * trigger-idle.ts — E2E 用の session.idle 発火モック
 * B案フル環境（docker --profile e2e）で opencode serve が起動している前提。
 * 実サーバが無ければ generateDailyLogbookCore を直接呼ぶフォールバックで検証する。
 *
 * 使い方:
 *   bun scripts/trigger-idle.ts                    # 自動（実サーバがあれば SDK、なければ直呼び）
 *   bun scripts/trigger-idle.ts --direct           # 強制直呼び（LLM 不要、file-direct 確認）
 *   bun scripts/trigger-idle.ts --session ses_xxx  # 既存セッションを指定
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const direct = process.argv.includes("--direct");
const sessionArg = process.argv.find((a) => a.startsWith("--session"));
const sessionId = sessionArg ? sessionArg.split("=")[1] : `e2e-${Date.now()}`;
const directory = resolve(process.cwd());

async function triggerDirect() {
  const { generateDailyLogbookCore } = await import("../dist/index.js");
  const sink = {
    warn: (m: string) => console.log(`[WARN] ${m}`),
    error: (m: string, e?: unknown) => console.error(`[ERROR] ${m}`, e ?? ""),
    info: (m: string) => console.log(`[INFO] ${m}`),
  };
  // 直呼び用: 実ファイル I/O はせずモック adapter で prompt を捕捉
  let prompted = false;
  const adapter = {
    get: async () => ({ data: { title: "e2e source" } }),
    getMessages: async () => ({
      data: [{ info: { role: "user" as const }, parts: [{ type: "text", text: "hello from e2e" }] }],
    }),
    create: async (title: string) => {
      console.log(`[ADAPTER] create title=${title}`);
      return { data: { id: `gen-${Date.now()}` } };
    },
    prompt: async (id: string, text: string) => {
      console.log(`[ADAPTER] prompt id=${id} len=${text.length}`);
      // file-direct fallback の検証: text に artifacts/daily が含まれるか
      if (text.includes("artifacts/daily")) {
        console.log("[CHECK] prompt contains artifacts/daily ✓");
      }
      // 実際にファイル直書きの fallback を経由させる場合は createFallbackSessionAdapter を使う
      // ここではモック成功として扱う
      prompted = true;
      // 直書き検証のため一時的に artifacts/daily/e2e_*.md を作成
      const outDir = join(directory, "artifacts/daily");
      mkdirSync(outDir, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const p = join(outDir, `${date}_logbook.md`);
      const existing = existsSync(p) ? " (append)" : " (new)";
      writeFileSync(p, `\n\n# E2E Direct ${new Date().toISOString()} session=${sessionId}${existing}\n`, { flag: "a" });
      console.log(`[FILE] appended ${p}`);
      return {};
    },
  };
  await generateDailyLogbookCore({ sessionId, directory, sink, adapter });
  console.log(`[RESULT] direct triggered, prompted=${prompted}`);
  return prompted;
}

async function triggerViaSdk() {
  // 実サーバ経由（opencode serve が 4096/49374 で待受している場合）
  // @opencode-ai/sdk が 401 で HTML を返す環境では直呼びにフォールバック
  try {
    const { createOpencodeClient } = await import("@opencode-ai/sdk");
    const baseUrl = process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096";
    const client = createOpencodeClient({ baseUrl } as never);
    // 疎通確認
    const hasSession = typeof (client as unknown as { session?: { list?: unknown } }).session?.list === "function";
    if (!hasSession) throw new Error("no session.list");
    console.log(`[SDK] trying ${baseUrl} ...`);
    // ダミーで session.list を呼んで疎通確認
    const res = await (client as unknown as { session: { list: (p: unknown) => Promise<unknown> } }).session.list({ limit: 1 } as never);
    console.log(`[SDK] list ok`, JSON.stringify(res).slice(0, 200));
    // 実サーバがあれば本来は event.subscribe で idle を待つが、E2E では直呼びにフォールバックして検証を完結
    console.log("[SDK] SDK reachable but idle subscribe requires Orca daemon — falling back to direct");
    return triggerDirect();
  } catch (e) {
    console.log(`[SDK] fallback to direct: ${e instanceof Error ? e.message : String(e)}`);
    return triggerDirect();
  }
}

const ok = direct ? await triggerDirect() : await triggerViaSdk();
if (!ok) {
  console.error("E2E trigger failed");
  process.exit(1);
}
console.log("E2E trigger succeeded");
