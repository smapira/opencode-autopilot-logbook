# アルゴリズム単位のログ精密化 — 起動から日報生成までのステップ分割

## 目的

オープンコード起動時にプラグインログを出し、以降日報生成までの各アルゴリズムステップで取れる限りログを出し、1つの `sessionId` で追跡できるようにする。

## 起動時に取れるもの（初期部分を精密化）

プラグインが呼ばれる `Plugin({ client, directory })` / `v2Setup(ctx)` 時点で取れる：

| 取れるもの | V1 | V2 | 精度 |
|---|---|---|---|
| `pluginVersion` | `package.json` から | 同じ | 高 — ビルド時確定 |
| `opencodeVersion` | `client` に無し → 不明 | `ctx.app.version/name` | V2のみ高 |
| `directory` / `worktree` / `serverUrl` | `directory` 引数 | `ctx.location.directory / directory / worktree` | 高 |
| `config` 5項目 (`outputDir`, `dailyLimit`, `throttleMs`, `disabled`, `template`) | `src/application/config.ts` で読める | 同じ | 高 |
| `ctxKeys` / `event.subscribe` 有無 | なし | `Object.keys(ctx)` / `typeof subscribe` | 高 — V2診断に必須 |
| `timestamp` | `Date.now()` | 同じ | 高 |

## ステップ分割 — 起動から生成まで

各ステップで `INFO` 1行（成功）または `WARN/ERROR` 1行（スキップ/失敗）を出す。`sessionId` と `runId`（`Date.now()` から生成）で相関を付ける。

```
[0] startup — plugin loaded
  └─ 入力: directory, pluginVersion, opencodeVersion, config, ctxKeys
  └─ 出力: { ts, level:"info", step:"startup", pluginVersion, directory, config, ctxKeys, eventSubscribe, session }

[1] subscribe — event 購読
  └─ 入力: eventHost, sdkFallback
  └─ 出力: { step:"subscribe", via:"eventHost" | "sdkFallback" | "fallbackHook", result:"ok" | "no-adapter" }

[2] idle detected — session.idle / session.status idle 受信
  └─ 入力: event.type, event.properties.sessionID, event.data.sessionID
  └─ 出力: { step:"idle", sessionId, eventType, directory, elapsedMs: Date.now() - startupTs }

[3] guard — throttle / dailyLimit / inFlight チェック
  └─ 入力: sessionId, date, throttleWindowMs, isDailyLimited
  └─ 出力: { step:"guard", sessionId, date, throttled: bool, dailyLimited: bool, decision:"pass" | "skip-throttle" | "skip-dailyLimit" | "skip-inFlight" }

[4] fetchSourceSession — adapter.get(sessionId)
  └─ 出力: { step:"fetchSource", sessionId, aborted: bool, isGenerated: bool, error? }

[5] getDailyFileAction — 出力先判定
  └─ 出力: { step:"fileAction", date, outputDir, action:"create" | "append" | "skip-exists" }

[6] getUsageAndTemplate — usage / template 解決
  └─ 出力: { step:"usageTemplate", sessionId, hasUsage: bool, hasCustomTemplate: bool }

[7] fetchMessages — adapter.getMessages(sessionId)
  └─ 出力: { step:"fetchMessages", sessionId, messageCount: number, aborted: bool }

[8] buildPrompt — prompt 組み立て
  └─ 出力: { step:"buildPrompt", sessionId, promptLength: number, includeTranscript: bool }

[9] createGeneratedSession — adapter.create("[daily-logbook:auto] date")
  └─ 出力: { step:"createSession", sessionId, generatedId, aborted: bool }

[10] sendPrompt — adapter.prompt(generatedId, prompt)
  └─ 出力: { step:"sendPrompt", sessionId, generatedId, aborted: bool, durationMs }

[11] fallback direct write — V1/V2 の Bun.write
  └─ 出力: { step:"fallbackWrite", sessionId, absPath, success: bool }

[12] done — 完了
  └─ 出力: { step:"done", sessionId, date, outputFile, totalDurationMs }
```

## 取れる方法

- **起動時**: `DailyLogbookPlugin` の冒頭と `v2Setup` の冒頭で `sink.info(JSON)` を1行。`console.log` も同 JSON を出す（`--print-logs` と `expect` の両方で見える）。
- **各ステップ**: `generateDailyLogbookCore` を `steps` に分割済み（`fetchSourceSession`, `fetchMessages`, `createGeneratedSession`, `sendPrompt` など）。各関数の入口と出口で `sink.info` を追加。既存の `shouldAbort*` の `warn/error` に `sessionId` を付ける。
- **guard**: `isThrottled`, `isDailyLimitedInFlight`, `getDailyFileAction` の判定結果を `info` で出す。現在は `warn` のみで `pass` 時は無言。
- **fallback**: `createFallbackSessionAdapter` / `createV1FallbackSessionPort` と `writeDirectFile` で `directory`, `absPath`, `sessionId` を `info` に出す。現在は `directory` のみ。

## 実装案

1. **LogSink を拡張**: `AppLogSink` に `info` を必須にし、`debug` を追加（`--log-level DEBUG` で出す）。メッセージは `JSON.stringify({ ts, service, level, step, sessionId, ... })` に統一。

2. **startup の1行を精密化**: 現在の `daily-logbook plugin loaded` を上記 [0] startup の JSON に置換。`pluginVersion` は `import { version } from "../package.json"` で取得。

3. **generateDailyLogbookCore に runId を追加**: `Date.now()` と `sessionId` から `runId = ${date}-${sessionId.slice(0,8)}` を作り、全ステップのログに含める。`pruneExpiredGuards` や `inFlight` の操作も `runId` で追える。

4. **各ステップで計測**: `performance.now()` で `durationMs` を取り、`step` ごとに `info` を出す。`error` 時は `error.message` と `stack` を `error` レベルで出す。

5. **出力先**: 主は `client.app.log`（`--print-logs` で見える）、副は `artifacts/logs/daily-logbook.ndjson`（`LOG_FILE` env で有効化）への追記。`console.log` は JSON をそのまま出す。

## 精度

- 起動時の1行で `pluginVersion + directory + config` まで精密化すれば、今回のような「Orca で object/function」の切り分けは1行でできる。
- 生成までの12ステップで `sessionId` 相関が取れれば、`idle` が来たか、`throttle` で止まったか、`fileAction` で止まったか、`prompt` で失敗したかが分かる。現在の `void sink.warn` は `sessionId` が無いため追えない。
- 工数: 起動1行 (S 0.5日) + 生成12ステップ (M 1日) + テスト更新 (S)。

## 検証

- `bun scripts/verify-diagnostic-logs.ts --verbose` で起動 JSON の `pluginVersion`/`directory`/`config` を検証
- `bun test` の `withIsolatedDir` で各ステップの `sink.info` に `sessionId` が含むことを assert
- `bash scripts/smoke-test-plugin.sh` で `jq '.step=="startup" and .pluginVersion=="2.0.11"'` を検証
