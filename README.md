# OpenCode Autopilot Logbook

![OpenCode Autopilot Logbook](assets/thumbnail.png)

[![npm version](https://img.shields.io/npm/v/opencode-autopilot-logbook)](https://www.npmjs.com/package/opencode-autopilot-logbook) [![npm downloads](https://img.shields.io/npm/dm/opencode-autopilot-logbook)](https://www.npmjs.com/package/opencode-autopilot-logbook) [![GitHub stars](https://img.shields.io/github/stars/smapira/opencode-autopilot-logbook)](https://github.com/smapira/opencode-autopilot-logbook) [![license](https://img.shields.io/npm/l/opencode-autopilot-logbook)](LICENSE)

An OpenCode plugin that automatically generates daily reports when a session becomes idle.

[README in Japanese](./README.jp.md)

## Features

- Auto-generates daily reports on `session.idle` events
- Configurable output directory
- Custom templates supported via environment variable
- Multi-language support via custom templates (output language is template-driven)
- Usage statistics (cost/tokens) via `{{ usage }}` template variable (read from `~/.local/share/opencode/opencode.db`)

## Install

First check which OpenCode you have:

```bash
opencode --version   # → 1.18.x = v1 (stable, Homebrew)
opencode2 --version  # → 0.0.0-beta-xxxxx = v2 (beta)
```

Use the matching command set. Mixing them (e.g. installing with `opencode` and checking with `opencode2 plugin list`) will show `No plugins found` because they read different config files.

### OpenCode v1 — stable (Homebrew, `opencode` 1.18.x)

Use `opencode-autopilot-logbook@2.0.9` (latest hybrid — works on both v1 and v2). `2.0.3` is the last v1-only release if you need to pin.

```bash
npm install -g opencode-autopilot-logbook@2.0.9
opencode plugin opencode-autopilot-logbook -g
```

> `opencode plugin list` does **not** exist in v1. `opencode plugin <name>` treats the argument as an npm package to install — running `opencode plugin list` installs an unrelated package named `list` and pollutes `~/.config/opencode/opencode.json`. To inspect plugins, use:
> ```bash
> cat ~/.config/opencode/opencode.json | python3 -m json.tool | grep -A5 plugin
> ```

> If you get "No plugin targets found", clear the cache and retry:
> ```bash
> rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
> opencode plugin opencode-autopilot-logbook -g
> ```

### OpenCode v2 — beta (`opencode2` 0.0.0-beta-xxxxx)

Use `opencode-autopilot-logbook@2.0.9` (latest hybrid — works on both v1 and v2). `2.0.5` was the first v2-only release.

```bash
npm install -g opencode-autopilot-logbook@2.0.9
opencode2 plugin add opencode-autopilot-logbook
```

v2 reads `~/.config/opencode/opencode.jsonc` and prefers the `plugins` key:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "opencode-autopilot-logbook" }]
}
```

> Do not use `opencode plugin ... -g` when you are on `opencode2` — it writes to `opencode.json` (v1) which `opencode2` does not read.

### Restart & Verify

Quit and relaunch OpenCode, then:

- Start a session, do some work, then let it idle
- A daily report will be generated at `artifacts/daily/YYYYMMDD_logbook.md`

Verify:

```bash
# v1
cat ~/.config/opencode/opencode.json | python3 -m json.tool
# v2
opencode2 plugin list
cat ~/.config/opencode/opencode.jsonc | python3 -m json.tool | grep -A5 plugins
```

### Update

#### v1

```bash
npm install -g opencode-autopilot-logbook@2.0.9
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
opencode plugin opencode-autopilot-logbook -g --force

npm list -g opencode-autopilot-logbook
```

#### v2

```bash
npm install -g opencode-autopilot-logbook@2.0.9
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
opencode2 plugin remove opencode-autopilot-logbook 2>/dev/null; opencode2 plugin add opencode-autopilot-logbook

opencode2 plugin list
npm list -g opencode-autopilot-logbook
```

## Uninstall

`npm uninstall -g` alone leaves config and cache. Clean all 4 places — global config, local project config, npm global, and cache.

> ```bash
> bash scripts/complete-uninstall.sh          # run for real
> bash scripts/complete-uninstall.sh --dry-run # preview what will be removed
> ```
> Then verify with the `Verify — Detect Any Remnants` block below. See `scripts/complete-uninstall.sh` for the exact commands.

#### v1 — `opencode` 1.18.x (reads `~/.config/opencode/opencode.json`, key `plugin`)

`opencode` 1.18.x has no `plugin remove` subcommand. Remove the entry manually:

```bash
# 1. Remove from global config (and also delete "list" if it exists
#    — it is a leftover from running `opencode plugin list` which v1 treats as an npm package)
#    Do it by hand, or run the one-liner below that also cleans opencode.jsonc and the v2 `plugins` key
#    Example clean state: "plugin": []  or remove the key entirely if no other plugins
npm uninstall -g opencode-autopilot-logbook
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* ~/.cache/opencode/packages/list* ~/.cache/opencode/packages/list@latest
rm -rf ~/.cache/opencode/npm/opencode-autopilot-logbook* ~/.cache/opencode/npm/list*

# 2. If this repository still shows the plugin locally, clean it too
#    (leftover ".opencode/opencode.json" with "list" was observed after `opencode plugin list`)
cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 plugin || echo "no local .opencode/opencode.json"
# if it contains "list" or "opencode-autopilot-logbook", edit .opencode/opencode.json and remove them
```

One-liner that cleans both global files (`opencode.json` + `opencode.jsonc`) and both keys (`plugin` + `plugins`):

```bash
python3 -c "
import json, pathlib
for p in [pathlib.Path.home()/'.config/opencode/opencode.json', pathlib.Path.home()/'.config/opencode/opencode.jsonc']:
    if p.exists():
        j=json.loads(p.read_text())
        for k in ('plugin','plugins'):
            if k in j:
                v=j[k]
                if k=='plugin':
                    j[k]=[x for x in v if x not in ('opencode-autopilot-logbook','list')]
                else:
                    j[k]=[x for x in v if x.get('package') not in ('opencode-autopilot-logbook','list')]
                if not j[k]: j.pop(k,None)
        p.write_text(json.dumps(j, indent=2)+'\n')
        print(f'cleaned {p}:', j.get('plugin', j.get('plugins','(removed)')))
"
# then verify — see "Verify — Detect Any Remnants" below for the full checklist
```

#### v2 — `opencode2` 0.0.0-beta-xxxxx (reads `~/.config/opencode/opencode.jsonc`, key `plugins`)

```bash
# 1. Preferred — via CLI (removes from opencode.jsonc `plugins`)
opencode2 plugin remove opencode-autopilot-logbook
opencode2 plugin list  # should show "No plugins found" or no autopilot entry

# 2. Fallback if CLI misses legacy `plugin` key — same one-liner as v1 (cleans both keys in both files)
python3 -c "
import json, pathlib
for p in [pathlib.Path.home()/'.config/opencode/opencode.json', pathlib.Path.home()/'.config/opencode/opencode.jsonc']:
    if p.exists():
        j=json.loads(p.read_text())
        for k in ('plugin','plugins'):
            if k in j:
                v=j[k]
                if k=='plugin':
                    j[k]=[x for x in v if x not in ('opencode-autopilot-logbook','list')]
                else:
                    j[k]=[x for x in v if x.get('package') not in ('opencode-autopilot-logbook','list')]
                if not j[k]: j.pop(k,None)
        p.write_text(json.dumps(j, indent=2)+'\n')
        print(f'cleaned {p}:', j.get('plugin', j.get('plugins','(removed)')))
"

# 3. npm global + cache (packages + npm sub-cache)
npm uninstall -g opencode-autopilot-logbook
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook* ~/.cache/opencode/packages/list* ~/.cache/opencode/packages/list@latest
rm -rf ~/.cache/opencode/npm/opencode-autopilot-logbook* ~/.cache/opencode/npm/list*

# 4. Local project leftover (same as v1)
cat .opencode/opencode.json 2>/dev/null | python3 -m json.tool | grep -A5 plugin || echo "no local .opencode/opencode.json"
```

----

## Environment Variables

All settings below are configured via environment variables. Set them **before launching OpenCode** and then restart OpenCode. Variables are read at startup.

**For one session only**

```bash
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"
opencode
```

**To persist across sessions**

Add the `export` line to your shell profile (`~/.zshrc` for zsh, `~/.bashrc` for bash), then reload it.

```bash
echo 'export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"' >> ~/.zshrc
source ~/.zshrc
```

Verify the value is set with `echo $OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` and check that `{{ outputDir }}/YYYYMMDD_logbook.md` is created in the expected location.

### `OPENCODE_DAILY_LOGBOOK_DISABLED`

- Default: `false`
- Set to `true` to disable the plugin

```bash
export OPENCODE_DAILY_LOGBOOK_DISABLED=true
```

### `OPENCODE_DAILY_LOGBOOK_TEMPLATE`

- Default: not set (uses built-in `SAMPLE_TEMPLATE`)
- Set to a file path to use a custom template
- Falls back to `SAMPLE_TEMPLATE` if the specified file cannot be read

```bash
export OPENCODE_DAILY_LOGBOOK_TEMPLATE="documents/plans/dev/daily-logbook.md"
```

### `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR`

- Default: `artifacts/daily`
- Set to change the output directory for daily reports
- Relative paths are resolved against the plugin directory (`resolve(directory, outputDir)`). Absolute paths are used as is. When `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true`, the value is passed to the prompt as an absolute path so the existence check and the agent write to the same location

Examples

```bash
# Simple folder in the repository
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"

# Under documents
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="documents/daily"

# Absolute path for temporary testing
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="/tmp/my-logs"
```

Verify with `ls -la daily/` or the directory you chose to confirm `YYYYMMDD_logbook.md` is created there

### `OPENCODE_DAILY_LOGBOOK_REDACT`

- Default: `true`
- When enabled, known secret patterns (`sk-...`/`SK-...`, `Bearer <token>`, `AKIA...`, `ghp_...`, `github_pat_...`, `xoxb-...`, JWT (`eyJ...`), PEM private keys, `password:`-style pairs, etc.) in the transcript are replaced with `***` before being embedded into the prompt
- Only the exact value `"false"` disables masking. Any other value keeps the default (`true`)
- Masking is a fail-safe to reduce accidental disclosure. It is **not** a guarantee of complete secrecy. Never rely on it to protect sensitive information

Masking limitations:

- OpenAI-style keys are matched case-insensitively (`sk-...` and `SK-...`)
- JWTs with any segment shorter than 10 characters are **not** masked (the matcher requires at least 10 characters per segment)
- `Bearer` matching is context-free, so natural-language phrases such as "bearer of" may be over-masked

```bash
export OPENCODE_DAILY_LOGBOOK_REDACT=false
```

### `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT`

- Default: `true`
- When `"false"`, the transcript is not embedded into the prompt at all (the template alone is used)
- Only the exact value `"false"` disables embedding. Any other value keeps the default (`true`)
- When this is `"false"`, the transcript is never embedded regardless of the `OPENCODE_DAILY_LOGBOOK_REDACT` setting

```bash
export OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT=false
```

### `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS`

- Default: `90000` (90 seconds)
- Minimum interval between two automatic generations for the same session
- Parsed as an integer. If the value cannot be parsed as a non-negative integer, the default is used
- `0` disables throttling (every idle event triggers generation, subject to other limits)
- Values in scientific notation (e.g. `1e3`) are truncated by the integer parser and read as `1`, not `1000`

```bash
export OPENCODE_DAILY_LOGBOOK_THROTTLE_MS=180000
```

### `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT`

- Default: `false`
- Only the exact value `"true"` enables the limit. Any other value keeps the default (`false`)
- When enabled, generation is skipped if `{{ outputDir }}/{{ date }}_logbook.md` already exists for today (file-based check, survives process restarts)
- **When enabled, the append-style workflow becomes once per day** (Issue C)
- **If the file exists but is empty or incomplete (e.g. a previous generation failed), regeneration is blocked for the rest of the day** (Issue D). The check is purely file-existence based
- **Concurrent idle events for the same date are suppressed**: while a generation for today is in flight, other sessions that idle at the same time are skipped (an in-memory, date-keyed guard; does not survive process restarts)
- **When enabled, `{{ outputDir }}` is passed to the prompt as an absolute path** resolved against the plugin's directory, so the agent writes to the same location the existence check inspects. When disabled, the relative string (e.g. `artifacts/daily`) is passed as before
- **Not supported together with `OPENCODE_DAILY_LOGBOOK_TEMPLATE`**: a custom template may change the file name pattern, so the existence check cannot be performed. A warning is logged and the daily limit check is skipped in that case

```bash
export OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true
```

### `OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY`

- Default: `true`
- When `true`, usage is aggregated for the current project only (resolved via `project.worktree` matching `directory`). When `"false"`, aggregates across all projects
- Only the exact value `"false"` disables project filtering. Any other value keeps the default (`true`)
- If the project cannot be resolved (e.g. global worktree `/`), falls back to all projects

```bash
export OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY=false
```

### `OPENCODE_DAILY_LOGBOOK_DB_PATH`

- Default: `~/.local/share/opencode/opencode.db`
- Override the path to the OpenCode database used for usage statistics
- Opened `read-only`; if the file does not exist or cannot be opened, usage is omitted and the daily report is still generated

```bash
export OPENCODE_DAILY_LOGBOOK_DB_PATH="$HOME/.local/share/opencode/opencode.db"
```

## Template Variables

Available in `SAMPLE_TEMPLATE` and custom templates:

| Variable | Description |
|----------|-------------|
| `{{ sessionId }}` | Source session ID |
| `{{ date }}` | `YYYYMMDD` (e.g. `20260902`) |
| `{{ dateJp }}` | Japanese date `YYYY年M月D日` |
| `{{ outputDir }}` | Output directory (relative or absolute, see `OUTPUT_DIR` / `DAILY_LIMIT`) |
| `{{ usage }}` / `{{ usageTable }}` | Usage statistics table (cost/tokens). Canonical is `{{ usage }}`, `{{ usageTable }}` is an alias. Resolved from `opencode.db` (`session` table, `time_created` in ms). See `USAGE_PROJECT_ONLY` / `DB_PATH` |

Example usage in a custom template:

```markdown
## Usage
{{ usage }}
```

When the database is unavailable or the day has no sessions, the variable is replaced with an empty string.

## Output

- Daily report: `{{ outputDir }}/YYYYMMDD_logbook.md`

Existing files are updated (appended), not overwritten.

## Philosophy

This column outlines the principles that guide how we engage with OSS. These principles are the reason we continue our day-to-day OSS activities and writing. It reframes long-unreviewed social structures as a form of technical debt. We would be glad if you take a look.

- [Engineering Blog: Society Also Has Technical Debt](https://www.thch-vape.shop/guide/column/git-log--oneline--all--society)

## License

MIT
