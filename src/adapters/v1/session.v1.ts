import type { PluginInput } from "@opencode-ai/plugin";
import type { AppLogSink, SessionPort } from "../../application/ports";

type Logger = PluginInput["client"];

// V1 file-direct fallback — mirrors V2's createFallbackSessionAdapter but for V1 host.
// Uses directory-aware resolve so withIsolatedDir E2E can verify file creation without LLM/TUI.
export async function createV1FallbackSessionPort(
  sink: AppLogSink,
  directory: string,
): Promise<SessionPort> {
  await sink.info?.(`v1: using file-direct fallback session adapter directory=${directory}`);
  return {
    get: async () => ({ data: { title: "fallback" } }),
    getMessages: async () => ({ data: [] }),
    create: async (title: string) => ({ data: { id: `fallback-v1-${Date.now()}` }, title }),
    prompt: async (_id: string, text: string) => {
      await writeDirectFileV1(text, sink, directory);
      return {};
    },
  };
}

async function writeDirectFileV1(text: string, sink: AppLogSink, directory: string): Promise<void> {
  try {
    const match = text.match(/Create `([^`]+)`/);
    const filePath = match ? match[1] : `artifacts/daily/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_logbook.md`;
    const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
    const { resolve, dirname, isAbsolute } = await import("node:path");
    const absPath = isAbsolute(filePath) ? filePath : resolve(directory, filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    const existing = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
    const content = `${existing ? existing + "\n\n" : ""}# Daily Logbook ${new Date().toISOString().slice(0, 10)}\n\n${text.slice(0, 2000)}\n`;
    writeFileSync(absPath, content);
    await sink.info?.(`v1 fallback direct write to ${absPath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.warn(`v1 fallback direct write failed: ${msg}`);
  }
}

export function createV1SessionPort(client: Logger): SessionPort {
  return {
    get: (id) => client.session.get({ path: { id } }) as Promise<unknown>,
    getMessages: (id) => client.session.messages({ path: { id } }) as Promise<unknown>,
    create: (title) => client.session.create({ body: { title } }) as Promise<unknown>,
    prompt: (id, text) =>
      client.session.promptAsync({
        path: { id },
        body: { parts: [{ type: "text", text }] },
      }) as Promise<unknown>,
  };
}
