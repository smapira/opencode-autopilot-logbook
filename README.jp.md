# OpenCode Autopilot Logbook

![OpenCode Autopilot Logbook](assets/thumbnail.png)

[![npm version](https://img.shields.io/npm/v/opencode-autopilot-logbook)](https://www.npmjs.com/package/opencode-autopilot-logbook) [![npm downloads](https://img.shields.io/npm/dm/opencode-autopilot-logbook)](https://www.npmjs.com/package/opencode-autopilot-logbook) [![GitHub stars](https://img.shields.io/github/stars/smapira/opencode-autopilot-logbook)](https://github.com/smapira/opencode-autopilot-logbook) [![license](https://img.shields.io/npm/l/opencode-autopilot-logbook)](LICENSE)

OpenCode セッション終了時に、日報を自動生成するプラグインです。

[English](./README.md)

## 機能

- `session.idle` 時に日報生成プロンプトを自動実行
- 日報保存先を環境変数で変更可能
- テンプレートのカスタマイズに対応（環境変数指定）
- テンプレート駆動で出力、言語はテンプレートで自由に切り替え可能
- `{{ usage }}` テンプレート変数で usage 統計（cost/tokens）を出力（`~/.local/share/opencode/opencode.db` から取得）

## インストール

まず利用中の OpenCode を確認してください:

```bash
opencode --version   # → 1.18.x なら v1 (stable, Homebrew)
opencode2 --version  # → 0.0.0-beta-xxxxx なら v2 (beta)
```

バージョンに合った手順を使ってください。混在させると（例: `opencode` でインストールして `opencode2 plugin list` で確認）参照する設定ファイルが違うため `No plugins found` になります。

### OpenCode v1 — stable（Homebrew, `opencode` 1.18.x）

`opencode-autopilot-logbook@2.0.3`（v1 対応の最終版）を使います。

```bash
npm install -g opencode-autopilot-logbook@2.0.3
opencode plugin opencode-autopilot-logbook -g
```

> `opencode plugin list` というコマンドは v1 には存在しません。`opencode plugin <名前>` は引数を npm パッケージ名としてインストールします。`opencode plugin list` を実行すると無関係な `list` パッケージが入り `~/.config/opencode/opencode.json` が汚染されます。確認は以下を使ってください:
> ```bash
> cat ~/.config/opencode/opencode.json | python3 -m json.tool | grep -A5 plugin
> ```

> 「No plugin targets found」と表示される場合はキャッシュをクリアして再試行:
> ```bash
> rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
> opencode plugin opencode-autopilot-logbook -g
> ```

### OpenCode v2 — beta（`opencode2` 0.0.0-beta-xxxxx）

`opencode-autopilot-logbook@2.0.5`（v2 専用）を使います。

```bash
npm install -g opencode-autopilot-logbook@2.0.5
opencode2 plugin add opencode-autopilot-logbook
```

v2 は `~/.config/opencode/opencode.jsonc` を読み、`plugins` キーを推奨します:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "opencode-autopilot-logbook" }]
}
```

> `opencode2` 環境で `opencode plugin ... -g` を使わないでください。v1 用の `opencode.json` に書き込まれ、`opencode2` からは読まれません。

### 再起動と動作確認

OpenCode を終了して再起動し、以下を確認:

- セッションを開始し、作業後にアイドル状態にする
- `artifacts/daily/YYYYMMDD_logbook.md` が自動生成される

確認コマンド:

```bash
# v1
cat ~/.config/opencode/opencode.json | python3 -m json.tool
# v2
opencode2 plugin list
cat ~/.config/opencode/opencode.jsonc | python3 -m json.tool | grep -A5 plugins
```

### アップデート

#### v1

```bash
npm install -g opencode-autopilot-logbook@2.0.3
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
opencode plugin opencode-autopilot-logbook -g --force
npm list -g opencode-autopilot-logbook
```

#### v2

```bash
npm install -g opencode-autopilot-logbook@2.0.5
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
opencode2 plugin remove opencode-autopilot-logbook 2>/dev/null; opencode2 plugin add opencode-autopilot-logbook
opencode2 plugin list
npm list -g opencode-autopilot-logbook
```

## アンインストール

`npm uninstall -g` だけでは設定ファイルとキャッシュが残ります。4箇所（グローバル設定・プロジェクトローカル設定・npm global・キャッシュ）をすべて掃除してください。本節はアンインストール後に**ユーザーが自分で再検出（セルフチェック）できる完全版**です。ソースを読み返さずに下の「検証 — 残留の再検出」ブロックだけで再確認できます。

#### v1 — `opencode` 1.18.x（`~/.config/opencode/opencode.json` の `plugin` キーを読む）

`opencode` 1.18.x には `plugin remove` サブコマンドがありません。手動で設定ファイルを編集します:

```bash
# 1. グローバル設定から削除（"list" があれば一緒に削除
#    — `opencode plugin list` を実行すると v1 は npm パッケージ `list` として誤登録します）
#    手編集するか、下のワンライナー（opencode.json + opencode.jsonc、plugin/plugins 両キーを掃除）を実行
#    例: "plugin": [] またはキー自体を削除
npm uninstall -g opencode-autopilot-logbook
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* ~/.cache/opencode/packages/list* ~/.cache/opencode/packages/list@latest
rm -rf ~/.cache/opencode/npm/opencode-autopilot-logbook* ~/.cache/opencode/npm/list*

# 2. リポジトリ直下のローカル設定に残留がないか確認
#    （`opencode plugin list` 実行後に .opencode/opencode.json に "list" が残る事例を確認）
cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 plugin || echo "no local .opencode/opencode.json"
# "list" や "opencode-autopilot-logbook" があれば .opencode/opencode.json を手編集して削除
```

両グローバルファイル・両キーを一括で綺麗にするワンライナー:

```bash
python3 -c "
import json, pathlib
for p in [pathlib.Path.home()/'.config/opencode/opencode.json', pathlib.Path.home()/'.config/opencode/opencode.jsonc']:
    if p.exists():
        j=json.loads(p.read_text())
        for k in ('plugin','plugins'):
            if k in j:
                v=j[k]
                if k=='plugin':
                    j[k]=[x for x in v if x not in ('opencode-autopilot-logbook','list')]
                else:
                    j[k]=[x for x in v if x.get('package') not in ('opencode-autopilot-logbook','list')]
                if not j[k]: j.pop(k,None)
        p.write_text(json.dumps(j, indent=2)+'\n')
        print(f'cleaned {p}:', j.get('plugin', j.get('plugins','(removed)')))
"
# 検証は下の「検証 — 残留の再検出」ブロックで一括実行
```

#### v2 — `opencode2` 0.0.0-beta-xxxxx（`~/.config/opencode/opencode.jsonc` の `plugins` キーを読む）

```bash
# 1. 推奨 — CLI で削除（opencode.jsonc の `plugins` から除去）
opencode2 plugin remove opencode-autopilot-logbook
opencode2 plugin list  # "No plugins found" または autopilot が無いことを確認

# 2. 取り残しがあった場合のフォールバック — v1 と同じワンライナー（両キーを両ファイルから掃除）
python3 -c "
import json, pathlib
for p in [pathlib.Path.home()/'.config/opencode/opencode.json', pathlib.Path.home()/'.config/opencode/opencode.jsonc']:
    if p.exists():
        j=json.loads(p.read_text())
        for k in ('plugin','plugins'):
            if k in j:
                v=j[k]
                if k=='plugin':
                    j[k]=[x for x in v if x not in ('opencode-autopilot-logbook','list')]
                else:
                    j[k]=[x for x in v if x.get('package') not in ('opencode-autopilot-logbook','list')]
                if not j[k]: j.pop(k,None)
        p.write_text(json.dumps(j, indent=2)+'\n')
        print(f'cleaned {p}:', j.get('plugin', j.get('plugins','(removed)')))
"

# 3. npm global + キャッシュ（packages + npm サブキャッシュ）
npm uninstall -g opencode-autopilot-logbook
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* ~/.cache/opencode/packages/list* ~/.cache/opencode/packages/list@latest
rm -rf ~/.cache/opencode/npm/opencode-autopilot-logbook* ~/.cache/opencode/npm/list*

# 4. ローカル残留（v1 と同じ）
cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 plugin || echo "no local .opencode/opencode.json"
```

#### 検証 — 残留の再検出（セルフチェック）

アンインストール後に以下を実行してください。すべて `clean` / `empty` / `no ...` と表示されれば完全削除です。このブロックだけで再検出できるようにしています。ソースの再読は不要です。**v3 では Orca 共有設定と全ファイルスキャンを追加し、従来版で見逃していた残留をカバーしています。**

```bash
echo "=== 1/9 npm global ==="; npm list -g opencode-autopilot-logbook 2>&1 | head -n 5; echo "(empty = clean)"
echo "=== 2/9 グローバル設定: opencode.json（v1, キー: plugin）==="; cat ~/.config/opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 '"plugin"\|"plugins"' || echo "no plugin/plugins key — clean"
echo "=== 3/9 グローバル設定: opencode.jsonc（v2, キー: plugin + plugins）==="; cat ~/.config/opencode/opencode.jsonc 2>/dev/null | python3 -m json.tool | grep -A5 '"plugin"\|"plugins"' || echo "no plugin/plugins key — clean"
echo "=== 4/9 v2 CLI ==="; opencode2 plugin list 2>&1 | head -n 20; echo '（期待値: "No plugins found" または autopilot が無いこと）'
echo "=== 5/9 キャッシュ（packages + npm）==="; ls -1 ~/.cache/opencode/packages/ 2>&1 | grep -E "autopilot|list" || echo "packages cache clean"; ls -1 ~/.cache/opencode/npm/ 2>&1 | grep -E "autopilot|list" || echo "npm cache clean"
echo "=== 6/9 ローカル残留（リポジトリ直下で実行）==="; cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 '"plugin"\|"plugins"' || echo "no local .opencode/opencode.json — clean"; cat .github/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 '"plugin"\|"plugins"' || echo "no .github/opencode.json — clean"; ls ~/.config/opencode/*.bak 2>/dev/null | head -n 5 || echo "no .bak files"
echo "=== 7/9 Orca 共有設定（従来版で見逃していた箇所）==="; cat "$HOME/Library/Application Support/orca/opencode-hooks/shared/opencode.json" 2>/dev/null | python3 -m json.tool | grep -A5 '"plugin"\|"plugins"' || echo "no Orca shared plugin — clean"
echo "=== 8/9 その他の残留 ==="; env | grep -E "OPENCODE_DAILY" || echo "no OPENCODE_DAILY env — clean"; ls -lh artifacts/daily/ 2>/dev/null | head -n 20 || echo "no artifacts/daily"
echo "=== 9/9 深掘りスキャン（全 opencode.json* と両キャッシュ）==="; grep -r "autopilot" ~/ --include="opencode.json*" 2>/dev/null | grep -v ".cache/opencode/packages" | grep -v ".cache/opencode/npm" | head -n 20 || echo "grep scan clean（opencode.json* に autopilot なし）"; find ~/.cache/opencode -maxdepth 4 -name "*autopilot*" 2>/dev/null | head -n 20 || echo "cache deep scan clean"
```

コピペ用ワンライナー（同じ検査を1行で）:

```bash
echo "--- npm global ---" && npm list -g opencode-autopilot-logbook 2>&1 | head -n 5; echo "--- opencode.json ---" && cat ~/.config/opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -E "plugin|plugins" || echo "clean"; echo "--- opencode.jsonc ---" && cat ~/.config/opencode/opencode.jsonc 2>/dev/null | python3 -m json.tool | grep -E "plugin|plugins" || echo "clean"; echo "--- opencode2 plugin list ---" && opencode2 plugin list 2>&1 | head -n 5; echo "--- cache packages ---" && ls ~/.cache/opencode/packages/ 2>&1 | grep -E "autopilot|list" || echo "packages cache clean"; echo "--- cache npm ---" && ls ~/.cache/opencode/npm/ 2>&1 | grep -E "autopilot|list" || echo "npm cache clean"; echo "--- local .opencode/opencode.json ---" && cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -E "plugin|plugins" || echo "clean"; echo "--- Orca shared ---" && cat "$HOME/Library/Application Support/orca/opencode-hooks/shared/opencode.json" 2>/dev/null | python3 -m json.tool | grep -E "plugin|plugins" || echo "Orca clean"; echo "--- grep scan ---" && grep -r "autopilot" ~/ --include="opencode.json*" 2>/dev/null | grep -v ".cache" | head -n 5 || echo "grep clean"; echo "--- env ---" && env | grep OPENCODE_DAILY || echo "no env"
```

Orca 共有にまだ `opencode-autopilot-logbook` が残っていた場合の除去:

```bash
python3 -c "
import json, pathlib
p=pathlib.Path.home()/'Library/Application Support/orca/opencode-hooks/shared/opencode.json'
if p.exists():
    j=json.loads(p.read_text())
    for k in ('plugin','plugins'):
        if k in j:
            v=j[k]
            if k=='plugin':
                j[k]=[x for x in v if x not in ('opencode-autopilot-logbook','opencode-autopilot-logbook@2.0.5','list')]
            else:
                j[k]=[x for x in v if (x if isinstance(x,str) else x.get('package')) not in ('opencode-autopilot-logbook','opencode-autopilot-logbook@2.0.5','list')]
            if not j[k]: j.pop(k,None)
    p.write_text(json.dumps(j, indent=2)+'\n')
    print(f'cleaned Orca shared {p}:', j)
else:
    print('no Orca shared config')
"
# ローカル汚染（.github/opencode.json + .opencode/opencode.json）とバックアップも除去
python3 -c "
import json, pathlib
for p in [pathlib.Path('.opencode/opencode.json'), pathlib.Path('.github/opencode.json')]:
    if p.exists():
        j=json.loads(p.read_text())
        for k in ('plugin','plugins'):
            if k in j:
                v=j[k]
                if k=='plugin':
                    j[k]=[x for x in v if x not in ('opencode-autopilot-logbook','opencode-autopilot-logbook@2.0.5','list')]
                else:
                    j[k]=[x for x in v if (x if isinstance(x,str) else x.get('package')) not in ('opencode-autopilot-logbook','opencode-autopilot-logbook@2.0.5','list')]
                if not j[k]: j.pop(k,None)
        if set(j.keys())=={'\$schema'}: p.unlink(); print(f'removed {p} (only schema left)')
        else: p.write_text(json.dumps(j, indent=2)+'\n'); print(f'cleaned {p}:', j)
"
rm -f ~/.config/opencode/opencode.jsonc.bak  # 任意: autopilot を含むバックアップを削除
```

期待されるクリーンな出力（v3・究極版）:

```
--- npm global ---
... (empty)
--- opencode.json ---
clean  （または autopilot/list を含まない plugin 一覧）
--- opencode.jsonc ---
clean  （または autopilot/list を含まない plugin 一覧）
--- opencode2 plugin list ---
No plugins found
--- cache packages ---
packages cache clean
--- cache npm ---
npm cache clean
--- local .opencode/opencode.json ---
clean
--- Orca shared ---
Orca clean
--- grep scan ---
grep clean
--- env ---
no env
```

いずれかの行で `opencode-autopilot-logbook` や `list` が再表示されたら、上の v1/v2 のワンライナーを再実行し、この検証ブロックを再実行してください。

## 互換性

| チャネル | バイナリ | 設定ファイル | プラグインキー | パッケージ |
|---------|----------|--------------|----------------|-----------|
| **v1 stable** | `opencode` 1.18.x (Homebrew `anomalyco/opencode`) | `~/.config/opencode/opencode.json` | `plugin: ["..."]` | `opencode-autopilot-logbook@2.0.3` |
| **v2 beta** | `opencode2` 0.0.0-beta-xxxxx (`@opencode-ai/cli@beta`) | `~/.config/opencode/opencode.jsonc` | `plugins: [{package:"..."}]` | `opencode-autopilot-logbook@2.0.5` |

* `2.0.3` が両ホストで動作する最後のバージョン（ハイブリッド default）です。`2.0.5` は **v2 専用** — `export default` がオブジェクト（`{id, setup, effect}`）のため v1 では `TypeError` になります。詳細は `CHANGELOG.md ## 2.0.5`。
* beta 期間中は V2 API が再 breaking する可能性があります。`main` の `package.json` は `@opencode-ai/plugin ^1.0.0` のまま維持し、beta ブランチでのみ `@beta` に切り替えます。
* API 差分: `event.properties.sessionID` → `event.data.sessionID`、`client.session.get({path:{id}})` → `ctx.session.get({sessionID})`、`ctx.app.log` → `console`。詳細は `CHANGELOG.md ## 2.0.0` と `daily-logbook.ts` 冒頭の対照表を参照。

---

## 環境変数

以下の設定はすべて環境変数で切り替えます。OpenCode を起動する前に設定し、設定後は OpenCode を再起動してください。起動時に読み込まれます。

**一時的に変える場合**

```bash
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"
opencode
```

**ずっと変えておく場合**

シェルの設定ファイル（zsh なら `~/.zshrc`、bash なら `~/.bashrc`）に `export` 行を追記し、再読み込みします。

```bash
echo 'export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"' >> ~/.zshrc
source ~/.zshrc
```

`echo $OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` で値が入っているか確認し、`{{ outputDir }}/YYYYMMDD_logbook.md` が期待どおりの場所に作られるか見てください。

### `OPENCODE_DAILY_LOGBOOK_DISABLED`

- 既定値: `false`（未設定時）
- `true` にするとプラグインを無効化

```bash
export OPENCODE_DAILY_LOGBOOK_DISABLED=true
```

### `OPENCODE_DAILY_LOGBOOK_TEMPLATE`

- 既定値: 未設定（プラグイン内 `SAMPLE_TEMPLATE` を使用）
- 設定時は指定ファイルをテンプレートとして使用
- 指定ファイルの読み込みに失敗した場合は自動で `SAMPLE_TEMPLATE` にフォールバック

```bash
export OPENCODE_DAILY_LOGBOOK_TEMPLATE="documents/plans/dev/daily-logbook.md"
```

### `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR`

- 既定値: `artifacts/daily`
- 設定時は日報の出力先ディレクトリを変更可能
- 相対パスはプラグインのディレクトリを基準に `resolve(directory, outputDir)` で解決されます。絶対パスはそのまま使われます。`OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` のときは、存在チェックとエージェントの書き込み先を合わせるため、絶対パスとして prompt に渡されます

例

```bash
# リポジトリ直下の daily に
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"

# documents 配下に
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="documents/daily"

# 一時的に絶対パスで試す
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="/tmp/my-logs"
```

`ls -la daily/` など、指定した場所に `YYYYMMDD_logbook.md` が作られるか確認してください

### `OPENCODE_DAILY_LOGBOOK_REDACT`

- 既定値: `true`（有効）
- 有効時、transcript に含まれる既知のシークレットパターン（`sk-...`/`SK-...`、`Bearer <token>`、`AKIA...`、`ghp_...`、`github_pat_...`、`xoxb-...`、JWT（`eyJ...`）、PEM 秘密鍵、`password:` 形式のペア等）を `***` に置換してから prompt に埋め込みます
- 無効化できるのは `"false"` の厳密一致のみ。それ以外の値は既定値（`true`）のままです
- マスキングは「転送事故を減らす」ためのフェイルセーフであり、完全な秘密保護を保証するものではありません。機密情報の保護をこの機能に依存しないでください

マスキングの制限:

- OpenAI 形式キーは大文字小文字を問わず対応（`sk-...` および `SK-...`）
- **各セグメントが 10 文字未満の短い JWT は非対応**（マッチャーはセグメントごとに 10 文字以上を要求します）
- `Bearer` は文脈を判断しないため、自然文（例: "bearer of"）も過マスクされ得ます

```bash
export OPENCODE_DAILY_LOGBOOK_REDACT=false
```

### `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT`

- 既定値: `true`（埋め込み）
- `"false"` にすると、transcript を prompt に埋め込みません（テンプレートのみを使用）
- 無効化できるのは `"false"` の厳密一致のみ。それ以外の値は既定値（`true`）のままです
- この設定が `"false"` のとき、`OPENCODE_DAILY_LOGBOOK_REDACT` の設定に関わらず transcript は埋め込まれません

```bash
export OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT=false
```

### `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS`

- 既定値: `90000`（90秒）
- 同一セッションで自動生成が連続して行われる間隔の最小値
- 整数として解釈されます。非負の整数として解釈できない場合は既定値が使われます
- `0` を指定するとスロットルが無効になります（他の制限がなければ、idle のたびに生成されます）
- 科学記法（例: `1e3`）は整数パーサーで打ち切られるため `1000` ではなく `1` として解釈されます

```bash
export OPENCODE_DAILY_LOGBOOK_THROTTLE_MS=180000
```

### `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT`

- 既定値: `false`
- 有効化できるのは `"true"` の厳密一致のみ。それ以外の値は既定値（`false`）のままです
- 有効時、当日の `{{ outputDir }}/{{ date }}_logbook.md` が既に存在すれば生成をスキップします（ファイルベース判定のため、プロセス再起動を跨いで機能します）
- **有効時は追記・更新運用が 1 日 1 回になります**（Issue C）
- **ファイルが存在しても空・不完全（前回の生成失敗等）の場合、当日中の再生成がブロックされます**。判定はファイルの存在のみに基づくためです（Issue D）
- **同一日付の並行 idle は抑制されます**: 当日の生成が実行中のあいだ、同時に idle した他のセッションはスキップされます（メモリ上の日付キーガードのため、プロセス再起動は跨ぎません）
- **有効時、`{{ outputDir }}` はプラグインのディレクトリ基準の絶対パスとして prompt に渡されます**。エージェントが存在チェックと同じ場所にファイルを書けるようにするためです。無効時は従来どおり相対文字列（例: `artifacts/daily`）が渡されます
- **`OPENCODE_DAILY_LOGBOOK_TEMPLATE` との併用は非対応です**: カスタムテンプレートによりファイル名パターンが変わるため存在判定ができません。併用時は warning ログを出し、daily-limit チェックをスキップします

```bash
export OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true
```

### `OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY`

- 既定値: `true`（当該プロジェクトのみで集計）
- `true` のときは現在のプロジェクト（`project.worktree` と `directory` の一致）で絞り込み、`"false"` のときは全プロジェクトで集計します
- 無効化できるのは `"false"` の厳密一致のみ。それ以外の値は既定値（`true`）のままです
- プロジェクトが解決できない場合（例: グローバル worktree `/`）は全プロジェクト集計にフォールバックします

```bash
export OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY=false
```

### `OPENCODE_DAILY_LOGBOOK_DB_PATH`

- 既定値: `~/.local/share/opencode/opencode.db`
- usage 統計の取得元となる OpenCode データベースのパスを上書きします
- `read-only` で開きます。ファイルが存在しない・開けない場合は usage を空文字として日報生成は継続します

```bash
export OPENCODE_DAILY_LOGBOOK_DB_PATH="$HOME/.local/share/opencode/opencode.db"
```

## テンプレート変数

`SAMPLE_TEMPLATE` およびカスタムテンプレートで利用できます:

| 変数 | 説明 |
|------|------|
| `{{ sessionId }}` | 元セッション ID |
| `{{ date }}` | `YYYYMMDD`（例: `20260902`） |
| `{{ dateJp }}` | 日本語日付 `YYYY年M月D日` |
| `{{ outputDir }}` | 出力ディレクトリ（相対/絶対、詳細は `OUTPUT_DIR` / `DAILY_LIMIT` を参照） |
| `{{ usage }}` / `{{ usageTable }}` | usage 統計テーブル（cost/tokens）。`{{ usage }}` が canonical、`{{ usageTable }}` はエイリアス。`opencode.db` の `session` テーブル（`time_created` は ms epoch）から取得。詳細は `USAGE_PROJECT_ONLY` / `DB_PATH` を参照 |

カスタムテンプレートでの使用例:

```markdown
## Usage
{{ usage }}
```

データベースが存在しない・当日データが 0 件の場合は空文字に置換されます。

---

## 出力先

- 日報: `{{ outputDir }}/YYYYMMDD_logbook.md`

既存ファイルがある場合は、上書きではなく追記・更新する運用です。

## フィロソフィー

私たちが大切にしている OSS への向き合い方を、指針としてまとめたコラムです。この指針があるからこそ、日々の OSS 活動や記事の執筆を続けています。社会に積み重なった見直されない仕組みを「技術的負債」と捉え直す考え方に触れていただけるとうれしいです。

- [【エンジニアブログ】社会にも、技術的負債がある。](https://www.thch-vape.shop/guide/column/git-log--oneline--all--society)

## ライセンス

MIT
