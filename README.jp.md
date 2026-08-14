# OpenCode Autopilot Logbook

OpenCode セッション終了時に、日報を自動生成するプラグインです。

[English](./README.md)

## 機能

- `session.idle` 時に日報生成プロンプトを自動実行
- 日報保存先を環境変数で変更可能
- 手動実行コマンド `/daily-logbook` を提供
- テンプレートのカスタマイズに対応（環境変数指定）

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

---

## 環境変数

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
export OPENCODE_DAILY_LOGBOOK_TEMPLATE="plans/dev/daily-logbook.md"
```

### `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR`

- 既定値: `artifacts/daily/`
- 設定時は日報の出力先ディレクトリを変更可能

```bash
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"
```

---

## 出力先

- 日報: `{{ outputDir }}/YYYYMMDD_logbook.md`

既存ファイルがある場合は、上書きではなく追記・更新する運用です。

## ライセンス

MIT
