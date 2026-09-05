# OpenCode Ver1 + plugin 1.1.1 日報未生成 調査手順書 (開発者向け)

## 優先度
🔴 高

## 対象
- 症状: OpenCode Ver1 (1.18.27) + `opencode-autopilot-logbook@1.1.1` で 60秒 idle 後も `artifacts/daily/YYYYMMDD_logbook.md` が生成されない
- 計画書: `documents/plans/dev/issues/20260905_opencode-v1-daily-logbook-investigation.md` (本ファイル)
- 関連: `daily-logbook.ts` (1.1.1 monolith, 81 tests), `src/domain/*`, `src/adapters/v1/*` ではない (1.1.1 は旧構成), `package.json 1.1.1`, `dist/index.js`
- 環境: `opencode 1.18.27`, `nodenv 24.13.1`, `~/.config/opencode/opencode.json: {"plugin":["opencode-autopilot-logbook"]}`, `~/.cache/opencode/packages/*`

## 指摘事項 / 背景
Ver1 ホストは `client` (SDK) と `event` (session.idle) を `Plugin` 引数で受け取る。1.1.1 は monolith 実装だが、`session.idle` は TUI のみ (`packages/opencode/src/session/idle.ts` `idleAfterMs=60000` `bus.publish`) で `serve` 経由では発火しない。Docker や Orca `opencode2` 環境で `expect "Ask anything"` が CSI (`\e[?2031h`) でタイムアウトし `hello` に到達できないと `session` 自体が生成されず `session.idle` も飛ばない。今回 `main@67a9222` は `1.2.1` に巻き戻したが、ローカル global は `1.1.1` に留置 (研修用) のため、Ver1 での再現確認が必要。

## 調査方法

### Step 1: 環境の確定 (5分)

```bash
opencode --version                          # 1.18.27 を確認
npm list -g opencode-autopilot-logbook --depth=0
cat ~/.config/opencode/opencode.json
cat ~/.cache/opencode/packages/opencode-autopilot-logbook/package.json  # 1.1.1 依存か
ls -la ~/.cache/opencode/packages/opencode-autopilot-logbook*
shasum dist/index.js; cat package.json | grep version
```

期待: global と cache と local repo のバージョンが一致 (1.1.1) していること。不一致なら `rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* && opencode plugin opencode-autopilot-logbook@1.1.1 -g --force` で揃える。

### Step 2: プラグイン読込ログの確認 (5分)

```bash
# Ver1 は opencode.log に診断ログを出す
grep -r "daily-logbook plugin loaded" ~/.cache/opencode/logs/ 2>/dev/null | tail
grep -r "daily-logbook" ~/.cache/opencode/logs/ 2>/dev/null | tail -n 50
# 起動直後のログを確認
tail -200 ~/.cache/opencode/logs/* 2>/dev/null | grep -i "daily\|ERROR\|CRITICAL" | tail -n 50
```

期待: `daily-logbook plugin loaded (v1)` が 1 回出る。出ない → `opencode.json` の `plugin` キー typo、または `dist/index.js` が `~/.cache` に解決されていない。

### Step 3: session.idle 到達確認 (10分)

```bash
# 手動 TUI で idle を待つ
rm -f artifacts/daily/$(date +%Y%m%d)_logbook.md
opencode  # 起動後、何もせず 75秒待機
# 別ターミナルで
ls -lh artifacts/daily/
cat artifacts/daily/$(date +%Y%m%d)_logbook.md 2>&1 | head -n 50
# DB に session が作られたか
sqlite3 ~/.local/share/opencode/opencode.db "select id, substr(title,1,30), datetime(time_created/1000,'unixepoch','localtime') from session order by time_created desc limit 5;"
```

期待: 75秒後に `artifacts/daily/YYYYMMDD_logbook.md` が 1 ファイル増える。増えない → `session` 自体が未生成 (次の Step 4 へ)。

### Step 4: TUI 到達 (hello) 問題の切り分け (10分)

Ver1 でも CSI 問題は発生しうる。`expect "Ask anything"` 相当の手動確認:

```bash
# tui-test があれば
tui-test run -- opencode 2>&1 | head
sleep 3; tui-test text 2>&1 | head -n 20
tui-test expect --timeout 15000 "Ask anything" 2>&1; echo "expect exit:$?"
# なければ expect/tmux で
expect -c 'spawn opencode; sleep 3; expect "Ask anything" {puts "PASS"} timeout {puts "FAIL"; exit 1}'
```

- `Ask anything` が見えない (`\e[?2031h` 等のみ) → ターミナルの `TERM` / `isTTY` 問題。`TERM=xterm-256color` で再試行
- `hello` 送信後に応答がない → `OPENCODE_API_KEY` 未設定で LLM 呼び出しが失敗している可能性 (`opencode` は TUI でも API キー必須)。`echo $OPENCODE_API_KEY | head -c 10` で確認

### Step 5: ファイル直接生成の対照実験 (5分)

`session.idle` 経由ではなく直接 `Bun.write` が動くかを切り分ける:

```bash
# 1.1.1 でも daily-logbook.ts は Bun.write で生成する。直接トリガーがあれば
ls scripts/  # trigger-idle.ts が 1.1.1 に存在するか確認 (なければ手動で Bun.write テスト)
bun -e "import {Bun} from 'bun'; await Bun.write('artifacts/daily/test_direct.md', '# test'); console.log('direct write PASS')"
ls -lh artifacts/daily/test_direct.md && rm artifacts/daily/test_direct.md
```

PASS ならファイル権限は正常。FAIL なら `artifacts/daily/` の権限・パス解決 (`resolve(directory, outputDir)`) を疑う。

## 推奨する修正候補 (優先度順)

1. **キャッシュ不整合の解消** — `1.1.1` に固定するなら `rm -rf ~/.cache/opencode/packages/* && opencode plugin opencode-autopilot-logbook@1.1.1 -g --force` を必須化 (本件の最頻原因)
2. **Ver1 ログの可視化** — `daily-logbook.ts` の `DailyLogbookPlugin` 先頭で `client.app.log` と `console.log` の両方を出す (Ver1 は `client.app.log` が `~/.cache/opencode/logs` に出ない場合があるため)
3. **session.idle の代替パス** — TUI 以外でも日報が欲しい場合は `.opencode/commands/logbook.md` (slash command) を併設し、`Bun.write` を手動でも呼べるようにする (1.2.0 の `{{ usage }}` 対応時に検討された案)

## 検証

```bash
# 全クリア後に 75秒待機で日報が 1 回生成されることを確認
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* artifacts/daily/$(date +%Y%m%d)_logbook.md
opencode plugin opencode-autopilot-logbook@1.1.1 -g --force
opencode  # 75秒待機
ls -lh artifacts/daily/$(date +%Y%m%d)_logbook.md && head -n 20 artifacts/daily/$(date +%Y%m%d)_logbook.md
```

## 備考

- `1.1.1` の `dist/index.js` は 8KB 程度 (1.2.1 は 16.5KB, 2.0.11 は 37KB)。monolith のため `src/adapters/v1/*` の Clean Architecture とは異なる
- Orca `opencode2` (`beta-19086`) では `~/.config/opencode/opencode.json` の `plugin` と `~/Library/Application Support/orca/opencode-hooks/shared/opencode.json` の `plugins` の両方を見に行く。Ver1 研修では Orca 側を無効化するか `plugins` を空にしておくと切り分けが容易
- Docker での再現は `docker/Dockerfile.test` が `1.18.27` 固定のため、Ver1 調査には `docker compose run --rm test` より host `opencode` での手動 75秒待機を推奨
