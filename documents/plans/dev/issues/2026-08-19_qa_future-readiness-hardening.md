# QA 検収: Future-Readiness Hardening 実装（opencode-autopilot-logbook）

## 優先度
総合判定: **承認**（ブロッカーなし）

## 対象
- 計画書: `documents/plans/dev/2026-08-19_future-readiness-hardening.md`
- 実装コミット: `885f3ec`（docs）, `e645274`（feat）, `cc70f0a`（build）, `3dcaabb`（feat）
- 関連ファイル: `daily-logbook.ts`, `test/daily-logbook.test.ts`, `dist/index.js`, `package.json`, `README.md`, `README.jp.md`, `CHANGELOG.md`

## 実施した検証

| 検証項目 | コマンド | 結果 |
|---------|---------|------|
| 単体テスト | `bun test` | ✅ **28 pass / 0 fail**（31 expect 呼び出し、338ms）。計画書の想定 28 件と一致 |
| ビルド | `npm run build` | ✅ 成功（Bundled 1 module in 81ms、`dist/index.js` 10.31 KB）。**再ビルド後 `git status` に dist 差分なし** = コミット済み dist と最新ソースが一致 |
| 公開物確認 | `npm pack --dry-run` | ✅ 公開物は 5 ファイルのみ（README.md / README.jp.md / CHANGELOG.md / dist/index.js / package.json）。旧生成物 `daily-logbook.js` は含まれない |
| dist 構成 | `git ls-files dist/` | ✅ `index.js` のみ。`daily-logbook.js` は `885f3ec` で git rm（223 行削除）済み |
| コミット一覧 | `git log --oneline -6` | ✅ 指定 4 コミット + 既存 English-first 変換 2 コミット。コミット粒度・メッセージは適切 |
| ReDoS 実測 | bun で大入力実行 | ✅ 破滅的バックトラッキングなし。200KB 入力でも最大 22.6ms（詳細は Issue 2） |
| 旧パス残存 | grep | ✅ README / 実装に旧パス残存なし（発見項目 Issue 5・6 参照） |
| リンク検証 | ファイル存在確認 | ✅ README.md⇔README.jp.md の相互リンク有効（npm files にも両方含まれる） |

## 計画書の受け入れ条件チェック

### タスク 1: README の手動コマンド主張の修正 ✅
- [x] README.md / README.jp.md の Features から `/daily-logbook` 記述が削除済み（grep で Features に該当なし。TEMPLATE の例示パスのみ残存）
- [x] 残存 README の各主張（自動生成 / 出力先設定 / テンプレート / English-first）が実装と一致
- [x] English-first 記述が README / SAMPLE_TEMPLATE / コマンド定義間で整合
- [x] コマンドファイルに「repository-local command, not a feature of the npm plugin」と明記（`.github/commands/daily-logbook.md` は `885f3ec` で追跡。`.opencode/commands/` は symlink 経由で同一実体）

### タスク 2: Build / artifact ハイジーン ✅
- [x] `dist/` は `index.js` のみ（package.json `main` と一致）
- [x] `git rm dist/daily-logbook.js` で追跡から削除済み
- [x] `npm pack --dry-run` で公開物から旧生成物が除外されている
- [x] 再ビルド後の `dist/index.js` がコミット済み（`cc70f0a`, `3dcaabb`）で、再ビルドしても差分なし
- [x] `bun build` エラーなし

### タスク 3: シークレットのマスキング ✅
- [x] パターン: PEM / `sk-` / `Bearer` / `AKIA` / `gh[pousr]_` / `github_pat_` / `xoxb-` / JWT / `password:` 形式ペア（テスト 12 件で検証）
- [x] **truncate 前適用** — `daily-logbook.ts:186-190`。テストの filler 11,990 は正当な境界値（raw 12,013 = 7 + 11,990 + 1 + 15、切り口 12,000 で `sk` 2 文字が残る）。Red 確認済み（truncate 後マスク実装でテスト失敗することを実証）
- [x] `OPENCODE_DAILY_LOGBOOK_REDACT`（既定 true、`"false"` のみ無効化）
- [x] `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT`（既定 true、`"false"` で埋め込み自体を無効化。REDACT より優先）

### タスク 4: スロットリングの設定可能化 ✅
- [x] `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS` — 整数パース、NaN・負値・空文字は 90000 フォールバック（テスト 4 件）
- [x] `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` — `fs.existsSync` ファイルベース判定でプロセス再起動を跨ぐ
- [x] パス解決は `resolve(directory, outputDir, ...)` 基準（`loadTemplate` と統一。Issue A 反映）
- [x] `isDailyLogbookExists` / `isWithinWindow` を純粋関数として named export（Issue B 反映）
- [x] 後方互換: `DISABLED` / `TEMPLATE` / `OUTPUT_DIR` は無変更
- [x] Issue C（追記運用が 1 日 1 回）/ Issue D（空・不完全ファイルで再生成ブロック）を README に明記
- [x] カスタムテンプレート併用時は warning ログ + README に「非対応」明記

### タスク 5: ドキュメント整合 ✅
- [x] 新環境変数 4 件の説明が両言語 README に存在
- [x] 真偽値の `"true"/"false"` 厳密一致規則・整数パース規則・優先関係を明記
- [x] `package.json` version 1.1.0（minor 妥当）
- [x] CHANGELOG に 1.0.6〜1.1.0 を追記（1.0.6〜1.0.9 は要約）

## 発見項目

### 🟡 中

#### Issue 1: package-lock.json の version が 1.0.9 のまま（package.json 1.1.0 と不整合）
- **対象**: `package-lock.json`（ルート `version: "1.0.9"`）
- **指摘**: package.json は 1.1.0 に更新されたが、lockfile のルート version は 1.0.9 のまま。npm の規約上 package.json と lockfile の version は一致させるべき。配布物（npm `files`）には含まれないため公開物への影響はないが、次回 `npm install` / `npm ci` 実行時に lockfile が自動更新され、意図しない diff が生じる。
- **改善案**: publish 前に `npm install --package-lock-only` を実行して lockfile を 1.1.0 に同期し、コミットする。または package.json と同じ 1.1.0 を手動で設定。

#### Issue 2: JWT パターンに polynomial ReDoS の理論的余地（実測では実害なし）
- **対象**: `daily-logbook.ts:47` `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g`
- **指摘**: `{10,}` に上限がないため、`eyJ` + 英数字の連続 + `.` + 連続のような入力で 2 次（O(n²)）のバックトラッキングが理論上発生しうる。マスキングは truncate 前（長さ制限なしの transcript）に適用されるため、悪意ある長大な transcript では CPU ブロックの余地がある。実測では 200KB 入力でも 16ms であり実害は確認できなかった（指数バックトラッキングではない）。
- **改善案**: 各セグメントに上限を付与（例: `{10,120}` — JWT の base64url セグメントは実用上 1,000 文字未満）し、`eyJ` を含む長大な連続文字列での後退を打ち切る。あわせて `maskSecrets` への入力長ガード（例: 1MB で打ち切り）を検討。

### 🟢 低

#### Issue 3: 大文字 `SK-` がマスキング非対応・`Bearer` の自然文誤爆
- **対象**: `daily-logbook.ts:41-42`
- **指摘**: ①`sk-` は小文字のみ対応で `SK-...`（大文字）は漏れる。②`Bearer` パターンは `i` フラグのため自然文の "bearer of..." 等を誤ってマスクする（過マスクは安全側だが transcript の可読性が下がる）。いずれも前回 Reviewer が「任意対応」とした既知事項。
- **改善案**: ①`[sS][kK]-` のように大文字小文字を許容。②過マスクが問題になる場合のみ `Bearer\s+` のトークン長下限を引き上げる。

#### Issue 4: `.opencode` symlink が git の untracked として常時表示される
- **対象**: `.gitignore:106` `/.opencode/`
- **指摘**: `.opencode` は `.github` へのシンボリックリンク。gitignore の `/.opencode/`（末尾スラッシュ付き）はディレクトリのみマッチし、symlink には効かないため `git status --short` に `?? .opencode` が常時表示される。
- **改善案**: `.gitignore` を `/.opencode`（末尾スラッシュなし）に変更する。

#### Issue 5: 旧ディレクトリ構成 `plans/` の残存（移行漏れの可能性）
- **対象**: `plans/dev/daily-logbook.md`（untracked）
- **指摘**: CHANGELOG 1.0.8 で `plans/` → `documents/plans/` の再編が実施済みだが、`plans/dev/daily-logbook.md` が未追跡のまま残存している。README の TEMPLATE 例示パス（`plans/dev/daily-logbook.md`）はこの残存ファイルを指すが、git 追跡されていないため公開リポジトリ上では壊れた参照になる。
- **改善案**: テンプレートとして残す場合は `documents/plans/dev/daily-logbook.md`（または適切な場所）へ移動して追跡し、README の例示パスも合わせて更新。不要なら削除。

#### Issue 6: `artifacts/` が .gitignore に未記載
- **対象**: `.gitignore`
- **指摘**: プラグインの既定出力先 `artifacts/daily/` は実行ごとに日報が生成され、すべて untracked として `git status` に表示される（現在も `artifacts/` が untracked 表示中）。
- **改善案**: `.gitignore` に `artifacts/` を追加する（実行生成物のため追跡不要と判断する場合）。

#### Issue 7: 過去レビュー issue に旧パス記述が残存
- **対象**: `documents/plans/dev/issues/opencode_daily_logbook_plugin_developer_guide.md` ほか
- **指摘**: 過去のレビュー issue（2026-08-12 系）に `.opencode/plugins/daily-logbook.ts`、`plans/dev/daily-logbook.md` 等の旧パス記述が残存。アーカイブ文書のため実装ブロッカーではないが、将来参照時に誤解を招く。
- **改善案**: アーカイブである旨を明記するか、参照頻度の高い文書のみ現行パスへ更新。

## 備考
- 実装の誤りは発見されなかった。前回 Reviewer 検収で指摘された 🟡 2 件（truncate 境界テストの filler、`github_pat_` マスキング）はコミット `3dcaabb` で解消済みであることを独立に再検証した（filler 11,990 は `[User]\n` 7 文字を考慮した正しい境界値。Red 確認の妥当性もコードから追認）。
- 未コミットの untracked（`.opencode/`・`artifacts/`・`documents/plans/`・`documents/reviews/`・`plans/`）はローカル運用ファイル・実行生成物・計画/レビュー文書であり、今回の実装スコープ外として許容。
- プラグインの npm 公開（1.1.0）は未実施。公開前に Issue 1（package-lock 同期）の対応を推奨。

## 判定
**承認**（🔴 高: 0 件 / 🟡 中: 2 件 / 🟢 低: 5 件）

計画書の全受け入れ条件を充足し、テスト 28 件すべて成功、ビルド生成物とコミット済み dist の整合も確認した。🟡 2 件は公開物に影響しない予防的指摘のためブロッカーではないが、npm 公開（1.1.0）前に Issue 1（package-lock.json の同期）の対応を推奨する。修正は Implementer または手動で実施のこと。
