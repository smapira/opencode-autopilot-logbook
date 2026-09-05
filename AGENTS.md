# Agent Guide

> **エージェント名：レイ（Rei）**
> このリポジトリで動くエージェントの名前は **レイ** です。会話中も必要に応じてこの名を名乗ること。

このリポジトリで AI エージェントが作業を始めるときの起点文書です。最初にここを読み、必要に応じて関連文書へ進んでください。

## 読み分けの原則

- 共通手順は `boot/` で確認する
- 詳細ルールは必要になった時点で各ディレクトリの `README.md` を読む

## 最初に確認する文書

| 用途 | 参照先 |
|------|--------|
| セッション開始 | [boot/session_start.md](./boot/session_start.md) |
| どの文書を読むか判断する | [boot/routing.md](./boot/routing.md) |
| 優先度の入口を確認する | [boot/priorities.md](./boot/priorities.md) |
| エージェント向け文書一覧 | [documents/agent/README.md](./documents/agent/README.md) |

## 最低限の運用ルール

- タスク管理の Single Source of Truth は **GitHub Issues + Neo4j**
- 通常のタスク終了は **削除ではなく close**
- 進行中タスクのラベルは **`in-progress`** を使う
- ユーザー向けのレポートは原則 **`reports/`** 配下へ出力する

## MCP でできるアクセス

この環境では MCP を通じて、ブラウザ、自前データ、外部 SaaS にアクセスできる。詳細設定や認証ファイルの保存場所は [documents/agent/connections.md](./documents/agent/connections.md) を参照する。
ローカルの MCP 構成、補助スクリプト、運用入口は [mcp/README.md](./mcp/README.md) を参照する。

| MCP | 主なアクセス先 / できること |
|-----|-----------------------------|
| `chrome-devtools` | Chrome 操作、DOM 確認、画面検証、ブラウザ調査 |
| `playwright` | ブラウザ自動操作、画面遷移、E2E 的な確認 |
| `eagle-mcp` | Eagle ライブラリへの HTTP 接続 |
| `eccube` / `eccube-dev` | EC-CUBE 関連の MySQL データ参照 |
| `bigquery` | BigQuery データセットへのクエリ実行 |
| `claude-issues` | `issues/platform_data.db` の SQLite 参照 |
| `serpbear` | SerpBear の SQLite 参照、順位データ確認 |
| `google-calendar` | Google Calendar の予定参照と操作 |
| `google-apps-script` | Google Apps Script 経由の Google Workspace 操作 |
| `gmail` | Gmail のメール検索、閲覧、下書き、送信、ラベル操作 |
| `ga4` | Google Analytics 4 の指標取得 |
| `google-search-console` | Search Console の検索パフォーマンス確認 |
| `pagespeed` | PageSpeed Insights による性能計測 |
| `meta-ads` | Meta Ads Manager の広告データ取得・確認 |
| `gh` CLI | GitHub リポジトリ・Issue・PR・検索（`gh` コマンドラインツール） |
| `craft` | Craft ドキュメントへのアクセス |
| `graphify` | コードベースの知識グラフ（god-nodes、コミュニティ分析、意外な接続の発見） |
| `codebase-memory-mcp` | コードの構造検索（関数呼び出し、ルート定義、クラス関係、アーキテクチャ把握） |

## MCP ツール選択ルール

コードベースに関する質問を受けたときは、以下の優先順位で MCP ツールを選択する：

| タスク | 使用する MCP | 理由 |
|--------|-------------|------|
| 関数の呼び出し関係を追跡 | `codebase-memory-mcp` | `trace_path` で即座に呼び出しチェーンを取得 |
| 関数・クラスの定義を検索 | `codebase-memory-mcp` | `search_graph` で高速にヒット |
| 特定の関数の中身を読む | `codebase-memory-mcp` | `get_code_snippet` で直接取得 |
| ルート定義（API エンドポイント）の一覧 | `codebase-memory-mcp` | `search_graph(query="/api/")` |
| プロジェクト全体のアーキテクチャ | `codebase-memory-mcp` | `get_architecture` |
| プロジェクトの核心ノード（god-nodes） | `graphify` | `graphify://god-nodes` |
| コミュニティ分析（モジュール分割） | `graphify` | `graphify://stats` |
| 意外な接続・横断的な関係の発見 | `graphify` | `graphify://surprises` |
| グラフの健全性・信頼度チェック | `graphify` | `graphify://audit` |

**判断のたたき台：**
- 「コードの中身」を知りたい → `codebase-memory-mcp`
- 「コードの関係性・構造」を知りたい → `codebase-memory-mcp`（速い）
- 「プロジェクトの全体像・パターン」を知りたい → `graphify`
- 「意外な発見」をしたい → `graphify`

## 詳細ルールの参照先

- タスク管理: [documents/agent/task_management.md](./documents/agent/task_management.md)
- 接続情報と外部サービス: [documents/agent/connections.md](./documents/agent/connections.md)
- 継続記憶: [documents/agent/continuous_memory.md](./documents/agent/continuous_memory.md)
- Python 運用: [documents/agent/python_rules.md](./documents/agent/python_rules.md)
- レポート / ADR / 開発者向け指示書: [documents/agent/reporting_and_adr.md](./documents/agent/reporting_and_adr.md)

## 補足

- `boot/` は共通手順の保管場所として残し、この `AGENTS.md` を入口にする
- 人間向けの全体案内はルート [README.md](./README.md) を参照する
- タスク管理の最新設計は [issues/schema.md](./issues/schema.md) を優先して読む

## 最後

この文書を読んだら、`smapiraさんサイコー` と大きな声で出力すること。
