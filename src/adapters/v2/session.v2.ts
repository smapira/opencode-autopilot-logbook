import type { AppLogSink, SessionPort } from "../../application/ports";

export type V2SessionLike = {
  get: (input: { sessionID: string }) => Promise<unknown>;
  context?: (input: { sessionID: string }) => Promise<unknown>;
  messages?: (input: { path: { id: string } }) => Promise<unknown>;
  create: (input: { title: string }) => Promise<unknown>;
  prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  promptAsync?: (input: unknown) => Promise<unknown>;
};

export function toSessionPort(session: V2SessionLike): SessionPort {
  return {
    get: (id) => session.get({ sessionID: id }),
    getMessages: async (id) => {
      if (session.context) return session.context({ sessionID: id });
      if (session.messages) return session.messages({ path: { id } });
      return { error: new Error("no messages method available") };
    },
    create: (title) => session.create({ title }),
    prompt: async (id, text) => {
      if (session.prompt) return session.prompt({ sessionID: id, text });
      if (session.generate) return session.generate({ sessionID: id, text });
      if (session.promptAsync) {
        return session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } });
      }
      return { error: new Error("no prompt method available on session") };
    },
  };
}

export async function createFallbackSessionAdapter(
  sink: AppLogSink,
  _serverUrl: unknown,
): Promise<V2SessionLike | undefined> {
  await sink.info?.("using file-direct fallback session adapter (no SDK)");
  return {
    get: async () => ({ data: { title: "fallback" } }),
    context: async () => ({ data: [] }),
    create: async (input: { title: string }) => ({ data: { id: `fallback-${Date.now()}` }, title: input.title }),
    prompt: async (input: { sessionID: string; text: string }) => {
      await writeDirectFile(input.text, sink);
      return {};
    },
  } as unknown as V2SessionLike;
}

async function writeDirectFile(text: string, sink: AppLogSink): Promise<void> {
  try {
    const match = text.match(/Create `([^`]+)`/);
    const filePath = match ? match[1] : `artifacts/daily/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_logbook.md`;
    const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const absPath = resolve(process.cwd(), filePath);
    mkdirSync(dirname(absPath), { recursive: true });
    const existing = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
    const content = `${existing ? existing + "\n\n" : ""}# Daily Logbook ${new Date().toISOString().slice(0, 10)}\n\n${text.slice(0, 2000)}\n`;
    writeFileSync(absPath, content);
    await sink.info?.(`fallback direct write to ${absPath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.warn(`fallback direct write failed: ${msg}`);
  }
}
