# Agent Guide

Hybrid OpenCode plugin (v1 `opencode` 1.18.x + v2 `opencode2` beta). Entry `src/plugin.ts` → built artifact `dist/index.js` (committed). Runtime `bun`.

## Commands

- `bun run build` — rebuild `dist/index.js`. Never hand-edit `dist/`.
- `bun run test` — unit tests, skips `vendor/`.
- Pre-commit hook (`.githooks/`, via `core.hooksPath`) runs **all five**: `npx tsc --noEmit` → `npx eslint .` (includes complexity cap) → bare `bun test` → `madge --circular` → `bun scripts/verify-diagnostic-logs.ts`. A commit must pass all five.
- Bare `bun test` recurses into `vendor/` (submodule), unlike `bun run test`. The 5th test file in full runs is the vendor runtime test.
- Focused: `bun test test/<name>.test.ts`. Coverage: `bun test --coverage`.

## Environment gotchas

- `OPENCODE_DAILY_LOGBOOK_TEMPLATE` must be an **absolute** path. A relative path resolves against the *project* directory (`loadTemplate`), so any other project gets ENOENT and silently falls back to the English `SAMPLE_TEMPLATE` with a warn.
- The operator shell sets that var. Tests must be hermetic: save/delete/restore it (and `..._DAILY_LIMIT` / `..._THROTTLE_MS`) at file top-level. Run suites with `env -u OPENCODE_DAILY_LOGBOOK_TEMPLATE` or unrelated failures appear.
- Verbose v2 logs are behind `DAILY_LOGBOOK_DEBUG=1` (`VERBOSE` / `LOG_EVENTS` also work). The v1-host skip path is silent by default; `scripts/verify-diagnostic-logs.ts` encodes this contract.

## Architecture

- `src/adapters/v1/` (idle hook) + `src/adapters/v2/` (`v2Setup`, subscribe loop + `{event}` hook dual delivery). `detectV1Host` keys off ctx shape; `v2Setup` skips on v1 hosts.
- Upstream truth: `session.idle` is deprecated, canonical is `session.status` — the host publishes both. Route both through `isIdleV2Event`; any new event shape must be added there with a test.
- `generateDailyLogbookCore` never writes a file itself; file output happens downstream (LLM prompt or file-direct fallback). Assert at those seams, not on core.
- `vendor/opencode` submodule pins upstream dev for runtime tests (`.../test/plugin/dailylogbook-runtime.test.ts` drives the real host). Don't commit inside it without an explicit order.

## Host separation

- v1 reads `~/.config/opencode/opencode.json` (`plugin` key), v2 reads `opencode.jsonc` (`plugins` key), with separate `XDG_DATA_HOME` data dirs. Never mix `opencode`/`opencode2` commands for one task.
- Never run `opencode plugin list` — v1 treats the arg as a package name and installs junk.
