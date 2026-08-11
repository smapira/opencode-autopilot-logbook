# OpenCode セッション終了時 日報自動作成プラグイン 開発者指示書

> **作成日**: 2026-08-11
> **ステータス**: 実装待機
> **対象**: Implementer / Markup Engineer / Super Hacker

---

## 1. 概要

OpenCode のセッション終了時に、自動的に日報と引き継ぎ文書を作成するプラグインを開発する。

### 背景

- 現在、日報作成は手動で `daily-handover` スキルを呼び出す必要がある
- セッション終了を忘れた場合、日報が作成されない問題がある
- 自動化により、属人化を防ぎ、一貫した品質の日報を保証する

### 目標

- セッション終了（`session.idle` イベント）時に自動で日報生成プロンプトを発火既存の `daily-handover` スキルを活用し、独自フォーマットを定義しない
- 必要に応じて手動トリガー（`/daily-report` コマンド）も提供

---

## 2. 技術仕様

### 2.1. プラグインアーキテクチャ

```
.opencode/
├── plugins/
│   └── daily-report.js      # 自動日報プラグイン
├── commands/
│   └── daily-report.md      # 手動トリガーコマンド
└── package.json              # 依存パッケージ（不要だが一応）
```

### 2.2. プラグインコード

**ファイル**: `.opencode/plugins/daily-report.js`

```javascript
/**
 * OpenCode Session Daily Report Plugin
 * 
 * セッション終了時に自動で日報・引き継ぎを作成する。
 * 既存の daily-handover スキルを活用する。
 */
export const DailyReportPlugin = async ({ project, client, $, directory, worktree }) => {
  // ログ出力
  await client.app.log({
    body: {
      service: "daily-report-plugin",
      level: "info",
      message: "Plugin initialized",
    },
  });

  return {
    /**
     * session.idle イベント: セッションがアイドル状態になった時
     * （AI応答完了後、ユーザーの次の入力待ち状態）
     */
    "session.idle": async (input, output) => {
      // セッションIDを取得
      const sessionId = input.sessionID;
      
      // プラグインが無効化されていないか確認
      // （環境変数や設定で無効化可能にする）
      if (process.env.OPENCODE_DAILY_REPORT_DISABLED === "true") {
        return;
      }

      // ログ出力
      await client.app.log({
        body: {
          service: "daily-report-plugin",
          level: "info",
          message: `Session idle detected: ${sessionId}`,
        },
      });

      // 日報生成プロンプトを発火
      // client.run() で非同期に新しいセッションを開始
      try {
        await client.session.create({
          title: "日報・引き継ぎ自動生成",
          messages: [
            {
              role: "user",
              content: `セッション ${sessionId} の内容を元に、daily-handoverスキルを使って日報と引き継ぎを作成してください。

手順:
1. daily-handover スキルを読み込む
2. 今日の日付の daily/YYYYMMDD_日報.md を作成/更新
3. 今日の日付の daily/YYYYMMDD_引き継ぎ.md を作成/更新
4. 作成したファイル名を報告

注意:
- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く、引き継ぎは次セッションが再開しやすい内容を書く
- やりとりの要点、決まった方針、次アクションを優先する`,
            },
          ],
        });
      } catch (error) {
        await client.app.log({
          body: {
            service: "daily-report-plugin",
            level: "error",
            message: `Failed to create daily report: ${error.message}`,
          },
        });
      }
    },
  };
};
```

### 2.3. 手動トリガーコマンド

**ファイル**: `.opencode/commands/daily-report.md`

```markdown
---
description: セッションの日報と引き継ぎを作成
agent: build
---
daily-handover スキルを使って、このセッションの日報と引き継ぎを作成してください。

手順:
1. daily-handover スキルを読み込む
2. 今日の日付の daily/YYYYMMDD_日報.md を作成/更新
3. 今日の日付の daily/YYYYMMDD_引き継ぎ.md を作成/更新
4. 作成したファイル名を報告

注意:
- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く、引き継ぎは次セッションが再開しやすい内容を書く
- やりとりの要点、決まった方針、次アクションを優先する
```

---

## 3. 実装手順

### Step 1: ディレクトリ作成

```bash
cd /Users/bookair18/orca/workspaces/guillemot
mkdir -p .opencode/plugins
mkdir -p .opencode/commands
```

### Step 2: プラグインファイル作成

```bash
cat > .opencode/plugins/daily-report.js << 'EOF'
[上記のプラグインコードを貼り付け]
EOF
```

### Step 3: コマンドファイル作成

```bash
cat > .opencode/commands/daily-report.md << 'EOF'
[上記のコマンド定義を貼り付け]
EOF
```

### Step 4: 動作確認

1. OpenCode を再起動
2. 通常のセッションを行い、完了する
3. `session.idle` イベントが発火し、日報生成プロンプトが実行されるか確認
4. `/daily-report` コマンドで手動トリガーが動作するか確認

### Step 5: オプション設定（必要に応じて）

環境変数で無効化可能にする:

```bash
# 日報プラグインを無効化
export OPENCODE_DAILY_REPORT_DISABLED=true
```

---

## 4. 既存との連携

### 4.1. daily-handover スキルとの連携

- プラグインは既存の `daily-handover` スキルを呼び出す
- 独自フォーマットは定義しない
- スキルの改善がプラグインに自動反映される

### 4.2. ファイル構成

```
daily/
├── YYYYMMDD_日報.md          # 今日やったことの要約
└── YYYYMMDD_引き継ぎ.md      # 次セッション向け引き継ぎ
```

### 4.3. 日報の内容

- 今日やったことの要約
- 新規 Issue / close / 重要更新
- 高優先タスクや残課題

### 4.4. 引き継ぎの内容

- ユーザーの指示と対応の流れ
- その場で確定したルールや方針
- 次セッションですぐ触るべきファイルやタスク

---

## 5. 注意事項

### 5.1. セキュリティ

- プラグインはセッション内容にアクセスするが、外部に送信しない
- 日報ファイルはローカルに保存される
- 機密情報の取り扱いに注意

### 5.2. パフォーマンス

- `session.idle` イベントは毎回発火するが、日報生成は非同期で実行
- セッションの応答に影響しない

### 5.3. エラーハンドリング

- プラグインのエラーはログに記録される
- セッション自体は停止しない

### 5.4. 無効化

- 環境変数 `OPENCODE_DAILY_REPORT_DISABLED=true` で無効化可能
- プラグインファイルを削除しても動作停止

---

## 6. 拡張可能性

### 6.1. 既存プラグインとの組み合わせ

| プラグイン | 組み合わせ効果 |
|-----------|---------------|
| `opencode-notificator` | 日報作成完了時にデスクトップ通知 |
| `opencode-scheduler` | 定期的に日報確認をリマインド |
| `opencode-session-tracker` | セッション履歴と日報を連携 |

### 6.2. 将来の改善案

- [ ] 日報の内容をカスタマイズ可能にする
- [ ] 複数セッションの日報を統合する
- [ ] 日報をGitHub Issueに自動投稿する
- [ ] 日報をSlack/Telegramに通知する

---

## 7. テスト計画

### 7.1. 動作テスト

| テストケース | 期待結果 |
|------------|---------|
| セッション終了時に `session.idle` が発火 | プラグインが日報生成プロンプトを実行 |
| `/daily-report` コマンドを実行 | 手動で日報生成が行われる |
| 環境変数で無効化 | プラグインが動作しない |

### 7.2. エラーテスト

| テストケース | 期待結果 |
|------------|---------|
| daily-handover スキルが見つからない | エラーログが記録され、セッションは停止しない |
| 日報ファイルの書き込み権限がない | エラーログが記録され、セッションは停止しない |

---

## 8. 参考資料

- [OpenCode Plugins ドキュメント](https://opencode.ai/docs/plugins/)
- [OpenCode Commands ドキュメント](https://opencode.ai/docs/commands/)
- [OpenCode Agent Skills ドキュメント](https://opencode.ai/docs/skills/)
- [daily-handover スキル](.github/skills/daily-handover/SKILL.md)

---

## 9. 承認

| 項目 | 状態 |
|------|------|
| 計画承認 | ⏳ 待機中 |
| 実装開始 | ⏳ 待機中 |
| テスト完了 | ⏳ 待機中 |
| 本番反映 | ⏳ 待機中 |
