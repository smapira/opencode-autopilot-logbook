# Changelog

## 1.0.5 (2026-08-14)

### Added

- `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` environment variable to customize output directory
  - Default: `artifacts/daily/`
  - Example: `export OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR="daily"`

### Changed

- Plugin compiled to `.js` for OpenCode compatibility
- Output directory is now configurable via `{{ outputDir }}` template variable

## 1.0.0 (2026-08-12)

### Added

- Initial release
- Auto-generates daily reports on `session.idle` events
- `OPENCODE_DAILY_LOGBOOK_DISABLED` environment variable
- `OPENCODE_DAILY_LOGBOOK_TEMPLATE` environment variable for custom templates
- Template fallback to built-in `SAMPLE_TEMPLATE` on load failure
- Output: `artifacts/daily/YYYYMMDD_日報.md`
