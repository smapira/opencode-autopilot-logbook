# Changelog

## 1.1.0 (2026-08-19)

### Added

- Secret masking: known secret patterns in the transcript (`sk-...`, `Bearer <token>`, `AKIA...`, `ghp_...`, `xoxb-...`, PEM private keys, `password:`-style pairs, etc.) are replaced with `***` before being embedded into the prompt
  - Applied **before** truncation so a secret split at the cut point is not leaked
  - Controlled by `OPENCODE_DAILY_LOGBOOK_REDACT` (default `true`, only `"false"` disables)
  - `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT` (default `true`, only `"false"` disables) can omit the transcript entirely; when `false`, the transcript is never embedded regardless of `REDACT`
  - Masking is a fail-safe to reduce accidental disclosure, not a guarantee of complete secrecy
- Configurable throttle window: `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS` (integer parse, falls back to 90000 on NaN/negative)
- Daily limit: `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` skips generation when `{{ outputDir }}/{{ date }}_logbook.md` already exists (file-based check, survives process restarts)
  - Not supported together with `OPENCODE_DAILY_LOGBOOK_TEMPLATE` (warns and skips the check)
- Unit tests via `bun test` (`test/daily-logbook.test.ts`) covering masking, throttle window, and daily-limit existence check

### Fixed

- Removed the "manual trigger via `/daily-logbook` command" claim from READMEs; the command files are now documented as repository-local features, not plugin features
- Dropped the stale build artifact `dist/daily-logbook.js`; `dist/` now contains only `index.js`

## 1.0.6 – 1.0.9 (2026-08-14 – 2026-08-18)

Unreleased changelog entries, summarized:

- **1.0.9**: Prompt/error messages/date formats switched to English-first; README updated (removed Method B, added uninstall steps and cache-clear warning)
- **1.0.8**: `daily-logbook.ts` moved to repository root with build path update; directory reorganization (`plans/` → `documents/plans/`); removed unused files
- **1.0.7**: OpenCode plugin support; `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` added; output file name switched to English (`YYYYMMDD_logbook.md`)
- **1.0.6**: Logbook-only generation (handover document generation removed); template loading switched to environment variable + built-in sample template; output path unified to `artifacts/daily`

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
