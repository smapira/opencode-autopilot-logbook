import type { AppLogSink } from "../../application/ports";
import { generateDailyLogbookCore } from "../../application/generate-logbook.usecase";
import { appendV2FileNote, createV2LogSink } from "./log-sink.v2";
import { createFallbackSessionAdapter, toSessionPort, type V2SessionLike } from "./session.v2";
import { resolveV2Iterable } from "./event-source.v2";

type V2CtxLike = {
  location?: { directory?: string };
  directory?: string;
  worktree?: string;
  serverUrl?: URL | string;
  app?: { name?: string; version?: string; channel?: string };
  client?: { event?: { subscribe?: unknown }; session?: unknown };
  event?: { subscribe?: ((opts: { signal: AbortSignal }) => unknown) & ((type: string) => unknown) };
  session?: V2SessionLike;
};

// Exported for tests / backward compat
export async function handleV2IdleEvent(params: {
  sessionID: string;
  directory: string;
  sink: AppLogSink;
  session: V2SessionLike;
}): Promise<void> {
  const adapter = toSessionPort(params.session);
  await generateDailyLogbookCore({
    sessionId: params.sessionID,
    directory: params.directory,
    sink: params.sink,
    adapter,
  });
}

function getV2Directory(anyCtx: V2CtxLike): string {
  return anyCtx.location?.directory ?? anyCtx.directory ?? anyCtx.worktree ?? process.cwd();
}

function getV2CtxKeys(anyCtx: V2CtxLike): string {
  try {
    return Object.keys(anyCtx as unknown as Record<string, unknown>).sort().join(",");
  } catch {
    return "unknown";
  }
}

function isVerboseLogEnabled(): boolean {
  const v = process.env.DAILY_LOGBOOK_DEBUG ?? process.env.DAILY_LOGBOOK_VERBOSE ?? process.env.DAILY_LOGBOOK_LOG_EVENTS;
  return v === "1" || v === "true";
}



function resolveEventHost(anyCtx: V2CtxLike): { subscribe?: unknown } | undefined {
  return (anyCtx.event as unknown as { subscribe?: unknown }) ?? (anyCtx.client?.event as unknown as { subscribe?: unknown } | undefined);
}

async function tryHandleEventHost(
  eventHost: { subscribe?: unknown } | undefined,
  anyCtx: V2CtxLike,
  sink: AppLogSink,
  directory: string,
): Promise<(() => void) | undefined> {
  if (!eventHost?.subscribe) return undefined;
  const controller = new AbortController();
  const session = (anyCtx.session as V2SessionLike | undefined) ?? (await createFallbackSessionAdapter(sink, anyCtx.serverUrl, directory));
  if (!session) {
    await sink.warn("v2: no session adapter available (ctx.session missing and fallback failed); idle handling disabled");
    return undefined;
  }
  void runV2EventLoop({ event: eventHost, session }, sink, directory, controller);
  return () => controller.abort();
}

export function buildV2FallbackHook(
  fallbackSession: V2SessionLike,
  sink: AppLogSink,
  directory: string,
): { event: (input: { event: { type: string; data?: unknown; properties?: unknown } }) => Promise<void> } {
  return {
    event: async ({ event }: { event: { type: string; data?: unknown; properties?: unknown } }) => {
      if (isVerboseLogEnabled()) {
        await sink.info?.(`[daily-logbook] v2 event received type=${event.type}`);
      }
      if (!isIdleV2Event(event)) return;
      const data = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).data;
      const properties = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).properties;
      const sessionID = data?.sessionID ?? properties?.sessionID;
      if (!sessionID) {
        await sink.warn("session.idle event missing sessionID; skipping");
        return;
      }
      await handleV2IdleEvent({ sessionID, directory, sink, session: fallbackSession });
    },
  };
}

async function logV2Startup(
  sink: AppLogSink,
  anyCtx: V2CtxLike,
  ctxKeys: string,
  hasEventSubscribe: boolean,
  hasClientEventSubscribe: boolean,
  hasSession: boolean,
): Promise<void> {
  const v2Message = `daily-logbook plugin loaded (v2) app=${anyCtx.app?.name ?? "unknown"} ${anyCtx.app?.version ?? ""} ctxKeys=[${ctxKeys}] event.subscribe=${hasEventSubscribe ? "yes" : "no"} client.event.subscribe=${hasClientEventSubscribe ? "yes" : "no"} session=${hasSession ? "yes" : "no"}`;
  await sink.info?.(v2Message);
  // Verbose only: also emit to stdout when debugging
  if (isVerboseLogEnabled()) {
    console.log(v2Message);
  }
}

type V2EventLike = { type: string; data?: unknown; properties?: unknown };

type V2StatusLike = { status?: { type?: string } };

function readIdleStatus(event: V2EventLike): string | undefined {
  const properties = (event as { properties?: V2StatusLike }).properties;
  const data = (event as { data?: V2StatusLike }).data;
  return properties?.status?.type ?? data?.status?.type;
}

export function isIdleV2Event(event: V2EventLike): boolean {
  if (event.type === "session.idle") return true;
  return event.type === "session.status" && readIdleStatus(event) === "idle";
}

export async function v2Setup(
  ctx: unknown,
): Promise<(() => void) | { event: (input: { event: { type: string; data?: unknown; properties?: unknown } }) => Promise<void> } | void> {
  const anyCtx = ctx as V2CtxLike;
  const directory = getV2Directory(anyCtx);
  const sink = createV2LogSink();
  const ctxKeys = getV2CtxKeys(anyCtx);
  const hasEventSubscribe = typeof anyCtx.event?.subscribe === "function";
  const hasClientEventSubscribe = typeof anyCtx.client?.event?.subscribe === "function";
  const hasSession = !!anyCtx.session;
  // v2 operates ONLY when the host provides an event stream.
  // No localhost SDK probing and no hook without subscribe: that is how v2
  // could activate inside a foreign (v1) process sharing this machine.
  const eventHost = resolveEventHost(anyCtx);
  if (typeof eventHost?.subscribe !== "function") {
    // Record to file only, stay silent on stdout.
    appendV2FileNote("INFO", `v2Setup idle handling disabled (no event.subscribe in ctx) directory=${directory} ctxKeys=[${ctxKeys}]`);
    return;
  }
  await logV2Startup(sink, anyCtx, ctxKeys, hasEventSubscribe, hasClientEventSubscribe, hasSession);
  // v2 beta may deliver idle via hook even when event.subscribe exists.
  // Start subscribe loop in background AND expose the hook so both paths work.
  const cleanups: Array<() => void> = [];
  const hostResult = await tryHandleEventHost(eventHost, anyCtx, sink, directory);
  if (!hostResult) {
    appendV2FileNote("INFO", `v2Setup idle handling disabled (no session adapter) directory=${directory} ctxKeys=[${ctxKeys}]`);
    return;
  }
  cleanups.push(hostResult);
  // Always build the hook (uses real ctx.session when available, fallback otherwise)
  // so idle delivered via host's {event} hook is handled even when subscribe loop is active.
  const hookSession = (anyCtx.session as V2SessionLike | undefined) ?? (await createFallbackSessionAdapter(sink, anyCtx.serverUrl, directory));
  if (!hookSession) {
    if (cleanups.length > 0) return () => cleanups.forEach((fn) => fn());
    await sink.warn("v2: no session adapter for fallback hook; idle handling disabled");
    return undefined;
  }
  const hook = buildV2FallbackHook(hookSession, sink, directory);
  if (cleanups.length > 0) {
    await sink.info?.(`v2: dual delivery enabled — subscribe loop + hook (cleanups=${cleanups.length})`);
    // Return hook for host delivery; keep loop alive in background.
    // Host that expects a cleanup function will still get hook; loop cleanup is kept alive until process exit.
    // If host calls the returned hook's event, it will handle idle; subscribe loop also handles idle.
    return hook;
  }
  await sink.warn(`v2: ctx.event.subscribe not found (ctxKeys=[${ctxKeys}]); falling back to return {event} hook. If idle is still not delivered, use opencode (v1) with 2.0.3.`);
  return hook;
}

export async function runV2EventLoop(
  anyCtx: { event?: { subscribe?: unknown }; session?: V2SessionLike },
  sink: AppLogSink,
  directory: string,
  controller: AbortController,
): Promise<void> {
  try {
    const iterable = await resolveV2Iterable(anyCtx.event?.subscribe, controller.signal, sink, anyCtx.event);
    if (!iterable) {
      await sink.warn(
        `event.subscribe did not return AsyncIterable (event.subscribe=${typeof anyCtx.event?.subscribe}) — trying fallback poll; v2 plugin idle subscription failed. ctx.event keys=${anyCtx.event ? Object.keys(anyCtx.event as Record<string, unknown>).join(",") : "no-event"}`,
      );
      return;
    }
     for await (const event of iterable as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>) {
      if (isVerboseLogEnabled()) {
        await sink.info?.(`[daily-logbook] v2 event received type=${event.type}`);
      }
      if (!isIdleV2Event(event)) continue;
      const sessionID = extractSessionId(event);
      if (!sessionID) {
        await sink.warn("session.idle event missing sessionID; skipping");
        continue;
      }
      if (!anyCtx.session) {
        await sink.warn("ctx.session not available; skipping idle handling");
        continue;
      }
      await handleV2IdleEvent({ sessionID, directory, sink, session: anyCtx.session });
    }
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "AbortError") return;
    await sink.error("v2 event loop error", error);
  }
}

function extractSessionId(event: { data?: unknown; properties?: unknown }): string | undefined {
  const data = (event as { data?: { sessionID?: string } }).data;
  const properties = (event as { data?: { sessionID?: string }; properties?: { sessionID?: string } }).properties;
  return (data as { sessionID?: string } | undefined)?.sessionID ?? (properties as { sessionID?: string } | undefined)?.sessionID;
}

// Re-export helpers for testability (Phase3 keeps backward compat from daily-logbook path)
export { getV2Directory, getV2CtxKeys, resolveEventHost };
