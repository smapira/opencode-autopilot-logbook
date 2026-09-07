# 開発者向け指示書: opencode-autopilot-logbook v1/v2 並行運用

作成日: 2026-09-07 / 改訂: 2026-09-07 並行運用版 / 対象: `opencode-autopilot-logbook@2.0.11` / 方針: **v1 と v2 を両方使う前提で共存させる**

> 本書は v1 に寄せるのではなく、**v1(1.18.29, Homebrew, stable)** と **v2(beta-19192, nodenv 24.13.1, `opencode2`)** を同一マシンで並行運用することを前提とする。どちらか一方を止める手順は含まない。

## 1. 対象

* リポジトリ: `smapira/opencode-autopilot-logbook`
* バイナリ:
  * `opencode 1.18.29` — v1, `/opt/homebrew/bin/opencode`, stable channel
  * `opencode2 v0.0.0-beta-19192` — v2, `~/.anyenv/envs/nodenv/versions/24.13.1/bin/opencode2`, beta channel (`opencode2.exe serve --service :49374` が常駐 Gateway)
* 設定:
  * v1: `~/.config/opencode/opencode.json` (`plugin` キー, 配列)
  * v2: `~/.config/opencode/opencode.jsonc` (`plugins` キー, `{package, options}` 形式)
* DB/ログ (分離後):
  * v1: `~/.local/share/opencode/opencode-data-v1/opencode/{opencode.db, log/opencode.log}` (`XDG_DATA_HOME` で分離、2.0.11〜)
  * v2: `~/.local/share/opencode/opencode-data-v2/opencode/{opencode.db, log/opencode.log}`
  * 分離前(旧): `~/.local/share/opencode/{opencode.db, log/opencode.log}` — 本環境の `symphony_workspaces/ses_fbe31d...` は旧DBに紐づくため移行が必要
* 現象: `symphony_workspaces` で `session.idle` → `artifacts/daily/YYYYMMDD_logbook.md` が v2 側で生成されない (v1 は生成される)

## 2. 前提条件

* Node 24.13.1 / Bun >=1.0.0 (`bun --version`)
* `opencode --version` (1.18.29) と `opencode2 --version` (beta-19192) が **別物** であることを理解していること (混同が不動作の主因)
* `~/.config/opencode/opencode.json` と `opencode.jsonc` が **別ファイル** であることを理解していること (v1 は json のみ、v2 は jsonc を優先)
* `opencode-data-v1/v2` の分離を適用済みであること (2.0.11 の `XDG_DATA_HOME` 対応。未適用なら §5.1 で移行)

## 3. 背景 — なぜ片方だけ動かないか (2026-09-06〜09-07 実測)

### 3.1 二重起動は仕様、失敗は設定とビルドの不一致

```
ps aux | grep opencode
30919 opencode2 --session ses_fbe31d147ffe...  # 現セッションは v2 (symphony)
30962 opencode2.exe serve --service :49374     # v2 Gateway 常駐
 5149 opencode  --session ses_f8c8b4c75ffe...  # v1 TUI (同日 06:48 成功)
```

* v1 成功: `2026-09-06T04:32/05:28/06:34 daily-logbook plugin loaded` (run e7d2673b/9ca709c6/9a809876) → `[daily-logbook:auto] 20260906` を5件生成
* v2 失敗: `17:13〜03:12 failed to load plugin target=autopilot cause=SchemaError(Expected object at ["default"])` が毎時発生 (run d9b0a29f) → `session.idle` に到達せず

→ **並行運用自体は正常。v2 側のロード失敗が原因で片系統だけ止まっている。**

### 3.2 設定の二重登録 (修正済みだが v2 はまだ失敗)

修正前 `opencode.json`:
```json
"plugin": [
  "/Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook",
  "opencode-autopilot-logbook"
]
```
* v1: 1個目は `server` として成功、2個目は `Plugin export is not a function` (05:28:06.423/425 同時)
* v2: 両方 `SchemaError` (`dist/index.js` の hybrid が beta の zod 検証を通過しない)

修正後 (現在):
```json
// opencode.json  (v1): 単一化
"plugin": ["/Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook"]
// opencode.jsonc (v2): 単一化
"plugins": [{ "package": "/Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook" }]
```
v1 はこれで成功。v2 は **単一化してもまだ失敗** — 原因は次項。

### 3.3 hybrid の形状不一致 (src/adapters/hybrid.ts)

* `2.0.9` まで: `Object.assign(DailyLogbookPlugin, {id,setup,effect})` の callable → v2 で `Expected object`
* `2.0.11` : `createHybridDefault() => {id, server, setup, effect?}` の plain object に修正 → v1 は `server` で通過、v2 は `id/setup` で通過するはずが、beta-19192 は `effect` を `Effect` 型として厳密に検証するため、素の `Promise` (`getEffectWrappedSetup()` が `effect` 未導入で undefined) だと一部パスで `Expected Effect` 相当の不一致が残る
* `dist/index.js` は `bun build src/plugin.ts --target=bun` で生成。`server` キーを含む hybrid は v1 loader は許容するが、v2 loader の一部は `server` を未知キーとして扱い `default` 全体の検証に影響する可能性がある (要 beta 側の schema 追従)

→ **v2 を並行で動かすには、v2 用のビルドを beta の `@opencode-ai/plugin@beta` で再ビルドする必要がある (v1 用のビルドとは別物)。単一 `dist` で両方を満たす hybrid には限界がある。**

### 3.4 DB/ログの分離

* 2.0.11 で `opencode-data` 共用による `Database is not empty and has no session table` を解消するため `opencode-data-v1/v2` に分離
* 本環境の `symphony_workspaces` の `ses_fbe31d...` は **旧DB** (`~/.local/share/opencode/opencode.db` ではなく旧共用の 15GB DB) に紐づく旧セッション。v1/v2 どちらの新DBからも見えるが、**新DBには `symphony` の最新 `daily-logbook` がない** (`v1/v2新DBとも 20260906 06:48 が最後`)
* 並行運用では **v1 と v2 で artifacts の出力先 (`artifacts/daily`) は同一だが、DBとログは分離** される。どちらで idle が発火したかは `opencode-data-v1` vs `v2` のログで切り分ける。

## 4. 決定 — 並行運用の設計

* **v1 と v2 を同時に常駐させる。どちらも正とする。** 片方を止めない。
* **設定は v1 と v2 で別ファイルに単一登録する** (重複登録しない)
  * v1: `opencode.json` の `plugin` にローカルパスのみ1件
  * v2: `opencode.jsonc` の `plugins` にローカルパスのみ1件
* **DB/ログは分離したまま運用する** (`opencode-data-v1` / `opencode-data-v2`)。共用に戻さない。
* **ビルドは v1 用と v2 用を分けて管理する** — 単一 `dist/index.js` の hybrid だけで両方の厳密な schema を満たすのは困難なため、**v2 は `@opencode-ai/plugin@beta` で再ビルドした `dist` を使う** (ブランチ `beta` または `dist-v2` を用意)。v1 は `^1.0.0` のまま。
* **検証は v1 と v2 で別々に idle を発火させ、両方の artifacts 生成を確認する** (同一 `artifacts/daily/YYYYMMDD_logbook.md` に追記されることを許容。将来は出力先を `artifacts/daily-v1` / `v2` に分けるか検討)。

## 5. 手順 — 並行で両方を動かす

### 5.1 現状確認 (読み取りのみ, v1/v2 両方)

```bash
# バイナリ
opencode --version   # 1.18.29
opencode2 --version  # beta-19192
ps aux | grep -E "opencode.*--session|opencode.*serve" | grep -v grep

# 設定 (v1 と v2 は別)
cat ~/.config/opencode/opencode.json  | python3 -m json.tool | grep -A3 plugin
cat ~/.config/opencode/opencode.jsonc | python3 -m json.tool | grep -A5 plugins

# DB/ログ (v1 と v2 は別)
ls -lh ~/.local/share/opencode/opencode-data-v1/opencode/opencode.db
ls -lh ~/.local/share/opencode/opencode-data-v2/opencode/opencode.db
ls -lh ~/.local/share/opencode/opencode-data-v1/opencode/log/opencode.log
ls -lh ~/.local/share/opencode/opencode-data-v2/opencode/log/opencode.log

# ログ切り分け
echo "--- v1 ---"
grep -a "daily-logbook plugin loaded\|failed to load plugin.*autopilot" ~/.local/share/opencode/opencode-data-v1/opencode/log/opencode.log | tail -n 10
echo "--- v2 ---"
grep -a "daily-logbook plugin loaded.*v2\|failed to load plugin.*autopilot" ~/.local/share/opencode/opencode-data-v2/opencode/log/opencode.log | tail -n 10

# 成果物 (v1/v2 共通出力先)
ls -lt ./artifacts/daily/ | head
sqlite3 ~/.local/share/opencode/opencode-data-v1/opencode/opencode.db "SELECT title, datetime(time_created/1000,'unixepoch','localtime'), directory FROM session WHERE title LIKE '[daily-logbook:auto]%' ORDER BY time_created DESC LIMIT 5;"
sqlite3 ~/.local/share/opencode/opencode-data-v2/opencode/opencode.db "SELECT title, datetime(time_created/1000,'unixepoch','localtime'), directory FROM session WHERE title LIKE '[daily-logbook:auto]%' ORDER BY time_created DESC LIMIT 5;"
```

### 5.2 v1 を安定させる (stable)

```bash
# 1. v1 設定を単一化 (既に済んでいればスキップ)
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.bak.$(date +%Y%m%d)
# opencode.json の plugin が1件であることを確認
cat ~/.config/opencode/opencode.json | python3 -m json.tool | grep -A5 plugin
# 例: "plugin": ["/Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook"]

# 2. キャッシュ除去 (2.0.9 以前の残骸)
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*

# 3. v1 用ビルド (stable の @opencode-ai/plugin ^1.0.0 で)
cd ~/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook
# stable ブランチ/タグであることを確認
cat package.json | grep -A2 '"devDependencies"' | grep plugin
bun run build
ls -lh dist/index.js  # 41KB 前後
grep -n "hybridDefault\|server:" dist/index.js | head

# 4. v1 で idle 検証
DAILY_LOGBOOK_DEBUG=1 opencode
# 90秒放置 → v1 ログに到達を確認
tail -f ~/.local/share/opencode/opencode-data-v1/opencode/log/opencode.log | grep daily-logbook
# 期待: "daily-logbook plugin loaded" と "event received type=session.idle" (DEBUG時のみ)
ls -lt ./artifacts/daily/$(date +%Y%m%d)_logbook.md
```

### 5.3 v2 を並行で安定させる (beta)

```bash
# 1. v2 設定を単一化 (既に済んでいればスキップ)
cat ~/.config/opencode/opencode.jsonc | python3 -m json.tool | grep -A5 plugins
# 例: "plugins": [{ "package": "/Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook" }]

# 2. v2 用ビルド (beta の @opencode-ai/plugin@beta で)
cd ~/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook
git status  # 変更があれば stash
# beta 用に devDependencies を切り替え (CHANGELOG 2.0.6 参照)
# 並行運用では main と beta で package.json を分けるか、beta ブランチを切ることを推奨
git checkout -b beta 2>/dev/null || git checkout beta
npm i -D @opencode-ai/plugin@beta
npm i -D effect  # getEffectWrappedSetup を有効化 (任意だが推奨)
bun run build
ls -lh dist/index.js
grep -n "hybridDefault\|setup: v2Setup\|effect" dist/index.js | head

# 3. v2 で idle 検証 (v1 と同時に常駐させてよい)
DAILY_LOGBOOK_DEBUG=1 opencode2
# 90秒放置 → v2 ログに到達を確認
tail -f ~/.local/share/opencode/opencode-data-v2/opencode/log/opencode.log | grep daily-logbook
# 期待: "daily-logbook plugin loaded (v2) app=..." と "event received type=session.idle"
ls -lt ./artifacts/daily/$(date +%Y%m%d)_logbook.md
# v1 と v2 の両方が同一ファイルに追記されることを確認 (将来は分離検討)

# 4. v1 に戻す場合
git checkout main
npm i -D @opencode-ai/plugin@^1.0.0
bun run build
```

### 5.4 旧DBからの移行 (symphony_workspaces の 20260827 セッションが旧DBにある場合)

```bash
# 旧DB (共用) と新DB (v1/v2) の差異を確認
ls -lh ~/.local/share/opencode/opencode.db 2>&1 | head  # 旧 (存在すれば)
sqlite3 ~/.local/share/opencode/opencode.db "SELECT count(*) FROM session;" 2>&1 | head
sqlite3 ~/.local/share/opencode/opencode-data-v1/opencode/opencode.db "SELECT count(*) FROM session;" 2>&1 | head
sqlite3 ~/.local/share/opencode/opencode-data-v2/opencode/opencode.db "SELECT count(*) FROM session;" 2>&1 | head

# 旧セッションを新DBに移す必要があれば、旧DBを v1 にコピー (v2 は beta なので v1 のみ移行でも可)
# cp ~/.local/share/opencode/opencode.db ~/.local/share/opencode/opencode-data-v1/opencode/opencode.db  # 要停止後に実行
# v2 は新規でよい (symphony の日報は v1 で生成されるため)
```

## 6. 禁止事項 (並行運用で特に重要)

* `opencode plugin list` を実行しない (v1 では `list` という名前の npm パッケージをインストールして `opencode.json` を汚染する)
* `opencode.json` に `plugins` を書かない / `opencode.jsonc` に `plugin` を書かない (キーが逆だと読まれない)
* 同一ファイル (`opencode.json` または `opencode.jsonc`) に同一 plugin を2回書かない (ローカルパスと npm パッケージの重複は v1 でも片方が必ず失敗)
* `~/.local/share/opencode/opencode.db` の共用に戻さない (v1 と v2 で共用すると `Database is not empty and has no session table` を再発)
* `opencode2 serve` を止めて v1 に寄せない — 本書は並行運用が前提。v2 を止める場合は本書の前提を崩すため別ADRが必要
* `dist/index.js` を手編集しない。v1 用は `^1.0.0` で、v2 用は `@beta` でそれぞれ `bun run build` する (hybrid の分岐は `src/adapters/hybrid.ts` のみで制御)
* `opencode` で作ったセッションを `opencode2` で開かない / 逆も同様 (DBは分離されているため、別バージョンで開くとセッションが見つからない)

## 7. 確認方法 (v1 と v2 で別々に確認)

| 観点 | v1 コマンド | v2 コマンド | 期待値 (両方) |
|------|-------------|-------------|---------------|
| ロード成功 | `grep -a "daily-logbook plugin loaded" ~/.local/share/opencode/opencode-data-v1/opencode/log/opencode.log \| tail` | `grep -a "daily-logbook plugin loaded.*v2" ~/.local/share/opencode/opencode-data-v2/opencode/log/opencode.log \| tail` | 各1件以上、直近に成功 |
| ロード失敗0 | `grep -a "failed to load plugin.*autopilot" .../v1/... \| tail` | `grep -a "failed to load plugin.*autopilot" .../v2/... \| tail` | 復旧後は0件 |
| idle 到達 | `DAILY_LOGBOOK_DEBUG=1` で `grep -a "event received type=session.idle" .../v1/...` | 同 `.../v2/...` | idle 後に1件以上 (DEBUG時のみ) |
| セッション生成 | `sqlite3 .../v1/.../opencode.db "SELECT title FROM session WHERE title LIKE '[daily-logbook:auto]%' ORDER BY time_created DESC LIMIT 1;"` | 同 `.../v2/...` | 当日日付のタイトルが各DBにある |
| ファイル生成 | `ls -lt ./artifacts/daily/$(date +%Y%m%d)_logbook.md` (v1/v2共通) | 同左 | 当日ファイルが更新 (v1/v2どちらで生成されても追記) |
| hybrid 形状 | `node -e "import('.../dist/index.js').then(m=>console.log(Object.keys(m.default)))"` (v1 build) | 同 (v2 build, beta) | v1: `id,server,setup` を含む object / v2: `id,setup` (+`effect` あれば) を含む object |

## 8. 影響範囲

* `symphony_workspaces` の全セッション — v1 と v2 のどちらで開いたかで日報の生成経路が変わる。並行運用では両方で生成されるため、同一 `artifacts/daily/YYYYMMDD_logbook.md` に二重追記される可能性がある (現状は許容、将来は `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` で分離検討)
* `opencode-autopilot-logbook` 自体の dogfooding — v1 と v2 で別DBに日報が分かれる。レビュー時は両方を確認
* 他プロジェクト — `opencode2 serve` は常駐のため、全プロジェクトの v2 セッションに影響。v1 プロジェクトは影響なし (DB分離)

## 9. 関連ファイル

* `~/.config/opencode/opencode.json` — v1 設定 (plugin)
* `~/.config/opencode/opencode.jsonc` — v2 設定 (plugins)
* `~/.local/share/opencode/opencode-data-v1/opencode/{opencode.db, log/opencode.log}` — v1 の真実
* `~/.local/share/opencode/opencode-data-v2/opencode/{opencode.db, log/opencode.log}` — v2 の真実
* `src/adapters/hybrid.ts` — hybrid default の形状定義 (v1/v2 両対応の唯一の箇所)
* `src/adapters/v1/plugin.v1.ts` — v1 の `server` 実装 (`DAILY_LOGBOOK_DEBUG` ゲート)
* `src/adapters/v2/plugin.v2.ts` — v2 の `setup` 実装 (`isV1Host` 判定, `v2Setup`)
* `package.json` — `build: bun build src/plugin.ts --target=bun --outfile dist/index.js` / `devDependencies.@opencode-ai/plugin` のバージョンが v1/v2 で異なる
* `dist/index.js` — 配布物 (手編集禁止, v1/v2 で別ビルド)

## 10. 次に必要な更新

* [ ] `beta` ブランチを作成し、`package.json` の `devDependencies.@opencode-ai/plugin` を `@beta` に固定 (main は `^1.0.0` のまま)。CI で `main → dist-v1` / `beta → dist-v2` を別々にビルド
* [ ] `README.md` の「v1 は 2.0.9 / v2 は 2.0.11」表記を「v1 と v2 を並行で使う場合はブランチを分けてビルド」に更新
* [ ] `scripts/verify-diagnostic-logs.ts` に v1/v2 両ログの「重複登録検出」「成功/失敗の分離チェック」を追加
* [ ] `artifacts/daily` の出力を `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` で `daily-v1` / `daily-v2` に分離するか検討 (現状は同一ファイルに追記で許容)
* [ ] 旧DB (`~/.local/share/opencode/opencode.db`) に残る `symphony` の旧セッションを `opencode-data-v1` に移行するかアーカイブするか決定

## 11. 参考: 今回の実測値 (2026-09-07 時点)

* `opencode 1.18.29` 成功 5回 (16:39〜17:13) / `opencode2 beta-19192` 失敗 6回 (17:13〜03:12)
* 最終生成: `symphony_workspaces 2026-09-06 06:48 ses_f8c743b1` (v1) / `autopilot-logbook 2026-09-06 06:55 20260906_logbook.md 7,984B` (v1)
* 現セッション `ses_fbe31d147ffeiaZmBX6KXWUgc8` は `opencode2` (v2) の旧DBセッション → v2 のロード失敗で日報が止まっているが、v1 セッションでは正常に生成される (並行運用で v1 がカバー)

---
*本指示書は `documents/plans/dev` 配下に置き、`AGENTS.md` / `README.md` から参照する。v1/v2 のどちらか一方に寄せる変更をする場合は、本書の「並行運用」前提を崩すため別ADRを作成すること。*
