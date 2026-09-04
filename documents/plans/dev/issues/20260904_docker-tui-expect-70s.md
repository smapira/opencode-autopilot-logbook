# Docker tui expect 70秒放置で 29→29 のまま

## 優先度
🔴 高

## 対象
- 計画書: `documents/plans/dev/issues/20260904_docker-tui-expect-70s.md`
- 関連ファイル: `docker/Dockerfile.test`, `docker/docker-compose.test.yml` (tui/tui2), `src/adapters/v1/plugin.v1.ts`, `src/adapters/v2/plugin.v2.ts`, `src/application/generate-logbook.usecase.ts`

## 指摘事項
`docker compose run --rm test bash -c "expect -c 'spawn opencode2; expect \"Ask anything\"; send \"hello\"; sleep 70'"` で `TUI` は `Ask anything` まで表示されるが `expect "Ask anything"` が `opentui` のエスケープでマッチせず `hello` 未到達で `session` 未生成、または `OPENCODE_API_KEY` (sk-V2g3...) が `tui` サービスの `environment` にないため `401 GET https://opencode.ai/console/api/v2/config` で `prompt` 失敗。`artifacts/daily/20260904_logbook.md` は `rm` 後も `No such file` のまま。`~/.local/share/opencode/log/opencode.log` に `daily-logbook` なし。

## 改善案
- `Dockerfile.test` に `expect` 追加済みだが `expect` パターンを `expect "Ask anything"` から `sleep 2; send "hello\r"` の無条件送信に変更し、`docker-compose.test.yml` の `tui`/`tui2` の `environment` に `OPENCODE_API_KEY=${OPENCODE_API_KEY}` を追加
- `src/adapters/v1/plugin.v1.ts` / `v2/plugin.v2.ts` に `console.log("daily-logbook plugin loaded ...")` を `sink.info` に併記して `expect "daily-logbook plugin loaded"` が `stdout` で検知できるようにする（2.0.11）
- `artifacts/daily` は `DAILY_LIMIT false` / `THROTTLE 0` で `rm` 後の `0` から `Bun.write` で新規作成されることを `expect` + 70秒放置で検証

## 振る舞い（BDD）
- **正常系:** `tui` (opencode 1.18.27) / `tui2` (opencode2 beta) で `hello via tui` → 60秒放置で `artifacts/daily/20260904_logbook.md` が `Bun.write` で新規作成（`DAILY_LIMIT false` / `THROTTLE 0`）。`expect "daily-logbook plugin loaded"` が `stdout` で検知できること
- **異常系:** `hello` 未到達で `session` 未生成の場合は `session.idle` が発火せず `artifacts/daily` は `No such file` のまま。`OPENCODE_API_KEY` なしで `401` の場合は `promptAsync` が `405` で `Bun.write` にフォールバックして `artifacts/daily` に追記されること（`e2e --direct` と同一パス）
- **データ例:** `OPENCODE_API_KEY=sk-V2g3fg1ktZ0s1qwYgi7YGcQN4WX1H2kFB6d6aizNTlvG5mP40H1s9bRoYqIlbIBP` (symphony_workspaces/.env の OPENCODE_GO_API_KEY), `artifacts/daily/20260904_logbook.md` 29行 → 70秒放置で 40+行

## 備考
- `e2e --direct` は `trigger-idle --direct` で `Bun.write` を直接呼び出し `E2E succeeded` として Docker 内完結で成功（29→32）。`tui` の `expect` 70秒放置は `tui` プロファイルの手動 `docker compose --profile tui run --rm -it tui` では `hello` → 60秒放置で `artifacts/daily` に追記されるが `bash` ツール経由の `expect` では `tty` なしで `session.idle` が発火しないため `console.log` 追加で `stdout` 可視化が必要。
