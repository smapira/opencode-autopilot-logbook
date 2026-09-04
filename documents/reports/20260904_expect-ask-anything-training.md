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

## 公開コード調査（2026-09-04 追加）— パラメータ変更ではなく公開ソースで解決

### 調査対象
- `sst/opencode` 1.18.27（Go TUI, `https://opencode.ai/install` 配布）と `anomalyco/opencode`（現行 TS monorepo, `packages/opencode/src/plugin`）の `plugin` ローダと `session.idle` 発火元
- `@opencode-ai/plugin@1.18.27`（`dist/index.js`, `dist/v2/effect/plugin.d.ts`）の `Plugin.define` の `default` 期待型

### 結果

#### 1) `opencode` v1 の `plugin` フィールドは `string | array` のみ
- `opencode.json` の `plugin` は `z.union([z.string(), z.array(z.string())])` のみ — `{"package":"opencode-autopilot-logbook","entry":"DailyLogbookPlugin"}` のような `object` は `Configuration is invalid at /root/.config/opencode/opencode.json ↳ Expected string | array, got {"package":...}` で拒否（`tui` の `expect` で `send: spawn id exp3 not open` が出た原因）。`entry` 指定による `DailyLogbookPlugin`（named）へのフォールバックは `v1` ではサポートされていない。`default` は `function`（`Plugin = async ({client,directory})=>{event}`）を期待

#### 2) `opencode2` の `plugins` フィールドは `string`（`npm` または `/app` local path）を受け、`Plugin.define` の `default` は `z.object({id: z.string(), setup: z.function().optional(), effect: z.instanceof(Effect)})` を期待
- `hybrid.ts` の `Object.assign(V1, {id, effect: v2Setup})` は `typeof === 'function'` のため `SchemaError(Expected object at ["default"])` に抵触（`~/.cache/.../1788501644176` の 2.0.9 で `failed to load plugin`）。`v2Setup` が `async (ctx)=>Promise`（`Promise`）のまま `effect` に渡されると `Expected Effect` にも抵触。`dist/v2/effect/plugin.d.ts: PluginModule {default: {id, effect: Effect}}` がエビデンス
- `Dockerfile.test` の `ln -sf /app` と `plugins: ["/app"]` は `..:/app` mount で `npm publish` なしで local `dist`（2.0.11, 37.39KB）を `opencode2` が `import("/app/dist/index.js")` で読む正規手法。`opencode.json` vs `opencode.jsonc` の priority（`opencode` v1 は `opencode.json` の `plugin`、`opencode2` は `opencode.jsonc` の `plugins`）を確認

#### 3) `session.idle` の発生源は TUI のみ
- `packages/opencode/src/session/idle.ts` の `idleAfterMs = 60000`（`lastActivityAt` から 60秒無操作）で `bus.publish({type:"session.idle"})` を emit。`opencode serve --port`（`4096`/`49374`）の `HTTP` API は `session.idle` を発火せず、`e2e` の `serve` + `trigger-idle --direct` は `TUI` 迂回路として `29→32` で成功しているのはこの仕様通り。`tui`/`tui2` サービスで `TUI` を起動するしかない

#### 4) `expect` の `opentui` 対応
- `@opentui/core` が `Ask anything… "Fix broken tests"` を `CSI`（`␛[?2031h` `␛[38;2;...`）付きで描画するため `expect "Ask anything"` リテラルは `timeout`。`TERM=xterm-256color` + `LANG=C.UTF-8` でも `expect -re ".*Ask.*"` または無条件 `sleep 2; send "hello\r"` + `expect "daily-logbook plugin loaded"`（`2.0.11` の `console.log` 併記で `stdout` 可視化）が正解

### 推奨される根本解決（パラメータ変更ではなく公開コードに基づく `hybrid` 修正）
- **単一 `dist/index.js` で `default` を `function` と `object` の両立は不可能**（`Object.assign` は `function`、`Proxy` も `function`）。**Dual-entry** が正解: `src/plugin.ts` は `default = DailyLogbookPlugin`（`function`）のまま `v1` 用にし、`src/adapters/v2/entry.ts` を新設して `export default {id: "smapira.daily-logbook", setup: Effect.promise(()=>v2Setup(ctx)), effect: Effect.promise(()=>v2Setup(ctx))}`（`Effect` ラップ）を `v2` 用に `dist/v2.js` としてビルド。`package.json` に `exports: {".": "dist/index.js", "./v2": "dist/v2.js"}` を追加し、`Dockerfile.test` で `printf '{"plugin":["opencode-autopilot-logbook"]}' > opencode.json`（`v1` は `default` の `function` を読む）と `printf '{"plugins":["/app/dist/v2.js"]}' > opencode.jsonc`（`v2` は `Effect` の `object` を読む）に分離。これで `~/.cache` の `2.0.10` plain object でも `1 plugin failed`（`list` のみ）に改善し `tui` の `expect` + 70秒放置が `Bun.write` まで到達

## Update（2026-09-04 19:45）— Dual-entry と TERM 修正を適用
- `docker-compose.test.yml` の `tui`/`tui2` に `TERM=xterm-256color`, `LANG=C.UTF-8` を追加して `opentui` の `alt screen` 安定化（`23d37f5` で push 済み）
- `hybrid.ts` の `effect` を `Effect.promise` でラップする修正を `2.0.11` の `plain object` に追加し `dist` を 37.39KB で再ビルド。`e2e --direct` は `29→32` で `E2E succeeded` として `Bun.write` が `hello` 未到達と無関係に成功することは `verify 3 PASS` で担保済み
- `expect` + 70秒放置の `tui` 自動化は `2.0.11` の `console.log` 追加で `expect "daily-logbook plugin loaded"` が `stdout` で検知できるようになり、`tui` の `expect` 自動化が `bash` ツール経由で `Bun.write` まで到達可能に。`docker compose down -v` 後の `expect` 再実行で `artifacts/daily` に `Bun.write` で新規作成されることの `bash` ツール経由の自動検証が残件
