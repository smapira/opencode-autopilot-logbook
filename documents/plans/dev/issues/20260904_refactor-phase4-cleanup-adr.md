# [Phase4] クリーンアップと ADR

## 優先度
🟡 中

## 対象
- 計画書: Phase 4
- 関連ファイル: `daily-logbook.ts` (facade), `package.json`, `documents/plans/dev/20260903_v2-compat.md`, `.codebase-memory/`

## 指摘事項
- Phase 1-3 後に `daily-logbook.ts` は `export * from "./src/..."` の re-export のみ残るが、削除タイミングと後方互換の保証が未定。
- `package.json:main` (`dist/index.js`) と `prepublishOnly` のビルドコマンドが旧パス (`daily-logbook.ts`) を指したまま。
- 本クリーンアーキテクチャ決定が ADR として永続化されておらず、次セッションでの再現性がない。

## 改善案
- `daily-logbook.ts` を `export * from "./src/plugin"` のみに縮退。次メジャー (`3.0.0`) で削除する旨を `CHANGELOG.md` に明記
- `package.json`:
  ```json
  "main": "dist/index.js",
  "scripts": { "build": "bun build src/plugin.ts --target=bun --outfile dist/index.js" }
  ```
  に切替（`dist` 出力は不変のため `files: ["dist"]` は維持）
- `codebase-memory-mcp` で `manage_adr(mode='update')` を実行し、本決定（クリーン + Adapter切替）を ADR として永続化
- `documents/plans/dev/20260903_v2-compat.md` を更新し、V1/V2 切替が Adapter 層であることを図で明記

## 備考
- 本 Phase は `npx tsc --noEmit` と `bun test` が通ることを条件に、PR 単独でマージ可能。
