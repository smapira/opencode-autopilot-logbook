# [横断] Quality Gate 強化 — Circular 検出と diagnostics 昇格

## 優先度
🟢 低

## 対象
- 計画書: 横断
- 関連ファイル: `.githooks/pre-commit`, `eslint.config.mjs` (complexity:20), `scripts/verify-diagnostic-logs.ts`, `npx madge --circular`

## 指摘事項
- 現行 `pre-commit` は `tsc`, `eslint`, `bun test`, `madge` の 4ステップだが、`domain` が `adapters` を import していないか等のレイヤー違反を検出できない。
- `scripts/verify-diagnostic-logs.ts` の 3ケース (`V1 loaded` / `V1 host detected` / `toAsyncIterable => AsyncIterable`) が `pre-commit` 外で手動実行のため、回帰に気づきにくい。

## 改善案
- `eslint.config.mjs` に `import/no-restricted-paths` 相当のルールを追加し、`src/domain` → `src/adapters` の import を禁止（または `madge --circular` のしきい値を維持し、domain が adapters を import していないかを CI で検証）
- `scripts/verify-diagnostic-logs.ts` を `pre-commit` の 5番目として昇格するか、少なくとも `package.json:scripts.test` に統合:
  ```json
  "scripts": { "test": "bun test && bun scripts/verify-diagnostic-logs.ts" }
  ```
- 各 Phase 末に `npx madge --circular --extensions ts --warning .` で循環がないことを担保

## 備考
- 任意対応。直すと将来の `effect/Stream` 対応時のバンドル肥大化を早期検出できる。
