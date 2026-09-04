# Docker tui 手動検証（profiles: ["tui"]）

## 優先度
🟡 中

## 対象
- 計画書: `documents/plans/dev/issues/20260904_docker-tui-manual.md`
- 関連ファイル: `docker/docker-compose.test.yml` (tui/tui2), `docker/Dockerfile.test`

## 指摘事項
`e2e --direct` は `29→32` で `E2E succeeded` として `Bun.write` の file-direct を Docker 内完結で担保済みだが、`tui` (opencode 1.18.27) / `tui2` (opencode2 beta) の手動 `docker compose --profile tui run --rm -it tui` → `hello` → 60秒放置は `expect` 自動化が `Ask anything` の `expect` マッチで詰まるため未検証。`bash` ツール経由の `expect` では `tty` なしで `session.idle` が発火しない。

## 改善案
- `docker-compose.test.yml` に `tui`/`tui2` サービス（`profiles: ["tui"]`, `tty: true`, `stdin_open: true`, `THROTTLE 0`/`DAILY_LIMIT false`）を追加済み。`2.0.11` の `console.log` 追加で `expect` の `stdout` 検知を可能にし、`e2e` と `tui` の両方を `bash` ツール経由で自動化
- 手動手順: `docker compose --profile tui run --rm -it tui` (v1) / `tui2` (v2) で TUI を対話起動 → `hello` 入力 → 60秒放置で `artifacts/daily` (`..:/app` マウントでホストと共有) に追記。`THROTTLE 0` / `DAILY_LIMIT false` で毎回発火

## 振る舞い（BDD）
- **正常系:** 手動 `tui` で `hello` → 60秒放置で `artifacts/daily/20260904_logbook.md` に追記。`expect` + 70秒放置で `artifacts/daily` に `Bun.write` で新規作成（`DAILY_LIMIT false`）
- **異常系:** `hello` 未到達で `session` 未生成の場合は `session.idle` が発火せず `artifacts/daily` は `No such file` のまま。`bash` ツール経由の `expect` では `tty` なしで `session.idle` が発火しない
- **データ例:** `docker compose --profile tui run --rm -it tui` → `hello via tui` → 60秒放置 → `artifacts/daily/20260904_logbook.md` 29行 → 40+行

## 備考
- `Dockerfile.test` に `expect`/`tmux` 追加済み。`tui`/`tui2` の `environment` に `OPENCODE_API_KEY` を追加予定。
