import { readFileSync } from "node:fs";

/**
 * The active nix-portable runtime (ADR 0008). bwrap is the fast user-namespace
 * path; proot is the universal ptrace fallback for hosts with unprivileged user
 * namespaces disabled. dustcastle surfaces whichever is active — never silent.
 */
export type RuntimeMode = "bwrap" | "proot";

/** Pick the runtime mode from host capability. Deterministic and surfaceable. */
export function chooseRuntimeMode(caps: { unprivilegedUserns: boolean }): RuntimeMode {
  return caps.unprivilegedUserns ? "bwrap" : "proot";
}

/**
 * Probe the host for unprivileged user namespaces (what the bwrap path needs).
 * Reads the kernel toggle where present; absence of the toggle on a modern
 * kernel means userns is compiled in and on, so we treat that as available.
 */
export function unprivilegedUsernsAvailable(): boolean {
  for (const knob of [
    "/proc/sys/kernel/unprivileged_userns_clone", // Debian/Arch/CachyOS
    "/proc/sys/user/max_user_namespaces", // generic cap
  ]) {
    try {
      const value = Number.parseInt(readFileSync(knob, "utf8").trim(), 10);
      if (Number.isFinite(value)) return value > 0;
    } catch {
      // knob absent — try the next one
    }
  }
  // No knob present: userns is built in and unrestricted on a current kernel.
  return true;
}
