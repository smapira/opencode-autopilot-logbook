import type { AppLogSink } from "../../application/ports";

type FallbackSdkClient = {
  client: { event: { subscribe: (opts: { signal: AbortSignal }) => unknown }; session: unknown };
  session: {
    get: (input: { sessionID: string }) => Promise<unknown>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    messages?: (input: { path: { id: string } }) => Promise<unknown>;
    create: (input: { title: string }) => Promise<unknown>;
    prompt?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    generate?: (input: { sessionID: string; text: string }) => Promise<unknown>;
    promptAsync?: (input: unknown) => Promise<unknown>;
  };
  url: string;
};

export function getCandidateUrls(): string[] {
  const candidates: string[] = [];
  for (const key of ["OPENCODE_SERVER_URL", "OPENCODE_API_URL", "OPENCODE_SERVER"]) {
    const v = process.env[key];
    if (v) candidates.push(v);
  }
  candidates.push("http://localhost:49374");
  const envPort = process.env.ORCA_AGENT_HOOK_PORT;
  if (envPort) candidates.push(`http://localhost:${envPort}`);
  candidates.push("http://localhost:4096", "http://localhost:8080");
  return [...new Set(candidates)];
}

async function tryCreateForSpec(url: string, spec: string): Promise<FallbackSdkClient | undefined> {
  let createOpencodeClient: ((opts: unknown) => unknown) | null = null;
  try {
    const m = (await import(spec).catch(() => null)) as unknown as {
      createOpencodeClient?: (opts: unknown) => unknown;
    } | null;
    createOpencodeClient = (m?.createOpencodeClient as unknown as (opts: unknown) => unknown) ?? null;
  } catch {}
  if (!createOpencodeClient) return undefined;
  return tryCreateClientInstance(createOpencodeClient, url);
}

async function tryCreateClientInstance(
  factory: (opts: unknown) => unknown,
  url: string,
): Promise<FallbackSdkClient | undefined> {
  try {
    const client = factory({ baseUrl: url }) as unknown as {
      event: { subscribe: (opts: { signal: AbortSignal }) => unknown };
      session: FallbackSdkClient["session"] & { list?: (p: unknown) => Promise<unknown> };
    };
    await verifyClient(client);
    return { client: client as FallbackSdkClient["client"], session: client.session as FallbackSdkClient["session"], url };
  } catch {}
  return undefined;
}

async function verifyClient(client: {
  event: { subscribe?: unknown };
  session: { list?: (p: unknown) => Promise<unknown> };
}): Promise<void> {
  await (client.session.list?.({ limit: 1 } as unknown as Record<string, unknown>) ?? Promise.resolve());
  const hasEvent = typeof client.event?.subscribe === "function";
  if (!hasEvent) throw new Error("no event.subscribe");
}

export async function createFallbackSdkClient(sink: AppLogSink): Promise<FallbackSdkClient | undefined> {
  const urls = getCandidateUrls();
  for (const url of urls) {
    const specs = ["@opencode-ai/sdk/v2", "@opencode-ai/sdk"] as const;
    for (const spec of specs) {
      const result = await tryCreateForSpec(url, spec);
      if (result) return result;
    }
  }
  await sink.warn(`fallback SDK client: all candidates failed (${urls.join(", ")})`);
  return undefined;
}
