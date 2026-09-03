import { basename, resolve } from "node:path";
import { buildTranscript } from "../domain/transcript";
import { formatUsageTable } from "../domain/formatting";
import { getUsageStats, isUsageProjectOnly } from "../infrastructure/usage/getUsageStats";
import {
  getDailyFileAction,
  handleDailyFileAction,
  isDailyLimitedInFlight,
  isThrottled,
  pruneExpiredGuards,
} from "./guards";
import {
  getOutputDir,
  getThrottleWindowMs,
  isDailyLimitEnabled,
  isPluginDisabled,
  isTranscriptIncluded,
} from "./config";
import { buildPrompt, loadTemplate, SAMPLE_TEMPLATE } from "./template-loader";
import type { AppLogSink, SessionPort, TranscriptMessage } from "./ports";

const GENERATED_TITLE_PREFIX = "[daily-logbook:auto]";

const inFlightSessionIds = new Set<string>();
const dailyLimitInFlightByDate = new Set<string>();
const recentlyTriggeredAtBySessionId = new Map<string, number>();

/** Test-only: clear all in-flight / throttle guards. Safe to call in beforeEach. */
export function resetForTest(): void {
  inFlightSessionIds.clear();
  dailyLimitInFlightByDate.clear();
  recentlyTriggeredAtBySessionId.clear();
}

/** Alias for task spec — both names reset the same global guards */
export const __resetGlobalStateForTest = resetForTest;

// --- Port defaults (DIP: use-case depends on abstractions, defaults provide concretes) ---
const usagePort = {
  getUsageStats,
  isUsageProjectOnly,
  formatUsageTable,
};

const transcriptPort = {
  buildTranscript,
  isTranscriptIncluded,
};

const configPort = {
  getOutputDir,
  isPluginDisabled,
  isDailyLimitEnabled,
  getThrottleWindowMs,
};

const templatePort = {
  loadTemplate,
  sampleTemplate: SAMPLE_TEMPLATE,
};

// ---------------------------------------------------------------------------
// Helpers: each <=20 lines, complexity <20
// ---------------------------------------------------------------------------

function formatDateTokens(now: Date): { date: string } {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return { date: `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}` };
}

function resolveUsageTable(directory: string, sessionId: string, date: string): string | undefined {
  const stats = usagePort.getUsageStats({
    directory,
    sessionId,
    date,
    projectOnly: usagePort.isUsageProjectOnly(),
  });
  if (!stats) return undefined;
  const projectDisplayName = basename(resolve(directory));
  const displayDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const table = usagePort.formatUsageTable(stats, displayDate, projectDisplayName);
  return table || undefined;
}

function resolveTemplate(directory: string): string {
  return templatePort.loadTemplate(directory);
}

function parseSourceResult(result: unknown): {
  ok: boolean;
  error?: unknown;
  isGenerated?: boolean;
} {
  const typed = result as { error?: unknown; data?: { title?: string }; title?: string };
  if (typed?.error) return { ok: false, error: typed.error };
  const title = typed?.data?.title ?? typed?.title ?? "";
  if (title.startsWith(GENERATED_TITLE_PREFIX)) return { ok: false, isGenerated: true };
  return { ok: true };
}

function parseMessagesResult(result: unknown): {
  error?: unknown;
  data: TranscriptMessage[];
} {
  const typed = result as { data?: unknown[]; messages?: unknown[]; error?: unknown };
  if (typed?.error) return { error: typed.error, data: [] };
  const data = (typed?.data ?? typed?.messages ?? typed ?? []) as TranscriptMessage[];
  const safe = Array.isArray(data) ? data : [];
  return { data: safe };
}

function parseCreateResult(result: unknown): { error?: unknown; id?: string } {
  const typed = result as { data?: { id: string }; id?: string; sessionID?: string; error?: unknown };
  if (typed?.error) return { error: typed.error };
  const id = typed?.data?.id ?? typed?.id ?? typed?.sessionID;
  if (!id) return { error: "missing session id" };
  return { id };
}

function buildTranscriptFromData(data: TranscriptMessage[]): string {
  return transcriptPort.isTranscriptIncluded() ? transcriptPort.buildTranscript(data) : "";
}

function getUsageAndTemplate(
  directory: string,
  sessionId: string,
  date: string,
  sink: AppLogSink,
): { usageTable: string | undefined; template: string } {
  let usageTable: string | undefined;
  try {
    usageTable = resolveUsageTable(directory, sessionId, date);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    void sink.warn(`Failed to get usage stats: ${msg}`);
  }
  let template: string;
  try {
    template = resolveTemplate(directory);
  } catch (error) {
    const custom = process.env.OPENCODE_DAILY_LOGBOOK_TEMPLATE;
    void sink.warn(`Template load failed (${custom ?? "unknown"}). Fallback to SAMPLE_TEMPLATE.`);
    void sink.error("Template load error", error);
    template = templatePort.sampleTemplate;
  }
  return { usageTable, template };
}

function shouldAbortSource(parsed: { ok: boolean; error?: unknown; isGenerated?: boolean }, sink: AppLogSink): boolean {
  if (parsed.error) {
    void sink.error("Failed to fetch source session", parsed.error);
    return true;
  }
  if (parsed.isGenerated) return true;
  return false;
}

function shouldAbortMessages(parsed: { error?: unknown }, sink: AppLogSink): boolean {
  if (parsed.error) {
    void sink.error("Failed to load source session messages", parsed.error);
    return true;
  }
  return false;
}

function shouldAbortCreate(parsed: { error?: unknown }, sink: AppLogSink): boolean {
  if (parsed.error) {
    void sink.error("Failed to create daily logbook session", parsed.error);
    return true;
  }
  return false;
}

function shouldAbortPrompt(result: { error?: unknown }, sink: AppLogSink): boolean {
  if (result.error) {
    void sink.error("Failed to send daily logbook prompt", result.error);
    return true;
  }
  return false;
}

// Orchestrator helpers split to keep each function <=20 lines

async function fetchSourceSession(
  adapter: SessionPort,
  sessionId: string,
  sink: AppLogSink,
): Promise<{ aborted: boolean }> {
  let getResult: unknown;
  try {
    getResult = await adapter.get(sessionId);
  } catch (error) {
    getResult = { error };
  }
  const parsed = parseSourceResult(getResult);
  if (shouldAbortSource(parsed, sink)) return { aborted: true };
  return { aborted: false };
}

async function fetchMessages(
  adapter: SessionPort,
  sessionId: string,
  sink: AppLogSink,
): Promise<{ aborted: boolean; data: TranscriptMessage[] }> {
  let msgResult: unknown;
  try {
    msgResult = await adapter.getMessages(sessionId);
  } catch (error) {
    msgResult = { error };
  }
  const parsed = parseMessagesResult(msgResult);
  if (shouldAbortMessages(parsed, sink)) return { aborted: true, data: [] };
  return { aborted: false, data: parsed.data };
}

async function createGeneratedSession(
  adapter: SessionPort,
  date: string,
  sink: AppLogSink,
): Promise<{ aborted: boolean; id?: string }> {
  let createResult: unknown;
  try {
    createResult = await adapter.create(`${GENERATED_TITLE_PREFIX} ${date}`);
  } catch (error) {
    createResult = { error };
  }
  const parsed = parseCreateResult(createResult);
  if (shouldAbortCreate(parsed, sink)) return { aborted: true };
  return { aborted: false, id: parsed.id as string };
}

async function sendPrompt(
  adapter: SessionPort,
  generatedId: string,
  prompt: string,
  sink: AppLogSink,
): Promise<{ aborted: boolean }> {
  let promptResult: unknown;
  try {
    promptResult = await adapter.prompt(generatedId, prompt);
  } catch (error) {
    promptResult = { error };
  }
  const typed = promptResult as { error?: unknown };
  if (shouldAbortPrompt(typed, sink)) return { aborted: true };
  return { aborted: false };
}

// ---------------------------------------------------------------------------
// Main use-case
// ---------------------------------------------------------------------------

export async function generateDailyLogbookCore(params: {
  sessionId: string;
  directory: string;
  sink: AppLogSink;
  adapter: SessionPort;
}): Promise<void> {
  if (configPort.isPluginDisabled()) return;
  const nowMs = Date.now();
  const throttleWindowMs = configPort.getThrottleWindowMs();
  pruneExpiredGuards(nowMs, throttleWindowMs, recentlyTriggeredAtBySessionId);
  if (isThrottled(params.sessionId, nowMs, throttleWindowMs, inFlightSessionIds, recentlyTriggeredAtBySessionId)) return;
  const now = new Date();
  const { date } = formatDateTokens(now);
  const outputDir = configPort.getOutputDir();
  const isDailyLimited = configPort.isDailyLimitEnabled();
  if (isDailyLimitedInFlight(date, isDailyLimited, dailyLimitInFlightByDate)) {
    await params.sink.warn(
      `Daily logbook for ${date} is already being generated. Skipping (OPENCODE_DAILY_LOGBOOK_DAILY_LIMIT=true).`,
    );
    return;
  }
  inFlightSessionIds.add(params.sessionId);
  if (isDailyLimited) dailyLimitInFlightByDate.add(date);
  try {
    const source = await fetchSourceSession(params.adapter, params.sessionId, params.sink);
    if (source.aborted) return;
    const action = getDailyFileAction(isDailyLimited, params.directory, outputDir, date);
    if (handleDailyFileAction(action, params.sink, date)) return;
    const { usageTable, template } = getUsageAndTemplate(params.directory, params.sessionId, date, params.sink);
    const msg = await fetchMessages(params.adapter, params.sessionId, params.sink);
    if (msg.aborted) return;
    const transcript = buildTranscriptFromData(msg.data);
    const includeTranscript = transcriptPort.isTranscriptIncluded();
    const promptOutputDir = isDailyLimited ? resolve(params.directory, outputDir) : outputDir;
    const prompt = buildPrompt(template, params.sessionId, transcript, includeTranscript, promptOutputDir, now, usageTable);
    const created = await createGeneratedSession(params.adapter, date, params.sink);
    if (created.aborted || !created.id) return;
    const sent = await sendPrompt(params.adapter, created.id, prompt, params.sink);
    if (sent.aborted) return;
    recentlyTriggeredAtBySessionId.set(params.sessionId, nowMs);
  } catch (error) {
    await params.sink.error("Unhandled error while generating daily logbook", error);
  } finally {
    inFlightSessionIds.delete(params.sessionId);
    if (isDailyLimited) dailyLimitInFlightByDate.delete(date);
  }
}
