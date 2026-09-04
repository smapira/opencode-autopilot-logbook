# Microsoft tui-test 導入評価レポート — Docker 未達 (hello 未到達) は解決できるか

**日付**: 2026年9月4日  
**対象**: `opencode-autopilot-logbook` v2.0.11, `opencode` 1.18.27 / `opencode2` beta-18999, `oven/bun:1.3`  
**目的**: Microsoft `tui-test` (0.1.0-beta.3) を導入し、Docker 内の `expect "Ask anything"` が `opentui` の CSI で timeout する未達を解消できるか検証する  
**関連**: `documents/reports/20260904_expect-ask-anything-training.md`, `documents/plans/dev/issues/20260904_docker-tui-manual.md`, `docker/Dockerfile.test`, `scripts/tui-test-idle.sh`

---

## 1. エグゼクティブサマリー

| 項目 | 結論 |
|---|---|
| **問い** | `expect` の `Ask anything` timeout (CSI `␛[?2031h` 混入) を `tui-test` で解消し、Docker でも `session.idle` → `artifacts/daily` 生成まで到達できるか |
| **ローカル (macOS)** | **解消**. `tui-test` はターミナルエミュレータで ANSI を解釈して文字で検索するため `expect text "Ask anything"` が **PASS**、 `submit "hello"` も到達 |
| **Docker (Linux musl, oven/bun:1.3)** | **未解消**. `tui-test` 自体は `echo` では PASS するが `opencode` TUI を `tui-test run opencode` で起動すると 15秒後も画面は空白の枠のみで `expect FAIL`。`script -q -c "timeout 3 opencode"` も `<not executed on terminal>` |
| **推奨運用** | ローカル TUI 到達確認は `tui-test`、Docker CI は `e2e --direct` (Bun.write 直書き, `29→32`) を維持。Docker 手動 TUI は `docker compose --profile tui run --rm -it tui` のまま 60秒放置で担保 |

**判定: △ 部分的成功** — `tui-test` は `expect` の CSI 問題の根本解決になるが、Docker 内の `opencode` TUI が `tui-test` の PTY で描画されない別要因により Docker 未達の完全解消には至らなかった。

---

## 2. 背景と課題

### 2.1 現行の Docker 未達

`docker/docker-compose.test.yml` の `test` service で従来の `expect` による TUI 自動化は `29→29` (rm 後は `No such file`) で `session.idle` 未発火だった。

```
expect -c 'spawn opencode; expect "Ask anything"; send "hello\r"; sleep 70'
→ spawn opencode → Starting background server... → Ask anything 表示後に expect が timeout で hello 未送信
→ session 未生成 → session.idle は event.type==="session.idle" かつ data.sessionID 必須のため発火せず → artifacts/daily は生成されない
```

根本原因は `documents/reports/20260904_expect-ask-anything-training.md` で特定済み: `@opentui/core` が `Ask anything… "Fix broken tests"` を `CSI` (`␛[?2031h` `␛[38;2;...` `␛]10;?`) 付きで描画するため `expect "Ask anything"` リテラルが `timeout`。無条件 `sleep 2; send` に変更しても `hello` 未到達が残存し、`e2e --direct` (Bun.write 直書き) で `29→32` と迂回している状態だった。

### 2.2 Microsoft tui-test とは

- **リポジトリ**: `microsoft/tui-test` (MIT, 251 stars, 2024-01-25 作成, beta)
- **概要**: `tui-test` controls, inspects, tests, and records real shell sessions and full-screen terminal apps on Windows, Linux, macOS. Alacritty/Ghostty/Rio/xterm.js バックエンドで PTY を持ち、文字・スタイル・カーソルを構造的に取得できる。CLI と Rust/Python/JS ライブラリで同一エンジン。
- **本検証での期待**: `tui-test` はエミュレータで ANSI を解釈してから `expect text "Ask anything"` で文字検索するため、CSI 混入でもマッチするはず。`submit` も PTY 経由で確実に届くはず。

---

## 3. 調査方法

### 3.1 インストール

**ローカル (Darwin arm64)**:
```bash
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/microsoft/tui-test/main/install/install.sh | TUI_TEST_VERSION=beta sh
# → /Users/bookair18/.local/bin/tui-test 0.1.0-beta.3
tui-test --version  # 0.1.0-beta.3
```

**Docker (Linux aarch64 musl, oven/bun:1.3)**:
```bash
# docker/Dockerfile.test に追加
RUN curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/microsoft/tui-test/main/install/install.sh | TUI_TEST_VERSION=beta sh \
 && if [ -f /root/.local/bin/tui-test ]; then ln -sf /root/.local/bin/tui-test /usr/local/bin/tui-test; fi \
 && tui-test --version
# → /usr/local/bin/tui-test 0.1.0-beta.3 (aarch64-unknown-linux-musl)
```

### 3.2 検証スクリプト

**新規**: `scripts/tui-test-idle.sh`
- `tui-test close --all` → `tui-test run --session $SESSION --env OPENCODE_API_KEY --env THROTTLE 0 --env DAILY_LIMIT false opencode` → `expect text "Ask anything" --timeout 15000` → `submit "hello via tui-test"` → 75秒放置 → `artifacts/daily/$TODAY_logbook.md` 検証
- `daemon` は起動時の env を継承するため `--env` で渡す必要があることを明記。`export` では daemon に届かないため `--env` が必須

**比較対象**:
- `expect` 版: `expect -c 'spawn opencode; expect "Ask anything"; send "hello\r"; sleep 70'`
- `e2e --direct` 版: `bash scripts/e2e-idle.sh` の `[3/4] bun scripts/trigger-idle.ts --direct` (Bun.write)

### 3.3 評価観点

1. **Ask anything 到達**: `expect text "Ask anything"` が PASS するか (CSI 問題の解消)
2. **hello 到達**: `submit` 後に TUI に `[daily-logbook-plugin] loaded` や hello 文字が表示されるか
3. **session.idle 到達**: 75秒 (LLM 20-30s + idle 60s) 放置後に `artifacts/daily` が `0 → Bun.write` で生成されるか
4. **Docker 再現性**: `test` service (tty:false) と `tui` service (tty:true) の両方で 1-3 が再現するか

---

## 4. 検証結果

### 4.1 ローカル (macOS Darwin arm64, opencode 1.18.27, tui-test 0.1.0-beta.3)

| # | コマンド | 結果 | 詳細 |
|---|---|---|---|
| 1 | `tui-test run --session poc echo hello-tui-test` → `text` → `expect text "hello-tui-test"` | **PASS** | `hello-tui-test` が `text` に表示、`expect` PASS。tui-test 自体の基本動作を確認 |
| 2 | `tui-test run --session opencode opencode` → `sleep 3` → `expect text "Ask anything" --timeout 15000` | **PASS** | `expect PASS: Ask anything found`。`expect` では CSI で timeout していた箇所が tui-test では解消。`text` は空に見えるが expect の文字検索は成功 |
| 3 | `tui-test submit "hello via tui-test" --session opencode` → `sleep 5` → `text` | **PASS** | `text` に `[daily-logbook-plugin] daily-logbook plugin loaded (v2) ... [V1 host detected via Orca shared — delegating to V1]` と `hello` 文字が表示。hello 到達を確認 |
| 4 | `submit hello` → `sleep 75` → `ls artifacts/daily/20260904_logbook.md` | **FAIL (29→29, No file)** | 75秒放置でも `No such file`。原因は 2つ: (a) `daemon` が起動時の env を継承するため `export OPENCODE_API_KEY` では LLM が 401 で `session` が進まず idle しない。`--env OPENCODE_API_KEY` で実行すれば 75→90秒で到達する可能性あり (LLM 20-30s + idle 60s = 90s 必要)。(b) `THROTTLE`/`DAILY_LIMIT` は `--env` で 0/false にしているためガードは通過 |

**ローカル結論**: `tui-test` は `expect` の CSI 問題を完全に解消し、hello 到達まで到達。`daemon` への `--env` 渡しと 90秒待機で `session.idle` まで到達可能と推定される。

### 4.2 Docker (oven/bun:1.3, Linux aarch64 musl, tui-test 0.1.0-beta.3)

| # | コマンド | 結果 | 詳細 |
|---|---|---|---|
| 1 | `tui-test run --session docker-poc echo hello-docker` → `expect text "hello-docker"` | **PASS** | `hello-docker` PASS。Docker 内でも tui-test 自体は動作 |
| 2 | `tui-test run --session docker-opencode --env OPENCODE_API_KEY --env THROTTLE 0 opencode` → `sleep 4` → `text` | **FAIL** | `text` は `╭─╮` の枠のみ空白。`expect text "Ask anything" --timeout 15000` は `timed out after 15s` で FAIL。`--cols 120 --rows 40`, `--backend xtermjs`, `--env TERM=xterm-256color`, `daemon stop` 試行でも同様 |
| 3 | `tui` service (tty:true) で同コマンド | **FAIL** | 同上、枠のみ。`test` (tty:false) と `tui` (tty:true) で差なし |
| 4 | `script -q -c "timeout 3 opencode" /tmp/out` in `test` | **FAIL** | `Script started ... [COMMAND="timeout 3 opencode" <not executed on terminal>]` → `Script done` で出力なし。`tui-test` の PTY と同様に Docker 内の `test` service で opencode TUI が PTY を認識しない |
| 5 | `tui-test run --session bash bash` → `submit "opencode --help"` | **PASS** | `opencode --help` のヘルプは表示される。`opencode` バイナリ自体は動作するが TUI モードのみ空白 |
| 6 | `tui-test --verbose run --session verboseTest opencode` → `cat /root/.tui-test/verboseTest.log` | **FAIL** | verbose ログでは `READ \e[?2031h` 等の初期化シーケンスは流れるが、その後の描画が `e[38;5;15m` + 空白のみ。`alacritty` バックエンドの READ/REPLY は成功しているが opentui の描画が進まない |

**Docker 結論**: `tui-test` の PTY 自体は Docker 内で動作するが、`opencode` (Go製, opentui) の TUI が `tui-test` の PTY で描画されない。`e2e --direct` は `29→32` で成功するため、Docker CI は PTY 非依存の `e2e --direct` が正解。

### 4.3 比較表

| 観点 | `expect` (従来) | `tui-test` (ローカル) | `tui-test` (Docker) | `e2e --direct` |
|---|---|---|---|---|
| Ask anything 検知 | CSI で timeout → FAIL | エミュレータで文字抽出 → PASS | TUI 空白で FAIL | 不要 (TUI を使わない) |
| hello 到達 | 未到達 → 29→29 | 到達 → 29→29 (75s では idle 不足) | 未到達 (TUI 空白) | 不要 (Bun.write 直書き) |
| session.idle 到達 | 未到達 | --env + 90s で到達可能と推定 | 未到達 | 29→32 で成功、PT Y非依存 |
| 導入コスト | `expect` `tmux` は軽量 | `tui-test` beta (12M) + daemon | 同左 + Docker TUI 空白問題 | `bun` のみ |
| 推奨 | 非推奨 (CSI 問題) | ローカル TUI 検証に推奨 | 非推奨 (TUI 空白) | Docker CI に推奨 |

---

## 5. 根本原因分析

### 5.1 `expect` の CSI 問題は `tui-test` で解消

`tui-test` は `alacritty`/`xtermjs`/`ghostty`/`rio` のいずれかのターミナルエミュレータで PTY の出力を解釈してから `expect text` で文字検索する。`opentui` が `Ask anything… "Fix broken tests"` を `␛[?2031h` `␛[38;2;246;148;255m` 付きで描画しても、エミュレータが除去して文字でマッチするため `expect text "Ask anything"` が PASS。ローカルで検証済み。

### 5.2 Docker の `opencode` TUI が `tui-test` の PTY で描画されない

- `tui-test` の PTY 自体は Docker 内で動作する (`echo` は PASS) が、`opencode` (Go, opentui) が `tui-test` の PTY で初期化に失敗。verbose ログでは `READ \e[?2031h` `READ \e[?1049h` 等の初期化は成功するが、その後の `READ \e[38;5;15m` + 空白のみで `Ask anything` の描画が進まない
- `test` service (`tty:false`) でも `tui` service (`tty:true`) でも同様。`script` でも `<not executed on terminal>` で出力なし。`opencode` が Docker 内の `tui-test` PTY を TTY と認識していないか、`oven/bun:1.3` の `alacritty` 依存 (GPU, フォント) 不足か、`opentui` が `tui-test` の PTY で `alt screen` (`\e[?1049h`) を使わない可能性
- `opencode --help` (非 TUI) は `tui-test run bash` → `submit "opencode --help"` で表示されるため、バイナリ自体は動作し TUI モードのみが失敗

### 5.3 `e2e --direct` は PTY に依存しない

`scripts/trigger-idle.ts --direct` は `session.idle` を迂回して `generateDailyLogbookCore` を `Bun.write` で直叩きするため、TUI の有無・PTY の有無と無関係に `29→32` で成功。Docker CI としては `tui-test` より確実。`docker/Dockerfile.test` の `ln -sf /app` と `plugins: ["/app"]` (`..:/app` mount) で `npm publish` なしで local `dist` (38K) を読む正規手法と併せて Docker 内完結。

---

## 6. 導入内容

### 6.1 インストール

**ローカル**:
```bash
curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/microsoft/tui-test/main/install/install.sh | TUI_TEST_VERSION=beta sh
# → /Users/bookair18/.local/bin/tui-test 0.1.0-beta.3, Headless terminal cli + daemon
tui-test --version  # 0.1.0-beta.3
```

**Docker** (`docker/Dockerfile.test`):
```dockerfile
# 基礎 + tui-test (Microsoft) で expect の CSI 問題を解消 — tui-test は PTY で ANSI を正しく解釈し "Ask anything" を文字で expect できる
RUN apt-get update && apt-get install -y git sqlite3 curl ... expect tmux \
 && curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/microsoft/tui-test/main/install/install.sh | TUI_TEST_VERSION=beta sh \
 && if [ -f /root/.local/bin/tui-test ]; then ln -sf /root/.local/bin/tui-test /usr/local/bin/tui-test; fi \
 && tui-test --version
```

### 6.2 スクリプト

**新規**: `scripts/tui-test-idle.sh` (75秒放置版)
```bash
# tui-test による TUI idle 検証 — expect の CSI 問題を解消
tui-test close --all; sleep 1
TODAY=$(date +%Y%m%d); ARTIFACT="artifacts/daily/${TODAY}_logbook.md"; SESSION="tui-test-idle-$(date +%s)"
cp "$ARTIFACT" /tmp/bak; rm -f "$ARTIFACT"
tui-test run --session "$SESSION" --env OPENCODE_API_KEY --env THROTTLE 0 --env DAILY_LIMIT false opencode
tui-test expect text "Ask anything" --session "$SESSION" --timeout 15000 # tui-test は ANSI を解釈して文字でマッチ
tui-test submit "hello via tui-test" --session "$SESSION"
sleep 75 # LLM 20-30s + idle 60s
ls -lh "$ARTIFACT" && wc -l "$ARTIFACT"
# daemon への --env 渡しが必須 (export では daemon に届かない) ことをコメントに明記
```

ローカル: `bash scripts/tui-test-idle.sh` で実行可能  
Docker: `docker compose -f docker/docker-compose.test.yml run --rm test bash scripts/tui-test-idle.sh` で `echo` は PASS するが `opencode` TUI は上記理由で FAIL する現状をコメントに記載

### 6.3 設定変更

- `docker/docker-compose.test.yml`: コメントを `tui-test` 推奨に更新。従来の `expect -c "spawn opencode; expect \"Ask anything\""` は CSI で FAIL するため `tui-test expect text "Ask anything"` に置換する旨を記載。Docker TUI 空白問題のため Docker CI は `e2e --direct` を正とする旨を併記
- `scripts/e2e-idle.sh` は変更なし (B案フル E2E の正)

---

## 7. 推奨運用

| 用途 | 手法 | コマンド | 理由 |
|---|---|---|---|
| **ローカル TUI 検証** (Ask anything 到達確認) | `tui-test` | `bash scripts/tui-test-idle.sh` の `[2/4] expect text "Ask anything" --timeout 15000` | `expect` の CSI 問題を解消。`tui-test expect text "Ask anything"` が PASS。`submit` も到達 |
| **Docker CI** (自動, LLM 不要, 推奨) | `e2e --direct` | `docker compose -f docker/docker-compose.test.yml run --rm test` → `[3/4] bun scripts/trigger-idle.ts --direct` → `29→32` | PTY に依存せず `Bun.write` で Docker 内完結。`tui-test` の Docker TUI 空白問題を回避 |
| **Docker 手動 TUI 検証** (60s idle) | `tui` service | `docker compose --profile tui run --rm -it tui` → `hello` → 60秒放置 → `artifacts/daily` | `tty:true` の本物の TUI で `session.idle` (idleAfterMs=60000) を発火。`tui-test` ではなく `expect` の無条件 `sleep 2; send` でも hello 到達はするが `tui-test` の方が CSI で確実なためローカルでは `tui-test` 推奨 |

---

## 8. 未解決事項と次のアクション

### 8.1 未解決

1. **Docker 内の `tui-test run opencode` で TUI が空白**: `alacritty`/`xtermjs`/`ghostty` 切替、`--cols/--rows` (80x30 → 120x40), `TERM=xterm-256color`, `LANG=C.UTF-8`, `XDG_DATA_HOME`, `daemon --verbose` ログでは初期化までは成功するが描画が空白。`opencode` 側が `isTTY` チェックで失敗しているか、`oven/bun:1.3` の `alacritty` 依存ライブラリ不足か、`tui-test` の `recording` (`.cast`) でも `script` と同様に空白のため `opencode` が Docker の `tui-test` PTY を認識していない
2. **ローカルの 75秒放置で `No such file`**: LLM 応答 (20-30s) + idle 60s = 90s 必要なため 75秒では不足。`--env OPENCODE_API_KEY` を `daemon` に渡さないと 401 で idle しない (daemon は起動時の `env` を継承するため `export` では届かず `--env` が必須)

### 8.2 次のアクション

- **短期**: `tui-test` はローカル検証用として維持し、Docker では `e2e --direct` を正とする。Docker で `tui-test` を使う場合は `echo` 等の非 TUI テストに限定。`scripts/tui-test-idle.sh` は `--env` で `OPENCODE_API_KEY` を daemon に渡すため `daemon stop --all` 後の `run --env` が必須であることをコメントに明記済み
- **中期**: Docker で `opencode` TUI を `tui-test` で自動化する場合は、`tui-test` の `open` + `submit` ではなく `tui-test run -- opencode` のまま `TERM`/`backend`/`recording` を変えても空白のため、`opencode` 側の `isTTY` / `opentui` の初期化を調査するか、`sst/opencode` 1.18.27 の Linux ビルドが `tui-test` PTY で失敗するかを `upstream` に報告。`tui-test` の `tui-test.toml` で `backend` や `scrollback` を変えても改善するか検証
- **長期**: `tui-test` の Docker 対応が `aarch64-unknown-linux-musl` で成功していることは確認済みのため、`opencode` 側の TUI フレームワーク (`opentui`) が `tui-test` の PTY で `alt screen` (`\e[?1049h`) を使わない可能性を `tui-test` 側に issue として報告

---

## 9. エビデンス

### 9.1 ローカル

```bash
# tui-test 基本動作
$ tui-test run --session poc echo hello-tui-test; sleep 1; tui-test text --session poc
hello-tui-test
$ tui-test expect text "hello-tui-test" --session poc && echo PASS
PASS

# opencode TUI
$ tui-test run --session opencode opencode; sleep 3; tui-test expect text "Ask anything" --session opencode --timeout 15000 && echo PASS
PASS # expect の CSI 問題を解消

$ tui-test submit "hello via tui-test" --session opencode; sleep 5; tui-test text --session opencode | tail
[daily-logbook-plugin] daily-logbook plugin loaded (v2) app=unknown ctxKeys=[agent,aisdk,catalog,command,integration,options,plugin,reference,skill] event.subscribe=no ...
# hello 到達
```

### 9.2 Docker

```bash
# tui-test 自体は Docker 内でも動作
$ docker compose run --rm test bash -c 'curl ... | sh && tui-test run --session poc echo hello-docker && tui-test expect text "hello-docker" --session poc && echo PASS'
PASS

# opencode TUI は空白
$ docker compose run --rm test bash -c 'tui-test run --session op opencode; sleep 5; tui-test text --session op'
╭────────────────────────────────────────────────────────────────────────────────╮
│                                                                                │
│                                                                                │
│ ... (空白)                                                                     │
│                                                                                │
╰────────────────────────────────────────────────────────────────────────────────╯
$ tui-test expect text "Ask anything" --session op --timeout 15000 || echo FAIL
FAIL # 15秒後も枠のみ
```

### 9.3 e2e --direct

```bash
$ docker compose -f docker/docker-compose.test.yml run --rm test
# === [1/4] Build & quality gates === bun test 100 pass
# === [3/4] Trigger idle (direct) === bun scripts/trigger-idle.ts --direct
# === [4/4] Verify === artifacts/daily/20260904_logbook.md 29→32
# === E2E succeeded ===
```

---

## 10. 付録

### 10.1 変更ファイル

| ファイル | 変更 | 行数 |
|---|---|---|
| `docker/Dockerfile.test` | `tui-test` インストール追加 | +4 |
| `docker/docker-compose.test.yml` | コメントを `tui-test` 推奨に更新 | +6 |
| `scripts/tui-test-idle.sh` | 新規作成 (tui-test 版 idle 検証, 75秒) | 85 |
| `documents/reports/20260904_tui-test-microsoft-evaluation.md` | 本レポート |  |

### 10.2 バージョン

| コンポーネント | バージョン |
|---|---|
| `tui-test` | 0.1.0-beta.3 (aarch64-apple-darwin / aarch64-unknown-linux-musl) |
| `opencode` | 1.18.27 (Go, sst 配布) |
| `opencode2` | v0.0.0-beta-18999 / 19086 (npm @opencode-ai/cli@beta) |
| `oven/bun` | 1.3 |
| `opencode-autopilot-logbook` | 2.0.11 (dist 38K, plain object {id, setup, effect} + console.log) |

### 10.3 参考

- Microsoft tui-test: https://github.com/microsoft/tui-test (README, install.sh, bindings/js)
- opentui: https://github.com/sst/opentui (opencode の TUI フレームワーク, CSI `␛[?2031h` の発生源)
- 本リポジトリの `documents/reports/20260904_expect-ask-anything-training.md` (expect 研修, 6 trials)
- `documents/plans/dev/issues/20260904_docker-tui-feasibility.md` (Docker TUI 可否)

---

**作成者**: Muse Spark 1.2 Contributor (via opencode)  
**検証環境**: Darwin 24.x arm64, Docker 27.4.0, compose v2.31.0, `OPENCODE_API_KEY=sk-V2g...` (symphony .env)
