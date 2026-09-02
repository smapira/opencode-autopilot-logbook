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

```bash
npm install -g opencode-autopilot-logbook
opencode plugin opencode-autopilot-logbook -g
```

> If you get "No plugin targets found", clear the OpenCode cache first:
> ```bash
> rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
> ```

### Restart OpenCode

Quit and relaunch OpenCode.

### Verify

- Start a session, do some work, then let it idle
- A daily report will be generated automatically

## Uninstall

```bash
opencode plugin opencode-autopilot-logbook -g --remove
npm uninstall -g opencode-autopilot-logbook
rm -rf ~/.cache/opencode/packages/opencode-autopilot-logbook*
```

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
