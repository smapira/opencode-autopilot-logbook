# Docker TUI 60s idle 技術的可否リサーチ

## 優先度
🔴 高

## 対象
- 計画書: `documents/plans/dev/issues/20260904_docker-tui-feasibility.md`
- 関連ファイル: `src/adapters/hybrid.ts`, `src/adapters/v2/plugin.v2.ts`, `docker/Dockerfile.test`, `docker/docker-compose.test.yml`, `dist/index.js`

## 調査目的
`opencode`/`opencode2` TUI の 60s idle (`session.idle`) が `docker compose run --rm test bash -c "expect -c 'spawn opencode2; send hello; sleep 70'"` (tty:true, THROTTLE 0, DAILY_LIMIT false, OPENCODE_API_KEY, XDG_DATA_HOME 分離) で原理的に発火するか。`plugins: ["/app"]` のローカル dist (2.0.11, 37.39KB) は `opencode2` の `Plugin.define` の `Effect` 期待を満たすか。

## 調査方法
- コードベース読解: `hybrid.ts` (tryCreateV2Plugin candidates 4 spec), `v2/plugin.v2.ts` (v2Setup async Promise), `event-source.v2.ts`, `Dockerfile.test` (ln -sf /app), `docker-compose.test.yml` (tui/tui2)
- 公開コード参照: `opencode-ai/opencode` (Go TUI, archived) → `anomalyco/opencode` (現行), `@opencode-ai/plugin@1.18.27`
- ログ証跡: `e2e --direct` は 29→32 成功, `tui` via `expect` は 29→29 (1 plugin failed)

## 結果
**Docker TUI の session.idle は原理的に可能だが 3 条件が必須:**
1. **セッション生成** - `hello` が `opentui` のエスケープで `expect "Ask anything"` にマッチせず未到達。新 `expect` は `sleep 2; send "hello\r"` の無条件送信に変更済み
2. **LLM 完了後 60s** - `OPENCODE_API_KEY` なしで 401, 有りでも model 遅延で実質待機不足。`tui` に `OPENCODE_API_KEY` 注入済み
3. **DB 分離** - `opencode-data` を `opencode-data-v1/v2` に分離し `XDG_DATA_HOME` で `Database is not empty` 解消済み

**`plugins: ["/app"]` の可否:** `Dockerfile.test` の `ln -sf /app` と `plugins: ["/app"]` は `..:/app` mount で `npm publish` なしで local dist を読む正規手法。`opencode2` の `Plugin.define` は `effect` に `Effect` 型を期待するが `hybrid.ts` は `v2Setup` (Promise) を `effect: v2Setup as unknown` で渡しており `zod` 検証で `Expected Effect` エラーになり得る。現行 `~/.cache` の `1 plugin failed` は `list` のみで `autopilot` は 2.0.10 plain object で成功しているが `effect` 型は要検証。

**`session.idle` の発生源:** TUI のみ。`serve` (4096/49374) は `server listening` でも `session` なしで `idle` を発火しない。`e2e` の `serve` + `trigger-idle --direct` は TUI idle の迂回路。

## 推奨事項
- **短期 (2.0.12):** `hybrid.ts` の `effect` candidate を `Effect` ラップまたは無効化し `setup` のみで登録。`expect` を `expect "daily-logbook plugin loaded"` の二重待機にし `TERM=xterm-256color` を追加
- **検証コマンド (npm publish 不要):** `docker compose run --rm test bash -c 'node -e "import(\"/app/dist/index.js\").then(m=>console.log(typeof m.default, m.default?.id))"'` と `docker compose --profile tui run --rm -it tui2` で `plugins: ["/app"]` の local dist 検証
- **判定:** 🟡 Feasible with constraints — 条件付きで可能。`e2e --direct` は `Bun.write` で既に Docker 内完結で成功。

## 備考
- `console.log` 追加 (2.0.11) は `sink.info` が `opencode.log` にしか出ない問題を `stdout` 可視化で補う手当。`expect "daily-logbook plugin loaded"` が `stdout` で検知できれば load 成功。
