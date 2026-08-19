# Future-Readiness Hardening Plan

Date: 2026-08-19
Source: `documents/reviews/2026-08-19_future-readiness-review.md`

## 目的

`opencode-autopilot-logbook` を「将来にわたって安全・安定・破綻なく使える」状態に引き上げる。レビュー文書で指摘されたギャップをコードベース実態と照合し、BDD アプローチで振る舞い単位に分解して実装する。

## 現状照合結果（レビュー vs コードベース）

| レビュー指摘 | コードベース実態 | 対応方針 |
|------------|----------------|---------|
| `/daily-logbook` コマンドが README にあるが未実装 | `.github/commands/daily-logbook.md` は存在するが未追跡（未コミット）。プラグインの `dist/` には含まれない | プラグイン機能として実装 or README から主張を削除 |
| Build/artifact hygiene | `dist/` に古い `daily-logbook.js` と新 `index.js` が同居。`main` は `index.js` | 古い生成物を削除し、`npm run build` で整合させる |
| Redaction/masking 未定義 | `buildTranscript` が生 transcript を prompt に埋め込む | シンプルなマスキング + transcript 埋め込み無効化設定 |
| "Once per day" + 堅牢なスロットリング未定義 | 現状は 90 秒ウィンドウのみ | 設定可能なデバウンス/1日1回 セマンティクス |

## タスク一覧（BDD）

### タスク 1: README の手動コマンド主張の修正（Issue 5・6 対応）

**背景**: プラグインにはコマンド機構がなく、`/daily-logbook` をプラグイン内で実装するのはバンドル外の作業になる。README の「Manual trigger via `/daily-logbook` command」の主張はプラグインの機能として正しくない。

**振る舞い**:
- **正常系**: README の「手動トリガー」主張が削除され、README がプラグインの実際の機能（自動生成・出力先設定・テンプレート・English-first）のみを説明する。
- **コマンドファイル**: `.github/commands/daily-logbook.md` と `.opencode/commands/daily-logbook.md` はリポジトリローカル運用コマンドとして**残す**（npm パッケージの README とは別物）。二重管理を避けるため、コマンドファイルに「プラグイン機能ではなくリポジトリローカル機能」と明記する。

**受け入れ条件**:
- README.md / README.jp.md の Features から `/daily-logbook` コマンドの記述が削除される。
- 残存 README の各主張（自動生成 / 出力先設定 / テンプレート / English-first）が実装と一致することを項目ごとに確認する。
- English-first 記述が README / 組み込みテンプレート / コマンド定義間で整合していることを確認する（Issue 6 対応済み扱い）。
- コマンドファイル 2 件が残り、「リポジトリローカル機能」である旨が明記される。

### タスク 2: Build / artifact ハイジーン（Issue 4 対応）

**振る舞い**:
- `npm run build` を実行すると、`dist/` に最新の `index.js` のみが生成される。
- 古い生成物 `dist/daily-logbook.js` が存在しない。

**受け入れ条件**:
- `git rm dist/daily-logbook.js` で追跡からも削除する（git 追跡済みのため）。
- `npm run build` 後の `dist/` が `index.js` のみ（package.json `main` と一致）。
- `npm pack --dry-run` で公開物が `index.js` のみになることを確認（npm `files` に旧生成物が含まれないこと）。
- 再ビルド後の `dist/index.js` の変更をコミットする。
- `bun build` がエラーなく成功する。

### タスク 3: シークレットのマスキング（Issue 8 対応）

**振る舞い**:
- **正常系**: transcript に `sk-...`, `Bearer ...`, `AKIA...`, `ghp_`, `xoxb-`, パスワードらしき値などが含まれる場合、それらがマスクされてから prompt に埋め込まれる。
- **適用順序**: マスキングは **truncate 前** に適用する（truncate 後だと切り口でシークレットが分割されマスク漏れするため）。
- **対象範囲**: マスキング対象は transcript（prompt に埋め込まれる部分）のみ。セッションタイトルは対象外（prompt に含まれないため）。
- **設定**: `OPENCODE_DAILY_LOGBOOK_REDACT=true`（既定 true）でマスキング有効。`false` で無効。
- **代替**: `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT=false`（既定 true）で transcript 埋め込み自体を無効化可能。

**受け入れ条件**:
- マスキング関数が既知のシークレットパターン（`sk-`、`Bearer`、`AKIA[0-9A-Z]{16}`、`ghp_`、`xoxb-` 等）を `***` に置換する。
- マスキングは truncate 前に適用される。
- 環境変数で有効/無効を切り替えられる。
- transcript 埋め込みを無効化する設定が機能する。
- マスキングの単体テスト（bun test）が通る。

### タスク 4: スロットリングの設定可能化（Issue 2 対応）

**振るべえ**:
- **既定**: 現状の 90 秒ウィンドウを維持（後方互換）。
- **設定**: `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS`（整数パース、NaN なら既定 90000 にフォールバック）でウィンドウを変更可能。
- **1日1回セマンティクス**: `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` で、既定ファイル名 `{{ outputDir }}/{{ date }}_logbook.md` の存在を `fs.existsSync` でチェックし、既に存在すれば生成をスキップする（**ファイルベース判定**。プロセス再起動を跨いで機能する）。
- **ファイルパス解決基準（Issue A）**: 存在チェックのパス解決は `loadTemplate` と同じく **`resolve(directory, outputDir, ...)` 基準**に統一する（CWD ではなくプラグインの `directory` 引数を基準とする）。
- **daily-limit 判定の純粋関数化（Issue B）**: ファイル存在判定を `isDailyLogbookExists(directory: string, date: string): boolean` のような純粋関数に切り出し、テスト計画の対象に含める。
- **カスタムテンプレート併用時**: ファイル名パターンが変わり判定不能になるため、warning ログを出し「非対応」と README に明記する。
- **TOCTOU**: チェック→生成の間の競合は `inFlightSessionIds` ガードで緩和（許容範囲）。

**受け入れ条件**:
- 環境変数でウィンドウを変更できる。
- daily-limit 有効時、同一日付の 2 回目の idle では生成をスキップする。
- daily-limit の判定がファイルベースで、プロセス再起動を跨いで機能する。
- daily-limit のファイルパス解決が `directory` 引数基準である（Issue A）。
- 後方互換性が保たれる（未設定時は現行と同じ挙動）。
- **README に「daily-limit 有効時は追記運用が 1 日 1 回になる」ことを明記する（Issue C）**。
- **ファイルが存在しても空・不完全（生成失敗）の場合は当日中の再生成がブロックされる副作用があることを許容し、README に注記する（Issue D）**。

### タスク 5: ドキュメント整合（README / CHANGELOG / version bump）（Issue 3・7 対応）

**振るべえ**:
- README.md / README.jp.md に新環境変数（`OPENCODE_DAILY_LOGBOOK_REDACT`, `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT`, `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS`, `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT`）の説明を追記。
- 真偽値 env は既存と同じ「`"true"` の厳密一致のみ有効」と明記。`THROTTLE_MS` は整数パース、NaN なら既定 90000。
- 優先関係を 1 行で明記（例: 「`INCLUDE_TRANSCRIPT=false` 時は `REDACT` の設定に関わらず transcript は埋め込まれない」）。
- `package.json` の version を **1.1.0** に更新（新機能追加のため minor）。
- CHANGELOG.md に 1.0.6〜1.1.0 の記録を追記（未記録分 1.0.6〜1.0.9 は要約で可）。

**受け入れ条件**:
- ドキュメントが実装と一致する。
- 新環境変数の説明が両言語 README に存在する。
- 真偽値・数値パース規則と優先関係が README に明記される。
- package.json が 1.1.0 に更新され、CHANGELOG が 1.0.6〜1.1.0 まで追記される。

## 制約・注意

- 編集はリポジトリルートのプラグインソース（`daily-logbook.ts`）とドキュメントのみ。
- `dist/` はビルド生成物。ソースを編集後 `npm run build` で再生成し整合させる。`dist/daily-logbook.js` は `git rm` で追跡から削除。
- マスキングは「転送事故を減らす」ためのフェイルセーフであり、完全な秘密保護を保証するものではないことを README に明記する。
- 後方互換性を最優先。既存環境変数（`DISABLED` / `TEMPLATE` / `OUTPUT_DIR`）の挙動は変えない。
- テストランナーは `bun test` を使用（bun は peerDependency のため追加依存なし）。テスト対象の純粋関数は named export する。
- **作業ツリーの既存変更（Issue F）**: `daily-logbook.ts` / `README.md` / `README.jp.md` / `dist/index.js` / `package.json` に未コミットの English-first 変換とビルドスクリプト修正が入っている。これらは本計画のタスク1・3・5（English-first 方針・ビルド整合）と整合するため**採用し、そのままコミット対象に含める**。実装者はこの既存変更を壊さず、その上に本計画の変更を積むこと。

## テスト計画（Issue 1 対応）

- **テストランナー**: `bun test`（`package.json` に `"test": "bun test"` を追加。bun は peerDependency で必須のため追加依存なし）。
- **テスト対象の抽出**: マスキング・スロットリング判定・truncate・テンプレート置換の純粋関数を **named export**（`export function maskSecrets(...)` / `export function isWithinWindow(...)` 等）する。既存 export への追加は後方互換。必要に応じ `daily-logbook-utils.ts` に分離（bun build がバンドルするため配布物は変わらない）。
- **スロットリング判定**: モジュール内 Map への依存を外し、`isWithinWindow(lastTriggeredAt: number | undefined, nowMs: number, windowMs: number): boolean` のような純粋述語に切り出してテスト。
- **テスト配置**: `test/*.test.ts`。
- **対象**:
  - タスク3: マスキング関数（正常・パターン別・truncate 前適用）。
  - タスク4: スロットリング判定（ウィンドウ境界・NaN フォールバック）+ daily-limit ファイル存在判定（`isDailyLogbookExists`）の正常・異常系（Issue B）。
- **ビルド検証（タスク2）**: `npm run build` 成功 + `dist/` 構成確認 + `npm pack --dry-run`。
- **手動確認（タスク1・5）**: README 記述の整合確認。

---

## 追記: メタレビュー指摘の修正（2026-08-19 レビューにレビュー）

`documents/plans/dev/issues/2026-08-19_meta-review.md` のメタレビューで、既存レビュー工程が見落とした実運用ギャップが発見された。ユーザー判断により 🔴+🟡 を全て修正する。

### 🔴 高 1: daily-limit の並行破綻（複数セッション同時 idle）
- **問題**: `inFlightSessionIds` は `Set<string>` で **セッション単位**。daily-limit は**ワークスペース単位（ファイル存在）**。別々のセッションが同時に idle すると、両方が存在チェックを通過して生成が走る。
- **修正**: daily-limit 有効時のみ、日付キーのグローバル in-flight ガード `dailyLimitInFlightByDate: Set<string>` を追加。日付単位で並行生成を抑制する。無効時は現行挙動維持。
- **テスト**: 並行系の単体テスト（同一日付の2回目 idle が抑制されること）を追加。

### 🟡 中 2: daily-limit のパス乖離（Issue A の残余）
- **問題**: 存在チェックは `resolve(directory, ...)` 基準だが、プロンプトに渡る `{{ outputDir }}` は `getOutputDir()` の**生の相対文字列**。エージェント（別プロセス）が CWD 基準でファイルを生成するため、`directory` ≠ CWD だと判定位置と実ファイル位置がズレる。
- **修正**: daily-limit の存在チェックは `directory` 基準で維持しつつ、**プロンプトに渡す `{{ outputDir }}` を `directory` 基準の絶対パスに解決する**（`resolve(directory, getOutputDir())`）。ただし後方互換のため、既定（daily-limit 無効）時は従来どおり相対文字列を維持するか、両方を絶対パスに統一する方針を選択する。→ **方針: daily-limit 有効時に限り絶対パスを渡す**。無効時は従来の相対文字列。

### 🟡 中 3: マスキング文書と実装の矛盾（README 過大表明）
- **問題**: README は「`sk-...`、JWT（`eyJ...`）等をマスク」と明記するが、大文字 `SK-`・短 JWT（10 未満）は漏れる。`Bearer` は自然文を過マスクする。
- **修正**: README 両言語に「大文字 `SK-` は非対応」「短い JWT は非対応」「`Bearer` は自然文も過マスクしうる」旨を注記。可能なら `[sS][kK]-` 対応も検討（フェイルセーフ強化）。

### 🟢 低: THROTTLE_MS エッジ / artifacts ignore / CHANGELOG
- `THROTTLE_MS` の「0=無効」「科学記法（`1e3`）は parseInt で打ち切り」を README に注記。
- `.gitignore` に `artifacts/` を追加（既定出力先の実行生成物）。
- CHANGELOG 1.1.0 に `dateJp` のソースレベル変更記録を追加（公開実害なし、記録のみ）。

## 修正後は再レビュー（Reviewer）・再QA を実施する。
