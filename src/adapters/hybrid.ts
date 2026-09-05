import { createRequire } from "node:module";
import { DailyLogbookPlugin as V1 } from "./v1/plugin.v1";
import { v2Setup } from "./v2/plugin.v2";

// Returns Effect-wrapped v2Setup if `effect` package is available.
// opencode2's Plugin.define expects `effect` to be Effect (see dist/v2/effect/plugin.d.ts),
// not a plain Promise, otherwise zod validation fails with "Expected Effect".
function getEffectWrappedSetup(): ((ctx: unknown) => unknown) | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("effect") as {
      Effect?: { promise: (fn: () => Promise<unknown>) => unknown };
    };
    if (mod.Effect && typeof mod.Effect.promise === "function") {
      return (ctx: unknown) => mod.Effect!.promise(() => v2Setup(ctx));
    }
  } catch {}
  return undefined;
}

type DefineFn = (p: { id: string; setup?: unknown; effect?: unknown }) => unknown;
type PluginMod = {
  Plugin?: { define?: DefineFn };
  define?: DefineFn;
};

function loadDefine(spec: string): DefineFn | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod = require(spec) as PluginMod;
    const define = mod?.Plugin?.define ?? mod?.define;
    if (typeof define === "function") return define;
  } catch {}
  return undefined;
}

function tryCreateV2Plugin(): unknown {
  // Prefer setup (Promise) – works for both @opencode-ai/plugin and v2/promise
  const setupSpecs = ["@opencode-ai/plugin", "@opencode-ai/plugin/v2/promise"];
  for (const spec of setupSpecs) {
    const define = loadDefine(spec);
    if (define) {
      try {
        return define({ id: "smapira.daily-logbook", setup: v2Setup });
      } catch {}
    }
  }

  // Only use effect candidate when we can provide an Effect value
  const wrapped = getEffectWrappedSetup();
  if (wrapped) {
    const effectSpecs = ["@opencode-ai/plugin/v2/effect", "@opencode-ai/plugin/effect"];
    for (const spec of effectSpecs) {
      const define = loadDefine(spec);
      if (define) {
        try {
          return define({ id: "smapira.daily-logbook", effect: wrapped });
        } catch {}
      }
    }
  }

  // Fallback plain object – setup only to avoid zod "Expected Effect" error
  return { id: "smapira.daily-logbook", setup: v2Setup };
}

export const DailyLogbookPluginV2: unknown = tryCreateV2Plugin();

// Hybrid default for npm package: plain object for Orca V2 (expects object with id/setup).
// V1 (1.18.27) needs function, V2 (Orca beta) needs object — single dist cannot satisfy both via typeof.
// We prioritize Orca V2 (user is checking V2 auto-generation). V1 will be satisfied via named export DailyLogbookPlugin.
// For V1 local, use `DailyLogbookPlugin` directly; default as object ensures V2 does not throw SchemaError(Expected object).
function createHybridDefault(): unknown {
  const wrapped = getEffectWrappedSetup();
  if (wrapped) {
    return { id: "smapira.daily-logbook", setup: v2Setup, effect: wrapped };
  }
  return { id: "smapira.daily-logbook", setup: v2Setup };
}

const hybridDefault: unknown = createHybridDefault();

export default hybridDefault as unknown as typeof DailyLogbookPluginV2;
export { V1 as DailyLogbookPlugin };
