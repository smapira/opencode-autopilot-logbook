#!/usr/bin/env bash
# complete-uninstall.sh — opencode-autopilot-logbook 究極の完全アンインストール
# v5 (2026-09-04): 汎用版。全7箇所を原子的に除去。
# 使い方: bash scripts/complete-uninstall.sh        # 実行
#         bash scripts/complete-uninstall.sh --dry-run  # 何が消えるかだけ表示
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=true; fi
run() { if $DRY_RUN; then echo "[dry-run] $*"; else eval "$@"; fi; }

echo "=== opencode-autopilot-logbook complete uninstall (v5) ==="
echo "dry-run: $DRY_RUN"
echo ""

# 0) 事前状態の表示（常に出す）
echo "--- 0) pre-check ---"
echo "[npm global]"; npm list -g opencode-autopilot-logbook 2>&1 | head -n 5 || true
echo "[opencode.json]"; cat ~/.config/opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "clean"
echo "[opencode.jsonc]"; cat ~/.config/opencode/opencode.jsonc 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "clean"
echo "[cache packages]"; ls -1 ~/.cache/opencode/packages/ 2>&1 | grep -E "autopilot|list" || echo "packages clean"
echo "[cache npm]"; ls -1 ~/.cache/opencode/npm/ 2>&1 | grep -E "autopilot|list" || echo "npm clean"
echo "[local .opencode]"; cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "no local .opencode"
echo "[local .github]"; cat .github/opencode.json 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "no .github/opencode.json"
echo ""

# 1) グローバル設定（両ファイル・両キー）
echo "--- 1) global configs (~/.config/opencode/opencode.json + opencode.jsonc) ---"
run 'python3 -c "
import json, pathlib, copy
for p in [pathlib.Path.home()/\".config/opencode/opencode.json\", pathlib.Path.home()/\".config/opencode/opencode.jsonc\"]:
    if p.exists():
        j=json.loads(p.read_text())
        orig=copy.deepcopy(j)
        for k in (\"plugin\",\"plugins\"):
            if k in j:
                v=j[k]
                if k==\"plugin\":
                    j[k]=[x for x in v if x not in (\"opencode-autopilot-logbook\",\"opencode-autopilot-logbook@2.0.5\",\"list\")]
                else:
                    j[k]=[x for x in v if x.get(\"package\") not in (\"opencode-autopilot-logbook\",\"opencode-autopilot-logbook@2.0.5\",\"list\")]
                if not j[k]: j.pop(k,None)
        if j!=orig:
            p.write_text(json.dumps(j, indent=2)+\"\n\")
            print(f\"cleaned {p}\")
        else:
            print(f\"already clean {p}\")
"'

# 2) npm global
echo "--- 2) npm global ---"
run 'npm uninstall -g opencode-autopilot-logbook 2>&1 | head -n 5 || true'

# 3) キャッシュ（packages + npm）
echo "--- 3) cache ---"
run 'rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* ~/.cache/opencode/packages/list* ~/.cache/opencode/packages/list@latest'
run 'rm -rf ~/.cache/opencode/npm/opencode-autopilot-logbook* ~/.cache/opencode/npm/list*'
run 'echo "cache cleaned"'

# 4) ローカル残留（リポジトリ直下の .opencode + .github）
echo "--- 4) local project configs ---"
run 'python3 -c "
import json, pathlib
for p in [pathlib.Path(\".opencode/opencode.json\"), pathlib.Path(\".github/opencode.json\")]:
    if p.exists():
        j=json.loads(p.read_text())
        for k in (\"plugin\",\"plugins\"):
            if k in j:
                v=j[k]
                if k==\"plugin\":
                    j[k]=[x for x in v if x not in (\"opencode-autopilot-logbook\",\"opencode-autopilot-logbook@2.0.5\",\"list\")]
                else:
                    j[k]=[x for x in v if (x if isinstance(x,str) else x.get(\"package\")) not in (\"opencode-autopilot-logbook\",\"opencode-autopilot-logbook@2.0.5\",\"list\")]
                if not j[k]: j.pop(k,None)
        if set(j.keys())=={\"$\"+\"schema\"}: p.unlink(); print(f\"removed {p} (only schema left)\")
        else: p.write_text(json.dumps(j, indent=2)+\"\n\"); print(f\"cleaned {p}: {j}\")
    else:
        print(f\"no {p}\")
"'

# 5) バックアップ（任意だが究極版では除去）
echo "--- 5) backups ---"
run 'rm -f ~/.config/opencode/opencode.jsonc.bak && echo "removed opencode.jsonc.bak if existed" || true'

# 6) 検証（7項目すべて clean になるはず）
echo ""
echo "=== post-check (all should be clean) ==="
echo "[npm global]"; npm list -g opencode-autopilot-logbook 2>&1 | head -n 5 || true
echo "[opencode.json]"; cat ~/.config/opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "clean"
echo "[opencode.jsonc]"; cat ~/.config/opencode/opencode.jsonc 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "clean"
echo "[opencode2 plugin list]"; opencode2 plugin list 2>&1 | head -n 5 || true
echo "[cache packages]"; ls -1 ~/.cache/opencode/packages/ 2>&1 | grep -E "autopilot|list" || echo "packages cache clean"
echo "[cache npm]"; ls -1 ~/.cache/opencode/npm/ 2>&1 | grep -E "autopilot|list" || echo "npm cache clean"
echo "[local]"; cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo "local .opencode clean"; cat .github/opencode.json 2>/dev/null | python3 -m json.tool | grep -E '"plugin"|"plugins"' || echo ".github clean"
echo "[grep scan]"; grep -r "autopilot" ~/ --include="opencode.json*" 2>/dev/null | grep -v ".cache" | head -n 5 || echo "grep clean"
echo "[env]"; env | grep OPENCODE_DAILY || echo "no OPENCODE_DAILY env"
echo ""
if $DRY_RUN; then echo "dry-run finished (no files changed)"; else echo "complete uninstall finished"; fi
