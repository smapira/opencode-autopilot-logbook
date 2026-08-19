# Future Readiness Review (Local)

Date: 2026-08-19

This document summarizes what `opencode-autopilot-logbook` provides today (based on the local README + implementation) and what is missing for long-term (“future-ready”) usage.

## What it does (today)

- Triggers on `session.idle` and creates a *new* session that prompts the agent to generate a daily logbook.
- Loads a custom template from `OPENCODE_DAILY_LOGBOOK_TEMPLATE` (fallback to a built-in template).
- Lets you change the output directory via `OPENCODE_DAILY_LOGBOOK_OUTPUT_DIR`.
- Can be disabled via `OPENCODE_DAILY_LOGBOOK_DISABLED=true`.

## Important implementation behaviors (not obvious from README)

- The plugin fetches the original session messages and embeds a truncated transcript excerpt into the prompt.
- It includes a duplicate-trigger guard (in-flight + time window) and skips sessions it generated itself (via a title prefix).

## Language policy (mixed Japanese/English)

To reduce “mixed-language” output (which tends to be harder to scan and reuse):

- Prefer **English-first** daily logbooks.
- If the source session contains both Japanese and English, write the logbook **primarily in English**.
- If you need bilingual output, make it explicit in your custom template and keep a consistent structure.

## Gaps to address for “future-ready” usage

- Manual command `/daily-logbook` is mentioned in README but is not present in this repository (no local command definition).
- Build/artifact hygiene should be kept consistent (source → `dist/` output should always match what is shipped).
- Redaction/masking strategy is not defined (transcripts may copy secrets into the logbook prompt).
- “Once per day” semantics and more robust throttling/configuration are not defined (cost/noise control).

## Suggested next steps (if you want to harden this tool)

- Add a real manual command implementation (or remove the README claim).
- Add an explicit “English-first” guideline to templates (and keep README + built-in template consistent).
- Add simple masking for obvious secrets before embedding transcripts (or provide a config option to disable transcript embedding).
- Add a stable throttle policy (e.g., once per day per workspace, or configurable window).

