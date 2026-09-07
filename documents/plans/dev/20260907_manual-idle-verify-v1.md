# 人手手順書: v1 idle検証（5.2-4）

前提: Phase B（設定バックアップ・キャッシュ除去・v1再ビルド 41.50KB）完了済み

## 手順（約5分）

```bash
# 1. v1 をデバッグ出力付きで起動（TUIが開く）
DAILY_LOGBOOK_DEBUG=1 opencode

# 2. TUI内で90〜120秒、何も操作せず放置する
#    （throttle 0 の場合は即時発火することもある）

# 3. 別ターミナルでログを監視
tail -f ~/.local/share/opencode/opencode-data-v1/opencode/log/opencode.log | grep daily-logbook
```

## 期待値

- `daily-logbook plugin loaded` が出ること
- `failed to load plugin … autopilot` が出ないこと
- （DEBUG時のみ）`event received type=session.idle` がidle後に1件以上出ること

## 成果物確認

```bash
ls -lt ./artifacts/daily/$(date +%Y%m%d)_logbook.md
sqlite3 ~/.local/share/opencode/opencode-data-v1/opencode/opencode.db \
  "SELECT title FROM session WHERE title LIKE '[daily-logbook:auto]%' ORDER BY time_created DESC LIMIT 1;"
```

当日日付のタイトルが返れば成功。結果をPhase Dの確認表に記録する。
