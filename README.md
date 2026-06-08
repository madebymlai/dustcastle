<h1 align="center">d&nbsp;u&nbsp;s&nbsp;t&nbsp;c&nbsp;a&nbsp;s&nbsp;t&nbsp;l&nbsp;e</h1>

<div align="center">
<img src="docs/hero.png?v=2" alt="dustcastle" width="100%">

<strong>One toolchain store for every AI-agent sandbox. Install once, share everywhere, any language.</strong>

</div>

---

AI coding agents work best inside isolated sandboxes. But today every project ships
its own `Dockerfile`, and every one rebuilds the same language runtime, `git`, `gh`,
and agent CLI from scratch. N projects means N image builds and N copies of the same
boilerplate.

dustcastle removes the per-project build. It manages **one shared, content-addressed
[Nix](https://nixos.org) store** on your machine and mounts it read-only into every
sandbox. The toolchain is described once, deduplicated across all of your projects,
and works for **any ecosystem** with zero per-project setup.

```
HOST
  /nix/store   <- ONE store. Deduplicated, content-addressed, immutable.
      |  (mounted read-only)
      |--> sandbox A   (Node project)
      |--> sandbox B   (Python project)  <- same store, no copy
      `--> sandbox C   (Rust project)
```

## Why dustcastle

- **Install once, share everywhere.** The store grows with *unique package-versions*,
  not *projects times dependencies*. No more N identical image builds, and nothing to
  tend: dustcastle keeps the store lean on its own.
- **Every repo just works.** dustcastle runs your project's real package manager inside
  the sandbox, lifecycle scripts and all, so native builds, `postinstall` hooks, and git
  dependencies install cleanly. The assembled result is cached by lockfile hash, so the
  next sandbox restores it instantly instead of reinstalling.
- **Any ecosystem, no config.** The language, package manager, and dependencies are
  detected from your lockfile. There is no `dustcastle.toml` and nothing to wire up.
- **Host boundary, normal network.** Sandboxes inherit none of your host credentials
  by default, while using normal container network access so package managers, git
  dependencies, and the agent can reach what they need. Curated Credentials (today:
  GitHub/GitLab via `dustcastle config`) are the explicit opt-in path for private HTTPS
  git dependencies.
- **Automatic and quiet.** Detection, dependency caching, store garbage collection, and
  session reuse all happen on their own. One command, nothing to pass.

## Status

Released at `v0.2.0`. Linux first; macOS and Windows run through a Linux container.
Requires a container runtime (Docker or Podman) and Node 22 or newer.

## Install

```bash
npm install -g dustcastle    # exposes the `dustcastle` command on your PATH
```

Or run it on demand without installing:

```bash
npx dustcastle run
```

## Build from source

```bash
git clone https://github.com/madebymlai/dustcastle.git
cd dustcastle
npm install
npm run build
npm link        # exposes the `dustcastle` command on your PATH
```

Or run it directly without linking:

```bash
npm run dev     # runs src/cli/main.ts via tsx
```

## Quick start

From the root of any git repository:

```bash
dustcastle run
```

That is the entire surface: **one zero-argument command, nothing to pass.**
dustcastle then:

1. **Detects** the ecosystem from your lockfile (`package-lock.json`,
   `pnpm-lock.yaml`, `uv.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, and so on).
2. **Provisions** the language toolchain from the shared store (downloaded once, then
   reused forever) and installs your project's dependencies inside the sandbox, caching
   the assembled result by lockfile hash.
3. **Launches** your coding agent inside the sandbox, wired to the shared store and a
   locked-down network.

The first run downloads the base toolchain closure (a few minutes, one time). Every run
after that, and every other project on your machine, reuses it instantly. A repeat run
on an unchanged lockfile skips dependency installation entirely.

## How it works

dustcastle is the **shared store manager and the UX around it**. It uses
[sandcastle](https://github.com/mattpocock/sandcastle) as a library to stand up the
sandbox, and slots the shared Nix store in where per-project image provisioning used to
live. Two independent ideas carry the design:

| Axis | Question | Answer |
|---|---|---|
| **The Store** | How is the toolchain described, stored, and shared? | One shared, content-addressed **Nix store**, mounted read-only into every sandbox |
| **The Boundary** | What isolates the agent from your host? | A **container** today, with a microVM as a drop-in upgrade |

The dedup value lives entirely in the Store and is identical whether the boundary is a
plain container or a microVM.

Every ecosystem reduces to three slots, which is why "works for everything" falls out of
the design rather than being a special case:

| Slot | npm / TS | Python | Rust | Go | Ruby |
|---|---|---|---|---|---|
| **Toolchain** (from shared store) | node, pnpm | python, uv | rustc, cargo | go | ruby, bundler |
| **Install deps** (real manager, then cached) | `npm install` | `pip install` / `uv export` | `cargo fetch` | `go mod download` | `bundle install` |
| **Run tests** (sandbox capability) | `vitest` | `pytest` | `cargo test` | `go test` | `rspec` |

The toolchain comes from the shared store. The dependencies are installed by the repo's
own package manager inside the sandbox, and the assembled result is cached and kept warm
by the same garbage collector that tends the store, so repeat runs stay fast without you
ever managing disk.

## License

MIT
