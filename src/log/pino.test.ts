import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loggerConfig, stderrLogSetting } from "./pino.js";

const prettyTransport = expect.stringMatching(/pretty-transport\.(?:ts|js)$/);

describe("loggerConfig", () => {
  const now = new Date("2026-06-03T04:05:06.007Z");

  it("builds the two dustcastle sinks as a pure transport value", () => {
    expect(loggerConfig({ homeDir: "/dust", now })).toEqual({
      level: "trace",
      runLogPath: join("/dust", "runs", "2026-06-03T04-05-06-007Z.jsonl"),
      transport: {
        targets: [
          {
            target: prettyTransport,
            level: "info",
            options: {
              destination: 2,
              ignore: "mod,event,ecosystems,mode,egress,toolchains,note,agent,line,sweptAt,freedBytes,pathsCollected",
            },
          },
          {
            target: "pino/file",
            level: "trace",
            options: {
              destination: join("/dust", "runs", "2026-06-03T04-05-06-007Z.jsonl"),
              mkdir: true,
            },
          },
        ],
      },
    });
  });

  it("lets DUSTCASTLE_LOG tune only the stderr target", () => {
    const debug = loggerConfig({ homeDir: "/dust", now, env: { DUSTCASTLE_LOG: "debug" } });
    const silent = loggerConfig({ homeDir: "/dust", now, env: { DUSTCASTLE_LOG: "silent" } });

    expect(debug.transport.targets[0]).toMatchObject({ target: prettyTransport, level: "debug" });
    expect(silent.transport.targets[0]).toMatchObject({ target: prettyTransport, level: "silent" });
    expect(debug.transport.targets[1]).toEqual(silent.transport.targets[1]);
    expect(debug.transport.targets[1]).toMatchObject({ target: "pino/file", level: "trace" });
  });
});

describe("stderrLogSetting", () => {
  it("accepts only the supported DUSTCASTLE_LOG values", () => {
    expect(stderrLogSetting(undefined)).toBe("info");
    expect(stderrLogSetting("debug")).toBe("debug");
    expect(stderrLogSetting("silent")).toBe("silent");
    expect(() => stderrLogSetting("warn")).toThrow(/DUSTCASTLE_LOG/);
  });
});
