# [Phase3] Adapter 分割 — V1/V2/hybrid

## 優先度
🔴 高

## 対象
- 計画書: Phase 3
- 関連ファイル: `daily-logbook.ts` C21(17件) `v2Setup/resolveV2Iterable/toAsyncIterable/runV2EventLoop`, `daily-logbook.ts:603-624` `DailyLogbookPlugin`, ` daily-logbook.ts:630-660` `handleV2IdleEvent`
- 影響範囲: `dist/index.js` (32.35KB, 1 module) のビルド単位

## 指摘事項
- `v2Setup` (13 complexity) に `isV1Host` 判定 (696-711行), `eventHost` 解決, `SDK fallback (49374優先)`, `file-direct fallback` が集中し、1関数150行超。将来的な `beta-18999` → `beta-19xxx` 追従がファイル全体に波及する。
- `DailyLogbookPlugin` (V1) と `handleV2IdleEvent` (V2) が同一ファイルで `SessionAdapter` の形状差異 (`path/body` vs `flat`) を分岐で吸収しており、V1 のみに影響する修正でも V2 が再ビルド対象。
- `tryCreateV2Plugin` の dynamic `require("@opencode-ai/plugin")` が複数候補をループしており、テストが困難。

## 改善案
- `src/adapters/v1/`:
  - `log-sink.v1.ts` (`createV1LogSink` → `client.app.log`)
  - `session.v1.ts` (`path/body` 変換)
  - `plugin.v1.ts` (`DailyLogbookPlugin`, 40行に瘦身)
- `src/adapters/v2/`:
  - `log-sink.v2.ts` (`console.*`)
  - `session.v2.ts` (flat + `createFallbackSessionAdapter` の file-direct)
  - `event-source.v2.ts` (`resolveV2Iterable`, `toAsyncIterable`, `isEffectStream`, `isAsyncIterable`, 90行)
  - `sdk-fallback.ts` (`createFallbackSdkClient`, 13 complexity を 2関数に分割)
  - `plugin.v2.ts` (`v2Setup`, `handleV2IdleEvent`, `isV1Host` 判定, 150行)
- `src/adapters/hybrid.ts`:
  ```ts
  import { DailyLogbookPlugin as V1 } from "./v1/plugin.v1";
  import { v2Setup } from "./v2/plugin.v2";
  export default Object.assign(V1, { id:"smapira.daily-logbook", setup:v2Setup, effect:v2Setup });
  ```
- `src/plugin.ts` をエントリにし `package.json:scripts.build` を `bun build src/plugin.ts --target=bun --outfile dist/index.js` に変更
- `scripts/verify-diagnostic-logs.ts` の 3ケース (`V1 loaded`, `V1 host detected`, `toAsyncIterable`) を `src/adapters/v2/event-source.v2.test.ts` に昇格
- `.githooks/post-commit` の fast reindex がここで有効に機能

## 備考
- `hybrid` は `2.0.9` の `Object.assign` 方式を維持し、V1 (`callable`) と V2 (`id/setup/effect` object) の両検証を通過させる。
