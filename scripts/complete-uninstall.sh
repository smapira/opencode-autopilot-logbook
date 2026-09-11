#!/usr/bin/env bash
# complete-uninstall.sh — opencode-autopilot-logbook 究極の完全アンインストール
# v6 (2026-09-11): バージョン引数対応。全7箇所を原子的に除去。
# 旧版の既定値（2.0.5）は廃止。未指定時は基本名のみ、指定版だけ追加で除去する。
# 使い方: bash scripts/complete-uninstall.sh [VERSION ...] [--version X] [--dry-run]
#         bash scripts/complete-uninstall.sh 2.0.11 --dry-run  # 指定版を含めて何が消えるかだけ表示
#         bash scripts/complete-uninstall.sh --version 2.0.9 --version 2.0.11
set -euo pipefail

DRY_RUN=false
VERSIONS=()
usage() {
  echo "usage: bash scripts/complete-uninstall.sh [VERSION ...] [--version X] [--dry-run]"
  echo "  VERSION は x.y.z 形式（例: 2.0.11）。未指定時は基本名のみ除去し、指定版だけ追加で除去する"
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --version) [[ -n "${2:-}" ]] || { echo "error: --version には値が必要です" >&2; usage; exit 2; }; VERSIONS+=("$2"); shift 2 ;;
    --version=*) VERSIONS+=("${1#--version=}"); shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "error: unknown option: $1" >&2; usage; exit 2 ;;
    *)
      if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.+-]+)?$ ]]; then VERSIONS+=("$1"); shift
      else echo "error: unknown argument: $1" >&2; usage; exit 2; fi ;;
  esac
done
# バージョン重複除去（順序保持）
UNIQ_VERSIONS=()
if ((${#VERSIONS[@]} > 0)); then
  for v in "${VERSIONS[@]}"; do
    skip=false
    if ((${#UNIQ_VERSIONS[@]} > 0)); then
      for u in "${UNIQ_VERSIONS[@]}"; do [[ "$u" == "$v" ]] && skip=true && break; done
    fi
    $skip || UNIQ_VERSIONS+=("$v")
  done
fi
BAD_LIST=("opencode-autopilot-logbook" "list")
if ((${#UNIQ_VERSIONS[@]} > 0)); then
  for v in "${UNIQ_VERSIONS[@]}"; do BAD_LIST+=("opencode-autopilot-logbook@$v"); done
fi
IFS=,; export BAD_PKGS_CSV="${BAD_LIST[*]}"; unset IFS
run() { if $DRY_RUN; then echo "[dry-run] $*"; else eval "$@"; fi; }
# 空ファイルや壊れたJSONで python が騒がないための表示用ヘルパー
show_keys() { # $1=file $2=fallback message
  if [[ -s "$1" ]]; then python3 -m json.tool "$1" 2>/dev/null | grep -E '"plugin"|"plugins"' || echo "$1: no plugin keys"; else echo "$2"; fi
}

echo "=== opencode-autopilot-logbook complete uninstall (v6) ==="
echo "dry-run: $DRY_RUN"
echo "target versions: ${UNIQ_VERSIONS[*]:-none}"
echo ""

# 0) 事前状態の表示（常に出す）
echo "--- 0) pre-check ---"
echo "[npm global]"; npm list -g opencode-autopilot-logbook 2>&1 | head -n 5 || true
echo "[opencode.json]"; show_keys ~/.config/opencode/opencode.json "clean"
echo "[opencode.jsonc]"; show_keys ~/.config/opencode/opencode.jsonc "clean"
echo "[cache packages]"; ls -1 ~/.cache/opencode/packages/ 2>&1 | grep -E "autopilot|list" || echo "packages clean"
echo "[cache npm]"; ls -1 ~/.cache/opencode/npm/ 2>&1 | grep -E "autopilot|list" || echo "npm clean"
echo "[local .opencode]"; show_keys .opencode/opencode.json "no local .opencode"
echo "[local .github]"; show_keys .github/opencode.json "no .github/opencode.json"
echo ""

# 1) グローバル設定（両ファイル・両キー）
echo "--- 1) global configs (~/.config/opencode/opencode.json + opencode.jsonc) ---"
run 'python3 -c "
import json, os, pathlib, copy
bad=tuple([x for x in os.environ.get(\"BAD_PKGS_CSV\",\"\").split(\",\") if x])
for p in [pathlib.Path.home()/\".config/opencode/opencode.json\", pathlib.Path.home()/\".config/opencode/opencode.jsonc\"]:
    if p.exists():
        j=json.loads(p.read_text())
        orig=copy.deepcopy(j)
        for k in (\"plugin\",\"plugins\"):
            if k in j:
                v=j[k]
                if k==\"plugin\":
                    j[k]=[x for x in v if x not in bad]
                else:
                    j[k]=[x for x in v if (x if isinstance(x,str) else x.get(\"package\")) not in bad]
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
import json, os, pathlib
bad=tuple([x for x in os.environ.get(\"BAD_PKGS_CSV\",\"\").split(\",\") if x])
for p in [pathlib.Path(\".opencode/opencode.json\"), pathlib.Path(\".github/opencode.json\")]:
    if p.exists():
        j=json.loads(p.read_text())
        for k in (\"plugin\",\"plugins\"):
            if k in j:
                v=j[k]
                if k==\"plugin\":
                    j[k]=[x for x in v if x not in bad]
                else:
                    j[k]=[x for x in v if (x if isinstance(x,str) else x.get(\"package\")) not in bad]
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
echo "[opencode.json]"; show_keys ~/.config/opencode/opencode.json "clean"
echo "[opencode.jsonc]"; show_keys ~/.config/opencode/opencode.jsonc "clean"
echo "[opencode2 plugin list]"; opencode2 plugin list 2>&1 | head -n 5 || true
echo "[cache packages]"; ls -1 ~/.cache/opencode/packages/ 2>&1 | grep -E "autopilot|list" || echo "packages cache clean"
echo "[cache npm]"; ls -1 ~/.cache/opencode/npm/ 2>&1 | grep -E "autopilot|list" || echo "npm cache clean"
echo "[local]"; show_keys .opencode/opencode.json "local .opencode clean"; show_keys .github/opencode.json ".github clean"
echo "[grep scan]"; grep -r "autopilot" ~/ --include="opencode.json*" 2>/dev/null | grep -v ".cache" | head -n 5 || echo "grep clean"
echo "[env]"; env | grep OPENCODE_DAILY || echo "no OPENCODE_DAILY env"
echo ""
if $DRY_RUN; then echo "dry-run finished (no files changed)"; else echo "complete uninstall finished"; fi
