# Changelog

## 2.0.8 - fix: v2 SDK this binding and file-direct fallback (2026-09-04)

### Fixed
- **ゲイン特定: `this._client` 束縛抜けと候補順の修正**: `2.0.7` で `SDK` フォールバックが `http://localhost:49353`（`ORCA_AGENT_HOOK_PORT`）を `49374`（`opencode2` 本体）より先に試し、かつ `client.event.subscribe({signal})` を `const sub = client.event.subscribe; sub({signal})` と切り離して呼んでいたため `undefined is not an object (evaluating 'this._client')` で `resolveV2Iterable` が失敗し、`v2 plugin idle subscription failed` が残留。`host.subscribe.call(host, {signal})` への修正と `49374` を最優先にする候補順の入れ替え、さらに `Promise<{stream: AsyncIterable}>` からの `stream` 抽出を `toAsyncIterable` に追加し、`v2: using SDK fallback via 49374` → `toAsyncIterable => AsyncIterable` まで到達するよう修正。`SDK` フォールバックの `session` は `opencode2` 本体の `session.create` が `405` となる環境があるため、ファイル直書きの `createFallbackSessionAdapter`（`Bun.write` で `artifacts/daily` に直接追記）に切り替え、`dist` は `31.73KB` に再構築（`bun test 85 pass` 維持）

## 2.0.7 - fix: permanent v2 idle for beta without ctx.event (2026-09-04)

### Fixed
- **v2 `ctxKeys=[agent,aisdk,catalog,command,integration,options,plugin,reference,skill]` で `event.subscribe=no` となる beta での恒久対応**: `opencode2 v0.0.0-beta-18999` の `PluginContext` が `{agent,aisdk,catalog,command,integration,options,plugin,reference,skill}` のみで `event`/`session`/`client`/`location` を持たないことが `2.0.6` の診断ログで確定。`2.0.6` の `ctx.event`/`client.event` フォールバックでも `no-event` のまま `v2 plugin idle subscription failed` になっていたため、以下の恒久対応を追加:
  - `v2Setup` が `eventHost` を持つ場合は従来通り `runV2EventLoop` で `subscribe({signal})` / `subscribe("session.idle")` の両対応（`AsyncIterable` / `Stream` 分岐は軽量維持）
  - `eventHost` が無い beta では `return {event: async ({event})=>{if(event.type==="session.idle") handleV2IdleEvent(...)}}` の **フォールバック `event` フック** を返す（ホストが旧来の `return {event}` 配信をまだサポートしていれば idle が届く）。`session` が無い場合は `@opencode-ai/sdk` から自前 `client` を生成する `createFallbackSessionAdapter`（`http://localhost:4096` 既定）で補完
  - `ctxKeys` / `session` 有無もログに出し、`v2: ctx.event.subscribe not found; falling back to return {event} hook` の警告で v1 (`opencode 1.18.x + 2.0.3`) へのフォールバックを案内
- `dist` は 87.67 KB に再ビルド（SDK フォールバックを含む 31 modules、`bun test` 85 pass 維持）

## 2.0.6 - fix: permanent v2 idle subscription for beta host (2026-09-04)

### Fixed
- **v2 `event.subscribe did not return AsyncIterable` の恒久対応**: `opencode2 v0.0.0-beta-18999` で `daily-logbook plugin loaded (v2) app=unknown` の後に `event.subscribe did not return AsyncIterable; v2 plugin idle` が出ていた。原因は `@opencode-ai/plugin@1.18.27` (stable) でビルドされた `dist` を beta ホストで実行すると `ctx.event` が存在せず、`ctx.event.subscribe` が `undefined` だったため。`v2Setup` を恒久的に以下の通り修正:
  - `ctxKeys` / `event.subscribe` / `client.event.subscribe` の有無を `sink.info` に出力し、beta での `ctx` 形状差異を可視化
  - `event` の位置を `ctx.event` と `ctx.client.event` の両方から解決（`eventHost` フォールバック）
  - `resolveV2Iterable` を `AsyncIterable` と `Effect Stream` の両対応にし、`toAsyncIterable` で `Promise<...>` の解決と `Stream` 検出（`isEffectStream`）を分岐。`effect/Stream` のバンドル肥大化を避けるため `Stream` は現状 `undefined` を返して別経路を試す軽量実装に
  - `runV2EventLoop` の警告を `event.subscribe=${typeof ...} ctx.event keys=...` を含む詳細に
  - `tryCreateV2Plugin` を `v2/promise` / `v2/effect` / `.` / `effect` の全経路に対応（`@opencode-ai/plugin` の beta での exports 変更に対応）
- `dist` は 25.62 KB に再ビルド（`bun test` 85 pass 維持）。`@opencode-ai/plugin` は `^1.0.0` のまま維持し、stable でも beta でもビルドが壊れない（`effect/Stream` は動的 import ではなく軽量分岐）

## 2.0.5 - fix: make default object for V2 host (2026-09-03)

### Fixed
- **V2 ホストでの `Expected object` 解消**: `2.0.4` の `_hybridDefault` は `DailyLogbookPlugin` 関数に `id`/`setup`/`effect` を付与した callable だったが、`opencode2` の `PluginModule` は `default` を `object` として検証するため `Expected object at ["default"]` で `failed to load plugin` になっていた。`export default` を `{id, setup: v2Setup, effect: v2Setup}` のオブジェクトに変更し、V2ホストで `id`/`setup`/`effect` 検証を通過するようにした。`DailyLogbookPlugin`（V1関数）は名前付き `export` として温存
  - **注意**: `2.0.5` は `opencode2` 専用。`opencode` 1.18.27（V1ホストで `default` を関数として呼ぶ）では `default` がオブジェクトのため `TypeError` になる。V1利用者は `2.0.3` を使用するか、`opencode2` に移行してください。`dist` は 24.0 KB に再ビルド

## 2.0.4 - fix: support both subscribe styles for V2 host (2026-09-03)

### Fixed
- **V2 ホスト E2E 未達を修正**: `v2Setup` が `ctx.event.subscribe({signal})=>AsyncIterable` (promise) のみに対応し、`ctx.event.subscribe("session.idle")=>Stream` (effect) で呼ばれる `opencode2 v0.0.0-beta-18999` (`opencode2 -s`) では `event.subscribe did not return AsyncIterable` で idle していた。`v2Setup` を `subscribe({signal})` と `subscribe("session.idle")` の両方を試すようにし、`resolveV2Iterable`/`trySubscribeEffect`/`isAsyncIterable`/`runV2EventLoop` に抽出して複雑度 31→<20 に。`tryCreateV2Plugin` は `setup` と `effect` 両方の `Plugin.define` を試し、フォールバックは `{id, setup, effect}` で両ホストで検証を通過するようにした。モックで promise/effect 両スタイルの `handleV2IdleEvent` 呼び出しが PASS することを確認
  - `package.json` は `^1.0.0` に戻し、`dist` は 24.79 KB に再ビルド。`npx eslint .` 0, `npx tsc --noEmit` 0, `bun test` 85 pass

## 2.0.3 - refactor: complexity 20 and dev env alignment (2026-09-03)

### Changed
- **eslint 準拠リファクタ**: `eslint.config.mjs` を `globals` + `complexity:20` に更新したことに伴い、`daily-logbook.ts` の複雑度違反 3件 (`getUsageStats 29`, `event 27`, `handleV2IdleEvent 56`) を解消。`getUsageStats` を `resolveProjectId`/`queryDailyStats` 等に抽出、`event`/`handleV2IdleEvent` の重複 170行を `generateDailyLogbookCore` + `SessionAdapter` に集約し、各関数を 20 以下に。コメントの簡素化と `dirname`/`fileURLToPath`/`isBetaPluginAvailable` の未使用整理も実施。`npx eslint .` 0, `npx tsc --noEmit` 0 を達成
  - `package.json` に `globals@^17.12.0` を追加（`eslint.config.mjs` の `globals.node` 用）
  - `dist/index.js` は 23.43 KB に再ビルド（`bun test` 85 pass 維持）

## 2.0.2 - fix: hybrid default for V1/V2 host compatibility (2026-09-03)

### Fixed
- **opencode2 検証失敗を修正**: `opencode2 plugin update` が `Failed to check Server plugin "opencode-autopilot-logbook": Plugin must export a default definition with an id and an effect or setup function.` で失敗していた。原因はキャッシュ環境（`~/.cache/opencode/packages/.../dist/index.js`）では `node_modules/@opencode-ai/plugin/package.json` が存在せず `isBetaPluginAvailable()` が `false` を返し `default` が V1 関数（`id` なし）のままだったため、V2 ホストの `id`/`setup` 検証を通過しなかった
  - `default` を V1 関数に `id`/`setup`/`effect` を付与したハイブリッド（callable かつ `id`/`setup` を持つ）に変更。これにより stable `1.18.27` では関数として呼び出され、beta `opencode2` では `id`/`setup` を持つ定義として両方のチェックを通過する
  - `DailyLogbookPluginV2` は従来通り `{id, setup}` の plain object として温存

### E2E
- beta E2E再検証: `opencode2 plugin list` で `opencode-autopilot-logbook` が `plugins` に表示、`opencode2 plugin update` の `Failed to check` が解消されることを確認予定。`bun test` 85 pass、`dist 25.32 KB`

## 2.0.1 - fix: ESM-only beta detection via package.json (2026-09-03)

### Fixed
- **beta ESM-only 対応**: `@opencode-ai/plugin@beta` は `exports` が `import` のみで `require("@opencode-ai/plugin")` が `No "exports" main defined` で失敗するため、`createRequire` だけでは V2 を検出できず `default` が V1 にフォールバックしていた。`isBetaPluginAvailable()` を追加し `fileURLToPath(import.meta.url)` + `existsSync` + `readFileSync(package.json)` で `version` に `beta` を含むかで判定するように修正。これにより `npx @opencode-ai/cli@beta` (`opencode2 v0.0.0-beta-18999`) で `default` が `DailyLogbookPluginV2` (`smapira.daily-logbook`) を正しく返し、`ctx.event.subscribe({signal})=>AsyncIterable` + `event.data.sessionID` + `ctx.session.*` の V2 経路が発火する
  - `tryCreateV2Plugin` のコメントを ESM フォールバックが beta ホストでも受理される旨に更新
  - `bun test` は stable `1.18.27` (`^1.0.0`) で 85 pass を維持。`bun /tmp/test-v2.mjs` で beta 時に `default === V2` を、stable 時に `default === V1` を確認

### E2E
- beta E2E: `npx @opencode-ai/cli@beta --version` → `opencode2 v0.0.0-beta-18999`、`handleV2IdleEvent` と `v2Setup` のモック E2E (flat shapes, `subscribe({signal})`, `ctx.location.directory`, `console` sink) が PASS。`artifacts/daily` 生成は `handleV2IdleEvent` 単体および `v2Setup` の `AsyncIterable` 1件 yield で検証済み

## 2.0.0 - BREAKING: migrate to @opencode-ai/plugin beta (2026-09-03)

### BREAKING
- **V2 Plugin API**: `DailyLogbookPlugin` (V1 `Plugin = async ({client,directory})=>({event})`) は温存しつつ、`Plugin.define({ id: "smapira.daily-logbook", setup(ctx) })` による V2 対応を追加（デュアル対応）。V2 では `ctx.event.subscribe({ signal }) => AsyncIterable<V2Event>` + `event.data.sessionID` / `ctx.session.get({ sessionID })` / `ctx.session.context({ sessionID })` / `ctx.session.create({ title })` / `ctx.session.prompt({ sessionID, text })` のフラット形状に移行。V1 の `path:{id}` / `body:{parts}` は廃止。対照表は `daily-logbook.ts` コメントを参照
  - `ctx.app.log` は V2 で存在しない（`ctx.app` は `{name,version,channel}` のみ）ためログは `console.warn/error` (`[daily-logbook]` prefix) に置換。`type Logger = PluginInput["client"]` は `AppLogSink` に抽象化
  - `ctx.location.directory` が旧 `directory` に相当
  - promise版 `subscribe({signal})` は全イベントが流れ `if(type==="session.idle")` でフィルタ。effect版 `subscribe(type):Stream` との差異をコメントで明記

### Added
- `DailyLogbookPluginV2` (`{ id, setup }`) と `handleV2IdleEvent`（テスト可能な抽出関数）を `daily-logbook.ts` に追加。`@opencode-ai/plugin@beta` では `Plugin.define` でラップ、stable 1.18.x では動的 `createRequire` + フォールバック plain object により `bun test` が壊れない
- `AppLogSink` / `createV1LogSink` / `createV2LogSink` によるログ抽象化

### Changed
- `package.json` は現行 stable では `devDependencies."@opencode-ai/plugin":"^1.0.0"` を維持。beta ブランチでの切り替え手順: `npm i -D @opencode-ai/plugin@beta`（`opencode@beta` と併用）。`bun:sqlite` や純粋ロジック（`maskSecrets` / `buildTranscript` / `throttle` / `dailyLimit` など）は変更なし（トランケート前にマスキングは維持）

### Migration
- beta での検証: `npx opencode@beta --version` → `opencode --standalone` (beta channel) 起動 → `session.idle` で `artifacts/daily/YYYYMMDD_logbook.md` が生成されることを確認
- `opencode.json` は V2 で `plugins: [...]` (`{package, options}` 形式) が推奨だが beta 期間中は `plugin` と共存可能（E2Eで確定要）。ファイル配置は `.opencode/plugins/` を推奨（V2は `plugin/` と `plugins/` 両方を読む）
- beta 期間中は再 breaking の可能性あり。本 CHANGELOG と `daily-logbook.ts` 冒頭の対照表コメントを追従すること
- V1 利用者への配慮: 本バージョンはデュアル対応のため既存 V1 利用者の挙動は壊さない。`plugin` / `plugins` 共存の可否はリリース時に判断し、必要なら major bump で分離

## 1.2.0 (2026-09-02)

### Added

- Usage statistics via `{{ usage }}` / `{{ usageTable }}` template variables (canonical is `{{ usage }}`). `SAMPLE_TEMPLATE` now includes `## Usage` / `{{ usage }}` so daily reports show cost/tokens by default. Resolved from `~/.local/share/opencode/opencode.db` (`session` table, `time_created` in ms epoch) with `bun:sqlite` (`readonly: true`, `?` binding, `coalesce(sum,0)`). Table includes `Cost (本日/セッション)` / `Tokens Input / Output / Cache Read` / `Sessions (本日)` / `Total Cost (累計)` with `formatCost` (`$x.xx`) and `formatTokens` (`K/M/B`)
- `OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY` (default `true`, only `"false"` disables; resolves `project.worktree` via `resolve(directory)`, falls back to all projects) and `OPENCODE_DAILY_LOGBOOK_DB_PATH` (default `~/.local/share/opencode/opencode.db`, `read-only` open, omitted on failure)
- Unit/integration tests for `getUsageStats` (tmp file DB), `formatUsageTable`, `replaceTemplateVariables` (`$` safety), `buildPrompt` with usage, and `DailyLogbookPlugin` with usage. `PLUGIN_ENV_KEYS` now includes the two new env vars

### Changed

- Documented the new feature in both READMEs (`## Features` / `## 機能`, `## Template Variables` / `## テンプレート変数`, and the two new env var sections). `README.md` Features now lists usage statistics; template variable table includes `{{ usage }}` / `{{ usageTable }}`
- `SAMPLE_TEMPLATE` is now exported and contains `## Usage` / `{{ usage }}`. Custom templates can place `{{ usage }}` at any position; when the database is unavailable or the day has no sessions, the variable is replaced with an empty string
- `replaceTemplateVariables` / `buildPrompt` now use function-form `() => value` replacements to avoid `$` special expansion (`$2.31` safety)

## 1.1.1 (2026-08-30)

### Added

- Philosophy section in READMEs linking to the guiding column on OSS principles (`https://www.thch-vape.shop/guide/column/git-log--oneline--all--society`). English README uses `## Philosophy`, Japanese README uses `## フィロソフィー` with the same intent. The column frames long-unreviewed social structures as technical debt and explains why we continue OSS activities and writing

### Changed

- Documented how to configure environment variables in both READMEs (`## Environment Variables` / `## 環境変数`). Added a common intro explaining that variables are read at startup and require an OpenCode restart, with examples for one-session (`export ...` then `opencode`) and persistent (`~/.zshrc` / `~/.bashrc`) usage and verification via `echo` and `ls`
- Expanded `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` documentation in both READMEs with path-resolution details (`resolve(directory, outputDir)` for relative paths, absolute paths as is, and absolute-path promotion when `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true`) and three concrete examples (`daily`, `documents/daily`, `/tmp/my-logs`)

## 1.1.0 (2026-08-19)

### Added

- Secret masking: known secret patterns in the transcript (`sk-...`/`SK-...`, `Bearer <token>`, `AKIA...`, `ghp_...`, `github_pat_...`, `xoxb-...`, JWT (`eyJ...`), PEM private keys, `password:`-style pairs, etc.) are replaced with `***` before being embedded into the prompt
  - Applied **before** truncation so a secret split at the cut point is not leaked
  - Controlled by `OPENCODE_DAILY_LOGBOOK_REDACT` (default `true`, only `"false"` disables)
  - `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT` (default `true`, only `"false"` disables) can omit the transcript entirely; when `false`, the transcript is never embedded regardless of `REDACT`
  - Masking is a fail-safe to reduce accidental disclosure, not a guarantee of complete secrecy
  - Uppercase `SK-` keys are also masked (case-insensitive `sk-`/`SK-`); short JWTs (any segment < 10 chars) and context-free `Bearer` over-masking are documented limitations
- Configurable throttle window: `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS` (integer parse, falls back to 90000 on NaN/negative)
- Daily limit: `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` skips generation when `{{ outputDir }}/{{ date }}_logbook.md` already exists (file-based check, survives process restarts)
  - Not supported together with `OPENCODE_DAILY_LOGBOOK_TEMPLATE` (warns and skips the check)
  - **Concurrent idle events for the same date are suppressed** via an in-memory date-keyed in-flight guard (different sessions idling at the same time no longer both pass the existence check)
  - **`{{ outputDir }}` is passed as an absolute path** (resolved against the plugin directory) when the limit is enabled, so the agent writes to the same location the existence check inspects; the relative string is kept when disabled
- Unit tests via `bun test` (`test/daily-logbook.test.ts`) covering masking, throttle window, daily-limit existence check, daily-limit concurrency guard, and absolute-path prompt resolution

### Changed

- `{{ dateJp }}` template variable value changed from ISO (`YYYY-MM-DD`, introduced in 1.0.9) back to Japanese (`YYYY年M月D日`) at the source level. No public behavior impact documented in this release; recorded for completeness

### Fixed

- Removed the "manual trigger via `/daily-logbook` command" claim from READMEs; the command files are now documented as repository-local features, not plugin features
- Dropped the stale build artifact `dist/daily-logbook.js`; `dist/` now contains only `index.js`
- Relocated the sample custom template to `documents/plans/dev/daily-logbook.md` (committed) and updated the `OPENCODE_DAILY_LOGBOOK_TEMPLATE` README example to point to it; removed the leftover root `plans/` directory to complete the `plans/` → `documents/plans/` reorganization
- Standardized the `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` default notation to `artifacts/daily` (no trailing slash) in READMEs to match the implementation

## 1.0.6 – 1.0.9 (2026-08-14 – 2026-08-18)

Unreleased changelog entries, summarized:

- **1.0.9**: Prompt/error messages/date formats switched to English-first; README updated (removed Method B, added uninstall steps and cache-clear warning)
- **1.0.8**: `daily-logbook.ts` moved to repository root with build path update; directory reorganization (`plans/` → `documents/plans/`); removed unused files
- **1.0.7**: OpenCode plugin support; `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` added; output file name switched to English (`YYYYMMDD_logbook.md`)
- **1.0.6**: Logbook-only generation (handover document generation removed); template loading switched to environment variable + built-in sample template; output path unified to `artifacts/daily`

## 1.0.5 (2026-08-14)

### Added

- `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` environment variable to customize output directory
  - Default: `artifacts/daily/`
  - Example: `export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"`

### Changed

- Plugin compiled to `.js` for OpenCode compatibility
- Output directory is now configurable via `{{ outputDir }}` template variable

## 1.0.0 (2026-08-12)

### Added

- Initial release
- Auto-generates daily reports on `session.idle` events
- `OPENCODE_DAILY_LOGBOOK_DISABLED` environment variable
- `OPENCODE_DAILY_LOGBOOK_TEMPLATE` environment variable for custom templates
- Template fallback to built-in `SAMPLE_TEMPLATE` on load failure
- Output: `artifacts/daily/YYYYMMDD_日報.md`
