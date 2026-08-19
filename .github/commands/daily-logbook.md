---
description: Generate a daily logbook for this session
agent: build
---

> This is a **repository-local command**, not a feature of the `opencode-autopilot-logbook`
> npm plugin. The plugin auto-generates logbooks on `session.idle`; this command exists
> for manual invocation inside this repository only.

Create a daily logbook for this session.

Steps:
1. Determine today's date (YYYYMMDD).
2. Create or update (append; do not overwrite) `artifacts/daily/YYYYMMDD_logbook.md`.
3. Keep it concise: highlights, decisions, and next actions.

Guidelines:
- If the session contains mixed Japanese/English, prefer English in the logbook.
- Clearly separate facts from opinions (speculation/evaluation).

