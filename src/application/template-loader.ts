import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SAMPLE_TEMPLATE = `Create a daily logbook based on the session {{ sessionId }}.

## Steps

1. Check today's date ({{ dateJp }})
2. Create \`{{ outputDir }}/{{ date }}_logbook.md\` (append or update if it exists)
3. Report the created filename

## Guidelines

- Do not overwrite existing files; append or update instead
- Keep the logbook concise and focused on key points
- Prioritize discussion highlights, decisions made, and next actions
- Output language is template-driven (this default template uses English)
- Clearly separate facts from opinions (speculation/evaluation)

## Usage
{{ usage }}`;

function formatDateTokens(now: Date): { date: string; dateJp: string } {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return {
    date: `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`,
    dateJp: `${y}年${m}月${d}日`,
  };
}

export function replaceTemplateVariables(
  template: string,
  sessionId: string,
  now: Date,
  outputDir: string,
  usageTable?: string,
): string {
  const { date, dateJp } = formatDateTokens(now);
  return template
    .replace(/\{\{\s*sessionId\s*\}\}/g, () => sessionId)
    .replace(/\{\{\s*date\s*\}\}/g, () => date)
    .replace(/\{\{\s*dateJp\s*\}\}/g, () => dateJp)
    .replace(/\{\{\s*outputDir\s*\}\}/g, () => outputDir)
    .replace(/\{\{\s*usage\s*\}\}/g, () => usageTable ?? "")
    .replace(/\{\{\s*usageTable\s*\}\}/g, () => usageTable ?? "");
}

export function loadTemplate(directory: string): string {
  const custom = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
  if (!custom) return SAMPLE_TEMPLATE;
  const resolved = resolve(directory, custom);
  return readFileSync(resolved, "utf-8");
}

export function buildPrompt(
  template: string,
  sessionId: string,
  transcript: string,
  includeTranscript: boolean,
  outputDir: string,
  now: Date,
  usageTable?: string,
): string {
  const replaced = replaceTemplateVariables(template, sessionId, now, outputDir, usageTable);
  if (!includeTranscript || !transcript) return replaced;
  return `${replaced}

---
Below is an excerpt of the session ${sessionId} history. Create the daily logbook based on this history.

${transcript}`;
}
