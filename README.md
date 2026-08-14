# OpenCode Autopilot Logbook

An OpenCode plugin that automatically generates daily reports when a session becomes idle.

[README in Japanese](./README.jp.md)

## Features

- Auto-generates daily reports on `session.idle` events
- Configurable output directory
- Manual trigger via `/daily-logbook` command
- Custom templates supported via environment variable

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
export OPENCODE_DAILY_LOGBOOK_TEMPLATE="plans/dev/daily-logbook.md"
```

### `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR`

- Default: `artifacts/daily/`
- Set to change the output directory for daily reports

```bash
export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"
```

## Output

- Daily report: `{{ outputDir }}/YYYYMMDD_logbook.md`

Existing files are updated (appended), not overwritten.

## License

MIT
