import type { PluginInput } from "@opencode-ai/plugin";
import type { SessionPort } from "../../application/ports";

type Logger = PluginInput["client"];

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
