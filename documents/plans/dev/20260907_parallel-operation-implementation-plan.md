# 実施計画書: v1・v2並行運用の実装

作成日: 2026-09-07 / 根拠文書: `20260907_developer-instructions-v1-v2-restore.md`（251行版）
状態: 承認待ち（本書の承認後に実行）

## 1. 目的

指示書の章5（5.1〜5.3）および章10の手順を実装し、v1・v2両ホストで
`session.idle` → 日報（`artifacts/daily/YYYYMMDD_logbook.md`）が生成される
並行運用を確立する。

## 2. 前提・制約

- 章4決定（両対応・設定分離・DB分離維持）を崩さない
- 章6禁止事項を遵守（`plugin list`禁止・混在記載禁止・重複登録禁止・
  DB共用禁止・serve停止によるv1寄せ禁止・`dist`手編集禁止・異版セッション開閉禁止）
- idle検証（5.2-4／5.3-3）はTUI起動を伴うため**人手手順**とし、
  本計画の自動実行範囲から除外する
- DB分離は検証済み（2026-09-07確認：v1 DB=PID 5149/7469、v2 DB=PID 30962、
  クロス使用なし）。旧共用パスに440K新規ファイルあり→起動時環境変数を別途確認

## 3. 実施範囲

### Phase A — 5.1 現状確認（読取のみ・約10分）

| # | 作業 | コマンド（抜粋） | 期待 |
|---|------|------------------|------|
| A1 | バイナリ・プロセス確認 | `opencode --version`／`opencode2 --version`／`ps aux \| grep opencode` | 1.18.29／beta-19192、v1×2・v2 serve・v2 session稼働 |
| A2 | 設定確認 | 両configを`json.tool`で表示 | v1=`plugin`単一、v2=`plugins`単一、キー混在なし |
| A3 | DB/ログ確認 | 両DB・両logの`ls -lh` | v1/v2各15G前後、log分離 |
| A4 | ログ切替確認 | 両logで成功／失敗を`tail` | 成功の出所（v1/v2）を記録 |
| A5 | 成果物・DB確認 | `ls -lt artifacts/daily`＋両DBの`[daily-logbook:auto]`最新5件 | 最終生成日時を確定 |

### Phase B — 5.2 v1安定化（変更あり・約15分）

| # | 作業 | 内容 | ロールバック |
|---|------|------|--------------|
| B1 | 設定バックアップ | `opencode.json`を日付付き退避 | 退避ファイルから復元 |
| B2 | 設定単一化の検証 | `plugin`が1件であることを確認（済みならスキップ） | — |
| B3 | キャッシュ除去 | `rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*` | 再取得で復元可 |
| B4 | v1用ビルド | `package.json`が`^1.0.0`であることを確認→`bun run build`→41KB・`hybridDefault`確認 | `git stash`／再ビルド |
| B5 | 人手引継書の作成 | 5.2-4のidle検証手順書（起動コマンド・待機時間・確認コマンド）を文書化 | — |

### Phase C — 5.3 v2並行安定化（変更あり・約30分）

| # | 作業 | 内容 | ロールバック |
|---|------|------|--------------|
| C1 | v2設定検証 | `plugins`が1件であることを確認（済みならスキップ） | — |
| C2 | 作業ツリー退避 | `git status`で未保持変更を確認→あれば`stash` | `stash pop` |
| C3 | betaブランチ | `git checkout -b beta`（存在すれば切替） | `git checkout main`＋`beta`削除可 |
| C4 | 依存入替 | `npm i -D @opencode-ai/plugin@beta`＋`npm i -D effect` | main側`package.json`で再install |
| C5 | v2用ビルド | `bun run build`→`hybridDefault`／`v2Setup`／`effect`確認 | 再ビルド |
| C6 | main復帰＋v1再ビルド | `git checkout main`→`npm i -D @opencode-ai/plugin@^1.0.0`→`bun run build` | betaブランチ保持 |
| C7 | 人手引継書の作成 | 5.3-3のidle検証手順書（v1同時常駐可・両log確認・同一ファイル追記確認） | — |

### Phase D — 章7確認表（読取のみ・約10分）

6観点×v1/v2＝12セルを実測で埋める（ロード成功／失敗0／idle到達／
セッション生成／ファイル生成／hybrid形状）。idle到達のみ人手検証後に追記。

### Phase E — 章10残件（任意・別途承認）

- E1: CIの`main→dist-v1`／`beta→dist-v2`分離
- E2: READMEの並行運用表記更新
- E3: `scripts/verify-diagnostic-logs.ts`への両ログチェック追加
- E4: `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR`による`daily-v1`／`v2`分離検討
- E5: 旧DB（440K新規含む）の移行／アーカイブ方針決定

## 4. 検証基準（完了条件）

- Phase Aの観測値がすべて記録されている
- Phase B/Cの各ビルドが`bun run build`で生成され`dist`手編集なし
- `git status`がクリーン（意図した変更のみ）
- 章7確認表のうち自動確認可能な11セルが期待値に一致
  （残1セル＝両idle到達は人手検証待ちとして明記）

## 5. リスクと対策

| リスク | 対策 |
|--------|------|
| betaブランチ切替中の作業混入 | C2でstash、C6で復帰確認を必須化 |
| npm入替によるlockfile差分 | 差分を報告し、承認なくcommitしない |
| v2ビルド失敗 | main＋`^1.0.0`に戻してv1再ビルド（C6）すれば現状復帰 |
| TUI起動の長期占有 | idle検証は人手手順に分離し自動実行しない |

## 6. 所要時間の目安

Phase A 10分＋B 15分＋C 30分＋D 10分＝**約65分**（idle人手検証を除く）

## 7. 成果物

- 本計画書（本ファイル）
- Phase B/Cの人手引継書2件（`documents/plans/dev/`に追記）
- 章7確認表の実測記録（本ファイル末尾に追記）
- 変更差分一覧（commitはしない）

## 8. 実測記録（Phase D・2026-09-07 16:00頃）

| 観点 | v1 | v2 |
|------|----|----|
| ロード成功 | ✅ 09-07 06:41 `loaded`（run 4f6dbbea） | ⏳ 未（旧distのため失敗継続→Phase Cでbeta build確認） |
| ロード失敗0 | ✅ 失敗行なし | ❌ SchemaErrorが毎時継続（旧dist。beta build後は未検証） |
| idle到達 | ⏳ 人手検証待ち（引継書あり） | ⏳ 人手検証待ち（引継書あり） |
| セッション生成 | ✅ 20260906（3件は本リポジトリ、1件はsymphony） | ✅ 20260906（分離時コピーのためv1と同一） |
| ファイル生成 | ✅ 20260906_logbook.md 7,984B（09-07分は未生成） | 同左（共通出力先） |
| hybrid形状 | ✅ `object [id,server,setup,effect]`（`bun -e`確認） | ✅ 同一dist（beta build時も`define({id,setup})`＋effect系を確認） |

### 実施メモ

- Phase A：バイナリ1.18.29／beta-19192、v1×3・v2 serve・v2 session稼働を確認。
  v2 sessionのPIDが30919→13377に変化（再起動あり）。設定は両方単一登録。
- Phase B：`opencode.json.bak.20260907`退避、キャッシュ除去（残骸あり→0件）、
  `^1.0.0`確認→再ビルド41.50KB。Orca同期は範囲外のため未実施。
- Phase C：`git stash`を回避しdirty-tree carry方式で`beta`ブランチ作成
  （commitなし）。`@opencode-ai/plugin@^0.0.0-beta-19234`＋`effect@^4.0.0-rc.112`
  でv2ビルド41.50KBを確認後、`main`復帰→stableは`^1.18.29`に解決→
  v1再ビルド41.50KB。`node`でのdist importは不可（`bun:`スキームのため。
  章7の`node -e`は`bun -e`で代替）。
- 未解決事項：旧共用パスに440K新規DB（15:34）→起動時`XDG_DATA_HOME`要確認。
  betaブランチは空ラベルのため、v2 dist再現時は引継書の再生成手順が必要。
- commitなし。`git status`のM／??は計画書作成前からの既存差分＋本計画の成果物。
