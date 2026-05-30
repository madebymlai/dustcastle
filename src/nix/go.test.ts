import { describe, expect, it } from "vitest";
import { generateGoBuild } from "./go.js";

// The nix/ module is the importer (ADR 0004): it emits the Nix expression that
// builds a project's Toolchain + Project Deps into the Store, hermetically. For
// Go that's buildGoModule (the proven spike path). These tests pin the contract
// the store/ module relies on — the parameters that get embedded and the names
// of the attributes it will realize (`nix-build -A <attr>`).

describe("generateGoBuild (ADR 0004 Go importer)", () => {
  it("names the toolchain, deps, and app attributes the store realizes", () => {
    const build = generateGoBuild({
      pname: "sample",
      vendorHash: "sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=",
    });

    // The attribute names are the contract between the importer and the store.
    expect(build.attrs).toEqual({ toolchain: "go", deps: "deps", app: "app" });
  });

  it("builds Go deps with buildGoModule, hash-pinned by vendorHash (ADR 0004)", () => {
    const vendorHash = "sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=";
    const build = generateGoBuild({ pname: "sample", vendorHash });

    expect(build.expression).toContain("buildGoModule");
    expect(build.expression).toContain('pname = "sample"');
    // The lockfile is genuinely enforced: the vendor FOD is pinned by this hash.
    expect(build.expression).toContain(`vendorHash = "${vendorHash}"`);
  });
});
