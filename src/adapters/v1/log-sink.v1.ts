import type { PluginInput } from "@opencode-ai/plugin";
import type { AppLogSink } from "../../application/ports";

const SERVICE_NAME = "daily-logbook-plugin";

type Logger = PluginInput["client"];

export function createV1LogSink(client: Logger): AppLogSink {
  return {
    warn: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "warn", message } });
      } catch {}
    },
    error: async (message, error) => {
      const msg = error instanceof Error ? error.message : String(error ?? "");
      const full = msg ? `${message}: ${msg}` : message;
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "error", message: full } });
      } catch {}
    },
    info: async (message) => {
      try {
        await client.app.log({ body: { service: SERVICE_NAME, level: "info", message } });
      } catch {}
    },
  };
}
