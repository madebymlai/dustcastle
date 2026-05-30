import { describe, expect, it } from "vitest";
import { parsePiModels } from "./pi-models.js";

// Pure parse of `pi --list-models` (the model picker's data source). Mirrors
// agentstack's parser: skip the header row, columns split on whitespace, value
// is `provider/model`. No subprocess — the live `listPiModels` runs pi.

// A trimmed-down sample of real `pi --list-models` output (header + rows).
const SAMPLE = `provider      model                                context  max-out  thinking  images
deepseek      deepseek-v4-pro                      1M       384K     yes       no
huggingface   deepseek-ai/DeepSeek-R1-0528         163.8K   163.8K   yes       no
huggingface   moonshotai/Kimi-K2.5                 262.1K   262.1K   yes       yes`;

describe("parsePiModels", () => {
  it("groups models by provider", () => {
    const byProvider = parsePiModels(SAMPLE);
    expect([...byProvider.keys()]).toEqual(["deepseek", "huggingface"]);
    expect(byProvider.get("huggingface")).toHaveLength(2);
  });

  it("builds the option value as provider/model (what sandcastle.pi takes)", () => {
    const byProvider = parsePiModels(SAMPLE);
    expect(byProvider.get("deepseek")![0]).toEqual({
      label: "deepseek-v4-pro (1M)",
      value: "deepseek/deepseek-v4-pro",
    });
  });

  it("keeps a slash-bearing model name intact (it has no spaces)", () => {
    const byProvider = parsePiModels(SAMPLE);
    expect(byProvider.get("huggingface")!.map((o) => o.value)).toEqual([
      "huggingface/deepseek-ai/DeepSeek-R1-0528",
      "huggingface/moonshotai/Kimi-K2.5",
    ]);
  });

  it("drops the header row and ignores blank/short lines", () => {
    expect(parsePiModels("").size).toBe(0);
    expect(parsePiModels("provider model context").size).toBe(0); // header only
    const withBlanks = parsePiModels(`provider model\ndeepseek deepseek-v4-pro 1M\n   \nbad`);
    expect([...withBlanks.keys()]).toEqual(["deepseek"]);
  });
});
