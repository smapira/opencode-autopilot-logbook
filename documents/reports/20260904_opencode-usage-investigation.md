# OpenCode 使用に関する調査レポート

**作成日:** 2026年9月4日  
**対象:** `anomalyco/opencode` および `sst/opencode` の GitHub 公開ソース、並びに当リポジトリ `smapira/opencode-autopilot-logbook` の v2 プラグイン実装  
**調査依頼:** オープンコードの GitHub で公開しているソースコードの調査  
**バージョン:** `opencode 1.18.27`（`@opencode-ai/plugin@1.18.27`）、`opencode2 v0.0.0-beta-18999`（`@opencode-ai/cli@0.0.0-beta-18999`）

---

## エグゼクティブサマリー

- `opencode` のプラグイン機構は **v1（`@opencode-ai/plugin@1.18.x`）** と **v2（`@opencode-ai/plugin/v2`）** で `PluginContext` の形状が根本的に異なり、`beta-18999` 時点の `v2` は `event`/`session` を持たない **9要素（`agent,aisdk,catalog,command,integration,options,plugin,reference,skill`）** のみであった。
- 当プラグイン `daily-logbook` の `v2` 実装が `ctx.event.subscribe({signal}) => AsyncIterable` と `ctx.event.subscribe("session.idle") => Stream` の両対応を試みていたため、`beta-18999` では `event.subscribe did not return AsyncIterable` で停止していた。
- `GitHub` 公開ソース（`anomalyco/opencode` は `sst/opencode` のフォーク）の `packages/plugin/src/v2` 構造と `opencode.ai/docs/plugins` の記述を照合し、**恒久的には `ctx.event` 優先 → `SDK` フォールバック（`http://localhost:49374`） → `return {event}` フォールバックの3段構え**に修正したことで、`dist 31.73KB` で `bun test 85 pass` を維持しつつ `v2` でも日誌生成が可能になった。

---

## 調査方法

| 観点 | 手法 | 対象 |
|------|------|------|
| `PluginContext` の型 | `read` / `grep` | `anomalyco/opencode` を `/tmp/opencode-anomaly` に `depth 1` でクローン、`packages/plugin/src/v2/effect/context.ts` / `promise/context.ts` / `event.ts` を精読 |
| `event` の注入箇所 | `grep` | `packages/opencode/src/plugin/loader.ts` / `bus/global.ts` / `event-v2-bridge.ts` |
| `session`/`event` の変遷 | `git log --grep=event` / `tag` | `anomalyco/opencode` と `sst/opencode` の `beta-18999` 前後の `CHANGELOG` / `tag` |
| 公式ドキュメントとの照合 | `webfetch` / `websearch` | `https://opencode.ai/docs/plugins` / `https://opencode.ai/v2/docs/build/plugins` の `Events` 節と `Examples` の `return {event: async ({event})=>{if(event.type==="session.idle")...}}` パターン |
| 実機検証 | `bun -e` / `lsof` / `createOpencodeClient` | `ORCA_AGENT_HOOK_PORT=49353` / `opencode2` 本体 `49374` / `4096` での `client.event.subscribe` と `session.list` の挙動、`this` 束縛抜けの再現 |

---

## 発見事項（優先度順）

### 🔴 高: `beta-18999` の `PluginContext` は `event` を持たない — 恒久実装はフォールバック維持が正解

- **事実:** `opencode2` 起動時の `daily-logbook` ログ `ctxKeys=[agent,aisdk,catalog,command,integration,options,plugin,reference,skill] event.subscribe=no` は `packages/plugin/src/v2` の9モジュールと1:1で一致し、`event.ts` が `promise` 側で未エクスポートなのは統合が未完了の傍証。
- **参照:** `/tmp/opencode-anomaly/packages/plugin/src/v2/effect/context.ts`（9行目の `PluginContext` 定義）、`promise/context.ts`（`event` import 欠落）、`https://github.com/anomalyco/opencode/tree/main/packages/plugin/src/v2`
- **結論:** `beta-18999` で `ctx.event` が無いのはバグではなく設計途上。`daily-logbook.ts` の `v2Setup` が `ctx.event` を第一に試すのは将来互換としては正しいが、`beta-18999` 単体では `return {event}` が唯一安定。公式ドキュメントも v1 は `return {event}`、v2 は `ctx.event.subscribe` へ移行中と読み取れる。

### 🔴 高: `SDK` フォールバックの `this` 束縛抜けと候補順の誤り

- **事実:** `@opencode-ai/sdk` の生成クライアントは `this._client` を参照するため、`const {subscribe}=client.event; subscribe({signal})` と切り離すと `undefined is not an object (evaluating 'this._client')` が必発。`host.subscribe.call(host, {signal})` の `call` 付与が正解。
- **事実:** `ORCA_AGENT_HOOK_PORT=49353`（agent-hook 用）を `49374`（`opencode2` 本体、`lsof` 実測）より先に試していたため、`49353` の `session.list` が偶然成功し正しい `49374` に到達せず。`49374` を最優先に修正。
- **事実:** `client.event.subscribe` は `Promise<{stream: AsyncIterable}>` を返すケースがあり、`toAsyncIterable` で `stream` プロパティを展開する必要があった。`value && "stream" in value` での抽出を追加。
- **参照:** `node_modules/@opencode-ai/sdk/dist/v2/gen/client/client.gen.js:84` の `createSseClient`、`packages/sdk/js/src/client.ts`

### 🟡 中: `anomalyco/opencode` と `sst/opencode` の乖離

- `anomalyco/opencode` はフォークで `main` の `d8eb3b80` が `sst/opencode` の `main` と一致しない。`beta-18999` タグは `sst` 側で切られている可能性が高く、`anomalyco` 側の `tag` では追えない。
- 参照: `https://opencode.ai/docs/plugins`（v1, `return {event}` が正）、`https://opencode.ai/v2/docs/build/plugins`（v2, `Plugin.define({setup/effect})` と `ctx.event.subscribe` が正）

### 🟡 中: `Bus` と `SDK` の関係

- `bus/global.ts` が内部 PubSub、`event-v2-bridge.ts` が `Bus` → 外部 SSE (`/event`) へのブリッジ、`sdk/js/src/v2` が SSE を `AsyncIterable` に変換する構成と推定。`daily-logbook.ts` が SDK 経由で `http://localhost:49374/event` を叩くのは迂回路であり、`ctx.event` が使えるなら不要。

### 🟢 低: `405 Method Not Allowed` の残存

- `opencode2` 本体（`49374`）の `session.create` が `POST /session` で `405` となる環境では `SDK` 経由の `session` 作成が不安定なため、最終的に **ファイル直書きの `createFallbackSessionAdapter`**（`Bun.write` で `artifacts/daily` に直接追記）に切り替えた。`dist` は `221KB` → `31.73KB` に再縮小。

---

## OpenCode の使用実態（当リポジトリにおける）

| 項目 | 内容 |
|------|------|
| **用途** | `session.idle` 時に `artifacts/daily/YYYYMMDD_logbook.md` を自動生成する `daily-logbook` プラグイン。`@opencode-ai/plugin` の `Plugin` 型で `event` フックを実装し、`generateDailyLogbookCore` で `transcript` の `maskSecrets` / `throttle`（`90s`） / `dailyLimit` / `usage`（`opencode.db` からの `cost/tokens`）を処理 |
| **対応ホスト** | `opencode 1.18.27`（`plugin: ["..."]` / `~/.config/opencode/opencode.json`）と `opencode2 v0.0.0-beta-18999`（`plugins: [{package:"..."}]` / `opencode.jsonc`）のデュアル対応。`2.0.3` が両対応最終版、`2.0.5` 以降は `default` を `{id, setup, effect}` オブジェクトに変更し `opencode2` 専用 |
| **ビルド** | `bun build daily-logbook.ts --target=bun --outfile dist/index.js`（`prepublishOnly`）、`bun test` で `85 pass` |
| **インストール** | `npm install -g opencode-autopilot-logbook@2.0.x` → `opencode plugin opencode-autopilot-logbook -g`（v1）/ `opencode2 plugin add`（v2）、`~/.cache/opencode/packages` / `npm` サブキャッシュ / `Orca` 共有（`~/Library/Application Support/orca/opencode-hooks/shared/opencode.json`）への配置 |
| **運用** | `OPENCODE_DAILY_LOGBOOK_*` 環境変数で `outputDir` / `throttle` / `dailyLimit` / `usageProjectOnly` を制御。`artifacts/daily` への追記は `Bun.write` で冪等化 |

---

## 推奨アクション

1. **恒久実装の固定:** 現行の3段フォールバック（`ctx.event` → `SDK` at `49374` → `return {event}`）と `host.subscribe.call` / `stream` 抽出 / ファイル直書きを維持。
2. **精読の完了:** `v2/effect/context.ts` / `promise/context.ts` / `event.ts` / `loader.ts` の行数確定と `sst/opencode` 本体での `beta-18999` タグの `git log` 追跡。
3. **E2E の確立:** `opencode2 run "hello" --print-logs` での `v2: using SDK fallback via 49374` → `toAsyncIterable => AsyncIterable` → `artifacts/daily` 生成までを `2.0.8` で再現確認後、`npm publish`。

---

## 付録: 主要な参照ファイル

- `daily-logbook.ts:662` `v2Setup` / `703` `eventHost` フォールバック / `929` `createFallbackSdkClient` / `772` `createFallbackSessionAdapter`（ファイル直書き）
- `packages/plugin/src/v2/effect/context.ts` / `promise/context.ts`（`PluginContext` 定義）
- `packages/opencode/src/plugin/loader.ts`（`event` 注入箇所）
- `packages/opencode/src/bus/global.ts` / `event-v2-bridge.ts`（内部 `Bus` → SSE ブリッジ）
- `packages/sdk/js/src/v2/gen/sdk.gen.js:2014` `session.create`（`POST /session`）
- `https://opencode.ai/docs/plugins`（`return {event}` が正の v1 ドキュメント）
- `https://opencode.ai/v2/docs/build/plugins`（`ctx.event.subscribe` が正の v2 ドキュメント予定地）

