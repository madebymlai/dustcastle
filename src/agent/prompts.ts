import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The four orchestration phases. dustcastle ships these prompts as a built-in
// workflow — they are not user-supplied or configurable (the loop is a
// first-class feature, like agentstack's parallel-planner-with-review).
export type PromptPhase = "plan" | "implement" | "review" | "merge";

// The prompts live as .md files next to this module so they read as markdown
// rather than escaped string literals. import.meta.url resolves to src/ under
// vitest/tsx and to dist/ in the built CLI (the build copies prompts/ to dist).
export function orchestrationPromptPath(phase: PromptPhase): string {
  return fileURLToPath(new URL(`./prompts/${phase}-prompt.md`, import.meta.url));
}

// sandcastle only runs {{KEY}} substitution and `!`cmd`` expansion on prompts
// sourced from a file (inline `prompt` strings are passed through literally), so
// the orchestrator hands sandcastle these absolute paths, not the loaded text.
// This reader is for tests / introspection.
export function loadOrchestrationPrompt(phase: PromptPhase): string {
  return readFileSync(orchestrationPromptPath(phase), "utf8");
}
