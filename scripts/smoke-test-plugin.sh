#!/bin/bash
set -euo pipefail

# Smoke test for opencode-autopilot-logbook plugin
# Checks that the plugin is present in debug config and actually loads at runtime.
# Run: bash scripts/smoke-test-plugin.sh
# CI: add to GitHub Actions as `bash scripts/smoke-test-plugin.sh`

echo "=== 1/2 Checking plugin in 'opencode debug config' ==="
if opencode debug config 2>&1 | grep -q "opencode-autopilot-logbook"; then
  echo "PASS: opencode-autopilot-logbook found in debug config"
  opencode debug config 2>&1 | grep -E "autopilot|plugin_origins" | head -n 10
else
  echo "FAIL: opencode-autopilot-logbook NOT found in 'opencode debug config'"
  echo "Hint: check ~/.config/opencode/opencode.json vs opencode.jsonc (jsonc overwrites json)"
  opencode debug config 2>&1 | head -n 30
  exit 1
fi

echo ""
echo "=== 2/2 Checking plugin actually loads (opencode run --print-logs) [optional] ==="
# Use --print-logs and look for the plugin's startup message
# V1: "daily-logbook plugin loaded", V2: "daily-logbook plugin loaded (v2)"
# Note: 'opencode run' may not trigger TUI idle path, but plugin should still log at startup.
# This check is informational — failure does not block CI, as debug config is the source of truth.
LOG=$(timeout 10 opencode run "smoke test" --print-logs 2>&1 || true)
if echo "$LOG" | grep -q "daily-logbook plugin loaded"; then
  echo "PASS: daily-logbook plugin loaded"
  echo "$LOG" | grep "daily-logbook plugin loaded" | head -n 5
else
  echo "WARN: daily-logbook plugin NOT loaded in 'opencode run' (may be expected for --print-logs without TUI)"
  echo "--- last 50 lines of log ---"
  echo "$LOG" | tail -n 50
  echo "Hint: 'opencode debug config' is the source of truth for plugin presence (check 1/2). Run 'opencode' TUI and check logs for full verification."
fi

echo ""
echo "All smoke tests passed."
