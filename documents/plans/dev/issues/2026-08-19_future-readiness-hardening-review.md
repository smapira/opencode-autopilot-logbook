# Future-Readiness Hardening Plan レビュー結果

## 優先度
🔴 高（差し戻し要因 2 件 / 合計 8 件）

## 対象
- 計画書: `documents/plans/dev/2026-08-19_future-readiness-hardening.md`
- 関連ファイル:
  - `daily-logbook.ts`
  - `package.json`
  - `dist/daily-logbook.js`, `dist/index.js`
  - `README.md`, `README.jp.md`, `CHANGELOG.md`
  - `.github/commands/daily-logbook.md`, `.opencode/commands/daily-logbook.md`

---

## 検証サマリ

計画のスコープ・BDD タスク分解・後方互換への配慮は概ね妥当。現状照合表（レビュー vs コードベース）も実態と一致している（`.github/commands/daily-logbook.md` が未コミットで存在、`dist/` に旧 `daily-logbook.js` が同居、`buildTranscript` が生 transcript を埋め込み、スロットリングは 90 秒固定）。

一方で **テスト計画が現状のコードベースでは実行不可能**（🔴）、**daily-limit の判定メカニズムが未定義**（🔴）という実装ブロッカーが 2 件ある。以下を反映すれば再レビューで承認可能な水準。

---

## 🔴 高

### Issue 1: テスト計画が実行不可能 — `node:test` は TS ソースを実行できない / テスト対象関数が未エクスポート / test スクリプトなし

**指摘事項**:
- `daily-logbook.ts` は TypeScript ソース。`package.json` の `engines.node >= 18.0.0` の環境では `node:test` は `.ts` を直接実行できない（Node 18/20 は type stripping 非対応。22.6+ で experimental、23.6+ で既定）。
- テスト対象と想定される純粋関数（`buildTranscript`, `truncateText`, `isDuplicateTrigger`, `replaceTemplateVariables` 等）はすべてモジュール内非公開。`export default DailyLogbookPlugin` と `export const DailyLogbookPlugin` のみで、テストから import できない。
- `package.json` に `test` スクリプトが存在せず、テスト基盤（tsconfig / test framework / テストファイル）がゼロ。
- ビルドツールが bun（`bun build`）である以上、テストランナーも `bun test` が自然で追加コストが最小。

**改善案**:
1. テストランナーを `bun test` に変更し、`package.json` に `"test": "bun test"` を追加（bun は peerDependency で必須のため追加依存なし）。
2. テスト対象の純粋関数を named export する（`export function maskSecrets(...)` / `export function isWithinWindow(...)` 等。既存 export への追加は後方互換）。
   - 代替: マスキング・スロットリング判定を別モジュール（例: `daily-logbook-utils.ts`）に抽出し、プラグイン本体とテストの両方から import。`bun build` は import をバンドルするため配布物は変らない。
3. テスト配置: `test/*.test.ts` に `node:test`（bun 互換）または `bun:test` で記述。
4. スロットリング判定はモジュール内 Map への依存を外し、`isWithinWindow(lastTriggeredAt: number | undefined, nowMs: number, windowMs: number): boolean` のような純粋述語に切り出してからテストする。

---

### Issue 2: daily-limit（1日1回）の「生成済み判定」メカニズムが未定義

**指摘事項**:
- 本プラグインはファイルを直接書かず、**生成セッションのエージェントが** `{{ outputDir }}/{{ date }}_logbook.md` を作成する。daily-limit の「既にその日のログブックが生成済みならスキップ」の判定方法（ファイル存在チェックか、インメモリ Map か）が計画に未記載。
- 判定がインメモリだと、プロセス再起動でリセットされ「1日1回」にならない。ファイル存在チェック（`fs.existsSync` / `stat`）なら再起動を跨いで機能する。
- カスタム `OPENCODE_DAILY_LOGBOOK_TEMPLATE` でファイル名パターンが変わると、既定名 `YYYYMMDD_logbook.md` では判定不能になる。
- ファイルが存在しても空・不完全（生成失敗）の場合、当日中の再生成がブロックされる副作用がある。
- README の「既存ファイルは追記・更新（上書きしない）」運用と daily-limit は互いに矛盾する（追記運用だと 1 日複数回の追記が前提）。挙動変化の明記が必要。

**改善案**:
1. 判定方法を明記: `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` 時、`fs.existsSync(resolve(outputDir, `${date}_logbook.md`))` で存在チェック（日付は `formatDateTokens` のローカル日付）。
2. ファイルベース判定とし、プロセス再起動を跨いで機能することを受け入れ条件に明記。
3. daily-limit は既定ファイル名 `YYYYMMDD_logbook.md` を前提とし、カスタムテンプレート併用時は warning ログを出す（判定不能のため）か「非対応」と README に明記。
4. README に「daily-limit 有効時は追記運用が 1 日 1 回になる」ことを明記。
5. TOCTOU（チェック→生成の間に別セッションが生成）は許容範囲だが、`inFlightSessionIds` ガードと併用することは注記。

---

## 🟡 中

### Issue 3: CHANGELOG の実装乖離（1.0.5 で停止 vs package.json は 1.0.9）とバージョン番号方針が未定義

**指摘事項**:
- `CHANGELOG.md` は 1.0.5 までしか記録がないが、`package.json` は `1.0.9`。Task 5 の「ドキュメントが実装と一致する」では、この既存乖離（1.0.6〜1.0.9 の未記録）をどう解消するか未定義。
- 新機能（マスキング・スロットリング設定）を追加するため、バージョン更新（1.1.0 推奨: 新機能追加のため minor）と CHANGELOG 追記が必須だが、計画に version bump の記載がない。

**改善案**:
- Task 5 に「package.json の version を 1.1.0 に更新し、CHANGELOG に 1.0.6〜1.1.0 の記録（未記録分は要約で可）を追記する」ことを明記する。

---

### Issue 4: Task 2 の前提が不正確 — `dist/daily-logbook.js` は git 追跡済み / npm パッケージにも含まれる

**指摘事項**:
- `dist/daily-logbook.js` は `git ls-files` で追跡済み。削除には `git rm dist/daily-logbook.js` が必要（`.gitignore` に `/dist` があるが、追跡済みファイルは ignore されない）。
- `package.json` の `files: ["dist"]` により、npm パッケージにも `daily-logbook.js` が含まれる。削除漏れがあると公開物に旧生成物が残る。
- 作業ツリーの `dist/index.js` は未コミットの変更（コミット済み版は古い）。Task 2 で再ビルド後にコミットする必要がある。

**改善案**:
- 受け入れ条件に以下を追加: ① `git rm dist/daily-logbook.js` の実行、② `npm pack --dry-run`（または `bun pm pack`）で公開物が `index.js` のみになることを確認、③ 再ビルド後の `dist/index.js` のコミットを含める。

---

### Issue 5: リポジトリ内コマンド定義（`.github/commands/` と `.opencode/commands/`）の扱いが未決定

**指摘事項**:
- 計画は「README から手動コマンドの主張を削除する」方針だが、`.github/commands/daily-logbook.md`（未コミット）と **`.opencode/commands/daily-logbook.md`（未コミット、同一内容）** の 2 ファイルがこのリポジトリに存在する。これらは本リポジトリの運用コマンドとして機能するため、README 主張削除後も残すか、削除するかの決定が計画にない。
- 「残りの README 記述が実装と一致する」という受け入れ条件が曖昧（何を持って一致とするか列挙がない）。

**改善案**:
- コマンドファイルの扱いを明示（推奨: リポジトリローカル運用として残す。README は npm パッケージの説明なので削除のみ。コマンドファイルと README の二重管理を避けるため、コマンドファイルにも「プラグイン機能ではなくリポジトリローカル機能」と明記）。
- 受け入れ条件に残存 README の主張ごとの照合項目（自動生成 / 出力先設定 / テンプレート / English-first）を列挙する。

---

## 🟢 低

### Issue 6: レビュー指摘「English-first ガイドラインの整合」への対応が計画に未明示

**指摘事項**:
- Future Readiness Review の next steps #2（"Add an explicit 'English-first' guideline to templates (and keep README + built-in template consistent)"）が計画の現状照合表に含まれていない。
- 実態としては SAMPLE_TEMPLATE・README 両言語・`.github/commands/daily-logbook.md` に既に一貫して存在するため、実質対応済み。

**改善案**:
- タスク 1 の受け入れ条件に「README / 組み込みテンプレート / コマンド定義間の English-first 記述が整合していること」を確認項目として明示する（計画に明示すれば対応完了扱いにできる）。

---

### Issue 7: 真偽値・数値環境変数のパース仕様と変数間の優先関係が未定義

**指摘事項**:
- 既存 `isPluginDisabled()` は `=== "true"` の厳密一致。新設 4 変数（`REDACT` / `INCLUDE_TRANSCRIPT` / `DAILY_LIMIT` / `THROTTLE_MS`）のパース規則が計画にない（"true"/"1"/"yes" のどれを有効とするか等）。
- `REDACT=false` と `INCLUDE_TRANSCRIPT=false` の優先関係（transcript 埋め込みなしなら redact は無意味）が未定義。

**改善案**:
- 既存と同じ「`"true"` の厳密一致のみ有効」を README に明記（`THROTTLE_MS` は整数パース、NaN なら既定 90000 にフォールバック）。
- README に優先関係を 1 行で明記（例: 「`INCLUDE_TRANSCRIPT=false` 時は `REDACT` の設定に関わらず transcript は埋め込まれない」）。

---

### Issue 8: マスキング適用順序（truncate 前か後か）が未定義

**指摘事項**:
- `buildTranscript` は 12,000 文字で truncate する。truncate **後に** マスキングすると、シークレットが切り口で分割され、正規表現パターン（`sk-...` 等）が途中で切れてマスク漏れする可能性がある。
- マスキング対象が transcript のみか（セッションタイトル等も含むか）も未定義。

**改善案**:
- `buildTranscript` 内で **truncate 前に** `maskSecrets()` を適用する順序を計画に明記。
- 対象は transcript（prompt に埋め込まれる部分）のみとし、セッションタイトルは対象外とする旨を明記（タイトルは `GENERATED_TITLE_PREFIX` チェックのみで使用され prompt に含まれないため）。

---

## 備考

- 計画全体の構成（現状照合 → BDD タスク → 制約 → テスト計画）はレビューアー基準を満たす水準。タスク粒度も 5 件に適切に分割されている。
- 後方互換（既定値で現行挙動維持: 90 秒ウィンドウ / INCLUDE_TRANSCRIPT=true / REDACT=true）への配慮は適切。
- マスキングを「フェイルセーフであり完全な秘密保護ではない」と README に明記する点は妥当（レビュー指摘と一致）。
- 環境変数命名（`OPENCODE_DAILY_LOGBOOK_*` プレフィックス）は既存規約と整合。
- 判定: **差し戻し（要修正）** — Issue 1（テスト基盤）・Issue 2（daily-limit 判定）の 2 件の 🔴 を解消して再レビュー依頼すること。
