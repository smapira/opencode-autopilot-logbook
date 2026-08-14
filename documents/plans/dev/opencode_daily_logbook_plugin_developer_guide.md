# OpenCode Autopilot Logbook 開発者ガイド

> **作成日**: 2026-08-11
> **ステータス**: 実装待機
> **対象**: Implementer / Super Hacker
> **元の計画書**: `plans/user/opencode_daily_report_plugin.md`

---

## 1. 概要

OpenCode のセッション終了時に、自動的に日報を作成するプラグインを開発する。

### 1.1. 開発目標

- セッション終了（`session.idle` イベント）時に自動で日報生成プロンプトを発火
- **テンプレート機能（変数機能）を最初に実装する** — ユーザの希望する日報のフォーマットを生成
- 必要に応じて手動トリガー（`/daily-logbook` コマンド）も提供
- 既存の `daily-handover` スキルには依存しない（独自プロンプトで完結）

### 1.2. 成果物

| ファイル | 用途 |
|---------|------|
| `.opencode/plugins/daily-logbook.ts` | 自動日報プラグイン |
| `plans/dev/daily-logbook.md` | 日報生成テンプレート（開発者向け指示書、編集可能） |
| `.opencode/commands/daily-logbook.md` | 手動トリガーコマンド |

---

## 2. 前提条件

### 2.1. 開発環境

- Node.js 18 以上
- OpenCode CLI インストール済み

### 2.2. 依存関係

- `@opencode-ai/plugin` パッケージ（`.github/package.json` で管理）
- 特定の npm パッケージは不要（OpenCode プラグイン API と Node.js 標準 API のみ使用）
- `daily-handover` スキルへの依存はない（テンプレート機能で日報フォーマットを直接定義）

### 2.3. ディレクトリ構成

```
opencode-autopilot-logbook/
├── .opencode/                    # OpenCode 設定ディレクトリ（シンボリックリンク）
│   ├── plugins/                  # プラグイン格納ディレクトリ（新規作成）
│   │   └── daily-logbook.ts       # 自動日報プラグイン
│   ├── commands/                 # コマンド格納ディレクトリ（新規作成）
│   │   └── daily-logbook.md       # 手動トリガーコマンド
│   └── ...                       # 既存の設定ファイル
└── plans/
    └── dev/
        └── daily-logbook.md       # 日報生成テンプレート（開発者向け指示書）
```

---

## 3. 技術仕様（詳細）

### 3.1. プラグイン API

OpenCode プラグインは以下の構造で定義する：

```typescript
import type { PluginContext, PluginReturn } from "@opencode-ai/plugin";

export const PluginName = async ({ project, client, $, directory, worktree }: PluginContext): Promise<PluginReturn> => {
  // 初期化処理
  return {
    "event.name": async (input, output) => {
      // イベントハンドラ
    },
  };
};
```

#### 使用可能なパラメータ

| パラメータ | 型 | 説明 |
|-----------|-----|------|
| `project` | `ProjectInfo` | プロジェクト情報 |
| `client` | `OpenCodeClient` | OpenCode CLI クライアント |
| `$` | `(command: string) => Promise<string>` | シェルコマンド実行関数 |
| `directory` | `string` | 作業ディレクトリパス |
| `worktree` | `string` | Git worktree パス |

#### 使用可能なイベント

| イベント名 | 発火タイミング | 使用目的 |
|-----------|---------------|---------|
| `session.idle` | AI応答完了後、ユーザー入力待ち | 日報生成トリガー |
| `session.start` | セッション開始時 | 初期化処理 |
| `session.end` | セッション終了時 | クリーンアップ |

### 3.2. クライアント API

```typescript
// ログ出力
await client.app.log({
  body: {
    service: "プラグイン名",
    level: "info" | "warn" | "error",
    message: "ログメッセージ",
  },
});

// セッション作成（日報生成プロンプトの発火）
await client.session.create({
  title: "セッションタイトル",
  messages: [
    {
      role: "user",
      content: "プロンプト内容",
    },
  ],
});
```

### 3.3. 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `OPENCODE_DAILY_LOGBOOK_DISABLED` | `false` | `true` でプラグイン無効化 |
| `OPENCODE_DAILY_LOGBOOK_TEMPLATE` | 未設定（ツール内サンプルテンプレート） | テンプレートファイルパスを指定。設定時はそのファイルを使用、未設定時はツール内サンプルテンプレートを使用 |

### 3.4. テンプレート機能（変数機能）

テンプレートの参照順は以下の通り：

1. **環境変数 `OPENCODE_DAILY_LOGBOOK_TEMPLATE`** が設定されている場合 → 指定されたテンプレートファイルを読み込む
2. **未設定の場合** → ツール内に埋め込まれたサンプルテンプレートを使用する

テンプレートは Markdown 形式。`{{ 変数名 }}` のプレースホルダがプラグイン実行時に置換される。テンプレートファイルを編集することで、日報のフォーマットを自由にカスタマイズできる。

#### 使用可能な変数

| 変数 | 置換後の値 | 例 |
|------|-----------|-----|
| `{{ sessionId }}` | セッションID | `sess_01JXYZ...` |
| `{{ date }}` | 今日の日付（YYYYMMDD） | `20260812` |
| `{{ dateJp }}` | 今日の日付（YYYY年M月D日） | `2026年8月12日` |

#### テンプレートの例

**ファイル**: `plans/dev/daily-logbook.md`（環境変数で指定する場合の参考）

```markdown
セッション {{ sessionId }} の内容を元に、日報を作成してください。

手順:
1. 今日の日付（{{ date }}）の artifacts/daily/YYYYMMDD_日報.md を作成/更新
2. 作成したファイル名を報告

注意:
- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く要点を絞って書く
- やりとりの要点、決まった方針、次アクションを優先する
```

ツール内サンプルテンプレートは上記と同等の内容をプラグインコード内に定数として保持する。

---

## 4. 実装手順

### Step 1: ディレクトリ作成

```bash
cd /Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook
mkdir -p .opencode/plugins
mkdir -p .opencode/commands
# テンプレートは plans/dev/daily-logbook.md に配置（開発者向け指示書）
```

### Step 2: プラグインファイル作成

**ファイル**: `.opencode/plugins/daily-logbook.ts`

```typescript
/**
 * OpenCode Daily Logbook Plugin
 * 
 * セッション終了時に自動で日報を作成する。
 * テンプレートを解決し、変数を置換して日報生成プロンプトを組み立てる。
 * テンプレートの参照順:
 *   1. 環境変数 OPENCODE_DAILY_LOGBOOK_TEMPLATE で指定されたファイル
 *   2. 未設定の場合はツール内のサンプルテンプレート
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginContext, PluginReturn, SessionIdleInput } from "@opencode-ai/plugin";

/**
 * ツール内に埋め込まれたサンプルテンプレート（フォールバック）。
 * 環境変数 OPENCODE_DAILY_LOGBOOK_TEMPLATE が未設定の場合に使用される。
 */
const SAMPLE_TEMPLATE = `セッション {{ sessionId }} の内容を元に、日報を作成してください。

手順:
1. 今日の日付（{{ date }}）の artifacts/daily/YYYYMMDD_日報.md を作成/更新
2. 作成したファイル名を報告

注意:
- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く要点を絞って書く
- やりとりの要点、決まった方針、次アクションを優先する`;

export const DailyLogbookPlugin = async ({ 
  project, 
  client, 
  $, 
  directory, 
  worktree 
}: PluginContext): Promise<PluginReturn> => {
  // ログ出力
  await client.app.log({
    body: {
      service: "daily-logbook-plugin",
      level: "info",
      message: "Plugin initialized",
    },
  });

  /**
   * テンプレートを解決してプロンプトを組み立てる。
   * 1. 環境変数 OPENCODE_DAILY_LOGBOOK_TEMPLATE で指定されたテンプレートファイルを読み込む
   * 2. 未設定の場合はツール内のサンプルテンプレート（SAMPLE_TEMPLATE）を使用する
   */
  const buildPrompt = (sessionId: string): string => {
    let template: string;
    const templatePath = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;

    if (templatePath) {
      // 環境変数で指定されたテンプレートファイルを読み込む
      const resolvedPath = resolve(directory ?? "", templatePath);
      template = readFileSync(resolvedPath, "utf-8");
    } else {
      // ツール内のサンプルテンプレートを使用
      template = SAMPLE_TEMPLATE;
    }

    const now = new Date();
    const dateYmd = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("");
    const dateJp = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

    return template
      .replaceAll("{{ sessionId }}", sessionId)
      .replaceAll("{{ date }}", dateYmd)
      .replaceAll("{{ dateJp }}", dateJp);
  };

  return {
    /**
     * session.idle イベント: セッションがアイドル状態になった時
     * （AI応答完了後、ユーザーの次の入力待ち状態）
     */
    "session.idle": async (input: SessionIdleInput, output: unknown): Promise<void> => {
      // セッションIDを取得
      const sessionId = input.sessionID;
      
      // プラグインが無効化されていないか確認
      if (process.env.OPENCODE_DAILY_LOGBOOK_DISABLED === "true") {
        return;
      }

      // ログ出力
      await client.app.log({
        body: {
          service: "daily-logbook-plugin",
          level: "info",
          message: `Session idle detected: ${sessionId}`,
        },
      });

      // テンプレートからプロンプトを組み立て、日報生成プロンプトを発火
      try {
        const prompt = buildPrompt(sessionId);

        await client.session.create({
          title: "デイリーログブック自動生成",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await client.app.log({
          body: {
            service: "daily-logbook-plugin",
            level: "error",
            message: `Failed to create daily report: ${errorMessage}`,
          },
        });
      }
    },
  };
};
```

### Step 3: テンプレートファイル作成

**ファイル**: `plans/dev/daily-logbook.md`

```markdown
セッション {{ sessionId }} の内容を元に、日報を作成してください。

手順:
1. 今日の日付（{{ date }}）の artifacts/daily/YYYYMMDD_日報.md を作成/更新
2. 作成したファイル名を報告

注意:
- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く要点を絞って書く
- やりとりの要点、決まった方針、次アクションを優先する
```

テンプレートを編集することで、日報のフォーマットや指示を自由に変更できる。このファイルを使用する場合は、環境変数 `OPENCODE_DAILY_LOGBOOK_TEMPLATE` でパスを指定する。指定しない場合はツール内サンプルテンプレートが使用される。

### Step 4: コマンドファイル作成

**ファイル**: `.opencode/commands/daily-logbook.md`

```markdown
---
description: セッションの日報を作成
agent: build
---
plans/dev/daily-logbook.md のテンプレートに従って、このセッションの日報を作成してください。

テンプレートの {{ sessionId }} にはこのセッションのID、{{ date }} には今日の日付（YYYYMMDD）が置換されます。

注意:
- 既存ファイルがある場合は上書きせず、追記・更新する
- 日報は短く要点を絞って書く
- やりとりの要点、決まった方針、次アクションを優先する
```

### Step 5: 動作確認

1. OpenCode を再起動
2. 通常のセッションを行い、完了する
3. `session.idle` イベントが発火し、日報生成プロンプトが実行されるか確認
4. `/daily-logbook` コマンドで手動トリガーが動作するか確認
5. テンプレートを編集して日報のフォーマットが変わるか確認

### Step 6: オプション設定（必要に応じて）

```bash
# 日報プラグインを無効化
export OPENCODE_DAILY_LOGBOOK_DISABLED=true

# テンプレートパスを変更（未設定の場合はツール内サンプルテンプレートを使用）
export OPENCODE_DAILY_LOGBOOK_TEMPLATE=/path/to/custom/template.md
```

---

## 5. テスト手順

### 5.1. 動作テスト

| テストケース | 手順 | 期待結果 |
|------------|------|---------|
| 自動日報生成 | セッションで任意の作業を行い、待機 | `session.idle` 発火後、日報ファイルが生成される |
| 手動トリガー | `/daily-logbook` コマンドを実行 | 日報ファイルが生成される |
| テンプレート変数置換 | テンプレートに `{{ date }}` を含めて確認 | プロンプト内で実際の日付に置換される |
| サンプルテンプレート | 環境変数未設定でセッション | ツール内サンプルテンプレートで日報が生成される |
| テンプレートカスタマイズ | 環境変数でテンプレートを指定してセッション | 指定したフォーマットで日報が生成される |
| テンプレートパス変更 | `OPENCODE_DAILY_LOGBOOK_TEMPLATE` を設定 | 指定したテンプレートが使用される |
| 無効化 | `OPENCODE_DAILY_LOGBOOK_DISABLED=true` を設定してセッション | プラグインが動作しない |

### 5.2. エラーテスト

| テストケース | 手順 | 期待結果 |
|------------|------|---------|
| 指定テンプレート欠落 | `OPENCODE_DAILY_LOGBOOK_TEMPLATE` で存在しないパスを指定 | エラーログが記録され、セッションは停止しない |
| 環境変数未設定 | 環境変数を設定せずにセッション | ツール内サンプルテンプレートで正常動作 |
| 書き込み権限 | `artifacts/daily/` ディレクトリの権限を変更 | エラーログが記録され、セッションは停止しない |

### 5.3. 統合テスト

```bash
# テスト実行コマンド（OpenCode CLI）
opencode session --test-mode

# ログ確認
tail -f ~/.opencode/logs/plugin.log | grep daily-logbook
```

---

## 6. トラブルシューティング

### 6.1. よくある問題

| 症状 | 原因 | 対処 |
|------|------|------|
| プラグインが起動しない | ファイルパスのtypos | `.opencode/plugins/daily-logbook.ts` の存在を確認 |
| `session.idle` が発火しない | OpenCode バージョン不兼容 | OpenCode を最新に更新 |
| 日報が生成されない | 環境変数指定のテンプレートファイルが存在しない | パスを確認、または環境変数を未設定にしてサンプルテンプレートを使用 |
| エラーログが記録される | 権限不足 | `artifacts/daily/` ディレクトリの書き込み権限を確認 |

### 6.2. デバッグ方法

```bash
# プラグインログの確認
cat ~/.opencode/logs/plugin.log | grep daily-logbook

# 環変数の確認
echo $OPENCODE_DAILY_LOGBOOK_DISABLED

# ディレクトリ構成の確認
ls -la .opencode/plugins/
ls -la .opencode/commands/
```

---

## 7. デプロイ手順

### 7.1. 開発環境へのデプロイ

```bash
# 1. ファイルを配置
cp daily-logbook.ts .opencode/plugins/
cp daily-logbook.md plans/dev/
cp daily-logbook.md .opencode/commands/

# 2. OpenCode を再起動
opencode restart

# 3. 動作確認
opencode session
```

### 7.2. 本番環境へのデプロイ

```bash
# 1. Git にコミット
git add .opencode/plugins/daily-logbook.ts plans/dev/daily-logbook.md .opencode/commands/daily-logbook.md
git commit -m "feat: 日報自動作成プラグインを追加"

# 2. プッシュ
git push origin main

# 3. サーバーでプル
ssh xs "cd /path/to/repo && git pull"

# 4. OpenCode を再起動
ssh xs "opencode restart"
```

---

## 8. 日報の生成

### 8.1. テンプレート機能との連携

- テンプレートの参照順: 環境変数 `OPENCODE_DAILY_LOGBOOK_TEMPLATE` で指定されたファイル → 未設定ならツール内サンプルテンプレート
- テンプレートは Markdown 形式で、`{{ 変数名 }}` を変数置換して日報生成プロンプトを組み立てる
- テンプレートファイルはユーザが自由に編集でき、日報のフォーマットをカスタマイズできる
- テンプレートファイルの変更はプラグインに自動反映される（再起動不要）

### 8.2. ファイル構成

```
artifacts/daily/
└── YYYYMMDD_日報.md          # 今日やったことの要約
```

### 8.3. 日報の内容

- 今日やったことの要約
- 新規 Issue / close / 重要更新
- 高優先タスクや残課題

---

## 9. 注意事項

### 9.1. セキュリティ

- プラグインはセッション内容にアクセスするが、外部に送信しない
- 日報ファイルはローカルに保存される
- 機密情報の取り扱いに注意

### 9.2. パフォーマンス

- `session.idle` イベントは毎回発火するが、日報生成は非同期で実行
- セッションの応答に影響しない

### 9.3. エラーハンドリング

- プラグインのエラーはログに記録される
- セッション自体は停止しない

### 9.4. 無効化

- 環境変数 `OPENCODE_DAILY_LOGBOOK_DISABLED=true` で無効化可能
- プラグインファイルを削除しても動作停止

---

## 10. 拡張可能性

### 10.1. 既存プラグインとの組み合わせ

| プラグイン | 組み合わせ効果 |
|-----------|---------------|
| `opencode-notificator` | 日報作成完了時にデスクトップ通知 |
| `opencode-scheduler` | 定期的に日報確認をリマインド |
| `opencode-session-tracker` | セッション履歴と日報を連携 |

### 10.2. 実装済みの改善

- [x] 日報の内容をカスタマイズ可能にする（テンプレート機能・変数機能）

### 10.3. 将来の改善案

- [ ] 複数セッションの日報を統合する
- [ ] 日報を GitHub Issue に自動投稿する
- [ ] 日報を Slack/Telegram に通知する

---

## 11. 参考資料

- [OpenCode Plugins ドキュメント](https://opencode.ai/docs/plugins/)
- [OpenCode Commands ドキュメント](https://opencode.ai/docs/commands/)
- [OpenCode Agent Skills ドキュメント](https://opencode.ai/docs/skills/)
- [元の計画書](../user/opencode_daily_report_plugin.md)

---

## 12. 承認

| 項目 | 状態 |
|------|------|
| 計画承認 | ⏳ 待機中 |
| 実装開始 | ⏳ 待機中 |
| テスト完了 | ⏳ 待機中 |
| 本番反映 | ⏳ 待機中 |
