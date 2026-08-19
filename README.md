# OpenCode Autopilot Logbook

An OpenCode plugin that automatically generates daily reports when a session becomes idle.

[README in Japanese](./README.jp.md)

## Features

- Auto-generates daily reports on `session.idle` events
- Configurable output directory
- Custom templates supported via environment variable
- If the session includes mixed Japanese/English, prefer English in the generated logbook

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

```bash
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"
```

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

## Output

- Daily report: `{{ outputDir }}/YYYYMMDD_logbook.md`

Existing files are updated (appended), not overwritten.

## License

MIT
