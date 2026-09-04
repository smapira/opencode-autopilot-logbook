#!/usr/bin/env bash
# scripts/e2e-idle.sh — B案フル E2E: opencode serve 起動 → build → idle 発火 → 成果検証
# Docker 内 (profile:e2e) とローカル両方で動作する
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== [1/4] Build & quality gates ==="
/usr/local/bin/bun run build
npx tsc --noEmit
npx eslint .
/usr/local/bin/bun test
/usr/local/bin/bun scripts/verify-diagnostic-logs.ts

echo ""
echo "=== [2/4] Start opencode serve (background) ==="
# 既に起動していれば再利用、なければ起動
if ! curl -fsSL http://localhost:4096/ >/dev/null 2>&1; then
  echo "starting opencode serve on 4096..."
  # v1 と v2 の両方を試す（どちらかが起動すれば良い）
  (opencode serve --port 4096 >/tmp/opencode-serve.log 2>&1 &)
  sleep 3
  # v2 も 49374 で起動（Orca とは別）
  (opencode2 serve --port 49374 >/tmp/opencode2-serve.log 2>&1 & ) || true
  sleep 2
fi
echo "serve check:"
curl -fsSL http://localhost:4096/ 2>&1 | head -n 2 || echo "4096 not ready (will use direct fallback)"
curl -fsSL http://localhost:49374/ 2>&1 | head -n 2 || echo "49374 not ready (will use direct fallback)"

echo ""
echo "=== [3/4] Trigger idle (direct fallback) ==="
# LLM 不要の direct モードで E2E を完結（file-direct で artifacts/daily に追記される）
/usr/local/bin/bun scripts/trigger-idle.ts --direct

echo ""
echo "=== [4/4] Verify artifacts ==="
ls -lh artifacts/daily/ | tail -n 10
echo "---"
# 当日分が追記されているか
TODAY="$(date +%Y%m%d)"
if ls artifacts/daily/${TODAY}_logbook.md >/dev/null 2>&1; then
  echo "✓ ${TODAY}_logbook.md exists"
  wc -l artifacts/daily/${TODAY}_logbook.md
  tail -n 20 artifacts/daily/${TODAY}_logbook.md
else
  echo "✗ ${TODAY}_logbook.md not found"
  exit 1
fi

# verify の 3ケースも再確認
/usr/local/bin/bun scripts/verify-diagnostic-logs.ts

echo ""
echo "=== E2E succeeded ==="
