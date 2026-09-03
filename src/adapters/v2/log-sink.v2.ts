import type { AppLogSink } from "../../application/ports";

const SERVICE_NAME = "daily-logbook-plugin";

export function createV2LogSink(): AppLogSink {
  return {
    warn: (message) => {
      console.warn(`[${SERVICE_NAME}] ${message}`);
    },
    error: (message, error) => {
      const msg = error instanceof Error ? error.message : error !== undefined ? String(error) : "";
      const full = msg ? `${message}: ${msg}` : message;
      console.error(`[${SERVICE_NAME}] ${full}`);
    },
    info: (message) => {
      console.log(`[${SERVICE_NAME}] ${message}`);
    },
  };
}
