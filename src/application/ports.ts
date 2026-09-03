// Application Ports — DIP boundaries for daily-logbook use-case
// Each port abstracts an infrastructure or domain capability so the use-case
// depends on abstractions, not concretions.

import type { UsageStats } from "../domain/formatting";

export type AppLogSink = {
  warn: (message: string) => Promise<void> | void;
  error: (message: string, error?: unknown) => Promise<void> | void;
  info?: (message: string) => Promise<void> | void;
};

export type SessionPort = {
  get: (sessionId: string) => Promise<unknown>;
  getMessages: (sessionId: string) => Promise<unknown>;
  create: (title: string) => Promise<unknown>;
  prompt: (sessionId: string, text: string) => Promise<unknown>;
};

// Alias for migration — daily-logbook historically used SessionAdapter
export type SessionAdapter = SessionPort;

export type EventSourcePort = {
  // Supports both promise-style (subscribe({signal})) and effect-style (subscribe(type))
  subscribe: ((opts: { signal: AbortSignal }) => unknown) & ((type: string) => unknown);
};

export interface PluginContextPort {
  directory: string;
  sink: AppLogSink;
  session: SessionPort;
  events: EventSourcePort;
}

export type UsagePort = {
  getUsageStats: (params: {
    directory: string;
    sessionId: string;
    date: string;
    projectOnly: boolean;
    dbPath?: string;
  }) => UsageStats | null;
  isUsageProjectOnly: () => boolean;
  formatUsageTable: (
    stats: UsageStats | null,
    date: string,
    projectDisplayName?: string,
  ) => string;
  getDbPath?: () => string;
};

export type TranscriptMessage = {
  info: { role: "user" | "assistant" };
  parts: Array<{ type: string; [key: string]: unknown }>;
};

export type TranscriptPort = {
  buildTranscript: (messages: TranscriptMessage[]) => string;
  isTranscriptIncluded: () => boolean;
};

export type ConfigPort = {
  getOutputDir: () => string;
  isPluginDisabled: () => boolean;
  isDailyLimitEnabled: () => boolean;
  isTranscriptIncluded: () => boolean;
  getThrottleWindowMs: () => number;
  isUsageProjectOnly: () => boolean;
  getDbPath: () => string;
  getTemplatePath: () => string | undefined;
};

export type TemplateLoaderPort = {
  loadTemplate: (directory: string) => string;
  sampleTemplate: string;
  replaceVariables: (
    template: string,
    sessionId: string,
    now: Date,
    outputDir: string,
    usageTable?: string,
  ) => string;
  buildPrompt: (
    template: string,
    sessionId: string,
    transcript: string,
    includeTranscript: boolean,
    outputDir: string,
    now: Date,
    usageTable?: string,
  ) => string;
};

export type FileLogbookWriterPort = {
  exists: (path: string) => boolean;
  isDailyLogbookExists: (directory: string, outputDir: string, date: string) => boolean;
};

export type FileLogbookWriter = FileLogbookWriterPort;

// Phase2: definition only — implementation moves in Phase3
export type SdkClientFactoryPort = {
  createFallbackSdkClient: (sink: AppLogSink) => Promise<unknown>;
  createFallbackSessionAdapter: (
    sink: AppLogSink,
    serverUrl: unknown,
  ) => Promise<SessionPort | undefined>;
};

export type SdkClientFactory = SdkClientFactoryPort;
