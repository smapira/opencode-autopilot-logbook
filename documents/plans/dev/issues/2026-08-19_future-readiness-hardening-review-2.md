# Future-Readiness Hardening Plan 再レビュー結果（修正版）

## 優先度
🔴 高 0 件 / 🟡 中 2 件（新規）/ 🟢 低 4 件（新規）— **前回 🔴 2 件は解消済み**

## 対象
- 計画書: `documents/plans/dev/2026-08-19_future-readiness-hardening.md`
- 関連ファイル:
  - `daily-logbook.ts`
  - `package.json`
  - `dist/daily-logbook.js`, `dist/index.js`
  - `README.md`, `README.jp.md`, `CHANGELOG.md`
  - `.github/commands/daily-logbook.md`, `.opencode/commands/daily-logbook.md`
- 前回レビュー: `documents/plans/dev/issues/2026-08-19_future-readiness-hardening-review.md`

---

## 検証サマリ

前回の差し戻し要因（🔴 2 件）は修正版で正しく解消されていることをコードベース実態と照合して確認した。🟡 3 件・🟢 3 件も計画に反映済み。ただし、新規に軽微な指摘（🟡 2 件・🟢 4 件）を発見した。いずれも実装ブロッカーではなく、実装時に反映すれば問題ない水準。

---

## 前回指摘の解消確認

### 🔴 Issue 1: テスト計画の実行可能性 — ✅ 解消

| 指摘 | 修正版の対応 | 確認 |
|------|------------|------|
| `node:test` は TS 実行不可 | `bun test` を採用（制約・テスト計画の両方に明記） | ✅ bun 1.3.12 が環境に導入済みで実行可能。peerDependency のため追加依存なしの前提も正しい |
| テスト対象関数が未エクスポート | named export（`export function maskSecrets(...)` 等）で切り出し、`daily-logbook-utils.ts` 分離も許容 | ✅ 既存 export への追加は後方互換。`bun build` がバンドルするため配布物不変の記述も正確 |
| `test` スクリプトなし | `"test": "bun test"` を追加（テスト計画セクションに明記） | ✅ 計画上のタスクとして定義済み（package.json への反映は実装フェーズ） |
| スロットリング判定が Map 依存 | `isWithinWindow(lastTriggeredAt, nowMs, windowMs)` 純粋述語化を明記 | ✅ |

### 🔴 Issue 2: daily-limit の判定メカニズム — ✅ 解消

| 指摘 | 修正版の対応 | 確認 |
|------|------------|------|
| 判定方法が未定義 | `fs.existsSync` によるファイルベース判定を明記（タスク 4） | ✅ |
| インメモリだと再起動でリセット | 「プロセス再起動を跨いで機能する」を受け入れ条件に明記 | ✅ |
| カスタムテンプレート併用時の判定不能 | warning ログ + README に「非対応」明記 | ✅ |
| TOCTOU | `inFlightSessionIds` ガードで緩和（許容範囲）と明記 | ✅ |

### 🟡 Issue 3〜5 / 🟢 Issue 6〜8 — ✅ 解消

- **Issue 3**（CHANGELOG 乖離・version bump）: タスク 5 に 1.1.0 更新 + 1.0.6〜1.1.0 追記（未記録分は要約可）を明記。CHANGELOG が 1.0.5 で停止している実態とも一致 ✅
- **Issue 4**（git 追跡・npm 公開物）: `git rm dist/daily-logbook.js`・`npm pack --dry-run`・再ビルド後のコミットをタスク 2 の受け入れ条件に明記。`git ls-files` で `dist/daily-logbook.js` が追跡済みである実態とも一致 ✅
- **Issue 5**（コマンド定義の扱い）: リポジトリローカル運用として残す + 「プラグイン機能ではない」旨の明記 + 残存 README 主張の照合項目列挙。2 ファイルが同一内容で未コミットである実態とも一致 ✅
- **Issue 6**（English-first 整合）: タスク 1 の受け入れ条件に確認項目として明示 ✅
- **Issue 7**（パース仕様・優先関係）: `"true"` 厳密一致 / THROTTLE_MS は整数パース NaN で 90000 / 優先関係の 1 行明記をタスク 5 に反映 ✅
- **Issue 8**（マスキング適用順序）: truncate 前適用・対象は transcript のみをタスク 3 に明記 ✅

---

## 新規指摘

## 🟡 中

### Issue A: daily-limit のファイルパス解決基準が未定義（タスク 4）

**指摘事項**:
- タスク 4 は「`{{ outputDir }}/{{ date }}_logbook.md` の存在を `fs.existsSync` でチェック」と定義するが、`outputDir` を**どの基準で解決するか**（プラグインの `directory` 引数基準か、プロセス CWD 基準か）が未定義。
- 既存コードの `loadTemplate` は `resolve(directory, customTemplatePath)` で `directory` 基準。一方 `getOutputDir()` は CWD 基準の相対パス文字列を返すだけ。
- プラグインの存在チェックと、プロンプト文字列を受け取ったエージェントの生成基準（CWD）がズレると、daily-limit が機能しない（存在しないパスをチェックし続ける）。

**改善案**:
- タスク 4 に「ファイル存在チェックは `resolve(directory, getOutputDir(), \`${date}_logbook.md\`)` のように `directory` 引数基準に統一する」ことを明記する（`loadTemplate` と同じ基準）。
- 受け入れ条件に「チェック基準（`directory` ベース）が README の出力パス表記と一致すること」を追加する。

---

### Issue B: daily-limit の判定ロジックがテスト計画に含まれていない

**指摘事項**:
- テスト計画の対象は「タスク 4: スロットリング判定（ウィンドウ境界・NaN フォールバック）」のみで、タスク 4 の中核機能である **daily-limit のファイル存在判定**（日付ファイル名の組み立て + 存在チェック）がテスト対象に明記されていない。
- 受け入れ条件（「同一日付の 2 回目の idle ではスキップ」「再起動跨ぎ」）はテスト可能な形で定義されているため、実装時に書けるが、計画上で対象外に見える。

**改善案**:
- テスト計画の対象に「タスク 4: daily-limit のファイル存在判定（存在時スキップ・日付ファイル名生成）」を追加する。
- 判定を純粋関数化（例: `buildDailyLogbookPath(outputDir: string, date: string): string` と `shouldSkipDailyLimit(exists: boolean): boolean` 程度の分解）してテスト容易にする旨を明記する。

---

## 🟢 低

### Issue C: 「追記運用が 1 日 1 回になる」ことの README 明記が欠落

**指摘事項**:
- 前回 Issue 2 の改善案 4（「README に daily-limit 有効時は追記運用が 1 日 1 回になることを明記」）が、修正版タスク 4 の本文・受け入れ条件・タスク 5 のいずれにも明示されていない。
- README の「Existing files are updated (appended), not overwritten.」と daily-limit は矛盾するため、挙動変化の明記が必要。

**改善案**:
- タスク 4 またはタスク 5 に「daily-limit 有効時の追記運用の変化（1 日 1 回になる）」を README に明記する旨を追加する。

---

### Issue D: 空ファイル・生成失敗時の daily-limit 副作用への言及がない

**指摘事項**:
- 前回 Issue 2 で指摘した「ファイルが存在しても空・不完全（生成失敗）の場合、当日中の再生成がブロックされる」副作用の扱い（許容 or サイズ閾値）が修正版に反映されていない。

**改善案**:
- 許容する（シンプルな存在チェックに徹する）ことを明記し、README にも「存在チェックのみで中身は検証しない」旨を 1 行追記する。

---

### Issue E: タスク 4・5 の見出し typo「振るべえ」

**指摘事項**:
- タスク 4 と 5 の見出しが「**振るべえ**」（タスク 3 のみ「振る舞い」）。文書品質上の軽微な typo。

**改善案**:
- 「振るべえ」→「振る舞い」に修正する。

---

### Issue F: 未承認のまま作業ツリーに変更が入っている（プロセス上の注意）

**指摘事項**:
- 本計画が未承認の時点で、`daily-logbook.ts`・`README.md`・`README.jp.md`・`package.json`・`dist/index.js` に未コミットの変更が存在する（`git status` で M）。
  - `daily-logbook.ts`: SAMPLE_TEMPLATE への English-first 追記 + `{{ dateJp }}` の挙動変更（ISO `YYYY-MM-DD` → 日本語 `YYYY年M月D日`）
  - `package.json`: build スクリプトの引数整理（`--outdir dist --outfile index.js` → `--outfile dist/index.js`）
  - `README*`: English-first の Feature 行追加
  - `dist/index.js`: 上記を反映した再ビルド生成物
- `dateJp` の挙動変更は本計画のスコープ外（タスク 1〜5 のどこにも含まれない）の破壊的変更に当たり得る（`{{ dateJp }}` を利用中のカスタムテンプレートがある場合、出力が変わる）。

**改善案**:
- Product Manager が実装着手前に、作業ツリーの既存変更を「本計画の実装に取り込む」か「リセットして計画タスクからやり直す」かを明示してから Implementer へ引き継ぐ。
- `dateJp` の挙動変更は CHANGELOG に breaking 項目として記録する（バージョン 1.1.0 内での明記で可）。

---

## 備考

- 前回 🔴 2 件（テスト計画の実行可能性・daily-limit 判定メカニズム）は、コードベース実態（bun 導入済み・関数の非公開性・git 追跡状況）と照合して解消を確認した。
- タスク粒度（5 件）・後方互換（既定値で現行挙動維持）・環境変数命名規約・マスキングを「フェイルセーフ」と位置付ける点は引き続き妥当。
- 新規指摘はすべて軽微な追記・明示で対応可能であり、実装ブロッカーは存在しない。

## 判定

**承認** — 前回の 🔴 2 件は解消済み。Issue A・B（🟡）と C〜F（🟢）は改善提案として実装依頼時に添付し、Implementer へ引き継いでよい。特に Issue A（パス解決基準）と Issue B（daily-limit テスト）はタスク 4 の実装時に必ず反映すること。
