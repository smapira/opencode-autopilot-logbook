import { isRedactEnabled, maskSecrets } from "./masking";

const TRANSCRIPT_MAX_MESSAGES = 80;
const TRANSCRIPT_MAX_CHARS = 12_000;

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)`;
}

export function extractReadableText(part: { type: string; [key: string]: unknown }): string {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  return "";
}

export function buildTranscript(
  messages: Array<{ info: { role: "user" | "assistant" }; parts: Array<{ type: string; [key: string]: unknown }> }>,
): string {
  const recentMessages = messages.slice(-TRANSCRIPT_MAX_MESSAGES);
  const transcriptLines = recentMessages
    .map(({ info, parts }) => {
      const roleLabel = info.role === "user" ? "User" : "Assistant";
      const text = parts
        .map((part) => extractReadableText(part))
        .join("\n")
        .trim();
      if (!text) return "";
      return `[${roleLabel}]\n${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
  if (!transcriptLines) return "(No summarizable text history found in the source session)";
  const maskedTranscript = isRedactEnabled() ? maskSecrets(transcriptLines) : transcriptLines;
  return truncateText(maskedTranscript, TRANSCRIPT_MAX_CHARS);
}
