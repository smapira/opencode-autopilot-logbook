import { describe, expect, test } from "bun:test";
import { isAsyncIterable, isEffectStream, resolveV2Iterable, toAsyncIterable } from "./event-source.v2";
import type { AppLogSink } from "../../application/ports";

function silentSink(): AppLogSink {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

function capturingSink(): { sink: AppLogSink; logs: string[] } {
  const logs: string[] = [];
  const sink: AppLogSink = {
    warn: (m) => {
      logs.push(`warn:${m}`);
    },
    error: (m, e) => {
      logs.push(`error:${m}:${String(e ?? "")}`);
    },
    info: (m) => {
      logs.push(`info:${m}`);
    },
  };
  return { sink, logs };
}

describe("isAsyncIterable", () => {
  test("detects async iterable", () => {
    const iter = { [Symbol.asyncIterator]: async function* () {} };
    expect(isAsyncIterable(iter)).toBe(true);
  });
  test("rejects plain object", () => {
    expect(isAsyncIterable({})).toBe(false);
  });
  test("rejects null", () => {
    expect(isAsyncIterable(null)).toBe(false);
  });
});

describe("isEffectStream", () => {
  test("detects pipe object as Effect", () => {
    expect(isEffectStream({ pipe: () => {} })).toBe(true);
  });
  test("detects _tag object as Effect", () => {
    expect(isEffectStream({ _tag: "x" })).toBe(true);
  });
  test("rejects async iterable", () => {
    const iter = { [Symbol.asyncIterator]: async function* () {}, pipe: () => {} };
    expect(isEffectStream(iter)).toBe(false);
  });
  test("rejects plain object", () => {
    expect(isEffectStream({})).toBe(false);
  });
});

describe("toAsyncIterable", () => {
  test("returns direct AsyncIterable unchanged (promotes V1 loaded case)", async () => {
    const iter = { [Symbol.asyncIterator]: async function* () { yield { type: "session.idle" }; } };
    const result = await toAsyncIterable(iter as unknown, silentSink());
    expect(result).toBe(iter);
  });

  test("unwraps Promise<AsyncIterable>", async () => {
    const iter = { [Symbol.asyncIterator]: async function* () { yield { type: "a" }; } };
    const result = await toAsyncIterable(Promise.resolve(iter) as unknown, silentSink());
    expect(result).toBe(iter);
  });

  test("extracts stream property when AsyncIterable (toAsyncIterable => AsyncIterable log)", async () => {
    const inner = { [Symbol.asyncIterator]: async function* () { yield { type: "session.idle" }; } };
    const wrapper = { stream: inner };
    const { sink, logs } = capturingSink();
    const result = await toAsyncIterable(wrapper as unknown, sink);
    expect(result).toBe(inner);
    expect(logs.length).toBe(0);
  });

  test("returns undefined for Effect stream (not leaked to event loop)", async () => {
    const effect = { pipe: () => {}, _tag: "Effect" };
    const result = await toAsyncIterable(effect as unknown, silentSink());
    expect(result).toBeUndefined();
  });

  test("handles stream property that is Promise<AsyncIterable>", async () => {
    const inner = { [Symbol.asyncIterator]: async function* () { yield { type: "x" }; } };
    const wrapper = { stream: Promise.resolve(inner) };
    const result = await toAsyncIterable(wrapper as unknown, silentSink());
    expect(result).toBe(inner);
  });
});

describe("resolveV2Iterable — V2 host detection / fallback paths", () => {
  test("subscribe({signal}) returning AsyncIterable → toAsyncIterable => AsyncIterable (V2 SDK fallback)", async () => {
    const iter = { [Symbol.asyncIterator]: async function* () { yield { type: "session.idle", data: { sessionID: "s1" } }; } };
    const subscribe = (_opts: { signal: AbortSignal }) => iter;
    const { sink, logs } = capturingSink();
    const controller = new AbortController();
    const result = await resolveV2Iterable(subscribe as unknown, controller.signal, sink);
    expect(result).toBe(iter);
    expect(logs.some((l) => l.includes("toAsyncIterable => AsyncIterable"))).toBe(true);
  });

  test("warns when subscribe is falsy (mirrors V1 host without event)", async () => {
    const { sink, logs } = capturingSink();
    const result = await resolveV2Iterable(null as unknown, new AbortController().signal, sink);
    expect(result).toBeUndefined();
    expect(logs.some((l) => l.includes("subscribe is falsy"))).toBe(true);
  });

  test("falls back to subscribe('session.idle') when subscribe({signal}) throws (beta-18999 compat)", async () => {
    const iter = { [Symbol.asyncIterator]: async function* () { yield { type: "session.idle" }; } };
    const failingPrimary = (_opts: { signal: AbortSignal }) => {
      throw new Error("bad signal");
    };
    // host with subscribe(type) fallback
    const host = { subscribe: (type: string) => (type === "session.idle" ? iter : undefined) };
    const { sink } = capturingSink();
    // Exercise via eventHost path: resolveV2Iterable will try host.subscribe({signal}) first which throws, then effect path
    const badSubscribe = Object.assign(failingPrimary, {}) as unknown;
    // To trigger fallback we pass host with subscribe(type) and make primary throw
    const result = await resolveV2Iterable(badSubscribe, new AbortController().signal, sink, host as unknown as { subscribe?: unknown });
    expect(result).toBe(iter);
  });
});
