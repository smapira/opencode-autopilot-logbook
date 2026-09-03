import type { AppLogSink } from "../../application/ports";

export function isAsyncIterable(value: unknown): boolean {
  return !!value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

export function isEffectStream(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (isAsyncIterable(value)) return false;
  return typeof v["pipe"] === "function" || "_tag" in v || "effect" in v;
}

export async function toAsyncIterable(
  value: unknown,
  sink: AppLogSink,
  signal?: AbortSignal,
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  if (!value) return undefined;
  if (isAsyncIterable(value)) return value as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
  const streamResult = await tryStreamProperty(value, sink, signal);
  if (streamResult) return streamResult;
  if (isEffectStream(value)) return undefined;
  if (value instanceof Promise) return awaitFromPromise(value, sink, signal);
  return undefined;
}

async function tryStreamProperty(
  value: unknown,
  sink: AppLogSink,
  signal?: AbortSignal,
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  if (!value || typeof value !== "object" || !("stream" in (value as Record<string, unknown>))) return undefined;
  const stream = (value as Record<string, unknown>)["stream"];
  if (isAsyncIterable(stream)) return stream as AsyncIterable<{ type: string; data?: unknown; properties?: unknown }>;
  const asIterable = await toAsyncIterable(stream, sink, signal);
  if (asIterable) return asIterable;
  await sink.warn(
    `toAsyncIterable: stream property exists but not AsyncIterable (keys=${Object.keys(value as Record<string, unknown>).join(",")})`,
  );
  return undefined;
}

async function awaitFromPromise(
  value: Promise<unknown>,
  sink: AppLogSink,
  signal?: AbortSignal,
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  try {
    const resolved = await value;
    return toAsyncIterable(resolved, sink, signal);
  } catch {
    return undefined;
  }
}

async function trySubscribeEffect(
  sub: (type: string) => unknown,
  sink: AppLogSink,
  signal?: AbortSignal,
  host?: { subscribe?: unknown },
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  try {
    const h = (host ?? {}) as { subscribe?: unknown };
    const fn = (h.subscribe as (type: string) => unknown) ?? (sub as (type: string) => unknown);
    const raw = fn.call(h as unknown as { subscribe: (type: string) => unknown }, "session.idle");
    const asIterable = await toAsyncIterable(raw, sink, signal);
    if (asIterable) return asIterable;
  } catch {}
  return undefined;
}

export async function resolveV2Iterable(
  subscribe: unknown,
  signal: AbortSignal,
  sink: AppLogSink,
  eventHost?: { subscribe?: unknown },
): Promise<AsyncIterable<{ type: string; data?: unknown; properties?: unknown }> | undefined> {
  const sub = subscribe as unknown as ((opts: { signal: AbortSignal }) => unknown) & ((type: string) => unknown);
  if (!sub) {
    await sink.warn("resolveV2Iterable: subscribe is falsy");
    return undefined;
  }
  const host = (eventHost ?? {}) as { subscribe?: unknown };
  try {
    const raw = callSubscribeWithSignal(host, sub, signal, sink);
    const logged = await logSubscribeResult(raw, sink);
    const asIterable = await toAsyncIterable(logged, sink, signal);
    await sink.info?.(`resolveV2Iterable: toAsyncIterable => ${asIterable ? "AsyncIterable" : "undefined"}`);
    if (asIterable) return asIterable;
    const viaEffect = await trySubscribeEffect(sub, sink, signal, host);
    if (viaEffect) return viaEffect;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sink.warn(`resolveV2Iterable: subscribe({signal}) threw ${msg}`);
    const viaEffect = await trySubscribeEffect(sub, sink, signal, host);
    if (viaEffect) return viaEffect;
  }
  const fallback = await trySubscribeEffect(sub, sink, signal, host);
  if (!fallback) await sink.warn("resolveV2Iterable: both subscribe styles returned non-AsyncIterable");
  return fallback;
}

function callSubscribeWithSignal(
  host: { subscribe?: unknown },
  sub: unknown,
  signal: AbortSignal,
  _sink: AppLogSink,
): unknown {
  const hostFn = host.subscribe as ((opts: { signal: AbortSignal }) => unknown) | undefined;
  if (hostFn) return hostFn.call(host, { signal });
  return (sub as (opts: { signal: AbortSignal }) => unknown)({ signal });
}

async function logSubscribeResult(raw: unknown, sink: AppLogSink): Promise<unknown> {
  const typeLabel = raw instanceof Promise ? "Promise" : typeof raw;
  const keys = raw && typeof raw === "object" ? `keys=[${Object.keys(raw as Record<string, unknown>).join(",")}]` : "";
  await sink.info?.(`resolveV2Iterable: subscribe({signal}) returned ${typeLabel} ${keys} isAsyncIterable=${isAsyncIterable(raw as unknown)}`);
  return raw;
}
