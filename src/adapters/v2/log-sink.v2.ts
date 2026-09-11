import type { AppLogSink } from "../../application/ports";
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SERVICE_NAME = "daily-logbook-plugin";

function fileLog(level: string, message: string) {
  try {
    const dir = join(homedir(), ".local/share/opencode/opencode-data-v2/opencode/log");
    mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${SERVICE_NAME}] ${level}: ${message}\n`;
    appendFileSync(join(dir, "daily-logbook-v2.log"), line);
  } catch {}
}

/** File-only note: recorded without touching stdout (for paths that must stay silent). */
export function appendV2FileNote(level: string, message: string): void {
  fileLog(level, message);
}

export function createV2LogSink(): AppLogSink {
  return {
    warn: (message) => {
      console.warn(`[${SERVICE_NAME}] ${message}`);
      fileLog("WARN", message);
    },
    error: (message, error) => {
      const msg = error instanceof Error ? error.message : error !== undefined ? String(error) : "";
      const full = msg ? `${message}: ${msg}` : message;
      console.error(`[${SERVICE_NAME}] ${full}`);
      fileLog("ERROR", full);
    },
    info: (message) => {
      console.log(`[${SERVICE_NAME}] ${message}`);
      fileLog("INFO", message);
    },
  };
}
