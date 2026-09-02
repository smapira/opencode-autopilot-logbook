# Plan: logbook末尾に usage (cost/tokens) 追記 — plugin統合 (Issue 20250902)

## 背景
- 現行 `artifacts/daily/YYYYMMDD_logbook.md` は transcript 要約のみ。費用は `~/.local/share/opencode/opencode.db` を手動参照する必要がある
- 案B: 本プラグインに統合し `session.idle` と原子的に日報と usage を残す
- 既存挙動は維持しつつ、環境変数で opt-in する後方互換設計とする

## 目標
- `OPENCODE_DAILY_LOGBOOK_APPEND_USAGE=true` 時に、logbook プロンプトへ usage 統計を自動挿入できる
- テンプレート内で `{{ usage }}` / `{{ usageTable }}` を任意位置に配置可能、未配置なら末尾に自動追記
- `opencode.db` 読み取りは read-only、失敗しても既存の日報生成は継続する

---

## BDD タスク分解

### Task 1: getUsageStats 実装 — opencode.db から集計取得
- **振る舞い:** `getUsageStats({ directory, sessionId, date, projectOnly })` を呼ぶと `{ dayCost, sessionCost, tokensInput, tokensOutput, cacheRead, sessionsToday, totalCost }` を返す
- **正常系:**
  - `directory=/Users/.../opencode-autopilot-logbook` が `project.worktree` に一致 → `project_id` を解決し、当該 project のみで集計
  - `directory` がグローバル `/` や未知パス → project 解決できず全 project で集計（フォールバック）
  - `sessionId` が存在する → `sessionCost` を session 行から取得
- **エッジケース:**
  - DB ファイルが存在しない / パーミッションエラー → `null` を返し呼び出し元は usage なしで継続（`existsSync` 事前チェックまたは `new Database` の try/catch でフォールバック）
  - `project_id` 解決失敗 → 全体集計にフォールバック
  - `sessionId` が見つからない → `sessionCost = null`
  - 当日データ 0 件 → `dayCost=0`, `sessionsToday=0`
- **データ例:**
  - `sqlite3` 中身: `session(cost=0.21, tokens_input=1200000, tokens_output=45000, tokens_cache_read=890000, time_created=1725235200000)` が 3 行 → `dayCost=2.31`, `tokensInput=1.2M` 相当
  - `project(id=350d..., worktree=/Users/.../opencode-autopilot-logbook)` が対象
- **実装:** `bun:sqlite` の `Database` (read-only) を使用。全クエリは `?` バインド（文字列補間禁止）。日付一致は `date(datetime(time_created/1000,'unixepoch','localtime')) = ?` に `YYYY-MM-DD` をバインド（`time_created` は ms epoch のため `/1000` 必須、localtime で `formatDateTokens` と整合）。`coalesce(sum(...),0)` で null 回避。範囲クエリ `time_created >= ? AND time_created < ?` は sargable だが現行は可読性優先の `date(datetime(...))` を採用（project 絞り込みで数百行なら <50ms、将来遅延が顕在化したら切替）。`totalCost` は `projectOnly` に従い same scope（project絞り込み時は当該 project 累計、false 時は全 project 累計）

### Task 2: replaceTemplateVariables 拡張 — {{ usage }} / {{ usageTable }} 置換
- **振る舞い:** テンプレート内の `{{ usage }}` / `{{ usageTable }}` を usageTable 文字列で置換する（`{{ usage }}` が canonical、`{{ usageTable }}` は同義エイリアス）
- **正常系:**
  - テンプレート `Hello {{ usage }}` + usageTable=`| Cost | $2.31 |` → `Hello | Cost | $2.31 |`
  - `{{ usageTable }}` も同様に置換
  - usage が null の場合は空文字に置換
- **実装注意:** `String.prototype.replace(regex, string)` の第2引数は `$&,$1,$2,$$` を特殊展開するため `$2.31` が壊れる。必ず関数形式 `() => usageTable ?? ""` で置換する（既存の4変数も含め統一）
- **異常系/エッジ:**
  - テンプレに両方の変数が複数回含まれる → 全置換 (global)
  - テンプレに変数がない → 何もしない（Task 3 の自動追記に委譲）
  - `usageTable` に `$` を含む → 関数形式で安全に置換されることをテストで検証
- **データ例:** `template="## Daily\n{{ usage }}"`, `usageTable="| Cost | $2.31 |"`

### Task 3: buildPrompt 拡張 — 未配置時の自動末尾追記
- **振る舞い:** `buildPrompt(template, ..., usageTable, appendUsage)` が、テンプレに `{{ usage }}` / `{{ usageTable }}` のいずれもなくかつ `appendUsage=true` かつ `usageTable` が非 null なら、プロンプト末尾に `\n\n---\n\n{{ usageTable }}` を自動追記する
- **正常系:**
  - テンプレに `{{ usage }}` / `{{ usageTable }}` のいずれかあり → 置換のみ、自動追記なし
  - テンプレに両変数なし + appendUsage true → 末尾に usageTable 追記
  - テンプレに両変数なし + appendUsage false → 追記なし（既存互換）
- **エッジ:**
  - usageTable が null/空 → 追記しない
  - transcript が空でも usage は追記可能
  - `{{ usageTable }}` 配置時に二重追記しないことを検証

### Task 4: 環境変数制御
- **振る舞い:**
  - `OPENCODE_DAILY_LOGBOOK_APPEND_USAGE === "true"` のときのみ Task1-3 を有効化（default false）
  - `OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY !== "false"` なら project 絞り込み（default true）
  - `OPENCODE_DAILY_LOGBOOK_DB_PATH` があればそれを DB パスに使用、なければ `~/.local/share/opencode/opencode.db` (HOME 解決)
- **正常系:**
  - `APPEND_USAGE=true`, `USAGE_PROJECT_ONLY=true` → project 絞り込みで集計
  - `APPEND_USAGE=true`, `USAGE_PROJECT_ONLY=false` → 全 project 集計
  - 未設定 → 既存挙動（usage 取得自体をスキップ）
- **エッジ:** 環境変数が空文字 / "True" (大文字) → false 扱い（厳密に "true" のみ true）

### Task 5: formatUsageTable 実装
- **振る舞い:** `formatUsageTable(stats, date, projectDisplayName)` が Markdown テーブル文字列を返す
- **正常系データ例:**
  ```
  | 項目 | 値 |
  |---|---|
  | Cost (本日/セッション) | $2.31 / $0.21 |
  | Tokens Input / Output / Cache Read | 1.2M / 45K / 890K |
  | Sessions (本日) | 3 |
  | Total Cost (累計) | $1314.50 |
  ```
  - `projectDisplayName` があれば見出し `## Usage — 2026-09-02 (project: opencode-autopilot-logbook)` に含める
- **エッジ:**
  - `sessionCost=null` → `Cost (本日) | $2.31` のようにセッション部分を省略
  - `stats=null` → 空文字を返す
- **フォーマッタ:** `formatCost(n)=$n.toFixed(2)`, `formatTokens(n)=1.2M/45K` 方式（>=1B→B, >=1M→M, >=1K→K）

### Task 6: プラグイン統合 — session.idle ハンドラ
- **振る舞い:** `session.idle` 発火時に、既存の transcript 取得の後に usage 取得を挿入し、`buildPrompt` に渡す。エラーでも日報生成は継続
- **挿入順序（必須）:** `inFlight check → daily-limit guard (dailyLimitInFlightByDate) → isDailyLogbookExists check` を通過した後に `try { getUsageStats }` を配置。daily-limit の早期 return 前に DB を開かない（無駄な I/O と不要な warn を回避）。`finally` の `dailyLimitInFlightByDate.delete(date)` は usage 失敗時も維持
- **正常系:** `APPEND_USAGE=true` → try { getUsageStats } → format → buildPrompt → promptAsync
- **異常系/エッジ:**
  - DB open 失敗 → warn ログ + usage なしで継続
  - getUsageStats が例外 → catch し warn ログ + usage なしで継続
  - 既存の throttle / daily-limit / in-flight ガードはそのまま維持
- **データ例:** `directory=/Users/.../opencode-autopilot-logbook`, `sessionId=ses_xxx`, `date=20260902`

### Task 7: テスト
- **単体テスト:**
  - `formatUsageTable` の正常/セッション null/stats null ケース
  - `replaceTemplateVariables` の `{{ usage }}` / `{{ usageTable }}` 置換（複数回、`$` 含み置換の回帰含む）
  - `buildPrompt` の自動追記あり/なし分岐（`{{ usage }}` / `{{ usageTable }}` のいずれかが含まれるかで判定、二重追記しないこと）
  - `getUsageStats` は `bun:sqlite` をモックせず、tmp DB (file) を作って検証（`OPENCODE_DAILY_LOGBOOK_DB_PATH` を tmp に向け `readonly:true` で open、存在しないパスで `null` 返却）
  - `getDbPath` / `isAppendUsageEnabled` / `isUsageProjectOnly` の env 分岐（`PLUGIN_ENV_KEYS` に新3変数を追加し snapshot/restore で隔離）
  - `directory` 末尾スラッシュ正規化、未知パス→全体集計フォールバック
- **統合テスト:** モック client + tmp DB を用いた `DailyLogbookPlugin` の 6 パターン: usageあり(projectOnly true/false), usageなし(DB不在), DBエラー(BUSY含む), daily-limit suppress 時に DB open しないこと
- **テスト種別:** Unit (bun:test) + Plugin integration (既存の harness 再利用)

### Task 8: ドキュメント
- **振る舞い:** README.md / README.jp.md に Usage 追記機能の説明を追記
- **内容:** 環境変数 3 つ、テンプレート変数 2 つ、DB パス解決、read-only である旨、デフォルト無効の注意

---

## 非機能要件
- `opencode.db` は 15GB 超。集計クエリのみで `SELECT coalesce(sum(...))` を `project_id` + 日付で絞る。`session` テーブルは `project_id` に index あり（`date(datetime(...))` は index 後の filter だが project 絞り込みで数百行なら <50ms）
- read-only open: `new Database(path, { readonly: true })` + `try/finally close`。WAL モードでも read-only SELECT は可能。DB 不在時は `existsSync` または try/catch で `null` フォールバック
- 全クエリは `?` バインド、文字列補間禁止
- `~` 展開は `homedir()` + `join()` で行う。`directory` の正規化は `resolve()` で末尾 `/` を除去して比較
- 依存追加なし: `import { Database } from "bun:sqlite"` は `bun build --target bun` でランタイム供給。`better-sqlite3` 等の追加はしない

## 受け入れ条件
- [ ] `OPENCODE_DAILY_LOGBOOK_APPEND_USAGE=true` で idle 時に usageTable がプロンプトに含まれる
- [ ] `{{ usage }}` をテンプレに置くと任意位置に挿入され、未配置なら末尾に自動追記される
- [ ] `USAGE_PROJECT_ONLY=true/false` で絞り込みが切り替わる
- [ ] DB 不在/エラー時も日報生成が成功する（usage なしで継続）
- [ ] 既存テスト 45 pass が維持され、新規テストが pass
- [ ] デフォルト (env 未設定) で既存挙動が変わらない

## 制約
- 編集は `daily-logbook.ts`, `test/daily-logbook.test.ts`, `README.md`, `README.jp.md`, `documents/plans/dev/*` のみ
- `src/Eccube` 等は存在しないため対象外。`app/` 配下のみに相当する本リポジトリのルートのみ編集
