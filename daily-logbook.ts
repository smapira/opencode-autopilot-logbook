// daily-logbook.ts — Phase4 facade (Strangler Fig)
// Re-export public API from src/plugin to keep `from "../daily-logbook"` stable.
// Build entry is src/plugin.ts (see package.json scripts.build).
// Will be removed in next major (3.0.0); migrate imports to `from "./src/plugin"` or package entry.
export * from "./src/plugin";
export { default } from "./src/plugin";
