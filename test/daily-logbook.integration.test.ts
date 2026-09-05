import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";

import { DailyLogbookPlugin } from "../src/adapters/v1/plugin.v1";
import { resetForTest } from "../src/application/generate-logbook.usecase";
import {
  emitSessionIdleViaBus,
  emitSessionStatusIdleViaBus,
  getVendorHead,
  triggerIdle,
  triggerStatusIdle,
  wirePluginToTestBus,
} from "./helpers/opencode-test-harness";

// This file proves that vendor/opencode core can be used locally as a test foundation (Medium pattern).
// It covers two paths:
//   1) Direct handler trigger — no bus, no TUI, fastest
//   2) Bus via vendor/opencode GlobalBus — demonstrates the core's event bus as test infra

function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

type MockClient = {
  app: { log: (input: unknown) => Promise<void> };
  session: {
    get: () => Promise<{ data: { id: string; title: string } }>;
    messages: () => Promise<{ data: unknown[] }>;
    create: () => Promise<{ data: { id: string } }>;
    promptAsync: (input: { body: { parts: Array<{ text: string }> } }) => Promise<{ data: unknown }>;
  };
};

function createMockClient(opts: { onPrompt?: (text: string) => void } = {}): {
  client: MockClient;
  prompts: string[];
} {
  const prompts: string[] = [];
  const client: MockClient = {
    app: { log: async () => {} },
    session: {
      get: async () => ({ data: { id: "src", title: "integration session" } }),
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: "generated-integration" } }),
      promptAsync: async (input) => {
        prompts.push(input.body.parts[0].text);
        opts.onPrompt?.(input.body.parts[0].text);
        return { data: {} };
      },
    },
  };
  return { client, prompts };
}

describe("opencode core as local test foundation (vendor/opencode)", () => {
  test("vendor submodule is present and pinned", () => {
    const head = getVendorHead();
    expect(head).not.toBe("unknown");
    expect(head.length).toBeGreaterThanOrEqual(7);
    expect(existsSync("vendor/opencode/packages/opencode/src/bus/global.ts")).toBe(true);
    expect(existsSync("vendor/opencode/packages/schema/src/session-status-event.ts")).toBe(true);
  });
});

describe("daily-logbook without TUI — direct handler path", () => {
  let tempDir: string;

  beforeEach(() => {
    resetForTest();
    tempDir = mkdtempSync(join(tmpdir(), "opencode-integration-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("triggerIdle fires the plugin and creates a generation prompt (no TUI)", async () => {
    const { client, prompts } = createMockClient();
    const plugin = await DailyLogbookPlugin({ client, directory: tempDir } as never);
    const handler = plugin.event as unknown as (input: { event: { type: string; properties: unknown } }) => Promise<void>;

    await triggerIdle(handler as never, "sess-direct-1");

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("sess-direct-1");
  });

  test("triggerStatusIdle via new session.status idle also works when plugin handles both", async () => {
    // Our current v1 plugin only handles session.idle, but the harness demonstrates the new event shape.
    // This test documents the gap and shows how a future plugin (handling session.status idle) would behave.
    let handled = false;
    const handler = async (input: { event: { type: string; properties: { sessionID: string; status?: { type: string } } } }) => {
      if (input.event.type === "session.status" && input.event.properties.status?.type === "idle") {
        handled = true;
      }
    };
    await triggerStatusIdle(handler as never, "sess-status-1");
    expect(handled).toBe(true);
  });
});

describe("daily-logbook without TUI — bus path (vendor/opencode GlobalBus)", () => {
  let tempDir: string;

  beforeEach(() => {
    resetForTest();
    tempDir = mkdtempSync(join(tmpdir(), "opencode-bus-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("emitSessionIdleViaBus reaches a plugin wired to the test bus (no TUI, no expect)", async () => {
    const { client, prompts } = createMockClient();
    const plugin = await DailyLogbookPlugin({ client, directory: tempDir } as never);
    const handler = plugin.event as unknown as (input: { event: { type: string; properties: unknown } }) => Promise<void>;
    const unwire = wirePluginToTestBus(handler);

    // Simulate what idle.ts does in TUI: bus.publish session.idle — but without TUI, via vendor bus
    emitSessionIdleViaBus("sess-bus-1", tempDir);

    // Give the bus a microtask to deliver (EventEmitter is sync, but plugin handler is async)
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("sess-bus-1");

    unwire();
  });

  test("emitSessionStatusIdleViaBus emits both deprecated and new events for compat", async () => {
    const received: string[] = [];
    const { getTestBus } = await import("./helpers/opencode-test-harness");
    const bus = getTestBus();
    const listener = (evt: { payload: { type: string } }) => received.push(evt.payload.type);
    bus.on("event", listener as never);

    emitSessionStatusIdleViaBus("sess-compat-1", tempDir);
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(received).toContain("session.status");
    expect(received).toContain("session.idle");

    bus.off("event", listener as never);
  });

  test("daily-limit guard still works when idle is injected via bus (no TUI)", async () => {
    // Prove that our existing guards (dailyLimitInFlightByDate, isDailyLogbookExists) work even when
    // idle is injected via bus, not TUI.
    const outputDir = join("artifacts", "daily");
    mkdirSync(join(tempDir, outputDir), { recursive: true });
    writeFileSync(join(tempDir, outputDir, `${todayDateString()}_logbook.md`), "existing");

    // Enable daily-limit
    const prev = process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT;
    process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT = "true";
    const prevThrottle = process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
    process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS = "0";
    try {
      const { client, prompts } = createMockClient();
      const plugin = await DailyLogbookPlugin({ client, directory: tempDir } as never);
      const handler = plugin.event as unknown as (input: { event: { type: string; properties: unknown } }) => Promise<void>;
      const unwire = wirePluginToTestBus(handler);

      emitSessionIdleViaBus("sess-bus-daily-limit", tempDir);
      await new Promise<void>((r) => setTimeout(r, 50));

      // Should be suppressed by daily-limit guard
      expect(prompts.length).toBe(0);

      unwire();
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT;
      else process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT = prev;
      if (prevThrottle === undefined) delete process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
      else process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS = prevThrottle;
    }
  });

  test("Bun.write still works as file-direct fallback when bus injection is not used (sanity)", async () => {
    const file = join(tempDir, "artifacts/daily", "probe.md");
    mkdirSync(join(tempDir, "artifacts/daily"), { recursive: true });
    await Bun.write(resolve(tempDir, "artifacts/daily/probe.md"), "# probe");
    expect(existsSync(file)).toBe(true);
  });
});
