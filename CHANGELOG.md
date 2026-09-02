# Changelog

## 1.2.0 (2026-09-02)

### Added

- Usage statistics via `{{ usage }}` / `{{ usageTable }}` template variables (canonical is `{{ usage }}`). `SAMPLE_TEMPLATE` now includes `## Usage` / `{{ usage }}` so daily reports show cost/tokens by default. Resolved from `~/.local/share/opencode/opencode.db` (`session` table, `time_created` in ms epoch) with `bun:sqlite` (`readonly: true`, `?` binding, `coalesce(sum,0)`). Table includes `Cost (本日/セッション)` / `Tokens Input / Output / Cache Read` / `Sessions (本日)` / `Total Cost (累計)` with `formatCost` (`$x.xx`) and `formatTokens` (`K/M/B`)
- `OPENCODE_DAILY_LOGBOOK_USAGE_PROJECT_ONLY` (default `true`, only `"false"` disables; resolves `project.worktree` via `resolve(directory)`, falls back to all projects) and `OPENCODE_DAILY_LOGBOOK_DB_PATH` (default `~/.local/share/opencode/opencode.db`, `read-only` open, omitted on failure)
- Unit/integration tests for `getUsageStats` (tmp file DB), `formatUsageTable`, `replaceTemplateVariables` (`$` safety), `buildPrompt` with usage, and `DailyLogbookPlugin` with usage. `PLUGIN_ENV_KEYS` now includes the two new env vars

### Changed

- Documented the new feature in both READMEs (`## Features` / `## 機能`, `## Template Variables` / `## テンプレート変数`, and the two new env var sections). `README.md` Features now lists usage statistics; template variable table includes `{{ usage }}` / `{{ usageTable }}`
- `SAMPLE_TEMPLATE` is now exported and contains `## Usage` / `{{ usage }}`. Custom templates can place `{{ usage }}` at any position; when the database is unavailable or the day has no sessions, the variable is replaced with an empty string
- `replaceTemplateVariables` / `buildPrompt` now use function-form `() => value` replacements to avoid `$` special expansion (`$2.31` safety)

## 1.1.1 (2026-08-30)

### Added

- Philosophy section in READMEs linking to the guiding column on OSS principles (`https://www.thch-vape.shop/guide/column/git-log--oneline--all--society`). English README uses `## Philosophy`, Japanese README uses `## フィロソフィー` with the same intent. The column frames long-unreviewed social structures as technical debt and explains why we continue OSS activities and writing

### Changed

- Documented how to configure environment variables in both READMEs (`## Environment Variables` / `## 環境変数`). Added a common intro explaining that variables are read at startup and require an OpenCode restart, with examples for one-session (`export ...` then `opencode`) and persistent (`~/.zshrc` / `~/.bashrc`) usage and verification via `echo` and `ls`
- Expanded `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` documentation in both READMEs with path-resolution details (`resolve(directory, outputDir)` for relative paths, absolute paths as is, and absolute-path promotion when `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true`) and three concrete examples (`daily`, `documents/daily`, `/tmp/my-logs`)

## 1.1.0 (2026-08-19)

### Added

- Secret masking: known secret patterns in the transcript (`sk-...`/`SK-...`, `Bearer <token>`, `AKIA...`, `ghp_...`, `github_pat_...`, `xoxb-...`, JWT (`eyJ...`), PEM private keys, `password:`-style pairs, etc.) are replaced with `***` before being embedded into the prompt
  - Applied **before** truncation so a secret split at the cut point is not leaked
  - Controlled by `OPENCODE_DAILY_LOGBOOK_REDACT` (default `true`, only `"false"` disables)
  - `OPENCODE_DAILY_LOGBOOK_INCLUDE_TRANSCRIPT` (default `true`, only `"false"` disables) can omit the transcript entirely; when `false`, the transcript is never embedded regardless of `REDACT`
  - Masking is a fail-safe to reduce accidental disclosure, not a guarantee of complete secrecy
  - Uppercase `SK-` keys are also masked (case-insensitive `sk-`/`SK-`); short JWTs (any segment < 10 chars) and context-free `Bearer` over-masking are documented limitations
- Configurable throttle window: `OPENCODE_DAILY_LOGBOOK_THROTTLE_MS` (integer parse, falls back to 90000 on NaN/negative)
- Daily limit: `OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true` skips generation when `{{ outputDir }}/{{ date }}_logbook.md` already exists (file-based check, survives process restarts)
  - Not supported together with `OPENCODE_DAILY_LOGBOOK_TEMPLATE` (warns and skips the check)
  - **Concurrent idle events for the same date are suppressed** via an in-memory date-keyed in-flight guard (different sessions idling at the same time no longer both pass the existence check)
  - **`{{ outputDir }}` is passed as an absolute path** (resolved against the plugin directory) when the limit is enabled, so the agent writes to the same location the existence check inspects; the relative string is kept when disabled
- Unit tests via `bun test` (`test/daily-logbook.test.ts`) covering masking, throttle window, daily-limit existence check, daily-limit concurrency guard, and absolute-path prompt resolution

### Changed

- `{{ dateJp }}` template variable value changed from ISO (`YYYY-MM-DD`, introduced in 1.0.9) back to Japanese (`YYYY年M月D日`) at the source level. No public behavior impact documented in this release; recorded for completeness

### Fixed

- Removed the "manual trigger via `/daily-logbook` command" claim from READMEs; the command files are now documented as repository-local features, not plugin features
- Dropped the stale build artifact `dist/daily-logbook.js`; `dist/` now contains only `index.js`
- Relocated the sample custom template to `documents/plans/dev/daily-logbook.md` (committed) and updated the `OPENCODE_DAILY_LOGBOOK_TEMPLATE` README example to point to it; removed the leftover root `plans/` directory to complete the `plans/` → `documents/plans/` reorganization
- Standardized the `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR` default notation to `artifacts/daily` (no trailing slash) in READMEs to match the implementation

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
