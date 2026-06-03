import { describe, expect, it } from "vitest";
import { FLIGHT_RECORDER_CEILING_BYTES, runsToEvict, type RunLogEntry } from "./retention.js";

describe("runsToEvict", () => {
  it("evicts the oldest run logs first until the flat byte ceiling is met", () => {
    const entries: RunLogEntry[] = [
      { path: "/dust/runs/new.jsonl", bytes: 6, createdAtMs: 300 },
      { path: "/dust/runs/old.jsonl", bytes: 5, createdAtMs: 100 },
      { path: "/dust/runs/mid.jsonl", bytes: 4, createdAtMs: 200 },
    ];

    expect(runsToEvict(entries, 10)).toEqual(["/dust/runs/old.jsonl"]);
    expect(runsToEvict(entries, 6)).toEqual(["/dust/runs/old.jsonl", "/dust/runs/mid.jsonl"]);
  });

  it("uses a flat 16 MiB flight-recorder ceiling", () => {
    expect(FLIGHT_RECORDER_CEILING_BYTES).toBe(16_777_216);
  });
});
