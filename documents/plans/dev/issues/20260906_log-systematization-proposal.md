# ログ出力の体系化・精密化 提案 — 特に初期部分

## 現状調査

### どこに出るか

| 経路 | 実体 | 見える場所 | 形式 |
|---|---|---|---|
| V1 `client.app.log` | `src/adapters/v1/log-sink.v1.ts` → `client.app.log({ service, level, message })` | `opencode --print-logs` / `--log-level` / `daemon.log` / `main.trace` | 非構造 plain message |
| V2 `console.log` | `src/adapters/v2/log-sink.v2.ts` → `console.log("[daily-logbook-plugin] ...")` | `stderr` / `opencode2 --print-logs` の一部 | プレフィックス付き plain |
| 006 `console.log` | `src/adapters/v1/plugin.v1.ts:36` `console.log("daily-logbook plugin loaded")` | `expect` の stdout 検出用 | 生文字列 |

### 初期部分で何が出るか

- **V1**: `daily-logbook plugin loaded` のみ。`directory`, `version`, `opencode version`, `config` は出ない。
- **V2**: `daily-logbook plugin loaded (v2) app=unknown ctxKeys=[agent,aisdk...] event.subscribe=yes/no session=yes/no [V1 host detected]` — `ctxKeys` 9要素や `event.subscribe` の有無は出るが、`directory`, `plugin version`, `opencode version (正確)`, `env config`, `runId/sessionId` は出ない。

### 既存の検証

`scripts/verify-diagnostic-logs.ts` が 3ケースを `captureConsole` で検証。`--verbose` で全ログを出す。`scripts/smoke-test-plugin.sh` は `debug config` (1/2) と `run --print-logs` (2/2) を見るが、後者は TUI なしで `WARN` になる。

## どこまで精密化できるか — 初期部分

起動時に手元にあるデータで、追加コストなしで精密化できる範囲：

| 追加できるフィールド | 入手元 | 精度 | コスト |
|---|---|---|---|
| `pluginVersion` | `package.json version` (2.0.11) を `import` | 高 — ビルド時に確定 | S |
| `opencodeVersion` | V1: `client` に version なし → `process.env` 推定不可。V2: `ctx.app.version/name/channel` | 中 — V2のみ正確、V1は `unknown` になる | S |
| `directory` / `worktree` | `directory` 引数 / `ctx.location.directory` | 高 — 既に `getV2Directory` で取得済み。V1は `directory` で確定 | S |
| `config` | `getOutputDir()`, `isDailyLimitEnabled()`, `getThrottleWindowMs()`, `isPluginDisabled()` など `src/application/config.ts` | 高 — 起動時に全 env を読める | S |
| `runId` / `sessionId` | 生成時の `sessionID` は初期には無い。`runId` は `opencode` が振るが plugin には渡らない | 低 — 初期では `sessionId` は出せない。生成時に `sessionID` を correlation に付けるのが精密化の上限 | M |
| `timestamp` | `Date.now()` / `new Date().toISOString()` | 高 — 1行で付与 | S |
| `isV1Host` | `detectV1Host` | 高 — 既に出ている | S |

**結論:** 初期部分は `pluginVersion + directory + config 5項目 + opencodeVersion(V2) + timestamp` までを **1行の構造化ログ** にすれば、原因切り分けに必要な 80% はカバーできる。`sessionId` は初期では出せないので、生成時の `generateDailyLogbookCore` で `sessionID` を `info` に付ける。

## 提案

### 1. 構造化ログに統一（V1/V2 共通）

`AppLogSink` を `info/warn/error` のまま、メッセージを `JSON` にする。`client.app.log` は `message` に JSON 文字列を入れれば `--print-logs` でも `jq` で絞れる。V2 の `console.log` も同じ JSON を出す。

```json
{"ts":"2026-09-06T05:30:00.000Z","service":"daily-logbook-plugin","level":"info","pluginVersion":"2.0.11","opencodeVersion":"1.18.27","directory":"/path/to/repo","worktree":"/path","config":{"outputDir":"artifacts/daily","dailyLimit":false,"throttleMs":90000,"disabled":false,"template":"(default)"},"ctxKeys":"agent,aisdk,...","eventSubscribe":"yes","session":"yes","v1Host":false,"msg":"plugin loaded"}
```

- `ts`: `new Date().toISOString()`
- `service`: 固定 `daily-logbook-plugin`
- `level`: `info/warn/error` は既存を踏襲
- 残りは上表のフィールド

### 2. 初期の1行を精密化（最優先）

- **V1**: `DailyLogbookPlugin` の `client.app.log` と `console.log` を上記 JSON 1行に置換。`directory` と `config` を必ず含める。
- **V2**: `logV2Startup` の `v2Message` を同 JSON に置換。`ctxKeys`, `hasEventSubscribe`, `hasSession`, `isV1Host` に加え `directory`, `pluginVersion`, `config` を追加。

これで `daemon.log` や `main.trace` で `grep daily-logbook` した 1行で「どの版がどの directory でどの config で起動したか」が分かる。現在の `ctxKeys` だけより精密。

### 3. 生成時の相関ログ

`generateDailyLogbookCore` の各 `sink.info/warn/error` に `sessionId`, `date`, `outputDir` を付ける。例:

```json
{"ts":"...","level":"info","sessionId":"ses_xxx","date":"20260906","outputDir":"artifacts/daily","msg":"fetchSourceSession done"}
{"ts":"...","level":"info","sessionId":"ses_xxx","msg":"fallback direct write to /abs/path/artifacts/daily/20260906_logbook.md"}
```

`inFlightSessionIds` や `throttle` でスキップした時も `reason` と `sessionId` を出す。現在の `void sink.warn(...)` は `sessionId` が無い。

### 4. ログレベルの整理

- `info`: 起動1行、生成成功の `write` パス
- `warn`: `throttle`/`dailyLimit` スキップ、`template load failed`、`fallback` 使用
- `error`: `get/create/prompt` 失敗、`unhandled error`

`--log-level` で絞れるように、現在の `console.warn`/`console.error` を `sink` 経由に統一。V2 の `createV2LogSink` が `console.log` 直なので、V2 も `client` があれば `client.app.log` を優先し、なければ `console` に JSON を出す fallback にする。

### 5. 出力先の体系化

- **主**: `client.app.log`（opencode の log 機構）に JSON を送る → `--print-logs` と `daemon.log` に残る。
- **副**: `artifacts/logs/daily-logbook.ndjson` に同 JSON を追記（任意）。`ls -lt` で直近の生成を確認できる。`LOG_FILE` env で有効化。

## 工数と優先度

| 項目 | 工数 | 効果 |
|---|---|---|
| 初期1行の JSON 化（V1/V2） | S (0.5日) | 高 — 原因の 80% を1行で特定 |
| 生成時の sessionId 付与 | S (0.5日) | 高 — idle が誰か分かる |
| V1/V2 LogSink 統一 | S | 中 — `--log-level` が効く |
| ファイル追記（ndjson） | M | 中 — `artifacts/logs` で即確認 |

**推奨:** まず「初期1行の JSON 化」だけを S で実施。これで `daemon.log` の `grep` 精度が上がり、今回のような「Orca で V2 が object/function で失敗」が1行で分かる。残りは `generate` の `sessionId` 付与までを次の S で追加。

## 検証方法

- `bun scripts/verify-diagnostic-logs.ts --verbose` に JSON 1行の `pluginVersion`/`directory`/`config` を含むことを追加
- `bash scripts/smoke-test-plugin.sh` で `debug config` (1/2) はそのまま、`run --print-logs` (2/2) の `grep` を `jq '.service=="daily-logbook-plugin" and .level=="info"'` に置換
- `bun test` の `withIsolatedDir` で `sink` の `info` に `sessionId` が含むことを assert
