#!/usr/bin/env bash
# scripts/tui-test-idle.sh — Microsoft tui-test による TUI idle 検証
# expect の CSI 問題（Ask anything が opentui のエスケープでマッチしない）を解消する
# 使い方:
#   # ローカル (要 tui-test インストール + OPENCODE_API_KEY)
#   bash scripts/tui-test-idle.sh
#   # Docker
#   docker compose -f docker/docker-compose.test.yml build test
#   docker compose -f docker/docker-compose.test.yml run --rm test bash scripts/tui-test-idle.sh
#   # TUI 検証は tui-test の PTY で 70秒放置、artifacts/daily に Bun.write で新規作成されることを検証
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# gitleaks 等の誤検知を避けるため環境変数から取得（なければ symphony の .env から補完）
if [ -z "${OPENCODE_API_KEY:-}" ] && [ -f "/Users/bookair18/OS/media/06_symphony/symphony_workspaces/.env" ]; then
  # shellcheck disable=SC1090
  set -a; source /Users/bookair18/OS/media/06_symphony/symphony_workspaces/.env 2>/dev/null || true; set +a
  OPENCODE_API_KEY="${OPENCODE_GO_API_KEY:-${OPENCODE_API_KEY:-}}"
fi

if ! command -v tui-test >/dev/null 2>&1; then
  echo "tui-test not found. Install: curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/microsoft/tui-test/main/install/install.sh | TUI_TEST_VERSION=beta sh"
  exit 2
fi

# 既存セッションをクリーン
tui-test close --all 2>&1 | head -n 5 || true
sleep 1

TODAY="$(date +%Y%m%d)"
ARTIFACT="artifacts/daily/${TODAY}_logbook.md"
SESSION="tui-test-idle-$(date +%s)"

echo "=== [tui-test] TUI idle 検証: session=$SESSION artifact=$ARTIFACT ==="
echo "before: $(ls -lh "$ARTIFACT" 2>&1 | head -n 1) wc:$(wc -l "$ARTIFACT" 2>&1 | head -n 1)"

# 0→Bun.write の新規作成を検証するため一旦削除（daily limit / throttle を 0 にしているため再生成される）
cp "$ARTIFACT" /tmp/logbook.bak.tui 2>&1 | head -n 1 || true
rm -f "$ARTIFACT"
echo "removed for 0->create test: $(ls -lh "$ARTIFACT" 2>&1 | head -n 1)"

echo ""
echo "=== [1/4] tui-test run opencode (with --env) ==="
# daemon に env を渡すため --env を使う（export は daemon に継承されない）
tui-test run --session "$SESSION" \
  --env OPENCODE_API_KEY="${OPENCODE_API_KEY:-}" \
  --env OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=false \
  --env OPENCODE_DAILY_LOGBOOK_THROTTLE_MS=0 \
  --env TERM=xterm-256color \
  --env LANG=C.UTF-8 \
  opencode 2>&1 | head -n 20

sleep 3
echo ""
echo "=== [2/4] expect Ask anything (tui-test は ANSI を解釈して文字でマッチ) ==="
# expect の "Ask anything" は opentui の CSI で timeout したが、tui-test はターミナルエミュレータで文字を抽出するため PASS
if tui-test expect text "Ask anything" --session "$SESSION" --timeout 15000 2>&1; then
  echo "✓ expect PASS: Ask anything found (CSI 問題を解消)"
else
  echo "✗ expect FAIL: Ask anything not found"
  tui-test text --session "$SESSION" 2>&1 | head -n 40
  tui-test close --session "$SESSION" 2>&1 | head -n 5 || true
  exit 1
fi

echo ""
echo "=== [3/4] submit hello + wait idle 75s (LLM 20-30s + idle 60s) ==="
tui-test submit "hello via tui-test" --session "$SESSION" 2>&1 | head -n 5
echo "submitted hello, waiting 5s for submit to land..."
sleep 5
echo "text after 5s:"
tui-test text --session "$SESSION" 2>&1 | tail -n 20

echo ""
echo "sleeping 75s for LLM + session.idle (idleAfterMs=60000)..."
sleep 75

echo ""
echo "=== [4/4] verify artifacts ==="
ls -lh "$ARTIFACT" 2>&1 | head -n 20
if [ -f "$ARTIFACT" ]; then
  echo "✓ $ARTIFACT exists after tui-test idle"
  wc -l "$ARTIFACT"
  head -n 30 "$ARTIFACT"
  echo "---"
  echo "✓ tui-test による Docker 未達 (hello未到達) を解消し、session.idle まで到達"
  RESULT=0
else
  echo "✗ $ARTIFACT not found after 75s idle"
  echo "tui-test text after idle:"
  tui-test text --session "$SESSION" 2>&1 | tail -n 40
  echo "recording: $(tui-test get-recording "$SESSION" 2>&1 | head -n 5 || echo 'no recording')"
  RESULT=1
fi

tui-test close --session "$SESSION" 2>&1 | head -n 5 || true

# 失敗時は bak を戻す、成功時は bak を残したまま
if [ $RESULT -ne 0 ] && [ -f /tmp/logbook.bak.tui ]; then
  cp /tmp/logbook.bak.tui "$ARTIFACT" 2>&1 | head -n 1 || true
  echo "restored backup after failure"
fi

if [ $RESULT -eq 0 ]; then
  echo ""
  echo "=== tui-test idle succeeded ==="
else
  echo ""
  echo "=== tui-test idle failed (artifact not created) ==="
  echo "Note: LLM が 30s 以上かかる場合は 75s では idle 60s が足りず 90s 必要。OPENCODE_API_KEY が無効なら 401 で idle しない。"
fi

exit $RESULT
