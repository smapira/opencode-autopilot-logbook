import type { AppLogSink } from "../../application/ports";
import { generateDailyLogbookCore } from "../../application/generate-logbook.usecase";
import { createV2LogSink } from "./log-sink.v2";
import { createFallbackSessionAdapter, toSessionPort, type V2SessionLike } from "./session.v2";
import { resolveV2Iterable } from "./event-source.v2";
import { createFallbackSdkClient } from "./sdk-fallback";

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

function detectV1Host(ctxKeys: string, hasEventSubscribe: boolean, hasSession: boolean): boolean {
  try {
    return ctxKeys.includes("agent") && ctxKeys.includes("skill") && !hasEventSubscribe && !hasSession;
  } catch {
    return false;
  }
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
  const session = (anyCtx.session as V2SessionLike | undefined) ?? (await createFallbackSessionAdapter(sink, anyCtx.serverUrl));
  if (!session) {
    await sink.warn("v2: no session adapter available (ctx.session missing and fallback failed); idle handling disabled");
    return undefined;
  }
  void runV2EventLoop({ event: eventHost, session }, sink, directory, controller);
  return () => controller.abort();
}

async function tryHandleSdkFallback(sink: AppLogSink, directory: string): Promise<(() => void) | undefined> {
  const sdkFallback = await createFallbackSdkClient(sink);
  if (!sdkFallback) return undefined;
  const sdkEventHost = sdkFallback.client.event as unknown as { subscribe?: unknown } | undefined;
  if (!sdkEventHost?.subscribe) return undefined;
  await sink.info?.(`v2: using SDK fallback for event subscription via ${sdkFallback.url}`);
  const fileSession = await createFallbackSessionAdapter(sink, null);
  if (!fileSession) {
    await sink.warn("v2: SDK event fallback has no file session; idle handling disabled");
    return undefined;
  }
  const controller = new AbortController();
  void runV2EventLoop({ event: sdkEventHost, session: fileSession }, sink, directory, controller);
  return () => controller.abort();
}

function buildV2FallbackHook(
  fallbackSession: V2SessionLike,
  sink: AppLogSink,
  directory: string,
): { event: (input: { event: { type: string; data?: unknown; properties?: unknown } }) => Promise<void> } {
  return {
    event: async ({ event }: { event: { type: string; data?: unknown; properties?: unknown } }) => {
      if (event.type !== "session.idle") return;
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
  isV1Host: boolean,
): Promise<void> {
  await sink.info?.(
    `daily-logbook plugin loaded (v2) app=${anyCtx.app?.name ?? "unknown"} ${anyCtx.app?.version ?? ""} ctxKeys=[${ctxKeys}] event.subscribe=${hasEventSubscribe ? "yes" : "no"} client.event.subscribe=${hasClientEventSubscribe ? "yes" : "no"} session=${hasSession ? "yes" : "no"}${isV1Host ? " [V1 host detected via Orca shared — delegating to V1]" : ""}`,
  );
  if (isV1Host) {
    await sink.warn(
      "v2Setup called on V1 host (ctxKeys without event/session). This is Orca shared's plugins being loaded by opencode 1.18.x. Daily-logbook will be handled by V1 DailyLogbookPlugin, not v2. Skipping v2 event setup.",
    );
  }
}

async function handleFallbackHook(
  anyCtx: V2CtxLike,
  sink: AppLogSink,
  directory: string,
  ctxKeys: string,
): Promise<{ event: (input: { event: { type: string; data?: unknown; properties?: unknown } }) => Promise<void> } | undefined> {
  await sink.warn(`v2: ctx.event.subscribe not found (ctxKeys=[${ctxKeys}]); falling back to return {event} hook. If idle is still not delivered, use opencode (v1) with 2.0.3.`);
  const fallbackSession = (anyCtx.session as V2SessionLike | undefined) ?? (await createFallbackSessionAdapter(sink, anyCtx.serverUrl));
  if (!fallbackSession) {
    await sink.warn("v2: no session adapter for fallback hook; idle handling disabled");
    return undefined;
  }
  return buildV2FallbackHook(fallbackSession, sink, directory);
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
  const isV1Host = detectV1Host(ctxKeys, hasEventSubscribe, hasSession);
  await logV2Startup(sink, anyCtx, ctxKeys, hasEventSubscribe, hasClientEventSubscribe, hasSession, isV1Host);
  if (isV1Host) return;
  const eventHost = resolveEventHost(anyCtx);
  const hostResult = await tryHandleEventHost(eventHost, anyCtx, sink, directory);
  if (hostResult) return hostResult;
  const sdkResult = await tryHandleSdkFallback(sink, directory);
  if (sdkResult) return sdkResult;
  return handleFallbackHook(anyCtx, sink, directory, ctxKeys);
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
      if (event.type !== "session.idle") continue;
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
export { detectV1Host as isV1Host, getV2Directory, getV2CtxKeys, resolveEventHost };
