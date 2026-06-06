import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { PreparedRun } from "../../src/run/index.js";

/**
 * Commit a staged fixture tree (ADR 0009 / ADR 0012): dustcastle builds the project's
 * COMMITTED source (`git archive HEAD`), so an e2e fixture — copied into a throwaway
 * temp dir — must be a real git repo with a commit, exactly as a user's repo is. The
 * identity is local + throwaway, so the commit is hermetic and leaves no global config.
 */
export function commitFixtureTree(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=e2e@dustcastle.local", "-c", "user.name=dustcastle-e2e", "commit", "-q", "-m", "fixture");
}

// ────────────────────────────────────────────────────────────────────────────
// The shared ADR 0012/0020 run harness.
//
// Under ADR 0012 a project's deps are no longer FOD-built into the Store and mounted
// read-only for an OFFLINE run — the Store holds only the Toolchain, and the deps
// install IN-SANDBOX via the `sandbox.onSandboxReady` hook (`npm install` /
// `cargo fetch` / `go mod download`). Under ADR 0020 dustcastle no longer stands up
// a filtering proxy; the container uses normal networking while retaining the Store
// and host-credential Boundary.
// ────────────────────────────────────────────────────────────────────────────

// A glibc base image that ships git: the in-Sandbox install's git-exclude step shells
// `git`, and the Nix Toolchain closure (mounted RO at /nix/store) is glibc, so a musl
// (alpine) base would break its dynamic loader. The language Toolchain itself always
// comes from the Store mount — this image only supplies sh + git + a working libc.
const DEFAULT_BASE_IMAGE = "docker.io/library/node:20";

interface ExecResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

// Async podman spawn so long-running containers do not block the test process.
function podmanSpawn(args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("podman", args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

export interface SandboxRunSpec {
  /** dustcastle's prepared pipeline output (detect → provision Toolchain → plan). */
  readonly prepared: PreparedRun;
  /** The staged, committed project dir (bind-mounted writable at /work). */
  readonly projectDir: string;
  /** A container name unique to the calling test (parallel e2e files coexist). */
  readonly container: string;
  /** The project's test command + the stdout it must produce to count as green. */
  readonly test: { readonly command: string; readonly expect: RegExp };
  /** Base image override (default: a glibc image with git). */
  readonly image?: string;
  /** Container working directory (default `/work`). */
  readonly cwd?: string;
  /** Extra in-container assertions after the install, before the test (e.g. cargo's CARGO_HOME). */
  readonly afterSetup?: (exec: (cmd: string) => Promise<ExecResult>) => Promise<void>;
  /** Stream progress (default: stderr). */
  readonly onLine?: (line: string) => void;
}

/**
 * Run a prepared project through the ADR 0012 in-Sandbox install + test flow. Runs
 * the container with the Store mounted RO, executes `plan.setupCommands` (the
 * in-Sandbox install), then runs the project's test command — asserting each step
 * green. Tears the container down whatever the outcome.
 */
export async function runInSandbox(spec: SandboxRunSpec): Promise<void> {
  const log = spec.onLine ?? ((line: string) => process.stderr.write(`   | ${line}\n`));
  const cwd = spec.cwd ?? "/work";
  const image = spec.image ?? DEFAULT_BASE_IMAGE;

  const storeRoot = spec.prepared.ecosystems[0].provisioned.physStoreRoot;
  // The plan env carries the Toolchain on PATH + writable cache vars.
  const env = {
    ...spec.prepared.plan.podmanOptions.env,
    HOME: "/root",
  };
  const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const exec = (cmd: string): Promise<ExecResult> =>
    podmanSpawn(["exec", "-w", cwd, ...envFlags, spec.container, "sh", "-c", cmd]);

  await podmanSpawn(["rm", "-f", spec.container]);
  try {
    const up = await podmanSpawn([
      "run",
      "-d",
      "--name",
      spec.container,
      "-v",
      `${storeRoot}:/nix/store:ro`,
      "-v",
      `${spec.projectDir}:/work`,
      image,
      "sleep",
      "600",
    ]);
    expect(up.code, `podman run failed: ${up.err}`).toBe(0);

    // dustcastle's in-Sandbox install (ADR 0012): the git-exclude + the real Package
    // Manager's resolving install.
    for (const command of spec.prepared.plan.setupCommands) {
      const setup = await exec(command);
      expect(setup.code, `setup '${command}' failed: ${setup.err}`).toBe(0);
    }

    await spec.afterSetup?.(exec);

    // THE GATE: the project's tests pass with the deps installed in-Sandbox.
    const test = await exec(spec.test.command);
    expect(test.code, test.err).toBe(0);
    expect(test.out).toMatch(spec.test.expect);
  } finally {
    await podmanSpawn(["rm", "-f", spec.container]);
  }
}

// Shared e2e fixtures, committed under test/fixtures/ — v1 now owns its own
// samples (the kickoff side-quest, finished). The rootless nix-portable binary
// is owned + managed by dustcastle itself (`ensureNixPortable()`), so the e2e
// just uses the default; the throwaway spike no longer backs any gate.

// The committed Go sample (slice 1): one real external dep (rsc.io/quote) so the
// build exercises a genuine go.sum lockfile + module graph. Lives under
// test/fixtures/ alongside the Node samples.
export const GO_SAMPLE = resolve(process.cwd(), "test/fixtures/go-sample");

/**
 * Stage the sample under a directory named "sample" inside `root` so the build's
 * pname matches the warm Store. Returns the staged project directory.
 */
export function stageSampleProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(GO_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
  return projectDir;
}

// The committed Node sample (slice 2): one real dep (is-number, zero deps, no
// install script → pure path) + a built-in `node --test`. Lives under
// test/fixtures/ — the start of v1 owning its own fixtures (the kickoff side-quest).
export const NODE_SAMPLE = resolve(process.cwd(), "test/fixtures/node-sample");

/** Stage the Node sample under a "sample"-named dir. */
export function stageNodeProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(NODE_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
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
  commitFixtureTree(projectDir);
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
  commitFixtureTree(projectDir);
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
    // Each member is its OWN committed repo (ADR 0009/0012): provisionStore stages the
    // member via `git archive HEAD` and the in-Sandbox git-exclude needs a git repo at
    // the member's worktree (each member is bind-mounted standalone at /work, so its own
    // .git must be present). detectWorkspace reads wsRoot's package.json directly (no git),
    // so the workspace root itself need not be a repo — and committing members as separate
    // repos keeps each member's `npm ci` isolated from the workspace root.
    commitFixtureTree(dir);
    return dir;
  });
  return { root: wsRoot, members };
}

// The committed Rust sample (dustcastle-gy5.2): a tiny Cargo crate with a
// committed Cargo.lock and an in-crate `cargo test` gate. The pure Cargo importer
// vendors deps into the Store and the Sandbox stages them as CARGO_HOME.
export const RUST_SAMPLE = resolve(process.cwd(), "test/fixtures/rust-sample");

/** Stage the Rust sample under a "sample"-named dir (pname matches the fixture crate). */
export function stageRustProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(RUST_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
  return projectDir;
}

// The committed Rust git-dependency sample (dustcastle-gy5.5): itoa is sourced
// from its git repo, proving fetchCargoVendor covers git deps under the single
// aggregate cargoHash and the rebased Cargo config resolves them offline.
export const RUST_GIT_SAMPLE = resolve(process.cwd(), "test/fixtures/rust-git-sample");

/** Stage the Rust git-dependency sample under the same "sample" crate name. */
export function stageRustGitProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(RUST_GIT_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
  return projectDir;
}

// The committed Rust crates.io-dependency sample (dustcastle-kzw): a real crates.io
// crate (itoa) so the happy crates.io vendor path actually vendors a dependency —
// the gy5.2 rust-sample is zero-dependency and vendors nothing. Proves the vendored
// tree is non-empty and resolves offline.
export const RUST_CRATE_SAMPLE = resolve(process.cwd(), "test/fixtures/rust-crate-sample");

/** Stage the Rust crates.io-dependency sample under the same "sample" crate name. */
export function stageRustCrateProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(RUST_CRATE_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
  return projectDir;
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
  commitFixtureTree(projectDir);
  return projectDir;
}

// The uv Python fixture (laimk-hse.6): a `uv.lock` (the real lockfile, beating a
// co-present requirements.txt → detection routes the `uv` Package Manager) +
// pyproject.toml + the EXPORTED hash-pinned requirements.txt the uv export
// front-end materialises (`uv export --format requirements-txt`), which the SAME
// pip-FOD Importer consumes. Same deps (idna + urllib3, pure-Python wheels) as
// python-sample, so it hits the same warm Store wheelhouse and builds PURE. Its
// live build is proven by the gated uv case in test/e2e/python-run.test.ts.
export const PYTHON_UV_SAMPLE = resolve(process.cwd(), "test/fixtures/python-uv-sample");

/** Stage the uv Python sample under a "sample"-named dir (pname matches the warm Store). */
export function stagePythonUvProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(PYTHON_UV_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
  return projectDir;
}

// The poetry Python fixture (laimk-hse.7): a GENUINE `poetry.lock` (the real
// lockfile, beating a co-present requirements.txt and losing to uv.lock → detection
// routes the `poetry` Package Manager) + a poetry-shaped pyproject.toml. poetry is an
// EXPORT FRONT-END (`poetry export`) to the SAME pip-FOD — NOT poetry2nix. The
// laimk-hse.7 spike PROVED `poetry export` hermetic (wheels-only, --require-hashes
// clean, same aggregate hash as uv export), so provisioning runs the pure path. The
// lock is a real poetry 2.4.1 lock (content-hash matches pyproject so `poetry export`
// consumes it without re-locking). Same deps (idna + urllib3, pure-Python wheels) as
// python-sample, so it hits the same warm Store wheelhouse. Drives the gated poetry
// case in test/e2e/python-run.test.ts (an offline-pytest build, like uv).
export const PYTHON_POETRY_SAMPLE = resolve(process.cwd(), "test/fixtures/python-poetry-sample");

/** Stage the poetry Python sample under a "sample"-named dir (pname matches the warm Store). */
export function stagePythonPoetryProject(root: string): string {
  const projectDir = join(root, "sample");
  mkdirSync(projectDir);
  cpSync(PYTHON_POETRY_SAMPLE, projectDir, { recursive: true });
  commitFixtureTree(projectDir);
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

