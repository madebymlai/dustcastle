import { describe, expect, it } from "vitest";
import {
  DEFAULT_PYTHON_INTERPRETERS,
  parsePythonVersionFile,
  readRequiresPython,
  resolvePythonInterpreter,
  type AvailableInterpreter,
} from "./python-version.js";

// The Toolchain version resolver (laimk-hse.3) is a standalone PURE module: a
// version-file reader + a (constraints, available interpreters) -> python3XX
// resolver, with NO Store/Nix coupling. The available-interpreter set is DATA
// (a parameter), never hardcoded magic inside the resolver — these tests pass an
// explicit set so the resolution rules are pinned independently of which minors
// the pinned nixpkgs happens to ship.

// A small, explicit available set standing in for "what the pinned nixpkgs ships"
// (ADR 0006b): python3.9 .. python3.13 stable, plus a pre-release python3.14 that
// MUST be excluded from the default candidate set. python3.8 is intentionally
// ABSENT (EOL / dropped from the pin) so the missing-minor error case is real.
const AVAILABLE: readonly AvailableInterpreter[] = [
  { attr: "python39", minor: 9 },
  { attr: "python310", minor: 10 },
  { attr: "python311", minor: 11 },
  { attr: "python312", minor: 12 },
  { attr: "python313", minor: 13 },
  { attr: "python314", minor: 14, prerelease: true },
];

describe("parsePythonVersionFile (.python-version — major.minor, patch dropped)", () => {
  it.each([
    ["3.12", { major: 3, minor: 12 }],
    ["3.12.4", { major: 3, minor: 12 }],
    ["3.11.9\n", { major: 3, minor: 11 }],
    ["  3.10  ", { major: 3, minor: 10 }],
    ["3.13.0rc1", { major: 3, minor: 13 }],
    ["3.12.0a1", { major: 3, minor: 12 }],
  ])("%s -> %o", (raw, expected) => {
    expect(parsePythonVersionFile(raw)).toEqual(expected);
  });

  it.each([undefined, "", "   ", "system", "pypy3.10", "nonsense"])("%o -> undefined", (raw) => {
    expect(parsePythonVersionFile(raw)).toBeUndefined();
  });
});

describe("readRequiresPython (pyproject requires-python — PEP 440, poetry ^/~ normalised)", () => {
  it("reads PEP 621 [project] requires-python", () => {
    expect(readRequiresPython('[project]\nrequires-python = ">=3.10"\n')).toBe(">=3.10");
  });

  it("reads poetry [tool.poetry.dependencies] python and normalises ^", () => {
    // poetry caret ^3.10 == >=3.10,<4 (next major) under PEP 440.
    expect(readRequiresPython('[tool.poetry.dependencies]\npython = "^3.10"\n')).toBe(">=3.10,<4");
  });

  it("normalises poetry tilde ~3.11 to >=3.11,<3.12 (next minor)", () => {
    expect(readRequiresPython('[tool.poetry.dependencies]\npython = "~3.11"\n')).toBe(">=3.11,<3.12");
  });

  it("prefers PEP 621 over poetry when both are present", () => {
    const text = '[project]\nrequires-python = ">=3.12"\n[tool.poetry.dependencies]\npython = "^3.9"\n';
    expect(readRequiresPython(text)).toBe(">=3.12");
  });

  it("returns undefined when neither is present", () => {
    expect(readRequiresPython("[build-system]\nrequires = []\n")).toBeUndefined();
    expect(readRequiresPython(undefined)).toBeUndefined();
  });
});

describe("resolvePythonInterpreter — table of (.python-version, requires-python) -> python3XX", () => {
  // The core acceptance table (laimk-hse.3): an exact .python-version minor wins
  // when it satisfies; a requires-python RANGE resolves to the HIGHEST satisfying
  // stable minor; no constraint -> the default python3; pre-release interpreters
  // are excluded from the default candidate set.
  it.each([
    // .python-version | requires-python | expected attr
    [".python-version exact, no requires", "3.11", undefined, "python311"],
    [".python-version exact with patch", "3.10.7", undefined, "python310"],
    ["requires range picks highest stable", undefined, ">=3.10", "python313"],
    ["requires upper bound caps the minor", undefined, ">=3.10,<3.12", "python311"],
    ["requires exact-ish ==3.11.*", undefined, "==3.11.*", "python311"],
    ["poetry caret excludes the prerelease 3.14", undefined, ">=3.10,<4", "python313"],
    ["pin wins over range when it satisfies", "3.11", ">=3.10", "python311"],
    ["range with only floor still excludes prerelease", undefined, ">=3.9", "python313"],
    ["no constraint at all -> default python3", undefined, undefined, "python3"],
  ])("%s", (_label, pythonVersion, requiresPython, expected) => {
    const attr = resolvePythonInterpreter({
      pythonVersion: parsePythonVersionFile(pythonVersion),
      requiresPython: requiresPython,
      available: AVAILABLE,
    });
    expect(attr).toBe(expected);
  });

  describe("EOL / missing minor -> actionable error (never a silent fallback)", () => {
    it("an exact .python-version pin for a minor absent from the pin errors", () => {
      // python3.8 is EOL / dropped from the pinned nixpkgs — an exact pin for it
      // must surface an actionable error, not silently fall back to python3.
      expect(() =>
        resolvePythonInterpreter({
          pythonVersion: { major: 3, minor: 8 },
          requiresPython: undefined,
          available: AVAILABLE,
        }),
      ).toThrow(/3\.8/);
    });

    it("the .python-version error names the version and the available minors", () => {
      try {
        resolvePythonInterpreter({
          pythonVersion: { major: 3, minor: 8 },
          requiresPython: undefined,
          available: AVAILABLE,
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/3\.8/);
        expect(msg).toMatch(/3\.9|available/i);
      }
    });

    it("a requires-python range satisfiable by NO available stable minor errors", () => {
      // <3.9 excludes every stable minor we ship (floor 3.9) — actionable error.
      expect(() =>
        resolvePythonInterpreter({
          pythonVersion: undefined,
          requiresPython: "<3.9",
          available: AVAILABLE,
        }),
      ).toThrow(/<3\.9|no .*interpreter|satisf/i);
    });

    it("a python-2 pin errors rather than silently provisioning python3", () => {
      expect(() =>
        resolvePythonInterpreter({
          pythonVersion: { major: 2, minor: 7 },
          requiresPython: undefined,
          available: AVAILABLE,
        }),
      ).toThrow(/2\.7/);
    });

    it("an exact pin that conflicts with requires-python errors (no silent pick)", () => {
      // .python-version says 3.13 but requires-python forbids it — surface the
      // conflict rather than silently honouring one over the other.
      expect(() =>
        resolvePythonInterpreter({
          pythonVersion: { major: 3, minor: 13 },
          requiresPython: "<3.12",
          available: AVAILABLE,
        }),
      ).toThrow(/3\.13|conflict|requires-python/i);
    });
  });

  describe("the default candidate set excludes pre-release interpreters", () => {
    it("never resolves the prerelease minor by default even though it is the highest", () => {
      // 3.14 is the numerically highest available minor but pre-release; the
      // default candidate set must skip it.
      const attr = resolvePythonInterpreter({
        pythonVersion: undefined,
        requiresPython: undefined,
        available: AVAILABLE,
      });
      expect(attr).toBe("python3");
    });

    it("an EXACT .python-version pin may still select a pre-release minor (explicit opt-in)", () => {
      // Excluding pre-releases from the DEFAULT candidate set does not forbid an
      // explicit exact pin onto one — the user asked for it by name.
      const attr = resolvePythonInterpreter({
        pythonVersion: { major: 3, minor: 14 },
        requiresPython: undefined,
        available: AVAILABLE,
      });
      expect(attr).toBe("python314");
    });
  });

  it("ships a non-empty DEFAULT_PYTHON_INTERPRETERS set discovered from the pinned nixpkgs", () => {
    // The available set the descriptor wires in is real DATA, not resolver magic.
    expect(DEFAULT_PYTHON_INTERPRETERS.length).toBeGreaterThan(0);
    // Every entry names a python3XX nixpkgs attr with a matching minor.
    for (const i of DEFAULT_PYTHON_INTERPRETERS) {
      expect(i.attr).toMatch(/^python3\d+$/);
      expect(i.minor).toBeGreaterThan(0);
    }
    // The spike's pinned interpreter (python312) is in the set.
    expect(DEFAULT_PYTHON_INTERPRETERS.some((i) => i.attr === "python312")).toBe(true);
  });
});
