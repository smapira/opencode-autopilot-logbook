import type { Plugin } from "@opencode-ai/plugin";
import type { AppLogSink } from "../../application/ports";
import type { SessionPort } from "../../application/ports";
import { generateDailyLogbookCore } from "../../application/generate-logbook.usecase";
import { createV1LogSink } from "./log-sink.v1";
import { createV1FallbackSessionPort, createV1SessionPort } from "./session.v1";

const SERVICE_NAME = "daily-logbook-plugin";

export async function handleV1IdleEvent(params: {
  sessionID: string;
  directory: string;
  sink: AppLogSink;
  session: SessionPort;
}): Promise<void> {
  await generateDailyLogbookCore({
    sessionId: params.sessionID,
    directory: params.directory,
    sink: params.sink,
    adapter: params.session,
  });
}

export async function createV1FallbackAdapter(
  sink: AppLogSink,
  directory: string,
): Promise<SessionPort> {
  return createV1FallbackSessionPort(sink, directory);
}

export const DailyLogbookPlugin: Plugin = async ({ client, directory }) => {
  await client.app.log({
    body: { service: SERVICE_NAME, level: "info", message: "daily-logbook plugin loaded" },
  });
  // CLI visibility for expect stdout detection (2.0.11): sink.info goes to log file, console.log to stdout
  console.log("daily-logbook plugin loaded");
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
