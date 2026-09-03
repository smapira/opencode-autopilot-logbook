# [Phase1] Domain / Infrastructure 分離 — masking/transcript/usage

## 優先度
🔴 高

## 対象
- 計画書: 本リファクタ提案 Phase 1
- 関連ファイル: `daily-logbook.ts` (1087行, C20 5件/C23 11件), `test/daily-logbook.test.ts` (85 tests), `package.json`, `tsconfig.json`
- Code-Based Memory: clusters C20/C23, hotspots maskSecrets/getUsageStats

## 指摘事項
- 単一ファイル `daily-logbook.ts` に Domain 純粋ロジック (`maskSecrets`, `buildTranscript`, `format*`) と Infrastructure (`getUsageStats` → `bun:sqlite` + `project.worktree` 解決) が同居し、1,087行で `complexity:20` ギリギリ。追加で容易に超過する。
- `SECRET_PATTERNS` 定義と `truncateText` / `extractReadableText` が散在し再利用性が低い。
- `queryDailyStats` / `queryTotalStats` / `resolveProjectId` が `generateDailyLogbookCore` から直接参照され、DIP が未適用。

## 改善案
- `src/domain/masking.ts` に `SECRET_PATTERNS` + `maskSecrets()` を抽出
- `src/domain/transcript.ts` に `truncateText`, `extractReadableText`, `buildTranscript()` を抽出
- `src/domain/formatting.ts` に `formatCost`, `formatTokens`, `formatUsageTable` を抽出
- `src/infrastructure/usage/` に `resolveProjectId.ts`, `queryDailyStats.ts`, `getUsageStats.ts` を分割（`toYyyyMmDd` 含む）
- `daily-logbook.ts` は各モジュールから `export *` で re-export し、既存 import パスを壊さない Strangler Fig 方式を採用
- 検証: `npx tsc --noEmit` 0, `npx eslint .` 0, `bun test` 85 pass 維持

## 備考
- 本 Phase は依存が少なく最も安全に切離せる。失敗しても re-export で公開 I/F (`maskSecrets`, `getUsageStats` 等) を維持可能。
