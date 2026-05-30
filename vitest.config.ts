import { defineConfig } from "vitest/config";

// Two projects:
//   - unit: fast, pure, no Nix/podman. The bulk of the suite. Runs in CI and on save.
//   - e2e:  the slice red→green gate. Real nix-portable build + real podman container.
//           Slow (first run builds the store) and gated behind DUSTCASTLE_E2E=1 so a
//           bare `vitest` stays fast; the e2e spec self-skips when the flag is unset.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          environment: "node",
          // The store build can take minutes the first time (ADR 0003's
          // "first-run provisioning" clock); subsequent runs hit the warm store.
          testTimeout: 15 * 60 * 1000,
          hookTimeout: 15 * 60 * 1000,
        },
      },
    ],
  },
});
