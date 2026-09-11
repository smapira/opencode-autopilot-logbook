import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { buildV2FallbackHook, v2Setup } from "../src/adapters/v2/plugin.v2";
import type { V2SessionLike } from "../src/adapters/v2/session.v2";
import { createFallbackSessionAdapter } from "../src/adapters/v2/session.v2";
import type { AppLogSink } from "../src/application/ports";

// Hermetic: temp-dir runs must not pick up the operator's template/limit env.
const savedEnv: Record<string, string | undefined> = {
  OPENCODE_DAILY_LOGBOOK_TEMPLATE: process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE,
  OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT: process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT,
  OPENCODE_DAILY_LOGBOOK_THROTTLE_MS: process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS,
};
delete process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
delete process.env.OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT;
delete process.env.OPENCODE_DAILY_LOGBOOK_THROTTLE_MS;
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Versions:
//   host (v2): opencode2 v0.0.0-beta-19242 (anomalyco/opencode dev lineage)
//   host (v1): opencode 1.18.30
//   plugin SDK (devDeps): @opencode-ai/plugin ^1.18.29
//   runtime: bun v1.3.12
//   recorded: 2026-09-10
//
// v2 host delivers idle via new session.status (session.idle is deprecated
// upstream) — the adapter must route BOTH shapes into report generation,
// and ignore non-idle events.
//
// NOTE: generateDailyLogbookCore never writes a file itself; the file is
// produced downstream (LLM prompt or file-direct fallback adapter). So these
// tests assert at the seams we own: (1) dispatch invokes the generation
// pipeline (create/prompt called), (2) end-to-end via the production
// file-direct fallback adapter a report file appears.

function makeSink() {
  const lines: string[] = [];
  const sink: AppLogSink = {
    info: async (m: string) => void lines.push(`info:${m}`),
    warn: async (m: string) => void lines.push(`warn:${m}`),
    error: async (m: string) => void lines.push(`error:${m}`),
  };
  return { sink, lines };
}

function makeRecordingSession() {
  const calls: { create: unknown[]; prompt: unknown[] } = { create: [], prompt: [] };
  const session: V2SessionLike = {
    get: async () => ({ data: { title: "probe" } }),
    context: async () => ({ data: [] }),
    create: async (input: { title: string }) => {
      calls.create.push(input);
      return { data: { id: `probe-${Date.now()}` }, title: input.title };
    },
    prompt: async (input: { sessionID: string; text: string }) => {
      calls.prompt.push(input);
      return {};
    },
  };
  return { session, calls };
}

async function dailyFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(join(dir, "artifacts", "daily"));
  } catch {
    return [];
  }
}

describe("v2 event dispatch (session.idle deprecated → session.status)", () => {
  test("session.status idle via properties invokes generation pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v2dispatch-"));
    const { sink } = makeSink();
    const { session, calls } = makeRecordingSession();
    const hook = buildV2FallbackHook(session, sink, dir);
    await hook.event({
      event: { type: "session.status", properties: { sessionID: "sess-dispatch-1", status: { type: "idle" } } },
    });
    expect(calls.create.length).toBe(1);
    expect(String((calls.create[0] as { title: string }).title).startsWith("[daily-logbook:auto]")).toBe(true);
    expect(calls.prompt.length).toBe(1);
  });

  test("session.status idle via data invokes generation pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v2dispatch-"));
    const { sink } = makeSink();
    const { session, calls } = makeRecordingSession();
    const hook = buildV2FallbackHook(session, sink, dir);
    await hook.event({
      event: { type: "session.status", data: { sessionID: "sess-dispatch-2", status: { type: "idle" } } },
    });
    expect(calls.create.length).toBe(1);
    expect(calls.prompt.length).toBe(1);
  });

  test("deprecated session.idle still invokes generation pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v2dispatch-"));
    const { sink } = makeSink();
    const { session, calls } = makeRecordingSession();
    const hook = buildV2FallbackHook(session, sink, dir);
    await hook.event({
      event: { type: "session.idle", properties: { sessionID: "sess-dispatch-3" } },
    });
    expect(calls.create.length).toBe(1);
    expect(calls.prompt.length).toBe(1);
  });

  test("end-to-end via file-direct fallback adapter writes report file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v2dispatch-"));
    const { sink } = makeSink();
    const fallback = await createFallbackSessionAdapter(sink, null, dir);
    expect(fallback).toBeDefined();
    const hook = buildV2FallbackHook(fallback!, sink, dir);
    await hook.event({
      event: { type: "session.status", properties: { sessionID: "sess-dispatch-4", status: { type: "idle" } } },
    });
    expect(await dailyFiles(dir)).not.toEqual([]);
  });

  test("session.status busy is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v2dispatch-"));
    const { sink } = makeSink();
    const { session, calls } = makeRecordingSession();
    const hook = buildV2FallbackHook(session, sink, dir);
    await hook.event({
      event: { type: "session.status", properties: { sessionID: "sess-dispatch-5", status: { type: "busy" } } },
    });
    expect(calls.create.length).toBe(0);
    expect(calls.prompt.length).toBe(0);
    expect(await dailyFiles(dir)).toEqual([]);
  });

  test("idle without sessionID warns and skips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v2dispatch-"));
    const { sink, lines } = makeSink();
    const { session, calls } = makeRecordingSession();
    const hook = buildV2FallbackHook(session, sink, dir);
    await hook.event({ event: { type: "session.idle", properties: {} } });
    expect(calls.create.length).toBe(0);
    expect(await dailyFiles(dir)).toEqual([]);
    expect(lines.some((l) => l.includes("missing sessionID"))).toBe(true);
  });
});

describe("no-capability skip", () => {
  test("no event.subscribe and no session: returns undefined, stdout always silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v1skip-"));
    // host shape with no event delivery path: no event.subscribe, no session
    const ctx = { directory: dir, agent: {}, skill: {} };
    const out: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    const savedDebug = process.env.DAILY_LOGBOOK_DEBUG;
    try {
      delete process.env.DAILY_LOGBOOK_DEBUG;
      expect(await v2Setup(ctx)).toBeUndefined();
      expect(out.filter((l) => l.includes("daily-logbook")).length).toBe(0);
      process.env.DAILY_LOGBOOK_DEBUG = "1";
      expect(await v2Setup(ctx)).toBeUndefined();
      expect(out.filter((l) => l.includes("daily-logbook")).length).toBe(0);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      if (savedDebug === undefined) delete process.env.DAILY_LOGBOOK_DEBUG;
      else process.env.DAILY_LOGBOOK_DEBUG = savedDebug;
    }
  });
});
