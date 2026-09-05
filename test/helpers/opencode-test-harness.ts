// test/helpers/opencode-test-harness.ts
// Vendor-backed test harness — uses anomalyco/opencode core locally as test foundation (Medium pattern).
// Demonstrates how to bring opencode core into this repo and inject session.idle without TUI.
//
// Vendor: vendor/opencode (git submodule, https://github.com/anomalyco/opencode.git @ bbd72fb)
// Bus: vendor/opencode/packages/opencode/src/bus/global.ts  (GlobalBus EventEmitter)
// Schema: vendor/opencode/packages/schema/src/session-status-event.ts (Idle deprecated → Status idle)
//
// Usage:
//   import { triggerIdleViaHarness, withIsolatedDir } from "./helpers/opencode-test-harness";
//   await triggerIdleViaHarness(pluginEventHandler, "sess-123");

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Vendor presence check
// ---------------------------------------------------------------------------

export function assertVendorPresent(): void {
  try {
    // Cheap existence check — avoids importing TS before bun has transpiled vendor
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(join(process.cwd(), "vendor/opencode/packages/opencode/src/bus/global.ts"))) {
      throw new Error("vendor/opencode not found");
    }
  } catch {
    throw new Error(
      "vendor/opencode is missing. Run: git submodule update --init --depth 1 vendor/opencode",
    );
  }
}

export function getVendorHead(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    return execSync("git -C vendor/opencode rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Bus-backed emitter (uses real vendor GlobalBus when available, falls back to mock)
// ---------------------------------------------------------------------------

type GlobalEvent = { directory?: string; payload: unknown };

let cachedBus: EventEmitter<{ event: [GlobalEvent] }> | null = null;

export function getTestBus(): EventEmitter<{ event: [GlobalEvent] }> {
  if (cachedBus) return cachedBus;
  try {
    // Try to load the real vendor bus (requires vendor/opencode to be present; bun can transpile TS on the fly)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../vendor/opencode/packages/opencode/src/bus/global.ts");
    if (mod?.GlobalBus) {
      cachedBus = mod.GlobalBus as EventEmitter<{ event: [GlobalEvent] }>;
      return cachedBus;
    }
  } catch {
    // fall through to mock
  }
  // Mock bus — behaves like GlobalBus for tests, no vendor build required
  cachedBus = new EventEmitter<{ event: [GlobalEvent] }>() as EventEmitter<{ event: [GlobalEvent] }>;
  return cachedBus;
}

// ---------------------------------------------------------------------------
// Direct plugin helpers — no bus required, fastest for unit tests
// ---------------------------------------------------------------------------

type IdleEvent = { event: { type: "session.idle"; properties: { sessionID: string } } };
type StatusIdleEvent = {
  event: { type: "session.status"; properties: { sessionID: string; status: { type: "idle" } } };
};

export async function triggerIdle(
  handler: (input: IdleEvent) => Promise<void>,
  sessionID: string,
): Promise<void> {
  await handler({ event: { type: "session.idle", properties: { sessionID } } });
}

export async function triggerStatusIdle(
  handler: (input: StatusIdleEvent) => Promise<void>,
  sessionID: string,
): Promise<void> {
  await handler({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
  });
}

// ---------------------------------------------------------------------------
// Bus-based helpers — demonstrate vendor core as test foundation
// ---------------------------------------------------------------------------

export function emitSessionIdleViaBus(sessionID: string, directory = process.cwd()): void {
  const bus = getTestBus();
  bus.emit("event", {
    directory,
    payload: { type: "session.idle", properties: { sessionID } },
  } as GlobalEvent);
}

export function emitSessionStatusIdleViaBus(sessionID: string, directory = process.cwd()): void {
  const bus = getTestBus();
  // New core uses session.status with idle, old plugin still listens to session.idle — emit both for compat
  bus.emit("event", {
    directory,
    payload: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
  } as GlobalEvent);
  bus.emit("event", {
    directory,
    payload: { type: "session.idle", properties: { sessionID } },
  } as GlobalEvent);
}

// ---------------------------------------------------------------------------
// Helper to wire a plugin's event handler to the test bus (one-liner for integration tests)
// ---------------------------------------------------------------------------

export function wirePluginToTestBus(
  handler: (input: { event: { type: string; properties: unknown } }) => Promise<void>,
): () => void {
  const bus = getTestBus();
  const listener = (evt: GlobalEvent) => {
    const payload = evt.payload as { type: string; properties: unknown };
    // Fire and forget — plugin handles its own errors via sink
    void handler({ event: { type: payload.type, properties: payload.properties } } as never);
  };
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

// ---------------------------------------------------------------------------
// Isolated temp directory helper
// ---------------------------------------------------------------------------

export function withIsolatedDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-harness-"));
  const result = fn(dir);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  if (result instanceof Promise) {
    return result.finally(cleanup) as Promise<T>;
  }
  cleanup();
  return Promise.resolve(result as T);
}
