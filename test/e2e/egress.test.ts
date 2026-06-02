import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { confineRouteScript } from "../../src/sandbox/confine.js";
import { egressHosts } from "../../src/sandbox/egress.js";
import { startEgressProxy, type EgressProxyHandle } from "../../src/sandbox/proxy.js";
import { prepareRun } from "../../src/run/index.js";
import { stageNodeImpureProject } from "./fixture.js";

// SLICE 3 RED→GREEN GATE — egress allowlist ENFORCEMENT, proven live.
//
// This closes ADR 0005's one claimed-but-unproven guarantee: an impure `allow`
// build runs untrusted `postinstall` code *with* network, and that code must be
// able to reach ONLY the derived allowlist (registry + git host) — nothing else.
//
// dustcastle's real outputs drive the test: prepareRun (impure `allow`) derives
// the allowlist, picks the egress network, and routes the container's tooling at
// the egress proxy; the proxy is dustcastle's real `startEgressProxy`, enforcing
// exactly the standing allowlist (`egressHosts(plan.egress)`). The only test-supplied piece is the *confinement*
// backend: production uses a podman-native internal network (unprovable on this
// privilege-stripped host — no bridge module/root), so here the sandbox is
// confined with the pasta route-strip fallback (`confineRouteScript`), making the
// proxy its single way out. Same proxy, same guarantee, provable on this machine.
//
// We assert, live: (a) a direct off-allowlist connection is BLOCKED at the
// network layer (no route past the proxy), (b) the proxy REFUSES an off-allowlist
// CONNECT with 403, (c) it ALLOWS registry.npmjs.org, (d) a real `npm ci` installs
// from the registry through the proxy AND runs the untrusted postinstall, whose
// own exfil attempt is blocked, and (e) `node --test` passes. Gated by DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

// The proxy listens on the host loopback; pasta maps PROXY_MAP_ADDR (a link-local
// address) to the host's loopback, so the container reaches it there and nowhere
// else after the route-strip. Port is fixed so the plan's HTTPS_PROXY matches.
const PROXY_MAP_ADDR = "169.254.7.7";
const PROXY_PORT = 18118;
const PROXY_URL = `http://${PROXY_MAP_ADDR}:${PROXY_PORT}`;
const CONTAINER = "dustcastle-egress-e2e";
// alpine-based so busybox provides `ip` for the route-strip confine, AND it ships git
// (the in-Sandbox git-exclude shells `git`); node itself comes from the RO Store mount.
// Its default entrypoint is `git`, so the run below overrides it with `--entrypoint sleep`.
const IMAGE = "docker.io/alpine/git:latest";

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  spawnSync("podman", ["rm", "-f", CONTAINER]);
});

// Async so the in-process egress proxy keeps serving while podman runs — a
// synchronous spawnSync would freeze this process's event loop and the container
// could never reach the proxy.
function podman(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("podman", args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

describe("dustcastle run (slice 3: impure-allow egress enforcement, ADR 0004/0005)", () => {
  e2e(
    "blocks off-allowlist egress while allowing the registry, with a real npm ci + postinstall",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-egress-"));
      tmps.push(root);
      const projectDir = stageNodeImpureProject(root);
      const log = (line: string) => process.stderr.write(`   | ${line}\n`);

      // dustcastle's real pipeline (ADR 0012, always-impure): detect → realize only
      // the nodejs Toolchain → plan the Sandbox with the STANDING egress + proxy env.
      // There is no purity decision; the install runs in-Sandbox under the allowlist,
      // and this fixture's postinstall is the untrusted lifecycle code being confined.
      const prepared = prepareRun({
        cwd: projectDir,
        proxyUrl: PROXY_URL,
        onLine: log,
      });
      expect(prepared.detection.ecosystem).toBe("node");
      expect(prepared.plan.egress.kind).toBe("allowlist");
      // The standing allowlist the proxy enforces: the npm registry (no git remote on
      // a temp fixture). `egressHosts` is the flat union the proxy consumes.
      const allowlist = egressHosts(prepared.plan.egress);
      expect(allowlist).toContain("registry.npmjs.org");
      expect(prepared.plan.podmanOptions.network).toBe("dustcastle-egress");
      expect(prepared.plan.podmanOptions.env?.HTTPS_PROXY).toBe(PROXY_URL);
      expect(prepared.plan.setupCommands.join("\n")).toContain("npm ci");

      // Start dustcastle's REAL filtering proxy, enforcing exactly the standing
      // allowlist. This is the production security brain; only its confinement
      // (below) is the privilege-stripped fallback rather than the internal net.
      let proxy: EgressProxyHandle | undefined;
      proxy = await startEgressProxy({
        allowlist,
        host: "127.0.0.1",
        port: PROXY_PORT,
        onDecision: (h, allowed) => log(`proxy ${allowed ? "ALLOW" : "DENY "} ${h}`),
      });

      const storeRoot = prepared.provisioned.physStoreRoot;
      // The plan's PATH (Store toolchain + /usr/bin:/bin) wins for `node`/`npm`;
      // append the sbin dirs so the harness's confine step finds busybox `ip`.
      const planPath = prepared.plan.podmanOptions.env?.PATH ?? "/usr/bin:/bin";
      const env = {
        ...prepared.plan.podmanOptions.env,
        PATH: `${planPath}:/sbin:/usr/sbin`,
        HOME: "/root",
        npm_config_audit: "false",
        npm_config_fund: "false",
      };
      const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const exec = (cmd: string) =>
        podman(["exec", "-w", "/work", ...envFlags, CONTAINER, "sh", "-c", cmd]);

      await podman(["rm", "-f", CONTAINER]);
      try {
        // The sandbox: cap NET_ADMIN (to strip its own route), pasta with the
        // host-loopback mapping (so the proxy is reachable), the Store RO, and the
        // project writable at /work.
        const up = await podman([
          "run",
          "-d",
          "--name",
          CONTAINER,
          "--cap-add",
          "NET_ADMIN",
          "--network",
          `pasta:--map-host-loopback,${PROXY_MAP_ADDR}`,
          "-v",
          `${storeRoot}:/nix/store:ro`,
          "-v",
          `${projectDir}:/work`,
          // alpine/git's default entrypoint is `git`; override it so the container just sleeps.
          "--entrypoint",
          "sleep",
          IMAGE,
          "600",
        ]);
        expect(up.code, `podman run failed: ${up.err}`).toBe(0);

        // The Toolchain resolves from the read-only Store mount.
        const which = await exec("command -v node && node --version");
        expect(which.code, which.err).toBe(0);
        expect(which.out).toContain("/nix/store/");

        // CONFINE: add a host route to the proxy, then drop the default route.
        // After this the proxy is the container's ONLY reachable address.
        const confine = await exec(confineRouteScript(PROXY_MAP_ADDR));
        expect(confine.code, `confine failed: ${confine.err}`).toBe(0);

        // (a) A direct, non-proxied connection to a public IP is BLOCKED at the
        // network layer — a malicious dep cannot bypass the proxy with a raw socket.
        const raw = await exec("node /work/probe.js raw 1.1.1.1 443");
        expect(raw.out.trim(), raw.err).toBe("BLOCKED");

        // (b) The proxy REFUSES an off-allowlist host with 403…
        const offlist = await exec(`node /work/probe.js connect ${PROXY_MAP_ADDR}:${PROXY_PORT} example.com`);
        expect(offlist.out.trim()).toBe("STATUS 403");

        // (c) …and ALLOWS the registry the build legitimately needs.
        const onlist = await exec(`node /work/probe.js connect ${PROXY_MAP_ADDR}:${PROXY_PORT} registry.npmjs.org`);
        expect(onlist.out.trim()).toBe("STATUS 200");

        // (d) dustcastle's real per-project setup: `npm ci` (WITH scripts) under
        // the scoped net — installs is-number from the registry THROUGH the proxy
        // and runs the untrusted postinstall.
        for (const command of prepared.plan.setupCommands) {
          const setup = await exec(command);
          expect(setup.code, `setup '${command}' failed: ${setup.err}`).toBe(0);
        }
        // The postinstall actually ran (untrusted lifecycle code executed) and its
        // own exfil attempt to an off-allowlist host was blocked.
        const markerPath = join(projectDir, ".postinstall-ran");
        expect(existsSync(markerPath), "postinstall did not run").toBe(true);
        expect(readFileSync(markerPath, "utf8")).toContain("exfil=blocked");

        // (e) THE GATE: the project's tests pass, with the registry dep installed
        // through the allowlist proxy.
        const test = await exec("node --test");
        expect(test.code, test.err).toBe(0);
        expect(test.out).toMatch(/pass 1|# pass 1/);

        // The proxy refused at least the off-allowlist host — surfaced, never silent.
        expect(proxy.denied).toContain("example.com");
      } finally {
        await podman(["rm", "-f", CONTAINER]);
        if (proxy) await proxy.close();
      }
    },
  );
});
