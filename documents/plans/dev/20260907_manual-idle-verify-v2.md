# 人手手順書: v2 idle検証（5.3-3）

前提: Phase C完了（betaブランチ作成・`@beta`＋`effect`でv2ビルド確認済み・
main復帰＋v1再ビルド済み）。v1と同時常駐可。

## 事前準備（v2 distの再配置・約5分）

betaブランチにはcommitしていないため、v2ビルドは再生成する：

```bash
cd /Users/bookair18/OS/home/Codes/github.com/smapira/opencode-autopilot-logbook
git checkout beta
npm i -D @opencode-ai/plugin@beta
npm i -D effect
bun run build
# 終了後は main に戻し v1 を再ビルドすること（C6手順）
```

## 手順（約5分）

```bash
# 1. v2 をデバッグ出力付きで起動（TUIが開く）
DAILY_LOGBOOK_DEBUG=1 opencode2

# 2. TUI内で90〜120秒、何も操作せず放置する

# 3. 別ターミナルでログを監視
tail -f ~/.local/share/opencode/opencode-data-v2/opencode/log/opencode.log | grep daily-logbook
```

## 期待値

- `daily-logbook plugin loaded (v2) app=...` が出ること
- `failed to load plugin … autopilot` が出ないこと
- （DEBUG時のみ）`event received type=session.idle` がidle後に1件以上出ること

## 成果物確認

```bash
ls -lt ./artifacts/daily/$(date +%Y%m%d)_logbook.md
# v1 と v2 の両方が同一ファイルに追記されることを確認（現状は許容、将来分離検討）
sqlite3 ~/.local/share/opencode/opencode-data-v2/opencode/opencode.db \
  "SELECT title FROM session WHERE title LIKE '[daily-logbook:auto]%' ORDER BY time_created DESC LIMIT 1;"
```

結果をPhase Dの確認表に記録する。
