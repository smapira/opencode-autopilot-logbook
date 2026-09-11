# 20260911_v2-lockdown-and-uninstall-v6.md

## 概要

v1セッション内でv2プラグインが誤動作する構造的穴を2つ封じ、`complete-uninstall.sh`をバージョン引数対応に改良。

## 変更ファイル

| ファイル | 内容 |
|---------|------|
| `src/adapters/v2/plugin.v2.ts` | `tryHandleSdkFallback`・`hasNoEventCapability`完全削除、`eventHost?.subscribe`直接チェックに書き換え |
| `src/plugin.ts` | 未使用`createFallbackSdkClient`・`getCandidateUrls`export削除 |
| `scripts/complete-uninstall.sh` | v6化。バージョン引数対応、`2.0.5`デフォルト廃止、空配列安全性修正 |
| `scripts/verify-diagnostic-logs.ts` | V2テスト名を「event.subscribeありでループ起動（SDK自動接続なし）」に更新 |
| `dist/index.js` | 再ビルド（41.49KB、SDK fallback関連コード削除で1.15KB縮小） |

## 修正した問題

### v2誤動作の穴（2つ）

1. **SDKフォールバック自動接続**: `tryHandleSdkFallback`がlocalhostに接続→同機の`opencode2.exe serve`に当たりv1内でv2が購読開始。**除去済み**
2. **無条件hook返却**: subscribeなしだったので`{event}`hookを返していた→ホストが繋げばv2処理が動く。**subscribe実在時のみhook構築に変更**

### 新ルール

- ホストがevent.subscribeを提供 → v2動作（subscribeループ＋hook）
- 提供しない → **何もしない**（localhost接続なし、hookなし）。stdout沈黙＋ファイルに1行記録

### complete-uninstall.sh v6

- `2.0.5`デフォルト除去を廃止
- `[VERSION ...] [--version X] [--dry-run]`で任意バージョン指定
- 重複除去、空配列安全性（`set -u`対応）を修正
- 空ファイル・壊れたJSONでpythonが騒ぐ問題を`show_keys`ヘルパーで解決

## 検証結果

- `bun test` 122 pass / 0 fail
- `verify-diagnostic-logs.ts` 3件PASS
- v1プローブ: `undefined (disabled)`、stdout無出力、ファイルに`idle handling disabled (no event.subscribe in ctx) directory=/tmp ctxKeys=[agent,directory,skill]`記録

## 残作業

- commit未実行（4ファイル変更 + dist再ビルド）
- 旧共用DB 12行削除可否の承認待ち
- Phase E(章10)、動画圧縮Batch未着手
- `sdk-fallback.ts`ファイル自体は残存（import削除済みだが未使用・要掃除判断）
