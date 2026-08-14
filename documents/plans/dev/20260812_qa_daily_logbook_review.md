# QAレビュー: daily-logbook プラグイン/コマンド

## 優先度
🟡 中

## 対象
- `.github/plugins/daily-logbook.ts`
- `.github/commands/daily-logbook.md`

## 指摘事項

### 1) 保存先パスの運用不整合リスク（🟡）
- コマンド/テンプレートは `daily/YYYYMMDD_日報.md` への出力を指示している。
- 一方、既存の運用文書では `artifacts/daily/...` や別ワークスペースの `.../daily/` が併存している。
- 本リポジトリ直下には `daily/` ディレクトリが現時点で存在せず、利用者環境によっては「どこに保存されるべきか」が曖昧。

該当箇所:
- `.github/commands/daily-logbook.md:7`
- `.github/plugins/daily-logbook.ts:19`

### 2) テンプレート読込失敗時のフォールバック不足（🟡）
- `OPENCODE_DAILY_LOGBOOK_TEMPLATE` が設定されると `readFileSync()` を直呼びしており、ファイル不在・権限不足時は例外。
- 現状でも `try/catch` で全体失敗は防げるが、日報生成自体は止まるため運用上の取りこぼしが起きる。

該当箇所:
- `.github/plugins/daily-logbook.ts:55-63`

### 3) 情報露出の運用リスク（🟢）
- 直近メッセージを transcript として新規セッションに転記する仕様のため、会話内に秘密情報が含まれると日報側に二次保存される可能性がある。
- 外部送信は確認できないため重大ではないが、機密性要件がある運用では注意が必要。

該当箇所:
- `.github/plugins/daily-logbook.ts:81-120`

## 改善案

1. 保存先の単一化
   - `daily/` で運用するなら、README/運用ドキュメントと agent 指示も同じパスへ統一。
   - 既存運用先（`artifacts/daily` 等）に合わせるなら、コマンド文面・テンプレート変数を合わせる。

2. テンプレート読込のフォールバック
   - 例: `readFileSync` 失敗時は警告ログを出して `SAMPLE_TEMPLATE` に戻す。

3. 機密マスキング方針の追記
   - APIキー/トークン様の文字列を簡易マスクしてから transcript 化する。
   - またはコマンド説明に「機密情報を含むセッションでは無効化」の運用注意を明記。

## 構造/パス整合確認
- `.opencode` は `.github` へのシンボリックリンクであり、対象2ファイルは同一実体として参照されることを確認。
- ハッシュ一致:
  - `.github/plugins/daily-logbook.ts` = `.opencode/plugins/daily-logbook.ts`
  - `.github/commands/daily-logbook.md` = `.opencode/commands/daily-logbook.md`

## 備考
- 現時点で `@opencode-ai/plugin` API のイベント名/プロパティ名（`session.idle`, `sessionID`）は型定義と整合。
- 重大なハードコード認証情報の露出は対象2ファイル内では未検出。
