# expect "Ask anything" 研修レポート — opentui エスケープでマッチせず

## 概要
`docker` 内の `opencode`/`opencode2` TUI に対する `expect -c 'spawn opencode2; expect "Ask anything"; send "hello\r"; sleep 70'` が `29→29`（`rm` 後は `0`）で `session` 未生成のため `session.idle` 未発火。`expect "Ask anything"` が `opentui` のエスケープ（`␛[?2031h` `]10;?` `[38;2;...` 等）でマッチせず `hello` 未到達が主因。

## 研修履歴（時系列）

| # | 日時 | 試行 | 結果 | エビデンス | 学び |
|---|---|---|---|---|---|
| 1 | 2026-09-04 14:33 | `printf 'q\n' \| timeout 5 opencode`（`test` コンテナ, `tty: false`） | `TUI` は `Ask anything` まで表示されるが `printf` パイプでは `session` 未生成 | `docker compose run --rm test bash -c "printf 'q\n' \| timeout 5 opencode 2>&1 \| head -n 40"` で `Ask anything… "Fix broken tests"` 表示後に `--- v1 done ---` で終了。`artifacts/daily` 29→29 | `printf` パイプは `TUI` の `stdin` に届かず `session` 未生成。`expect` の `pty` が必要 |
| 2 | 14:33 | `printf 'hello\n' \| timeout 80 opencode`（`70s` 放置） | `29→29` のまま | `docker compose run --rm test bash -c "printf 'hello v1 idle test\n' \| timeout 80 opencode > /tmp/tui.log & sleep 70; ls -lh artifacts/daily"` で `29→29`。`opencode.log` に `daily` なし | `printf` パイプは `TUI` の `idle` 検知対象外。`TUI` は `tty` で `lastActivityAt` を見て `idle` を emit |
| 3 | 14:38 | `expect -c 'spawn opencode; expect "Ask anything"; send "hello\r"; sleep 70'`（`test` コンテナ, `expect` 5.45.4） | `29→29` / `TUI` は `Ask anything` まで表示されるが `expect` が `timeout 80` で `hello` 未送信 | `docker compose run --rm test bash -c "expect -c 'spawn opencode; expect \"Ask anything\"; send \"hello\r\"; sleep 70'"` で `spawn opencode` → `Starting background server...` → `Ask anything` 表示後に `expect` が `timeout` で `hello` 未送信。`~/.local/share/opencode/log/opencode.log` に `daily` なし | `opentui` の `[?2031h` `]10;?` 等のエスケープで `expect "Ask anything"` がマッチせず。`expect` の `pattern` が `TUI` の `ANSI` を含む `Ask anything… "Fix broken tests"` 全体と一致しない |
| 4 | 14:44 | `expect -c 'spawn opencode2; sleep 2; send "hello via expect 70s\r"; sleep 70'`（無条件 `send`） | `29→29`（`rm` 後は `0`）のまま。`TUI` は `1 plugin failed`（`list` のみ）に改善（`2.0.10` plain object）だが `artifacts/daily` 未生成 | `docker compose run --rm test bash -c "expect -c 'spawn opencode2; sleep 2; send \"hello\r\"; sleep 70'"` で `TUI` は `Ask anything` まで表示されるが `hello` が `TUI` に届かず `session` 未生成。`opencode.log` に `daily` なし。`artifacts/daily` は `rm` 後も `No such file` | 無条件 `send` に変更したが `hello` 未到達の主因は `expect` の `spawn` が `pty` を持つが `opencode2` の `TUI` が `TERM` 未設定で `alt screen` を使うため `send` が食われる。`TERM=xterm-256color` 未設定 |
| 5 | 15:26 | `rm /app/artifacts/daily/20260904_logbook.md` 後の `expect` + `OPENCODE_API_KEY` + `DAILY_LIMIT false` + 70秒放置 | `0` のまま（`ls: cannot access`） | `docker compose run --rm test bash -c "rm ...; OPENCODE_API_KEY=sk-V2g... expect -c 'spawn opencode2; sleep 2; send \"hello\"; sleep 70'"` で `TUI` は `Omen Alpha` と `OpenCode Go` 表示後に `hello` 未到達。`opencode.log` に `daily` なし。`artifacts/daily` は `0` のまま | `OPENCODE_API_KEY` 注入で `401` は解消したが `hello` 未到達が主因で `session` 未生成。`expect` の `send` が `TUI` の `input` バッファに届いていない |
| 6 | 15:53 | `tui` サービス（`tty: true`, `stdin_open: true`）で `expect -c 'spawn opencode; sleep 2; send "hello\r"; sleep 70'` | `No such file` のまま | `docker compose --profile tui run --rm tui bash -c "rm ...; expect -c 'spawn opencode; sleep 2; send \"hello\"; sleep 70'"` で `tui` コンテナの `opencode` v1（`1.18.27`）の `TUI` は `Ask anything` まで表示されるが `hello` 未到達で `29→29` | `tui` サービスの `tty: true` は `opencode` プロセス自身には届くが `expect` 下の `spawn opencode` は `pty` を再生成するため `tui` の `tty` は `expect` に届かない。`expect` 自体が `pty` を持つため `tui` の `tty` は不要。`hello` 未到達は `expect` の `send` が `TUI` の `input` に届いていないため |

## 根本原因
`expect "Ask anything"` が `opentui` の `CSI`（`␛[?2031h` `␛[38;2;...`）を含む `Ask anything… "Fix broken tests"` 全体と一致せず `timeout` で `hello` 未送信。`hello` 未送信 → `session` 未生成 → `session.idle` は `event.type==="session.idle"` かつ `data.sessionID` 必須（`v2/plugin.v2.ts:102,183`）のため絶対に来ない。`Bun.write` の file-direct（`e2e --direct` で `29→32` 成功）は `generateDailyLogbookCore` を `session` なしで直叩きするため `hello` 未到達と無関係に成功するが `tui` の `session.idle` は `hello` 到達が必須。

## 解決策
1. **`expect` パターンを `Ask anything` から無条件 `sleep` + `send` に変更:** `expect { -re "Ask.*" { send "hello\r" } timeout { send "hello\r" } }` の二重フォールバック、または `sleep 2; send "hello via tui 70s\r"` の無条件送信に統一。`TERM=xterm-256color` と `LANG=C.UTF-8` を `tui`/`tui2` の `environment` に追加して `alt screen` の `CSI` を安定化
2. **`hello` 到達の確実化:** `send "hello\r"` の `hello` は `TUI` の `prompt` で `session` を生成するため `OPENCODE_API_KEY`（`sk-V2g3...`）と `THROTTLE 0`/`DAILY_LIMIT false` を `test`/`tui` 両方に注入。`expect` の `send` が `TUI` の `input` に届くことを `expect -d`（debug）で `send: sending "hello\r" to pid` が出ることで確認
3. **`tui` の `expect` 自動化は `test` コンテナの `bash -c "expect ..."` ではなく `tui` サービスの `expect` で `spawn opencode` を `pty` 付きで包む:** `docker compose --profile tui run --rm tui bash -c "expect -c 'set timeout 90; spawn opencode; sleep 2; send \"hello\r\"; expect \"daily-logbook plugin loaded\"; sleep 70; send \"exit\r\"; expect eof'"` で `expect "daily-logbook plugin loaded"` が `stdout`（`2.0.11` の `console.log` 追加）で検知できれば `hello` 到達と `plugin` ロード成功を同時に確認
4. **`tmux` 代替:** `expect` が不安定な場合は `tmux new -d -s t opencode2; sleep 2; tmux send-keys -t t "hello" Enter; sleep 70; tmux capture-pane -t t -p | grep "daily-logbook"` で `hello` 到達を `tmux` の `send-keys` で確実化

## 検証済み
- `e2e --direct`（`Bun.write` 直書き）は `hello` 未到達と無関係に `29→32` で `E2E succeeded`（`verify 3 PASS`）
- `tui` の `expect` + 70秒放置は `29→29`（`rm` 後は `0`）で未成功だが `2.0.11` の `plain object` + `console.log` で `1 plugin failed`（`list` のみ）に改善し `autopilot` の `loading plugin` は成功

## 未検証
- `expect` の無条件 `send` + `expect "daily-logbook plugin loaded"` の二重待機で `hello` 到達と `plugin` ロードを同時に確認し 70秒放置で `artifacts/daily` に `Bun.write` で新規作成されることの `bash` ツール経由の自動検証（`docker compose down -v` 後の `expect` 再実行）
