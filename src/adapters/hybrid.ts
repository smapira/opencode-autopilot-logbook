import { createRequire } from "node:module";
import { DailyLogbookPlugin as V1 } from "./v1/plugin.v1";
import { v2Setup } from "./v2/plugin.v2";

function tryCreateV2Plugin(): unknown {
  const candidates: Array<{ spec: string; kind: "setup" | "effect" }> = [
    { spec: "@opencode-ai/plugin", kind: "setup" },
    { spec: "@opencode-ai/plugin/v2/promise", kind: "setup" },
    { spec: "@opencode-ai/plugin/v2/effect", kind: "effect" },
    { spec: "@opencode-ai/plugin/effect", kind: "effect" },
  ];
  for (const { spec, kind } of candidates) {
    try {
      const require = createRequire(import.meta.url);
      const mod = require(spec) as {
        Plugin?: { define?: (p: { id: string; setup?: unknown; effect?: unknown }) => unknown };
        define?: (p: { id: string; setup?: unknown; effect?: unknown }) => unknown;
      };
      const define = mod?.Plugin?.define ?? mod?.define;
      if (typeof define === "function") {
        if (kind === "setup") return define({ id: "smapira.daily-logbook", setup: v2Setup });
        return define({ id: "smapira.daily-logbook", effect: v2Setup as unknown as (ctx: unknown) => unknown });
      }
    } catch {}
  }
  return { id: "smapira.daily-logbook", setup: v2Setup, effect: v2Setup };
}

export const DailyLogbookPluginV2: unknown = tryCreateV2Plugin();

const hybridDefault: unknown = Object.assign(V1, {
  id: "smapira.daily-logbook",
  setup: v2Setup,
  effect: v2Setup,
});

export default hybridDefault as unknown as typeof V1 | typeof DailyLogbookPluginV2;
export { V1 as DailyLogbookPlugin };
