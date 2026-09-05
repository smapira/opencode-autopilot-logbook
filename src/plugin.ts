// src/plugin.ts — build entry (Phase3)
// Hybrid V1/V2 plugin is the public export; also re-export building blocks for tests.

export { DailyLogbookPlugin, handleV1IdleEvent, createV1FallbackAdapter } from "./adapters/v1/plugin.v1";
export { handleV2IdleEvent, v2Setup, runV2EventLoop } from "./adapters/v2/plugin.v2";
export { DailyLogbookPluginV2 } from "./adapters/hybrid";
export { createV1LogSink } from "./adapters/v1/log-sink.v1";
export { createV1SessionPort, createV1FallbackSessionPort } from "./adapters/v1/session.v1";
export { createV2LogSink } from "./adapters/v2/log-sink.v2";
export { createFallbackSessionAdapter, toSessionPort } from "./adapters/v2/session.v2";
export type { V2SessionLike } from "./adapters/v2/session.v2";
export { resolveV2Iterable, toAsyncIterable, isAsyncIterable, isEffectStream } from "./adapters/v2/event-source.v2";
export { createFallbackSdkClient, getCandidateUrls } from "./adapters/v2/sdk-fallback";

// Domain / Application re-exports for backward compat when importing from build entry
export { maskSecrets, SECRET_PATTERNS, isRedactEnabled } from "./domain/masking";
export { buildTranscript, truncateText, extractReadableText } from "./domain/transcript";
export { formatCost, formatTokens, formatUsageTable } from "./domain/formatting";
export type { UsageStats } from "./domain/formatting";
export { getUsageStats, getDbPath, isUsageProjectOnly } from "./infrastructure/usage/getUsageStats";
export { getThrottleWindowMs } from "./application/config";
export { SAMPLE_TEMPLATE, replaceTemplateVariables, buildPrompt } from "./application/template-loader";
export { isWithinWindow, isDailyLogbookExists } from "./application/guards";
export { generateDailyLogbookCore, resetForTest, __resetGlobalStateForTest } from "./application/generate-logbook.usecase";
export type { AppLogSink, SessionPort, SessionAdapter, EventSourcePort, PluginContextPort } from "./application/ports";

import hybridDefault from "./adapters/hybrid";
export default hybridDefault;
