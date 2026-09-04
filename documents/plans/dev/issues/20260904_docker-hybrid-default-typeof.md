# Docker 検収ブロッカー: hybrid.ts の default の typeof 衝突

## 優先度
🔴 高

## 対象
- 計画書: `documents/plans/dev/issues/20260904_docker-hybrid-default-typeof.md`
- 関連ファイル: `src/adapters/hybrid.ts`, `src/plugin.ts`, `dist/index.js`, `~/.config/opencode/opencode.json` (host), `docker/Dockerfile.test`

## 指摘事項
`hybrid.ts` の `hybridDefault = Object.assign(V1, {id, setup, effect})` は `typeof === 'function'` のため `opencode2` (beta-19059) の `PluginModule.LoadError: SchemaError(Expected object at ["default"])` に抵触し `~/.cache/opencode/npm/opencode-autopilot-logbook@latest` の `dist`（2.0.9）が `failed to load plugin`。`2.0.10` で `plain object` (`{id, setup, effect}`) にしたが `opencode` v1 (1.18.27) の `plugin: ["opencode-autopilot-logbook"]` は `default` を `function` として呼び出すため `daily-logbook plugin loaded` が出ず `ses_f97f152a` の `loop` のみ。

## 改善案
- `hybrid.ts` で `default` を `opencode2` 用の `object` としつつ `opencode` v1 が `DailyLogbookPlugin` (named) を優先して読むようにする: `opencode.json` を `plugin: [{"package":"opencode-autopilot-logbook","entry":"DailyLogbookPlugin"}]` 形式にするか、`hybrid.ts` で `default` を `Proxy` で `typeof === 'object'` かつ `callable` にする。または `daily-logbook.ts` の facade を `export default DailyLogbookPlugin` (V1 関数) のままにしつつ `DailyLogbookPluginV2` (named) を `opencode2` 用に `plugins: ["opencode-autopilot-logbook/DailyLogbookPluginV2"]` で読ませる分離。`2.0.11` で `src/adapters/v1/plugin.v1.ts` / `v2/plugin.v2.ts` に `console.log` を `sink.info` に併記して `expect "daily-logbook plugin loaded"` が `stdout` で検知できるようにする。

## 振る舞い（BDD）
- **正常系:** `opencode` v1 で `daily-logbook plugin loaded`（v2なし）が出て `event` フックを返すこと（`verify-diagnostic-logs` V1 PASS）。`opencode2` で `daily-logbook plugin loaded (v2) ctxKeys=[...]` が出ること（V2 PASS）
- **異常系:** `opencode2` で `SchemaError(Expected object at ["default"])` が出ないこと。`opencode` v1 で `TypeError: def is not a function` が出ないこと（`verify` は `DailyLogbookPlugin` (named) を使用）
- **データ例:** `dist/index.js` 37.29KB (20 modules), `verify 3 PASS`, `~/.cache` の `1788503187890` (2.0.10) で `autopilot` の `failed` なし（`list` のみ `1 plugin failed`）

## 備考
- `src/plugin.ts` は `export {DailyLogbookPlugin} from "./adapters/v1/plugin.v1"` と `export default hybridDefault` を維持。`hybrid.ts` の `tryCreateV2Plugin` は `Plugin.define` の `setup`/`effect` 両対応を温存。`scripts/verify-diagnostic-logs.ts` の V1 case は `DailyLogbookPlugin` (named) を使用するように修正済み（2.0.10）。
