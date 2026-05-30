import * as sandcastle from "@ai-hero/sandcastle";
import { z } from "zod";

// The planner emits its dependency-graph result as JSON wrapped in <plan> tags.
// Each entry is an unblocked issue with a deterministic branch name.
export const planSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
    }),
  ),
});

export type Plan = z.infer<typeof planSchema>;
export type PlannedIssue = Plan["issues"][number];

// Fed to sandcastle.run as `output`: sandcastle extracts the <plan> block and
// validates it against the schema (zod implements Standard Schema natively),
// throwing StructuredOutputError on a missing tag or invalid shape.
export const planOutput = sandcastle.Output.object({
  tag: "plan",
  schema: planSchema,
});
