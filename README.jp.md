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

```bash
npm install -g opencode-autopilot-logbook
opencode plugin opencode-autopilot-logbook -g
```

> 「No plugin targets found」と表示される場合は、OpenCode のキャッシュをクリアしてください:
> ```bash
> rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
> ```

### OpenCode を再起動

OpenCode を終了し、再び起動してください。

### 動作確認

- セッションを開始し、作業後にアイドル状態にする
- 日報が自動生成される

## アンインストール

```bash
opencode plugin opencode-autopilot-logbook -g --remove
npm uninstall -g opencode-autopilot-logbook
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
```

## 互換性

### V1（stable）

- `opencode` 1.18.x（`anomalyco/opencode` via Homebrew）+ `@opencode-ai/plugin ^1.0.0`
- 現行 stable ブランチ。設定変更不要。`opencode.json` は `plugin` またはキーなし（`.opencode` は symlink）

### V2 beta（デュアル対応, `feature/v2-migration`）

本プラグインは **デュアル対応** です。既存の `DailyLogbookPlugin`（`Plugin = async ({ client, directory }) => ({ event })`）を温存し、V2 用に `Plugin.define({ id: "smapira.daily-logbook", setup(ctx) })` を追加。stable 1.18.x では V1 経路、beta では V2 経路（`handleV2IdleEvent` / `v2Setup`）が動作します。

**V2 を試す**

```bash
# beta ブランチのみ
npm i -D @opencode-ai/plugin@beta
npx opencode@beta --version   # beta channel（opencode2 という別バイナリは存在しません）
opencode --standalone         # beta で起動
# session.idle → artifacts/daily/YYYYMMDD_logbook.md が生成されることを確認
```

**設定** — V2 は `opencode.json` で `plugins` のオブジェクト形式を推奨:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "opencode-autopilot-logbook" }]
}
```

beta 期間中は V1 の `plugin` キーも受け付ける可能性があります（E2E 未確定）。詳細は `CHANGELOG.md ## 2.0.0 Migration` と `daily-logbook.ts` の対照表（`event.data.sessionID` vs `properties`、`ctx.session.get({sessionID})` vs `path:{id}`、`ctx.app.log` → `console`）を参照。

beta 期間中は V2 API が再 breaking する可能性があります。`main` の `package.json` は `^1.0.0` のまま維持し、beta ブランチでのみ `beta` に切り替えます。

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
