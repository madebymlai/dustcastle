// tsc only emits .js/.d.ts. The orchestration prompts ship as .md files read
// at runtime via import.meta.url, so copy them into dist alongside the loader.
// Run via tsx after the build's tsc pass (not compiled into dist): build tooling,
// kept in TypeScript for consistency and type-checked by `npm run typecheck`.
import { chmodSync, cpSync, readFileSync } from "node:fs";

cpSync("src/agent/prompts", "dist/agent/prompts", { recursive: true });
console.log("copied src/agent/prompts → dist/agent/prompts");

// The agent sandbox image's Containerfile is read at runtime (ensureAgentImage via
// import.meta.url), so it must ship into dist alongside the loader.
cpSync("src/sandbox/agent.Containerfile", "dist/sandbox/agent.Containerfile");
console.log("copied src/sandbox/agent.Containerfile → dist/sandbox/agent.Containerfile");

// tsc emits the CLI entry as 0644, but it's the package `bin` and runs via a shebang
// (`#!/usr/bin/env node`), so it must be executable. npm sets +x when it links/installs
// the bin, but a bare `npm run build` (or a clean rebuild over an already-linked global)
// doesn't — leaving `dustcastle` "exists but is not an executable file". Re-assert it
// here so every build produces a runnable bin, regardless of npm's bin-linking.
interface PackageManifest {
  readonly bin?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
const bins: Record<string, string> = manifest.bin ?? {};
for (const binPath of Object.values(bins)) {
  chmodSync(binPath, 0o755);
  console.log(`chmod +x ${binPath}`);
}
