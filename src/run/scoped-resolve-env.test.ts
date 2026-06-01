import { describe, expect, it } from "vitest";
import type { HostResolveExecution } from "../ecosystems/index.js";
import { HOST_RESOLVE_ENV_FLOOR, scopedResolveEnv } from "./pin.js";

// The host-side loose-pin resolve runs deny-by-default (ADR 0005 decision 1 /
// dustcastle-4ky): a trusted, pre-Sandbox metadata resolve that must inherit NO
// ambient host secret. `scopedResolveEnv` is the pure policy — given a manager's
// execution policy and the ambient env, it returns the env the resolve runs under.
// No filesystem/process I/O lives here; the temp-dir lifecycle stays imperative in
// the runner, which supplies the bound directory.

describe("scopedResolveEnv (the pure deny-by-default resolve env — dustcastle-4ky)", () => {
  it("passes the shared floor through from the ambient env", () => {
    const ambient = { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8" };
    const env = scopedResolveEnv(undefined, ambient);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("passes a manager's extraEnv through (cargo's rustup vars)", () => {
    const execution: HostResolveExecution = { extraEnv: ["RUSTUP_HOME", "RUSTUP_TOOLCHAIN"] };
    const ambient = { PATH: "/usr/bin", RUSTUP_HOME: "/rh", RUSTUP_TOOLCHAIN: "stable" };
    const env = scopedResolveEnv(execution, ambient);
    expect(env.RUSTUP_HOME).toBe("/rh");
    expect(env.RUSTUP_TOOLCHAIN).toBe("stable");
  });

  it("strips an ambient host secret not on the floor or in extraEnv", () => {
    const ambient = { PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "leak-me", RUSTUP_HOME: "/rh" };
    const env = scopedResolveEnv({ extraEnv: ["RUSTUP_HOME"] }, ambient);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RUSTUP_HOME).toBe("/rh");
  });

  it("binds isolatedHomeEnv to the supplied directory", () => {
    const execution: HostResolveExecution = { isolatedHomeEnv: "CARGO_HOME" };
    const env = scopedResolveEnv(execution, { PATH: "/usr/bin" }, "/tmp/throwaway-home");
    expect(env.CARGO_HOME).toBe("/tmp/throwaway-home");
  });

  it("yields just the floor when no policy applies", () => {
    const ambient = { PATH: "/usr/bin", HOME: "/home/u", SOME_SECRET: "x" };
    const env = scopedResolveEnv(undefined, ambient);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(Object.keys(env).every((k) => HOST_RESOLVE_ENV_FLOOR.includes(k as never))).toBe(true);
  });
});
