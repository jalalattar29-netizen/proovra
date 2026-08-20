/**
 * Point-7 proof promotion — a newer proof is not a stronger proof, and an
 * incomplete one is not a proof at all.
 *
 * WHAT WENT WRONG
 *
 * `recordScenarioProof` wrote each suite's record with a blind
 * `suites[key] = {...}`. The runtime mode and CSP flag were RECORDED from
 * `P7_WEB_RUNTIME_MODE` / `P7_STRICT_CSP` but never COMPARED against what was
 * already on disk, and both default to their weak values when unset.
 *
 * `scripts/point7-run.mjs` sets them; `pnpm test:integration` does not — and it
 * runs the same suites. So a routine integration run replaced 18 scenarios
 * proven under `next build` + strict CSP with a dev-server run, and the
 * findings ledger then refused NEW-027/028/029 because `browserVerified: PASS`
 * no longer matched an artifact deriving NOT_EXECUTED.
 *
 * These tests DRIVE the writer against a scratch artifact rather than asserting
 * about its source text. A guard that is only asserted to be PRESENT in a file
 * is a guard nobody has ever watched refuse anything, which is the same
 * category of fictional control this programme keeps finding.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  DIAGNOSTIC_PROOF_DIR,
  PROOF_ARTIFACT,
  PROOF_STRENGTH_AUTHORITATIVE,
  PROOF_STRENGTH_DIAGNOSTIC,
  decidePromotion,
  proofArtifactPathFor,
  proofStrengthOf,
  recordScenarioProof,
  requiredIdsForLayer,
  type ProvenScenarioRecord,
} from "./point7/scenario-manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

/** A real suite, so the writer hashes real bytes. */
const SUITE = "services/api/test/point7/context-safety.integration.test.ts";

const AUTHORITATIVE = { webRuntimeMode: "production-build", strictCsp: true };
const DEV_STRICT = { webRuntimeMode: "development", strictCsp: true };
const PROD_LOOSE = { webRuntimeMode: "production-build", strictCsp: false };
const DIAGNOSTIC = { webRuntimeMode: "development", strictCsp: false };

// ---------------------------------------------------------------------------
// Environment control. Every test states the runtime it is simulating, because
// the WHOLE defect was a run inheriting strength from an unset variable.
// ---------------------------------------------------------------------------

const ENV_KEYS = ["P7_WEB_RUNTIME_MODE", "P7_STRICT_CSP", "POINT7_RUN_ID"] as const;
const SAVED: Record<string, string | undefined> = {};
let scratch = "";

function setRuntime(mode: string | undefined, csp: boolean | undefined): void {
  if (mode === undefined) delete process.env.P7_WEB_RUNTIME_MODE;
  else process.env.P7_WEB_RUNTIME_MODE = mode;
  if (csp === undefined) delete process.env.P7_STRICT_CSP;
  else process.env.P7_STRICT_CSP = csp ? "true" : "false";
}

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  scratch = mkdtempSync(resolve(tmpdir(), "p7-promotion-"));
  process.env.POINT7_RUN_ID = "testrun1";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k] as string;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** SHA-256 of the real suite, so "unchanged suite" is the branch under test. */
function shaOfSuite(): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO, SUITE)))
    .digest("hex");
}

/** Write a scratch artifact holding one seeded record; return its path. */
function seed(over: Partial<ProvenScenarioRecord>): string {
  const path = resolve(scratch, "proof.json");
  const record = {
    sha256: shaOfSuite(),
    layer: "SERVER",
    scenarios: [] as string[],
    runId: "seeded",
    buildId: "seeded",
    binding: "seeded",
    recordedAtUtc: "2020-01-01T00:00:00.000Z",
    webRuntimeMode: "production-build",
    strictCsp: true,
    isolation: {
      deniedHosts: [],
      allowedHosts: [],
      observabilityErrorEvents: 0,
      recordingTransport: true,
    },
    ...over,
  };
  writeFileSync(
    path,
    `${JSON.stringify({ suites: { [SUITE]: record } }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

// ===========================================================================

describe("proof strength is ordered, and only production-build + strict CSP is authoritative", () => {
  it("classifies the authoritative combination and nothing else", () => {
    expect(proofStrengthOf(AUTHORITATIVE)).toBe(PROOF_STRENGTH_AUTHORITATIVE);
    // Each half alone is not enough: a dev server does not exhibit the failure
    // modes a production build does, and a loose CSP proves nothing about the
    // one the product actually ships.
    expect(proofStrengthOf(DEV_STRICT)).toBe(PROOF_STRENGTH_DIAGNOSTIC);
    expect(proofStrengthOf(PROD_LOOSE)).toBe(PROOF_STRENGTH_DIAGNOSTIC);
    expect(proofStrengthOf(DIAGNOSTIC)).toBe(PROOF_STRENGTH_DIAGNOSTIC);
  });

  it("treats an undeclared runtime as diagnostic, never as authoritative", () => {
    // The writer's defaults are the WEAK values, so a run that declares nothing
    // must not be able to inherit strength by omission.
    expect(proofStrengthOf({})).toBe(PROOF_STRENGTH_DIAGNOSTIC);
    expect(proofStrengthOf({ strictCsp: true })).toBe(PROOF_STRENGTH_DIAGNOSTIC);
    expect(proofStrengthOf({ webRuntimeMode: "production-build" })).toBe(
      PROOF_STRENGTH_DIAGNOSTIC,
    );
  });

  it("orders authoritative strictly above diagnostic", () => {
    expect(PROOF_STRENGTH_AUTHORITATIVE).toBeGreaterThan(PROOF_STRENGTH_DIAGNOSTIC);
  });
});

describe("strength decides where a run may write", () => {
  it("sends an authoritative run to the canonical artifact", () => {
    expect(proofArtifactPathFor(PROOF_STRENGTH_AUTHORITATIVE, "abc", REPO)).toBe(
      resolve(REPO, PROOF_ARTIFACT),
    );
  });

  it("sends a diagnostic run to run-scoped evidence, never the canonical file", () => {
    const p = proofArtifactPathFor(PROOF_STRENGTH_DIAGNOSTIC, "abc", REPO);
    expect(p).not.toBe(resolve(REPO, PROOF_ARTIFACT));
    expect(p).toContain(DIAGNOSTIC_PROOF_DIR);
    // Run-scoped, so one diagnostic run cannot overwrite another's evidence.
    expect(p).toContain("abc");
  });
});

describe("an ordinary integration run cannot touch the canonical artifact", () => {
  it("leaves the repository proof byte-identical and writes run-scoped evidence instead", () => {
    const canonical = resolve(REPO, PROOF_ARTIFACT);
    const before = readFileSync(canonical);

    setRuntime(undefined, undefined); // exactly what `pnpm test:integration` has
    process.env.POINT7_RUN_ID = "diagrun9";
    const diagnostic = resolve(
      REPO,
      DIAGNOSTIC_PROOF_DIR,
      "point7-diagnostic-diagrun9.json",
    );
    rmSync(diagnostic, { force: true });

    try {
      const refusal = recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: requiredIdsForLayer("SERVER").slice(0, 3),
        root: REPO,
      });

      // Not refused. A diagnostic run may record; it may not record THERE.
      expect(refusal).toBeNull();
      expect(readFileSync(canonical)).toEqual(before);
      expect(existsSync(diagnostic)).toBe(true);
      const written = JSON.parse(readFileSync(diagnostic, "utf8"));
      expect(written.suites[SUITE].webRuntimeMode).toBe("development");
      expect(written.suites[SUITE].strictCsp).toBe(false);
    } finally {
      rmSync(diagnostic, { force: true });
    }
  });
});

describe("the writer refuses a downgrade", () => {
  it("leaves an authoritative record untouched when a dev run records the same suite", () => {
    const path = seed({ scenarios: [] });
    const before = readFileSync(path);

    setRuntime("development", true); // strict CSP, but a dev server
    const refusal = recordScenarioProof({
      suiteRelPath: SUITE,
      layer: "SERVER",
      scenarios: requiredIdsForLayer("SERVER"),
      root: REPO,
      artifactPath: path,
    });

    expect(refusal).not.toBeNull();
    expect(refusal?.candidateStrength).toBeLessThan(
      refusal?.existingStrength as number,
    );
    expect(refusal?.reason).toContain("scripts/point7-run.mjs");
    // BYTE-IDENTICAL. Not "equivalent", not "re-serialised the same".
    expect(readFileSync(path)).toEqual(before);
  });

  it("does not decide by recency — an OLDER authoritative record survives a NEWER weak one", () => {
    const path = seed({ recordedAtUtc: "2000-01-01T00:00:00.000Z" });
    const before = readFileSync(path);

    setRuntime("development", false);
    expect(
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: requiredIdsForLayer("SERVER"),
        root: REPO,
        artifactPath: path,
      }),
    ).not.toBeNull();
    expect(readFileSync(path)).toEqual(before);
  });
});

describe("an incomplete run is not a promotion, at any strength", () => {
  it("refuses a production run that proved fewer scenarios for an unchanged suite", () => {
    const full = requiredIdsForLayer("SERVER").slice(0, 5);
    const path = seed({ scenarios: full });
    const before = readFileSync(path);

    setRuntime("production-build", true); // fully authoritative…
    const refusal = recordScenarioProof({
      suiteRelPath: SUITE,
      layer: "SERVER",
      scenarios: full.slice(0, 2), // …but three scenarios failed
      root: REPO,
      artifactPath: path,
    });

    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toContain("incomplete run");
    expect(readFileSync(path)).toEqual(before);
  });

  it("promotes an authoritative run that covers everything already recorded", () => {
    const full = requiredIdsForLayer("SERVER").slice(0, 5);
    const path = seed({ scenarios: full.slice(0, 2) });

    setRuntime("production-build", true);
    expect(
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: full,
        root: REPO,
        artifactPath: path,
      }),
    ).toBeNull();

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.suites[SUITE].scenarios).toEqual([...full].sort());
    expect(after.suites[SUITE].runId).toBe("testrun1");
  });

  it("does not pin the artifact to a scenario the manifest has retired", () => {
    // A record naming an id the manifest no longer requires must not refuse
    // every future run: the id is gone, so nothing could ever cover it again.
    const required = requiredIdsForLayer("SERVER").slice(0, 3);
    const path = seed({
      scenarios: [...required, "p7.retired.scenario.that.no.longer.exists"],
    });

    setRuntime("production-build", true);
    expect(
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: required,
        root: REPO,
        artifactPath: path,
      }),
    ).toBeNull();
  });

  it("lets an EDITED suite record fewer scenarios — its old record is already stale", () => {
    const path = seed({
      sha256: "0".repeat(64), // a different body of work
      scenarios: requiredIdsForLayer("SERVER").slice(0, 5),
    });

    setRuntime("production-build", true);
    expect(
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: requiredIdsForLayer("SERVER").slice(0, 1),
        root: REPO,
        artifactPath: path,
      }),
    ).toBeNull();
  });
});

describe("the decision itself is pure and clock-free", () => {
  const base = (over: Partial<ProvenScenarioRecord>): ProvenScenarioRecord =>
    ({
      sha256: "a".repeat(64),
      layer: "SERVER",
      scenarios: ["x"],
      runId: "r",
      buildId: "b",
      binding: "bind",
      recordedAtUtc: "2026-01-01T00:00:00.000Z",
      webRuntimeMode: "production-build",
      strictCsp: true,
      isolation: {
        deniedHosts: [],
        allowedHosts: [],
        observabilityErrorEvents: 0,
        recordingTransport: true,
      },
      ...over,
    }) as ProvenScenarioRecord;

  it("admits a first record for a suite with no history", () => {
    expect(
      decidePromotion({
        suite: SUITE,
        existing: undefined,
        candidate: base({}),
        requiredIds: ["x"],
      }),
    ).toBeNull();
  });

  it("admits an equal-strength, equal-coverage re-run", () => {
    expect(
      decidePromotion({
        suite: SUITE,
        existing: base({}),
        candidate: base({ runId: "later" }),
        requiredIds: ["x"],
      }),
    ).toBeNull();
  });

  it("admits a STRONGER candidate over a weaker record", () => {
    expect(
      decidePromotion({
        suite: SUITE,
        existing: base({ webRuntimeMode: "development", strictCsp: false }),
        candidate: base({}),
        requiredIds: ["x"],
      }),
    ).toBeNull();
  });

  it("refuses a weaker candidate however recent", () => {
    expect(
      decidePromotion({
        suite: SUITE,
        existing: base({ recordedAtUtc: "1999-01-01T00:00:00.000Z" }),
        candidate: base({
          webRuntimeMode: "development",
          strictCsp: false,
          recordedAtUtc: "2099-01-01T00:00:00.000Z",
        }),
        requiredIds: ["x"],
      }),
    ).not.toBeNull();
  });
});

describe("the write cannot truncate the authority", () => {
  it("never leaves a partial file at the destination", () => {
    // The observable property, rather than an assertion that `renameSync`
    // appears in the source: the destination parses, and no temporary file is
    // left beside it.
    const path = resolve(scratch, "fresh.json");
    setRuntime("production-build", true);
    expect(
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: requiredIdsForLayer("SERVER").slice(0, 2),
        root: REPO,
        artifactPath: path,
      }),
    ).toBeNull();
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    expect(existsSync(`${path}.testrun1.tmp`)).toBe(false);
  });

  it("creates the destination directory rather than failing on a fresh checkout", () => {
    const path = resolve(scratch, "nested", "deep", "proof.json");
    setRuntime("production-build", true);
    expect(
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: [],
        root: REPO,
        artifactPath: path,
      }),
    ).toBeNull();
    expect(existsSync(path)).toBe(true);
  });
});

describe("proof may only be recorded by a real run", () => {
  it("refuses to write without a run id", () => {
    delete process.env.POINT7_RUN_ID;
    setRuntime("production-build", true);
    expect(() =>
      recordScenarioProof({
        suiteRelPath: SUITE,
        layer: "SERVER",
        scenarios: [],
        root: REPO,
        artifactPath: resolve(scratch, "x.json"),
      }),
    ).toThrow(/POINT7_RUN_ID/);
  });

  it("refuses to record on behalf of a suite that does not exist", () => {
    setRuntime("production-build", true);
    expect(() =>
      recordScenarioProof({
        suiteRelPath: "services/api/test/point7/not-a-real-suite.ts",
        layer: "SERVER",
        scenarios: [],
        root: REPO,
        artifactPath: resolve(scratch, "x.json"),
      }),
    ).toThrow(/does not exist/);
  });

  it("drops an identifier the manifest does not require", () => {
    const path = resolve(scratch, "strays.json");
    setRuntime("production-build", true);
    recordScenarioProof({
      suiteRelPath: SUITE,
      layer: "SERVER",
      scenarios: ["p7.invented.by.hand"],
      root: REPO,
      artifactPath: path,
    });
    const a = JSON.parse(readFileSync(path, "utf8"));
    expect(a.suites[SUITE].scenarios).toEqual([]);
  });
});

describe("the canonical production workflow is the only promoter", () => {
  it("scripts/point7-run.mjs declares both authoritative inputs", () => {
    const runner = readFileSync(resolve(REPO, "scripts/point7-run.mjs"), "utf8");
    expect(runner).toMatch(/P7_WEB_RUNTIME_MODE: "production-build"/);
    expect(runner).toMatch(/P7_STRICT_CSP: "true"/);
  });

  it("the generic integration project declares neither, so it can only be diagnostic", () => {
    // This is the run that caused the downgrade. It stays able to RUN the
    // suites — it simply can no longer promote their results.
    const cfg = readFileSync(
      resolve(REPO, "services/api/vitest.integration.config.ts"),
      "utf8",
    );
    expect(cfg).not.toMatch(/P7_WEB_RUNTIME_MODE|P7_STRICT_CSP/);
  });
});

describe("a diagnostic run cannot contaminate the canonical outbound ledger", () => {
  /**
   * THE SECOND HALF OF THE SAME DEFECT.
   *
   * Protecting the proof ARTIFACT was not enough. The closure gate also reads
   * `.p7tmp/product-run-network.jsonl` — every destination the run reached for
   * — and refuses a proof whose ledger holds records from another run. That
   * path was a fixed default in the integration project, so an ordinary
   * `pnpm test:integration` appended its own connections to it under a fresh
   * run id and the gate reported:
   *
   *     40 ledger record(s) belong to a different run id
   *
   * An authoritative proof invalidated by a diagnostic run merely existing.
   */
  it("the integration project's ledger defaults are RUN-SCOPED", () => {
    const cfg = readFileSync(
      resolve(REPO, "services/api/vitest.integration.config.ts"),
      "utf8",
    );
    // Both ledgers, both interpolating the run id into the filename.
    expect(cfg).toMatch(
      /P7_NETWORK_LEDGER:[\s\S]{0,200}?product-run-network\.\$\{POINT7_RUN_ID\}\.jsonl/,
    );
    expect(cfg).toMatch(
      /P7_CANARY_LEDGER:[\s\S]{0,200}?canary-network\.\$\{POINT7_RUN_ID\}\.jsonl/,
    );
    // No fixed shared path survives as a default.
    expect(cfg).not.toMatch(/\?\?\s*"\.\.\/\.\.\/\.p7tmp\/product-run-network\.jsonl"/);
    expect(cfg).not.toMatch(/\?\?\s*"\.\.\/\.\.\/\.p7tmp\/canary-network\.jsonl"/);
  });

  it("the canonical runner NAMES both ledgers and clears them before the run", () => {
    const runner = readFileSync(resolve(REPO, "scripts/point7-run.mjs"), "utf8");
    expect(runner).toMatch(/P7_NETWORK_LEDGER: PRODUCT_LEDGER/);
    expect(runner).toMatch(/P7_CANARY_LEDGER: CANARY_LEDGER/);
    // A fresh run inherits no credit: both are removed before it starts, so an
    // older run's entries cannot be read as this one's isolation evidence.
    expect(runner).toMatch(
      /for \(const f of \[PRODUCT_LEDGER, CANARY_LEDGER,[\s\S]{0,120}?rmSync\(f, \{ force: true \}\)/,
    );
  });

  it("the gate reads the canonical paths, which only the runner writes", () => {
    const gate = readFileSync(
      resolve(REPO, "services/api/test/point7/closure-gate.ts"),
      "utf8",
    );
    expect(gate).toMatch(/"\.p7tmp\/product-run-network\.jsonl"/);
    expect(gate).toMatch(/"\.p7tmp\/canary-network\.jsonl"/);
  });
});
