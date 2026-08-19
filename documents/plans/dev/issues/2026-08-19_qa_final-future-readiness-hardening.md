# QA 最終検収: Future-Readiness Hardening（メタレビュー指摘修正後）

## 優先度
総合判定: **承認**（リリースブロッカーなし。🟡 1 件・🟢 3 件は軽微なドキュメント整合・運用改善）

## 対象
- 計画書: `documents/plans/dev/2026-08-19_future-readiness-hardening.md`
- メタレビュー修正コミット: `32bd673`（並行ガード + 絶対パス）, `e85c141`（docs）, `fd0bb71`（date 注入 + エラー経路ガード解除）
- 過去コミット: `885f3ec`, `e645274`, `cc70f0a`, `3dcaabb`, `4d3c186`, `b344976`
- 関連ファイル: `daily-logbook.ts`, `test/daily-logbook.test.ts`, `dist/index.js`, `package.json`, `README.md`, `README.jp.md`, `CHANGELOG.md`, `.gitignore`

## 実施した検証

| 検証項目 | コマンド | 結果 |
|---------|---------|------|
| 単体テスト | `bun test` | ✅ **45 pass / 0 fail**（54 expect、282ms）。想定 45 件と一致 |
| ビルド | `npm run build` | ✅ 成功（Bundled 1 module in 54ms、`dist/index.js` 10.97 KB）。**再ビルド後 `git status` / `git diff dist/` に差分なし** = HEAD の dist は最新ソースと完全同期 |
| 公開物確認 | `npm pack --dry-run` | ✅ `opencode-autopilot-logbook@1.1.0`、5 ファイルのみ（README.md / README.jp.md / CHANGELOG.md / dist/index.js / package.json）。旧 `daily-logbook.js` は含まれない |
| dist 構成 | `git ls-files dist/` | ✅ `index.js` のみ。`daily-logbook.js` は追跡から削除済み |
| gitignore 機能 | `git check-ignore artifacts/` | ✅ `.gitignore:108:/artifacts/` にマッチ（追加機能）。`dist/` も `/.gitignore:109:/dist` でマッチ（プローブで確認） |
| コミット一覧 | `git log --oneline -10` | ✅ 指定 3 コミット（`32bd673` / `e85c141` / `fd0bb71`）+ 過去 6 コミットが正しい順序で存在 |
| ReDoS 実測 | bun で敵対的入力実行 | ✅ 全パターン **20ms 未満**（最大 19.4ms = PEM 未閉じ）。JWT セグメント上限 120 により polynomial バックトラッキング防止 |
| 旧パス残存 | grep | ✅ `06_openclaw` / `/OS/media` の残存なし。`dist/daily-logbook.js` は CHANGELOG の削除記録のみ |
| リンク検証 | ファイル存在確認 | ✅ README.md⇔README.jp.md 相互リンク有効（npm files にも両方含まれる） |

## 発見項目

### 🟡 中 1: README のテンプレート例示パスが旧パス `plans/dev/daily-logbook.md` のまま + ルート `plans/` が未整理残存

- **対象**: `README.md:61`, `README.jp.md:63`
- **指摘**: `OPENCODE_DAILY_LOGBOOK_TEMPLATE` の例示が `plans/dev/daily-logbook.md`。CHANGELOG 1.0.8 は「`plans/` → `documents/plans/` 整理」を主張するが、実体は `plans/dev/daily-logbook.md`（未追跡）のみで、`documents/plans/dev/daily-logbook.md` は存在しない。ルート `plans/` ディレクトリも未追跡のまま残り、整理が中途半端。
- **改善案**:
  - 例示パスを実在ファイル（例: `documents/plans/dev/issues/daily-logbook.md`）に更新する
  - または `plans/` の整理を完了（削除 or コミット）し、両言語 README の例を実在パスに揃える
- **備考**: 例示のため実行は破綻しない（現在はローカルに実在）。ドキュメント整合の観点での指摘。

### 🟢 低 2: `.opencode` symlink が常に untracked として表示される

- **対象**: `.gitignore`（`/.opencode/` エントリ）、`.opencode -> .github`（symlink）
- **指摘**: `.opencode` は `.github` へのシンボリックリンク。`.gitignore` の `/.opencode/`（末尾スラッシュ）は実ディレクトリのみにマッチするため、symlink は常に `?? .opencode` として git status に現れる。
- **改善案**: `.gitignore` に `/.opencode`（末尾スラッシュなし）を追加するか、symlink をコミットする意図を明文化。

### 🟢 低 3: 2026-08-19 系の文書（計画書・レビュー・QA issue）が未コミットで不統一

- **対象**: `documents/plans/dev/2026-08-19_future-readiness-hardening.md`, `documents/plans/dev/issues/2026-08-19_*.md`, `documents/reviews/`
- **指摘**: 旧 issue 文書（2026-08-14, 20260812 系）はコミット済みだが、今回の計画書・メタレビュー issue 2 件・前回 QA レポート・`documents/reviews/` はすべて untracked。コミットポリシーが不統一。
- **改善案**: 計画書・レビュー文書をコミットする方針に統一するか、`.gitignore` に明示して「ローカル管理」と割り切る。

### 🟢 低 4: 細部の表記揺れ（実害なし）

- **対象**: `README.md:66`, `README.jp.md:68`
- **指摘**: 既定出力先の表記が README は `artifacts/daily/`（末尾スラッシュあり）、コードは `DEFAULT_OUTPUT_DIR = "artifacts/daily"`（なし）。動作影響なし。
- **改善案**: 任意。どちらかに揃えると美観が向上。

## 確認できた重要事項（承認根拠）

### メタレビュー指摘の反映状況（🔴+🟡 全件反映済み）

| 指摘 | 実装 | 検証 |
|------|------|------|
| 🔴 1: daily-limit 並行破綻 | `dailyLimitInFlightByDate: Set<string>`（日付キー・daily-limit 有効時のみ）を追加。finally で確実に解除 | ✅ 単体テスト: 並行抑制（prompt 1 回のみ）/ 後方互換（無効時は 2 回）/ **エラー経路 4 種 × error/throw = 8 テスト**でガード解除を検証 |
| 🟡 2: daily-limit パス乖離 | daily-limit 有効時のみ `resolve(directory, outputDir)` の絶対パスを prompt に注入。無効時は従来の相対文字列（後方互換） | ✅ 単体テスト: 有効時は絶対パス / 無効時は相対文字列 |
| 🟡 3: マスキング文書と実装の矛盾 | 実装は `[sS][kK]-` で大文字対応済み。両 README に「短い JWT 非対応」「Bearer 過マスク」を注記 | ✅ 実装（`/\[sS\]\[kK\]-/`）+ README.md:80-84 / README.jp.md:82-86 |
| 🟢 THROTTLE_MS エッジ | 0=無効・科学記法 parseInt 打ち切りを両 README に注記 | ✅ README.md:106-107 / README.jp.md:108-109 |
| 🟢 artifacts ignore | `.gitignore` に `/artifacts/` 追加 | ✅ `git check-ignore` で機能確認 |
| 🟢 CHANGELOG dateJp | 1.1.0 にソースレベル変更を記録 | ✅ CHANGELOG.md:22 |

### 計画書受け入れ条件の最終確認

- タスク 1: README から `/daily-logbook` コマンド主張削除 ✅ / コマンドファイルに repo-local 明記 ✅（`.opencode/commands/` は symlink で同一実体）
- タスク 2: build 成功・dist は index.js のみ・pack に旧生成物なし・再ビルド差分なし ✅
- タスク 3: マスキング 9 パターン実装 ✅ / truncate 前適用（テストで検証）✅ / REDACT・INCLUDE_TRANSCRIPT の true/false 規約 ✅ / 優先関係（INCLUDE_TRANSCRIPT=false が REDACT に優先）✅
- タスク 4: THROTTLE_MS 整数パース・NaN/負値フォールバック ✅ / daily-limit ファイルベース判定・directory 基準解決（`isDailyLogbookExists` 純粋関数化）✅ / カスタムテンプレート併用時 warning ✅ / TOCTOU は in-flight ガードで緩和（計画どおり許容）✅ / README に Issue C（1日1回化）・Issue D（空ファイル副作用）注記 ✅
- タスク 5: version 1.1.0 ✅ / CHANGELOG 1.0.6〜1.1.0 追記 ✅ / 新 env 4 種を両言語 README に記載 ✅ / 真偽値・数値パース規則・優先関係の明記 ✅

### マスキング正規表現 ReDoS 評価

- 全 9 パターンを構造分析 + 実測（最大 500KB 入力、未閉じ PEM 19.4ms が最大）。ネストされた量指定子・重複する選択肢がないため、破滅的バックトラッキングなし。
- JWT パターンは `4d3c186` でセグメント上限 120 を導入済み（実測 2.8ms）。

## 備考

- 作業ツリーには未追跡ファイル（`.opencode` symlink / `plans/` / `documents/reviews/` / 2026-08-19 系文書）が存在するが、ソース・テスト・ビルド生成物のコミット済み状態は完全に整合している。
- 本レポートは修正を行わず、発見と提案のみに留める（修正は Implementer または手動）。