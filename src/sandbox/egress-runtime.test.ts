import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import {
  confine,
  EGRESS_NETWORK,
  isProxyListeningLogLine,
  type EgressDecision,
  type EnforceConfinementOptions,
  type PodmanResult,
} from "./confine.js";

/** A structured allowlist decision (ADR 0010): Build hosts + optional Agent hosts. */
const allow = (buildHosts: string[], agentHosts: string[] = []): EgressDecision => ({
  kind: "allowlist",
  buildHosts,
  agentHosts,
});

const TEST_PROXY_IMAGE = "/test/dustcastle-egress-proxy:latest";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-enforce-home-"));
  tmps.push(dir);
  return dir;
}

function ensureEgress(opts: { readonly egress: EgressDecision } & EnforceConfinementOptions) {
  const { egress, ...enforceOpts } = opts;
  const defaultHome =
    egress.kind === "allowlist" && enforceOpts.dustcastleHome === undefined ? { dustcastleHome: tempHome() } : {};
  return confinementFor(egress).enforce({
    ensureProxyImage: async () => TEST_PROXY_IMAGE,
    ...defaultHome,
    ...enforceOpts,
  });
}

function confinementFor(decision: EgressDecision) {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-enforce-"));
  tmps.push(dir);
  if (decision.kind === "none") return confine({ projectDir: dir, packageManagers: [] });

  const packageManagers = decision.buildHosts.includes("registry.npmjs.org") ? (["npm"] as const) : [];
  const gitHost = decision.buildHosts.find((host) => host !== "registry.npmjs.org");
  if (gitHost !== undefined) {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", `git@${gitHost}:org/repo.git`]);
  }
  return confine({ projectDir: dir, packageManagers, agentModelHosts: decision.agentHosts });
}

// The imperative glue that brings up the production egress backend (ADR 0005,
// handoff item 1-tail): build the proxy image, materialize its external-resolver
// resolv.conf, create an --internal network with no route off-host, then start a
// dual-homed filtering-proxy container before sandcastle.run() and tear it down
// after. This host can't make a bridge network, so the orchestration is driven
// through injected seams and the command/liveness sequence is asserted; the live
// run is gated for a capable host.

const OK: PodmanResult = { status: 0, stderr: "" };

/** A proxy whose logs report it is serving — the JSON liveness contract. */
const LIVE_LOGS: PodmanResult = {
  status: 0,
  stderr: '{"level":30,"event":"listening","port":8118,"msg":"proxy listening"}\n',
};

/** Default replies: ordinary commands succeed, and the liveness probe sees a live proxy. */
function defaultReply(args: string[]): PodmanResult {
  if (args[0] === "logs") return LIVE_LOGS;
  return OK;
}

function recorder(reply: (args: string[]) => PodmanResult = defaultReply) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): PodmanResult => {
    const a = [...args];
    calls.push(a);
    return reply(a);
  };
  return { run, calls };
}

/** The container the proxy `run -d --name <c>` actually started — what teardown must remove. */
function startedContainer(calls: string[][]): string {
  const runCall = calls.find((c) => c[0] === "run");
  expect(runCall).toBeDefined();
  return runCall![runCall!.indexOf("--name") + 1]!;
}

describe("enforce() (the production egress backend orchestration — ADR 0005)", () => {
  it("is a no-op on the closed/pure path (no image, no network, no proxy)", async () => {
    const { run, calls } = recorder();
    let built = false;
    const handle = await ensureEgress({
      egress: { kind: "none" },
      run,
      ensureProxyImage: async () => {
        built = true;
        return "/test/unused";
      },
    });
    expect(built).toBe(false);
    expect(calls).toEqual([]);
    handle.teardown(); // must not throw
    expect(calls).toEqual([]);
  });

  it("builds the proxy image and materializes resolv.conf before creating the network", async () => {
    const { run, calls } = recorder();
    const home = tempHome();
    const milestones: string[] = [];

    await ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      run: (args) => {
        if (args[0] === "network" && args[1] === "create") {
          milestones.push(existsSync(join(home, "egress-resolv.conf")) ? "resolv" : "missing-resolv");
          milestones.push("network");
        } else {
          milestones.push(`podman:${args[0]}`);
        }
        return run(args);
      },
      dustcastleHome: home,
      ensureProxyImage: async () => {
        milestones.push("image");
        return "/test/proxy:with-code";
      },
    });

    expect(milestones.slice(0, 3)).toEqual(["image", "resolv", "network"]);
    const runCall = calls.find((c) => c[0] === "run")!;
    const resolvMount = runCall.find((arg) => arg.includes("egress-resolv.conf:/etc/resolv.conf:ro"));
    expect(resolvMount).toBe(`${join(home, "egress-resolv.conf")}:/etc/resolv.conf:ro`);
    expect(readFileSync(join(home, "egress-resolv.conf"), "utf8")).toContain("nameserver 1.1.1.1");
    expect(runCall).toContain("/test/proxy:with-code");
    expect(runCall).toContain("/opt/dustcastle/proxy-main.js");
  });

  it("creates the internal network then starts the dual-homed proxy, in order", async () => {
    const { run, calls } = recorder();
    const handle = await ensureEgress({
      egress: allow(["registry.npmjs.org", "github.com"]),
      run,
    });
    // First podman command: the --internal network (the hard confinement — no route off-host).
    expect(calls[0]!.slice(0, 2)).toEqual(["network", "create"]);
    expect(calls[0]).toContain("--internal");
    expect(calls[0]).toContain(EGRESS_NETWORK);
    // Then: a `podman run` of the proxy carrying the derived allowlist + default entrypoint.
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall!.join(" ")).toContain("registry.npmjs.org,github.com");
    expect(runCall!).toContain("/opt/dustcastle/proxy-main.js");
    // Network create precedes the proxy run.
    expect(calls.indexOf(runCall!)).toBeGreaterThan(0);
    expect(handle.teardown).toEqual(expect.any(Function));
  });

  it("logs egress progress through the caller-named child logger", async () => {
    const root = createMemoryLogger();
    const { run } = recorder();
    await ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      run,
      logger: root.child({ mod: "egress" }),
    });

    expect(root.records).toContainEqual({
      level: "info",
      fields: { mod: "egress", network: EGRESS_NETWORK },
      msg: "internal network ready",
      args: [],
    });
    expect(root.records.some((r) => r.fields.mod === "egress" && r.msg === "proxy enforcing allowlist")).toBe(true);
  });

  it("enforces the deduped Build∪Agent allowlist on the proxy (ADR 0010)", async () => {
    const { run, calls } = recorder();
    // A host shared by build and agent must reach the proxy exactly once.
    const handle = await ensureEgress({
      egress: { kind: "allowlist", buildHosts: ["github.com"], agentHosts: ["github.com", "api.deepseek.com"] },
      run,
    });
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall!.join(" ")).toContain("github.com,api.deepseek.com");
    // github.com appears once, not twice — the union is deduped.
    expect(runCall!.join(" ")).not.toContain("github.com,github.com");
    expect(handle.teardown).toEqual(expect.any(Function));
  });

  it("tolerates an already-existing network (idempotent re-run)", async () => {
    const { run } = recorder((a) =>
      a[0] === "network" && a[1] === "create"
        ? { status: 125, stderr: "Error: network dustcastle-egress already exists" }
        : defaultReply(a),
    );
    const handle = await ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      run,
    });
    expect(handle.teardown).toEqual(expect.any(Function));
  });

  it("throws on a hard network-create failure (not an already-exists)", async () => {
    const { run } = recorder((a) =>
      a[0] === "network" && a[1] === "create"
        ? { status: 125, stderr: "bridge: operation not permitted" }
        : OK,
    );
    await expect(ensureEgress({ egress: allow(["x"]), run })).rejects.toThrow(/egress network/i);
  });

  it("rolls back the freshly-created network when the proxy fails to start", async () => {
    const { run, calls } = recorder((a) => (a[0] === "run" ? { status: 1, stderr: "no such image" } : OK));
    await expect(ensureEgress({ egress: allow(["x"]), run })).rejects.toThrow(/proxy/i);
    // A failed setup leaves nothing behind: the network we created is removed.
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c.includes(EGRESS_NETWORK))).toBe(true);
  });

  it("throws (and rolls back) when the proxy is created but crashes — never a silent success", async () => {
    // `podman run -d` exits 0 (container CREATED) but the process dies a moment later
    // because the image lacks the proxy code — the exact ADR-0005 "never silent" trap.
    const { run, calls } = recorder((a) => {
      if (a[0] === "logs")
        return { status: 0, stderr: "Error: Cannot find module '/opt/dustcastle/proxy-main.js'\n" };
      if (a[0] === "inspect") return { status: 0, stdout: "false\n", stderr: "" };
      return OK; // image build + network create + `run -d` all "succeed"
    });
    await expect(ensureEgress({ egress: allow(["api.deepseek.com"]), run })).rejects.toThrow(
      /proxy container started but is not serving[\s\S]*Cannot find module/i,
    );
    // A dead proxy leaves nothing behind: the container it started is removed, our network rolled back.
    expect(calls.some((c) => c[0] === "rm" && c.includes(startedContainer(calls)))).toBe(true);
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c.includes(EGRESS_NETWORK))).toBe(true);
  });

  it("bind-mounts its internally materialized resolv.conf onto the proxy run", async () => {
    const { run, calls } = recorder();
    const home = tempHome();
    await ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      dustcastleHome: home,
      run,
    });
    const runCall = calls.find((c) => c[0] === "run")!;
    expect(runCall.join(" ")).toContain(`${join(home, "egress-resolv.conf")}:/etc/resolv.conf:ro`);
  });

  it("accepts the proxy once its logs report the JSON listening event (liveness confirmed)", async () => {
    const { run } = recorder(); // default reply: logs report the proxy is serving
    const handle = await ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      run,
    });
    expect(handle.teardown).toEqual(expect.any(Function));
  });

  it("treats readiness as a pure JSON event predicate, not a stderr-prefix grep", () => {
    expect(isProxyListeningLogLine('{"level":30,"event":"listening","port":8118}')).toBe(true);
    expect(isProxyListeningLogLine("dustcastle-egress: listening on http://0.0.0.0:8118")).toBe(false);
    expect(isProxyListeningLogLine('{"level":30,"event":"egress decision","decision":"allow"}')).toBe(false);
  });

  it("teardown removes the proxy container and the network", async () => {
    const { run, calls } = recorder();
    const handle = await ensureEgress({
      egress: allow(["x"]),
      run,
    });
    const startedProxy = startedContainer(calls);
    calls.length = 0; // isolate the teardown calls
    handle.teardown();
    expect(calls.some((c) => c[0] === "rm" && c.includes(startedProxy))).toBe(true);
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c.includes(EGRESS_NETWORK))).toBe(true);
  });
});
