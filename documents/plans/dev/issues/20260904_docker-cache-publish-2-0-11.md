# Docker キャッシュと 2.0.11 publish

## 優先度
🟢 低

## 対象
- 計画書: `documents/plans/dev/issues/20260904_docker-cache-publish-2-0-11.md`
- 関連ファイル: `src/adapters/hybrid.ts`, `src/adapters/v1/plugin.v1.ts`, `src/adapters/v2/plugin.v2.ts`, `dist/index.js`, `package.json`

## 指摘事項
`2.0.10` (plain object) は `npm publish` 済みだが `~/.cache/opencode/npm/opencode-autopilot-logbook@latest` (1788503187890) が `2.0.10` の plain object で `autopilot` の `failed` は解消（`1 plugin failed` は `list` のみ）したものの `2.0.11` の `console.log` 追加を `~/.cache` に反映するには `docker compose down -v` (`opencode-cache` ボリューム削除) が必要。`~/.cache` の `1788501644176` (2.0.9) は `Object.assign` 関数で `SchemaError` が出ていた。

## 改善案
- `2.0.11` で `src/adapters/v1/plugin.v1.ts` / `v2/plugin.v2.ts` に `console.log("daily-logbook plugin loaded ...")` を `sink.info` に併記して `expect "daily-logbook plugin loaded"` が `stdout` で検知できるようにし `npm publish` → `docker compose down -v` で `opencode-cache` ボリュームをクリアして `opencode2` が新しい `dist` (plain object + console.log) を読むようにする
- `Dockerfile.test` の `ln -sf /app → /usr/local/lib/node_modules` と `/app/node_modules` は `~/.cache` を優先する `opencode2` では `plugins: ["/app"]` で `/app` 直参照にしないと `~/.cache` の旧 `dist` が読まれるため `plugins: ["/app"]` での検証も併記

## 振る舞い（BDD）
- **正常系:** `docker` 内の `opencode2` が `~/.cache` の `2.0.11` (console.log 付き plain object) を読み込み `daily-logbook plugin loaded (v2)` が `opencode.log` と `stdout` の両方に出ること。`docker compose --profile tui run --rm tui` で `hello` → 60秒放置で `artifacts/daily` に `Bun.write` で新規作成
- **異常系:** `~/.cache` が `2.0.9` (Object.assign 関数) のままでは `opencode2` で `SchemaError(Expected object at ["default"])` が出ること。`docker compose down -v` で `opencode-cache` ボリュームを削除すると `2.0.11` の plain object が読まれて `1 plugin failed` (list のみ) になること
- **データ例:** `~/.cache/opencode/npm/opencode-autopilot-logbook@latest` at `1788503187890` (2.0.10 plain object) で `autopilot` の `failed` なし、`1788501644176` (2.0.9 Object.assign) で `failed`

## 備考
- `2.0.10` は `npm publish` 済み (`latest: 2.0.10`, `2.0.9` は旧)。`2.0.11` は `console.log` 追加で `dist` を 37.29KB → 37.3KB に再ビルド。
