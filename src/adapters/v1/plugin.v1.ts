import type { Plugin } from "@opencode-ai/plugin";
import { generateDailyLogbookCore } from "../../application/generate-logbook.usecase";
import { createV1LogSink } from "./log-sink.v1";
import { createV1SessionPort } from "./session.v1";

const SERVICE_NAME = "daily-logbook-plugin";

export const DailyLogbookPlugin: Plugin = async ({ client, directory }) => {
  await client.app.log({
    body: { service: SERVICE_NAME, level: "info", message: "daily-logbook plugin loaded" },
  });
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sink = createV1LogSink(client);
      const adapter = createV1SessionPort(client);
      await generateDailyLogbookCore({
        sessionId: event.properties.sessionID,
        directory,
        sink,
        adapter,
      });
    },
  };
};
