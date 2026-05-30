// tsc only emits .js/.d.ts. The orchestration prompts ship as .md files read
// at runtime via import.meta.url, so copy them into dist alongside the loader.
import { cpSync } from "node:fs";

cpSync("src/agent/prompts", "dist/agent/prompts", { recursive: true });
console.log("copied src/agent/prompts → dist/agent/prompts");
