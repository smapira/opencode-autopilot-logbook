# Plan Review: logbook末尾に usage (cost/tokens) 追記 — 20250902_usage-append.md

## 判定
🟡 条件付き承認 — 🔴 3件の必須修正を反映すれば実装可。🟡 4件は対応推奨、🟢 は任意。

## 検証対象
- 計画書: `documents/plans/dev/20250902_usage-append.md` (122行, Task1-8)
- コードベース: `daily-logbook.ts` (448行), `test/daily-logbook.test.ts` (558行), `package.json` (build: `bun build --target bun`)
- DB実査: `~/.local/share/opencode/opencode.db` (15.4GB, 2251行, `session.time_created` は ms epoch, `session_project_idx` に index あり), `project.worktree` に `/Users/.../opencode-autopilot-logbook` 存在確認済み

---

## 🔴 高 — 必ず修正

### 🔴-1 Task3 自動追記の判定が `{{ usage }}` のみ — `{{ usageTable }}` 使用時に二重追記する
- **対象:** 計画書 Task3, `buildPrompt` 拡張
- **指摘:** 現行文面 `テンプレに {{ usage }} がなくかつ appendUsage=true` では、`{{ usageTable }}` を配置したテンプレートで自動追記が誤発火し同じテーブルが2回出現する。Task2で両者を同値と定義しているなら判定も両者を対象にすべき。
- **改善案:**
  ```ts
  // daily-logbook.ts
  const USAGE_PLACEHOLDER_RE = /\{\{\s*usage(Table)?\s*\}\}/g;
  const hasUsagePlaceholder = USAGE_PLACEHOLDER_RE.test(template);
  // または個別に
  const hasUsage = /\{\{\s*usage\s*\}\}/.test(template) || /\{\{\s*usageTable\s*\}\}/.test(template);
  ```
  計画書 Task3 の「正常系: テンプレに `{{ usage }}` あり → 置換のみ」を `{{ usage }} / {{ usageTable }} のいずれかが含まれる → 置換のみ` に修正。

### 🔴-2 `replaceTemplateVariables` の置換で `$` が解釈される — `$2.31` が capture参照で壊れる
- **対象:** Task2, `replaceTemplateVariables` 拡張
- **指摘:** `String.prototype.replace(regex, string)` の第2引数は `$&,$1,$2,$$` を特殊扱いする。`usageTable` は `| Cost (本日/セッション) | $2.31 / $0.21 |` を含むため `$2` が空文字に置換され `$.31` 等に化ける。既存の4変数は `$` を含まないため顕在化していないが、新変数で確実に発火する。
- **改善案:** 置換は関数形式で実装し、既存の4変数も合わせて統一する。
  ```ts
  .replace(/\{\{\s*usage\s*\}\}/g, () => usageTable ?? "")
  .replace(/\{\{\s*usageTable\s*\}\}/g, () => usageTable ?? "")
  // 既存も同様に () => sessionId で安全化するか、少なくとも新変数は関数形式
  ```
  計画書 Task2 に「置換は関数形式 `() => usageTable` を用い `$` の特殊展開を回避」と明記。

### 🔴-3 SQL組み立てが文字列補間 — パラメータバインドを明記
- **対象:** Task1 実装, 非機能要件
- **指摘:** 計画書に `date(datetime(time_created/1000,'unixepoch','localtime')) = 'YYYY-MM-DD'` とリテラル例示があるが、実装で補間をするとクォート漏れ・将来の拡張で injection になる。`bun:sqlite` は `prepare().get(...params)` でバインドできる。
- **改善案:** 計画書に以下を追記
  ```ts
  const stmt = db.prepare(`
    SELECT coalesce(sum(cost),0) AS dayCost,
           coalesce(sum(tokens_input),0) AS tokensInput
    FROM session
    WHERE project_id = ? AND date(datetime(time_created/1000,'unixepoch','localtime')) = ?
  `);
  stmt.get(projectId, yyyyMmDd);
  ```
  また `sessionCost` 取得は `SELECT cost FROM session WHERE id = ?` でバインド。非機能要件に「全クエリは `?` バインド、文字列補間禁止」を明記。

---

## 🟡 中 — 対応推奨

### 🟡-1 `time_created/1000` の localtime 対応は正しいが、パフォーマンス注記が不足
- **対象:** 検証項目2, Task1
- **事実:** `sqlite3` 実査で `time_created=1788350622778` → `datetime(time_created/1000,'unixepoch','localtime')=2026-09-02` が一致。`formatDateTokens` は `getFullYear/getMonth/getDate` (local) なので `localtime` を付ける判断は正しい。
- **改善案:** 現行 `date(datetime(...)) = ?` は `session_project_idx(project_id)` で絞った後の full-scan になる。`EXPLAIN QUERY PLAN` 実査で `SEARCH session USING INDEX session_project_idx` 後に filter されることを確認済み。project絞り込みで数百行程度なら15GBでも <50ms で問題ないが、代替として範囲クエリ `time_created >= ? AND time_created < ?` (JSで `setHours(0,0,0,0)` のmsを計算) の方が sargable で索引活用できる。計画書に「現行は可読性優先、将来遅延が顕在化したら範囲クエリに切替」とトレードオフを1行追記。

### 🟡-2 usage 取得の挿入位置が曖昧 — daily-limit の早期return前だと無駄なDB open
- **対象:** Task6, 既存 `dailyLogbook.ts:322-373` の daily-limit ガード
- **指摘:** Task6「既存の transcript 取得の後に usage 取得を挿入」だけでは、`isDailyLimitEnabled()` の `isDailyLogbookExists()` / `dailyLimitInFlightByDate` による早期returnより前に DB を開く可能性。無駄な I/O かつ daily-limit の suppress 時に不要な warn ログが出る。
- **改善案:** 計画書 Task6 に挿入順序を明示: `inFlight check → daily-limit guard → isDailyLogbookExists check → try { getUsageStats } → loadTemplate → buildTranscript → buildPrompt → create/promptAsync`。また `finally` の `dailyLimitInFlightByDate.delete(date)` は usage 失敗時も維持されることを図で示す。既存の throttle / in-flight との整合性を担保。

### 🟡-3 `directory` vs `project.worktree` の正規化
- **対象:** Task1 正常系, `PluginInput` ( `directory`, `worktree`, `project` )
- **指摘:** `directory` は PluginInput の `directory: string` (常に絶対パス, 実査で `/Users/.../opencode-autopilot-logbook` が `project.worktree` と一致) だが、末尾 `/` や symlink 差異で完全一致しないケースがある。`global` プロジェクト (`worktree=/`) はフォールバックで全体集計という仕様は正しいが、比較時の正規化が未規定。
- **改善案:** `getUsageStats` 内で `projectId` 解決は `project.worktree` ではなく `PluginInput.project.id` を直接使うのが最も確実（プラグインは `project` を受け取れる）。もし `directory` 文字列で照合するなら `resolve(directory)` で正規化し、`worktree` 比較時は `normalizePath()` (末尾 `/` 除去) を挟む。`getDbPath` の `~` 展開は `homedir()` + `join()` で行うことを計画書に明記。テストに「末尾スラッシュ付き worktree」「未知パス→全体集計フォールバック」を追加。

### 🟡-4 テスト計画の粒度 — 環境変数の snapshot/restore と projectOnly 分岐が不足
- **対象:** Task7
- **指摘:** 既存テスト `PLUGIN_ENV_KEYS` (`test/daily-logbook.test.ts:273-281`) は snapshot/restore を厳密に行っている。新規3変数 `APPEND_USAGE`, `USAGE_PROJECT_ONLY`, `DB_PATH` を追加しないとテスト間で汚染する。また `USAGE_PROJECT_ONLY=true/false` の統合テスト分岐が Task7 の「4パターン」に含まれていない。
- **改善案:** Task7 に以下を追記:
  - `PLUGIN_ENV_KEYS` に3変数を追加し `snapshotPluginEnv/restorePluginEnv` で隔離
  - `getUsageStats` は tmp DB (file) で検証する際、`OPENCODE_DAILY_LOGBOOK_DB_PATH` を tmp に向け `readonly:true` で開くこと、存在しないパスで `null` 返却を検証
  - 統合テストは 6パターンに拡張: usageあり(projectOnly true/false), usageなし(DB不在), DBエラー(BUSY含む), daily-limit suppress 時に DB open しないこと
  - `replaceTemplateVariables` は `{{ usage }}` と `{{ usageTable }}` が複数回含まれるケースと `$` 含み置換の回帰を追加

---

## 🟢 低 — 任意だが直すと良い

### 🟢-1 テンプレート変数名のエイリアス冗長性
- `{{ usage }}` と `{{ usageTable }}` が完全同値なら、ドキュメントで canonical を `{{ usage }}` に一本化し `{{ usageTable }}` は後方互換エイリアスと明記すべき。両方を広めると利用者が迷う。計画書 Task8 の README 追記時に「推奨は `{{ usage }}`、 `{{ usageTable }}` は同義エイリアス」と1行添える。

### 🟢-2 DB open 前の exists チェックと readonly の挙動
- `new Database(nonexistent, {readonly:true})` は Bun で例外を投げる (実査で `readonly:true` の正常 open は成功)。Task1 エッジケース「DB ファイルが存在しない → null」は `existsSync(dbPath)` を先にチェックするか、try/catch で `Database` コンストラクトを包むかのいずれかが必要。計画書に「open 前に `existsSync` または try/catch で `null` フォールバック」と明記。

### 🟢-3 resource 制約と `totalCost` の定義
- Task1 の `totalCost` は「累計」の定義が曖昧 (project絞り込み時の累計か、全project累計か)。`dayCost/sessionsToday` と同じスコープ (projectOnly に従う) に統一することを計画書に明記。`formatUsageTable` の見出し `projectDisplayName` は `basename(worktree)` または `project.name` のどちらを使うか固定。

### 🟢-4 編集範囲と import
- 制約「編集は `daily-logbook.ts` ... のみ」は妥当。`bun:sqlite` の import は `import { Database } from "bun:sqlite"` をファイル先頭に追加し、`--target bun` で外部化されることをコメントで補足。`better-sqlite3` 等の追加依存は不要と再確認済み (実査で `bun -e "new Database(..., {readonly:true})"` が 15GB DB で成功)。

### 🟢-5 セキュリティ — read-only + finally close
- 計画書の「read-only open: `new Database(path, { readonly: true })` + `try/finally close`」は正しい。補足として `WAL` モードの DB でも read-only で `SELECT` は可能であること (実査で `opencode.db-wal` 存在下でも成功) を非機能要件に追記するとレビュアの懸念を解消できる。

---

## 検証項目別判定

| # | 検証項目 | 判定 | 備考 |
|---|---------|------|------|
| 1 | bun:sqlite 利用妥当性 | ✅ 妥当 | `bun build --target bun` で `bun:sqlite` はランタイム供給。better-sqlite3 不要。実査で readonly open 成功。 |
| 2 | time_created ms対応 (÷1000) | ✅ 正しい | 計画書 `time_created/1000` + `localtime` は `formatDateTokens` の local 日付と整合。要件通りの `coalesce(sum,0)` も含む。 |
| 3 | in-flight/throttle/daily-limit 整合 | 🟡 要明確化 | 挿入位置を daily-limit 早期return 後に限定すべき。finally クリーンアップは維持。 |
| 4 | 環境変数命名・デフォルト | ✅ 一貫 | `APPEND_USAGE === "true"` (opt-in, isPluginDisabled/isDailyLimitEnabled と同型), `USAGE_PROJECT_ONLY !== "false"` (opt-out, isRedactEnabled と同型) は既存規約に準拠。 |
| 5 | テンプレート変数命名・重複防止 | 🔴 要修正 | `$` 展開バグと Task3 の `usageTable` 判定漏れ。 |
| 6 | テスト計画粒度 | 🟡 要補強 | 環境変数 snapshot、projectOnly分岐、DB不在/BUSY、$回帰を追加。 |
| 7 | セキュリティ (read-only, フォールバック) | ✅ 概ね良い | パラメータバインドと exists/try-catch の明記で完成。 |

---

## 推奨する計画書差分 (抜粋)

```diff
- Task 3: テンプレに `{{ usage }}` がなくかつ ...
+ Task 3: テンプレに `{{ usage }}` / `{{ usageTable }}` のいずれもなくかつ ...

- Task 2: .replace(/\{\{\s*usage\s*\}\}/g, usageTable)
+ Task 2: .replace(/\{\{\s*usage\s*\}\}/g, () => usageTable ?? "")
+         .replace(/\{\{\s*usageTable\s*\}\}/g, () => usageTable ?? "")
+         // $ の特殊展開を避けるため関数形式

- Task 1: date(datetime(time_created/1000,'unixepoch','localtime')) = 'YYYY-MM-DD'
+ Task 1: date(datetime(time_created/1000,'unixepoch','localtime')) = ?  -- ? バインド, 補間禁止
+         // 別案: time_created >= ? AND time_created < ? (ms範囲) は将来の性能対策として注記

- Task 6: 既存の transcript 取得の後に usage 取得を挿入
+ Task 6: daily-limit の isDailyLogbookExists / dailyLimitInFlightByDate ガード通過後に
+         try { getUsageStats } を挿入。失敗時は warn ログのみで日報生成継続
```

---

## 次のアクション (Implementer への指示)

1. 上記 🔴 3件を計画書に反映 (Task2,3,1の修正)
2. 🟡 4件を計画書の実装手順・テスト計画に追記
3. その後 `Implementer` に引き継ぎ可 — 編集範囲は `daily-logbook.ts`, `test/daily-logbook.test.ts`, `README.md`, `README.jp.md` のみで問題なし
