import type { Plugin } from "@opencode-ai/plugin";
import type { AppLogSink } from "../../application/ports";
import type { SessionPort } from "../../application/ports";
import { generateDailyLogbookCore } from "../../application/generate-logbook.usecase";
import { createV1LogSink } from "./log-sink.v1";
import { createV1FallbackSessionPort, createV1SessionPort } from "./session.v1";

const SERVICE_NAME = "daily-logbook-plugin";

function isVerboseLogEnabled(): boolean {
  const v = process.env.DAILY_LOGBOOK_DEBUG ?? process.env.DAILY_LOGBOOK_VERBOSE ?? process.env.DAILY_LOGBOOK_LOG_EVENTS;
  return v === "1" || v === "true";
}

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
  // Verbose only: sink.info goes to log file; console.log to stdout only when debugging
  if (isVerboseLogEnabled()) {
    console.log("daily-logbook plugin loaded");
  }
  return {
    event: async ({ event }) => {
      if (isVerboseLogEnabled()) {
        const now = new Date().toISOString();
        const raw = (() => {
          try {
            return JSON.stringify(event);
          } catch {
            return String(event);
          }
        })();
        await client.app.log({
          body: {
            service: SERVICE_NAME,
            level: "info",
            message: `[daily-logbook] event received type=${(event as { type?: unknown })?.type} time=${now} raw=${raw}`,
          },
        });
        console.log(`[daily-logbook] event type=${(event as { type?: unknown })?.type} time=${now} raw=${raw}`);
      }
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
