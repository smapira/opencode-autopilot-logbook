# Docker opencode v1 serve の Database is not empty and has no session table

## 優先度
🟡 中

## 対象
- 計画書: `documents/plans/dev/issues/20260904_docker-db-separation.md`
- 関連ファイル: `docker/docker-compose.test.yml` (opencode-data ボリューム), `docker/Dockerfile.test`

## 指摘事項
`docker compose run --rm test bash -c "opencode serve --port 4096 > /tmp/serve1.log"` で `serve1.log` に `Error: Database is not empty and has no session table`。`test` / `tui` / `tui2` で `opencode-data` ボリューム（`~/.local/share/opencode/opencode.db`）を共用し `opencode` v1 (1.18.27) と `opencode2` (beta-19059) で `opencode.db` のスキーマが衝突。`opencode2` の `beta` 形式で作成された `opencode.db` を `opencode` v1 の `serve` が `session` テーブルなしで読み込んで起動失敗。

## 改善案
- `docker-compose.test.yml` の `opencode-data` を `opencode-data-v1` と `opencode-data-v2` に分離するか、`tui` (v1) と `tui2` (v2) で `XDG_DATA_HOME=/tmp/opencode-v1` / `/tmp/opencode-v2` に分けて `DB` を分離
- `Dockerfile.test` の `opencode --version` / `opencode2 --version` は両方確認済み（`1.18.27` / `0.0.0-beta-19059`）のため `DB` 分離で `serve` の `Database is not empty` は解消。`test` サービスの `bun test` は `DB` を使わないため影響なし

## 振る舞い（BDD）
- **正常系:** `opencode serve --port 4096` (v1) と `opencode2 serve --port 49374` (v2) が同時に `server listening` すること。`ls ~/.local/share/opencode/opencode.db` で `session` テーブルが存在すること
- **異常系:** `opencode-data` を共用したまま `opencode` v1 の `serve` を起動すると `Database is not empty and has no session table` が出ること。`docker compose down -v` で `opencode-data` ボリュームを削除すると `serve` が再作成されて `server listening` になること
- **データ例:** `opencode-data` ボリューム at `~/.local/share/opencode/opencode.db` (v2 形式), `opencode serve --port 4096` → `Error: Database is not empty...`, `opencode2 serve --port 49374` → `server listening`

## 備考
- `Dockerfile.test` の `opencode` v1 は `curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.27` で取得し `/root/.opencode/bin/opencode` → `/usr/local/bin/opencode` にリンク。`opencode2` は `npm i -g @opencode-ai/cli@beta` で `/usr/local/bin/opencode2`。
