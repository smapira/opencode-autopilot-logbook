# [Phase2] Application 層 — ports と UseCase 抽出

## 優先度
🔴 高

## 対象
- 計画書: Phase 2
- 関連ファイル: `daily-logbook.ts` C19(22件) `generateDailyLogbookCore`, `src/domain/*`, `src/infrastructure/*`
- 検証: `codebase-memory-mcp` trace_path(Call) で C19 の fan_in 確認済み

## 指摘事項
- `generateDailyLogbookCore` (complexity 20, 70行) が `SessionAdapter` と `AppLogSink` に直接依存しつつ、`isThrottled`, `getDailyFileAction`, `getUsageAndTemplate` 等のガードロジックを内包。V1/V2 の差異を UseCase が意識しており SRP 違反。
- `AppLogSink` / `SessionAdapter` が `daily-logbook.ts` 内で型エイリアスとして定義され、Application 層としての独立性がない。
- テストの `createMockClient` が V1 形状 (`path/body`) に固定され、V2 flat 形状との共存が困難。

## 改善案
- `src/application/ports.ts` を新設:
  ```ts
  export type AppLogSink = { warn(msg:string):void|Promise<void>; error(msg:string,e?:unknown):void|Promise<void>; info?(msg:string):void|Promise<void> };
  export type SessionPort = { get(id:string):Promise<unknown>; getMessages(id:string):Promise<unknown>; create(title:string):Promise<{id:string}>; prompt(id:string,text:string):Promise<unknown> };
  export type EventSourcePort = { subscribe(signal:AbortSignal):AsyncIterable<unknown>|Promise<AsyncIterable<unknown>> };
  export interface PluginContextPort { directory:string; sink:AppLogSink; session:SessionPort; events:EventSourcePort }
  ```
- `src/application/generate-logbook.usecase.ts` に現行 `generateDailyLogbookCore` 本体を移動（`parseSourceResult`, `shouldAbort*`, `buildTranscriptFromData` を内包）
- `src/application/guards.ts` に `isWithinWindow`, `isThrottled`, `isDailyLimitedInFlight`, `getDailyFileAction` を抽出
- `daily-logbook.ts` は `export { generateDailyLogbookCore } from "./src/application/..."` の facade に縮退
- `test/daily-logbook.test.ts` の import を段階的に `src/application/...` へ切替（両対応期間は re-export で互換維持）
- 検証: complexity 20 未満を各関数で維持、`bun test` 85 pass

## 備考
- 本 Phase で DIP が完成し、Phase 3 の Adapter 分割の前提となる。
