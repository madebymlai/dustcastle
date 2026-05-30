// tsc only emits .js/.d.ts. The orchestration prompts ship as .md files read
// at runtime via import.meta.url, so copy them into dist alongside the loader.
import { cpSync } from "node:fs";

cpSync("src/agent/prompts", "dist/agent/prompts", { recursive: true });
console.log("copied src/agent/prompts → dist/agent/prompts");

// The agent sandbox image's Containerfile is read at runtime (ensureAgentImage via
// import.meta.url), so it must ship into dist alongside the loader.
cpSync("src/sandbox/agent.Containerfile", "dist/sandbox/agent.Containerfile");
console.log("copied src/sandbox/agent.Containerfile → dist/sandbox/agent.Containerfile");

// The egress-proxy image's Containerfile is read at runtime (ensureProxyImage via
// import.meta.url) and `COPY`s the compiled proxy.js + proxy-main.js from its own
// directory (the build context). tsc already emits those two into dist/sandbox, so
// shipping the Containerfile beside them completes a self-contained build context.
cpSync("src/sandbox/proxy.Containerfile", "dist/sandbox/proxy.Containerfile");
console.log("copied src/sandbox/proxy.Containerfile → dist/sandbox/proxy.Containerfile");
