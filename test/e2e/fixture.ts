import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Shared e2e fixtures, committed under test/fixtures/ — v1 now owns its own
// samples (the kickoff side-quest, finished). The rootless nix-portable binary
// is owned + managed by dustcastle itself (`ensureNixPortable()`), so the e2e
// just uses the default; the throwaway spike no longer backs any gate.

// The committed Go sample (slice 1): one real external dep (rsc.io/quote) so the
// build exercises a genuine go.sum lockfile + module graph. Lives under
// test/fixtures/ alongside the Node samples.
export const GO_SAMPLE = resolve(process.cwd(), "test/fixtures/go-sample");

// The known vendor hash for the sample's deps (rsc.io/quote …). Supplying it
// gives a warm-Store cache hit and skips the discovery build (ADR 0004).
export const KNOWN_VENDOR_HASH = "sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=";

/**
 * Stage the sample under a directory named "sample" inside `root` so the build's
 * pname matches the warm Store. Returns the staged project directory.
 */
export function stageSampleProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(GO_SAMPLE, projectDir, { recursive: true });
  return projectDir;
}

// The committed Node sample (slice 2): one real dep (is-number, zero deps, no
// install script → pure path) + a built-in `node --test`. Lives under
// test/fixtures/ — the start of v1 owning its own fixtures (the kickoff side-quest).
export const NODE_SAMPLE = resolve(process.cwd(), "test/fixtures/node-sample");

// The known npmDepsHash for the Node sample's deps. Supplying it skips the
// discovery build and hits the warm Store (same role as KNOWN_VENDOR_HASH).
export const KNOWN_NPM_DEPS_HASH = "sha256-oFyV3fMNa6lKWWuX7MPWxvQJWCbLZ46hSPQSq2BaRTQ=";

/** Stage the Node sample under a "sample"-named dir (pname matches the warm Store). */
export function stageNodeProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(NODE_SAMPLE, projectDir, { recursive: true });
  return projectDir;
}

// The committed pnpm + yarn samples (slice 2b): same shape as the npm sample —
// one real dep (is-number, zero deps, no install script → pure path) + a built-in
// `node --test` — but signalled by a real pnpm-lock.yaml / yarn.lock so detection
// routes the pnpm / yarn importer. Their live builds are proven by the gated
// pm e2e (test/e2e/pm-run.test.ts), the analogue of the npm gate.
export const PNPM_SAMPLE = resolve(process.cwd(), "test/fixtures/pnpm-sample");
export const YARN_SAMPLE = resolve(process.cwd(), "test/fixtures/yarn-sample");

/** Stage a JS sample under a "sample"-named dir (pname matches the warm Store). */
export function stageFixtureProject(fixtureDir: string, root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(fixtureDir, projectDir, { recursive: true });
  return projectDir;
}

// The loose-manifest Node fixture (ADR 0006c, pin-then-pure): the same package.json
// shape as node-sample (is-number 7.0.0, a built-in node:test) but with NO lockfile,
// so detection flags it `loose` and dustcastle resolves it once into a generated
// package-lock.json, then builds pure. Drives the gated pin-then-pure e2e.
export const NODE_LOOSE_SAMPLE = resolve(process.cwd(), "test/fixtures/node-loose-sample");

/** Stage the loose Node sample under a "sample"-named dir (pname matches the warm Store). */
export function stageNodeLooseProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(NODE_LOOSE_SAMPLE, projectDir, { recursive: true });
  return projectDir;
}

// A 2-member npm workspace (ADR 0006d): a root package.json declaring
// `workspaces: ["packages/*"]` whose members each reuse the pure node-sample
// (is-number + a committed lock + a built-in node:test). Built from NODE_SAMPLE so
// the members' deps match the warm Store. Drives the gated workspace e2e: detection
// enumerates both members and dustcastle provisions EACH.
export function stageWorkspaceProject(root: string): { root: string; members: string[] } {
  const wsRoot = join(root, "workspace");
  mkdirSync(join(wsRoot, "packages"), { recursive: true });
  writeFileSync(
    join(wsRoot, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }, null, 2),
  );
  const members = ["a", "b"].map((name) => {
    const dir = join(wsRoot, "packages", name);
    mkdirSync(dir, { recursive: true });
    cpSync(NODE_SAMPLE, dir, { recursive: true });
    return dir;
  });
  return { root: wsRoot, members };
}

// The committed Python sample (slice laimk-hse.2): a hash-pinned, wheels-only
// requirements.txt (idna + urllib3, both pure-Python wheels → pip-FOD pure path)
// + a `python -m pytest` gate. Signalled by requirements.txt so detection routes
// the pip-FOD Importer. Its live build is proven by the gated Python e2e
// (test/e2e/python-run.test.ts), the analogue of the Node gate.
export const PYTHON_SAMPLE = resolve(process.cwd(), "test/fixtures/python-sample");

/** Stage the Python sample under a "sample"-named dir (pname matches the warm Store). */
export function stagePythonProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(PYTHON_SAMPLE, projectDir, { recursive: true });
  return projectDir;
}

// The LOOSE Python fixture (ADR 0006c, laimk-hse.5): an abstract pyproject.toml
// (the manifest marker) + a loose, unpinned requirements.in (idna, urllib3) and NO
// lock-grade requirements.txt, so detection flags it `loose`. dustcastle resolves
// it ONCE into a hash-pinned requirements.txt (`uv pip compile --generate-hashes`),
// then builds PURE via the pip-FOD. Drives the gated pin-then-pure Python e2e.
export const PYTHON_LOOSE_SAMPLE = resolve(process.cwd(), "test/fixtures/python-loose-sample");

/** Stage the loose Python sample under a "sample"-named dir (pname matches the warm Store). */
export function stagePythonLooseProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(PYTHON_LOOSE_SAMPLE, projectDir, { recursive: true });
  return projectDir;
}

// The impure-allow Node fixture (ADR 0004/0005): a real registry dep (is-number)
// + a local dep with a postinstall, so the lockfile reports hasInstallScript and
// the build resolves impure. Drives the live egress-enforcement e2e: a real
// `npm ci` (with scripts) runs in the container, confined to the egress proxy.
export const NODE_IMPURE_SAMPLE = resolve(process.cwd(), "test/fixtures/node-impure-sample");

/** Stage the impure Node sample under a "sample"-named dir (pname matches the warm Store). */
export function stageNodeImpureProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(NODE_IMPURE_SAMPLE, projectDir, { recursive: true });
  return projectDir;
}
