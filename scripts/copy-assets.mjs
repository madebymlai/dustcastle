// tsc only emits .js/.d.ts. The orchestration prompts ship as .md files read
// at runtime via import.meta.url, so copy them into dist alongside the loader.
import { cpSync } from "node:fs";

cpSync("src/agent/prompts", "dist/agent/prompts", { recursive: true });
console.log("copied src/agent/prompts → dist/agent/prompts");

// The agent sandbox image's Containerfile is read at runtime (ensureAgentImage via
// import.meta.url), so it must ship into dist alongside the loader.
cpSync("src/sandbox/agent.Containerfile", "dist/sandbox/agent.Containerfile");
console.log("copied src/sandbox/agent.Containerfile → dist/sandbox/agent.Containerfile");
