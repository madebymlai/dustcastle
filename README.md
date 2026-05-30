# dustcastle

<div align="center">
<pre>
                               ░▒▒▄▒▒▄▒▒░                               
                               ░▒▒▒▒▒▒▒▒░                               
                               ▀▓▀▓▀▀▓▀▓▀                               
                        ▄▄▄▄▄▄▄▄▒░▒▄▄░▒▒▄▄▄▄▄▄▄▄                        
                        ▒▒▀▒▒▒▒▓▒▒░▀▀░▒▒▒▒▒▒▒▀▒▓                        
        ▄▄▓▒▒▓▒▒█▄▄▄    ▒▓▓▓▓▓█▓▒░▒░▒░▒▓▒▓▓▓▓▓▓▓    ▄▄▄▓▒▒▓▀▓▓▄▄        
       ░▀▓▒▀▒▀▒▒████▒   ▒▒▒▄▒░▓▄▒▒▒▒▒▒▒▒▄▓░▒▄░▒▒   ▒▓▒▀▒▒▒▀▒▀▒██░       
       ░▄▄▄▄▄▄▄▄████▒   ▒▒▒▓▒░▓▓░▒▒░▒░░▒▒▒░▒▓▒▒▒   ▒▒▒▄▄▄▄▄▄▄▄██░       
        ▀▀▀▀▒▒▀▓███▀░▄▄▄▒▒▒░▒▒█▓▒▒▒▒▒▒▒▒▒▓▒▒░░▒▒▄▄▄░▀▀▀▀▓▀▒▒▀██▀        
        ░▒▒▒▓█░▒███▓░▓▓▓▓▒▒░▓░▀▀▒▒▀▒▒▀▒▒▀▀▒▓░▒▒▓▓▓▓░▒░▒▒▒░█▓▒██▒        
        ▒▒▒▒▓▀░▒███▓░▓▓▓▓░▒░▓▄▄▓▄▄▄▄▄▄▄▄▄▄▄▓░▒▒▓▓▓▓░▒░▒▒▒░▀▓▒██▒        
        ▒▒▒▒░░░▓███▓░▓▓▓▓▄▒▒▒▓▀▒▒▒▀▒▒▀▒▒▒▀█▄▒▒▄▓▓▓▓░▒▄▒▒▓▒░░░██▒        
        ▒▒▓▒▒▒░▒██▒▓▓▒▒▓▒▒▓▓▒▓░▒▒▒▒▒▒▒▒▒▀▒▓▒▓▓▒▓▓▒▒▓▓▒▓▒▒░▒▒░██▒        
        ▒▒▓▒▒▒░▒██▒░░▒░░░▒░░▒▓▒▒▒▓▄██▄▓▒▒▒▓▒░░▒▒░▒▒░░▒▓▒▒░▒▒▒██▓        
        ▒▒▒▒▒▒░▒██▒▒▒▒▒▒▒▒▒▒▒▓░▒▓██████▓▒░▓▒▒▒▒▒▒▒▒▒░▒▓▒▒░▒▒░▓█▓        
        ▓▄▓▒▄▄▄▓██▒░▒▒▒▒▒▒▒▒▒▓░▒▓█▓█▓▓█▓▒▒▓▒▒▒▒▒▒▒▒▒░▒▓▄▓▄▄▄▄██▓        
       ░▒▒▒▒▒▒▒▒██▓░▒░▒▒▒▒▒░▒▒░▒▓██████▓▒░▓▒░░░▒▒▒░▒░▓▒▓▒▒▒▒▒▒██░       
     ▄▄▒▒▒▒▒▒▒▒▒▀▀▀▀▒▒▒▒▒▒▒▒▒▓▒▓▓▀▀▀▀▓▀▓▓▒▓▒▒▒▒▒▒▒▒▒▀▀▀▓▒▒▒▒▒▒▀▀▒▄▄     
</pre>

<strong>One toolchain store for every AI-agent sandbox. Install once, share everywhere, any language.</strong>

</div>

---

AI coding agents run best in isolated sandboxes, but today every project ships its
own `Dockerfile`, and every project rebuilds the same runtime, `git`, `gh`, and agent
CLI from scratch. **N projects means N image builds and N copies of the same 90%
boilerplate.**

dustcastle kills the per-project build. It manages **one shared, content-addressed
[Nix](https://nixos.org) store** on your machine and mounts it into every sandbox.
The toolchain is described once, deduplicated across all projects, reproducible, and
works for **any ecosystem** (npm, Python, Rust, Go, Ruby) with zero per-project setup.

```
HOST
  /nix/store   <- ONE store. Deduplicated, content-addressed, immutable.
      |  (mounted read-only)
      |--> sandbox A   (Node project)
      |--> sandbox B   (Python project)  <- same store, no copy
      `--> sandbox C   (Rust project)
```

## Why dustcastle

- 🏰 **Install once, share everywhere.** The store grows with *unique
  package-versions*, not *projects times deps*. No more N identical image builds.
- 🌍 **Any ecosystem, no config.** The language, package manager, and deps are
  detected from your lockfile. There is no `dustcastle.toml`.
- 🔁 **Reproducible by default.** Project deps are Nix-built from the lockfile with
  **no network access**, so an untrusted `postinstall` can't exfiltrate anything.
  When a package genuinely can't build hermetically, the impurity is policy-gated and
  **never silent**.
- 🔒 **Secure by construction.** Sandboxes inherit **no** host credentials and egress
  is scoped to an allowlist derived from your project. The agent can't leak your secrets.
- ⚡ **Zero per-project setup.** `dustcastle run` detects, provisions, and launches.
  Detection, store GC, and session reuse are automatic and invisible.

## Status

Early and not yet on npm. The project is at `v0.1.0`, so for now you build it from
source (see below). Linux first; macOS and Windows run via a Linux container.
Requires a container runtime (Docker or Podman) and Node `>=22`.

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

That's the whole surface: **one zero-argument command, nothing to pass.** dustcastle:

1. **Detects** the ecosystem from your lockfile (`package-lock.json`, `uv.lock`,
   `Cargo.lock`, `go.sum`, `Gemfile.lock`, and so on).
2. **Provisions** the toolchain from the shared store (downloaded once, then cached
   forever) and Nix-builds your project's deps into it.
3. **Launches** your coding agent inside the sandbox, wired to the shared store.

First run downloads the base closure (a few minutes, one time). Every run after that,
and every other project on your machine, reuses it instantly.

## How it works

dustcastle is the **global store manager plus UX**. It uses
[sandcastle](https://github.com/mattpocock/sandcastle) as a library to stand up the
sandbox, and slots the shared Nix store in where per-project image provisioning used
to be. Two ideas do all the work:

| Axis | Question | Answer |
|---|---|---|
| **The Store** | How is the toolchain described, stored, shared? | A shared, content-addressed **Nix store** |
| **The Boundary** | What isolates the agent from your host? | A **container** (microVM is a swappable upgrade) |

These are independent: the "install once, dedup everywhere" value lives entirely in
the Store and works the same inside a plain container or a microVM.

Every ecosystem reduces to three slots, which is why "works for everything" falls out
of the design rather than being a special case:

| Slot | npm/TS | Python | Rust | Go | Ruby |
|---|---|---|---|---|---|
| **Toolchain** (to shared store) | node, pnpm | python, uv | rustc, cargo | go | ruby, bundler |
| **Install deps** (Nix-built into store) | `pnpm i` | `uv sync` | `cargo fetch` | `go mod download` | `bundle install` |
| **Run tests** (sandbox capability) | `vitest` | `pytest` | `cargo test` | `go test` | `rspec` |

## Documentation

For the project's vocabulary (Store, Boundary, Toolchain, Ecosystem, and more), see
**[`CONTEXT.md`](CONTEXT.md)**.

## License

MIT
