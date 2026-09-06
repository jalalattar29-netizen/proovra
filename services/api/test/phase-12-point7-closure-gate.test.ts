/**
 * PHASE 12 — POINT 7: the independently-derived closure gate.
 *
 * Two halves, and the second is the one that matters.
 *
 * The POSITIVE half reconciles the manifest, the catalog, the suites on disk
 * and the proof artifact, and reports the closure metrics.
 *
 * The NEGATIVE half proves the gate is CAPABLE of failing. A gate that has
 * only ever been observed passing is indistinguishable from `expect(true)`.
 * Each of the ten cases the mandate names is executed here by perturbing a
 * COPY of the real inputs and asserting the evaluator refuses — deleting a
 * scenario proof, reusing an older run's artifact, editing a suite after it
 * ran, adding a fictional plan, skipping a required scenario, removing a
 * cross-tenant scenario, crediting server-only proof as browser proof,
 * crediting DOM-only proof, mixing build ids, and finally restoring the
 * complete run.
 *
 * The evaluator itself lives in `test/point7/closure-gate.ts` precisely so it
 * can be called with corrupted inputs; a gate implemented inline in its own
 * `it()` cannot be shown to fail without breaking the repository.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canPlanPurchasePersonalWorkspacePlan,
  PLAN_CAPABILITIES,
} from "@proovra/shared-billing";

import { evaluatePoint7Closure } from "./point7/closure-gate.js";
import { CANONICAL_PLANS } from "./point7/plan-contract.js";
import {
  PROOF_ARTIFACT,
  SCENARIOS,
  discoverScenarioSuites,
  point7BuildId,
  proofBindingHash,
  repoRoot,
  requiredIdsForLayer,
  type ProvenScenariosArtifact,
} from "./point7/scenario-manifest.js";

const ROOT = repoRoot();

function loadArtifact(): ProvenScenariosArtifact | null {
  const path = resolve(ROOT, PROOF_ARTIFACT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ProvenScenariosArtifact;
}

/**
 * A synthetic COMPLETE artifact: every required scenario, at every required
 * layer, with correct hashes, one run id and the current build.
 *
 * Built rather than assumed so the negative cases have a known-good baseline
 * to perturb even when the working tree has not just executed a full run. The
 * POSITIVE case below still measures the REAL artifact — this baseline exists
 * to prove the gate's failure modes, not to grant closure.
 */
function syntheticCompleteArtifact(runId = "synthetic-run"): ProvenScenariosArtifact {
  const suites: ProvenScenariosArtifact["suites"] = {};
  const binding = proofBindingHash();
  const buildId = point7BuildId(ROOT);
  for (const layer of ["SERVER", "BROWSER"] as const) {
    const files = discoverScenarioSuites(layer, ROOT);
    expect(files.length, `${layer} suites must exist on disk`).toBeGreaterThan(0);
    const ids = requiredIdsForLayer(layer);
    files.forEach((file, index) => {
      // All ids go on the FIRST suite of each layer; the others carry none.
      // The gate unions across suites, so this is a legitimate distribution.
      suites[file] = {
        sha256: createHash("sha256")
          .update(readFileSync(resolve(ROOT, file)))
          .digest("hex"),
        layer,
        scenarios: index === 0 ? ids : [],
        runId,
        buildId,
        binding,
        recordedAtUtc: "2026-08-05T00:00:00.000Z",
        isolation: {
          deniedHosts: [],
          allowedHosts: ["127.0.0.1"],
          observabilityErrorEvents: 0,
          recordingTransport: true,
        },
        // PHASE 12 — POINT 7 (final pass): the baseline is a PRODUCTION-BUILD
        // run under strict CSP, because that is the only kind that can be
        // credited. The two cases below prove the gate rejects anything else.
        webRuntimeMode: "production-build" as const,
        strictCsp: true,
      };
    });
  }
  return { $comment: "synthetic — negative-case baseline", suites };
}

// ===========================================================================
// Synthetic outbound ledgers
// ===========================================================================

/**
 * PHASE 12 — POINT 7 (final pass).
 *
 * The gate now reads the product-run outbound ledger from disk, so the
 * negative battery has to be able to hand it a ledger. These are written under
 * the run's temp directory and pointed at explicitly, so a case never depends
 * on — or disturbs — the real one.
 */
type SyntheticLedgerEntry = {
  runId?: string;
  phase?: string;
  host: string;
  category?: string;
  outcome: "ALLOWED" | "BLOCKED";
};

let ledgerSeq = 0;

function writeLedger(name: string, entries: SyntheticLedgerEntry[]): string {
  const rel = `.p7tmp/gate-fixtures/${name}-${(ledgerSeq += 1)}.jsonl`;
  const abs = resolve(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    entries
      .map((e) =>
        JSON.stringify({
          runId: e.runId ?? "synthetic-run",
          buildId: point7BuildId(ROOT),
          phase: e.phase ?? "product",
          process: "api-server",
          scenarioId: "",
          category: e.category ?? "unknown-external",
          transportAuthority: "fetch",
          boundedCallSite: "synthetic.mjs",
          atUtc: "2026-08-05T00:00:00.000Z",
          ...e,
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
  return rel;
}

/** A ledger that says the run only ever reached its disposable stack. */
function cleanProductLedger(): string {
  return writeLedger("clean-product", [
    { host: "127.0.0.1", category: "loopback-disposable", outcome: "ALLOWED" },
    { host: "127.0.0.1", category: "loopback-disposable", outcome: "ALLOWED" },
  ]);
}

/** The canary's own ledger: one deliberate, blocked, forbidden destination. */
function canaryLedger(): string {
  return writeLedger("canary", [
    { host: "o123.ingest.de.sentry.io", category: "sentry", outcome: "BLOCKED", phase: "canary" },
  ]);
}

describe("PHASE 12 POINT 7 — closure gate", () => {
  // =========================================================================
  // Structure — discovered, not declared
  // =========================================================================

  it("every canonical plan has scenarios, and the manifest invents none", () => {
    const verdict = evaluatePoint7Closure({
      root: ROOT,
      artifact: syntheticCompleteArtifact(),
    });
    expect(verdict.metrics.canonicalPlans).toBe(CANONICAL_PLANS.length);
    expect(verdict.metrics.plansInScenarioManifest).toBe(CANONICAL_PLANS.length);
    expect(verdict.metrics.plansExecutedInCurrentRun).toBe(CANONICAL_PLANS.length);
  });

  it("every scenario suite on disk is registered and vice versa", () => {
    const server = discoverScenarioSuites("SERVER", ROOT);
    const browser = discoverScenarioSuites("BROWSER", ROOT);
    expect(server.length).toBeGreaterThan(0);
    expect(browser.length).toBeGreaterThan(0);
    for (const file of [...server, ...browser]) {
      expect(existsSync(resolve(ROOT, file)), `${file} must exist`).toBe(true);
    }
  });

  it("the cross-tenant and context-safety scenarios are present in the manifest", () => {
    const ids = new Set(SCENARIOS.map((s) => s.id));
    for (const required of [
      "p7.xtenant.foreign_ids_concealed_without_side_effects",
      "p7.ctx.restore.foreign_tenant_stored_id",
      "p7.ctx.switch.stale_response_not_committed",
      "p7.invite.cross_tenant_id_denied",
      "p7.overlimit.concurrent_edge_cannot_both_pass",
    ]) {
      expect(ids.has(required), `${required} missing from the manifest`).toBe(true);
    }
  });

  // =========================================================================
  // The ten negative cases
  // =========================================================================

  describe("negative cases — the gate must be capable of failing", () => {
    const failsWith = (
      artifact: ProvenScenariosArtifact,
      fragment: string,
    ): void => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact,
        productLedger: cleanProductLedger(),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok, "the gate accepted a corrupted proof").toBe(false);
      expect(
        verdict.failures.some((f) => f.includes(fragment)),
        `expected a failure mentioning "${fragment}", got: ${verdict.failures.join(" | ")}`,
      ).toBe(true);
    };

    it("1. deleting one FREE scenario proof → fails", () => {
      const a = syntheticCompleteArtifact();
      for (const record of Object.values(a.suites)) {
        record.scenarios = record.scenarios.filter(
          (id) => id !== "p7.free.cases.not_included",
        );
      }
      failsWith(a, "p7.free.cases.not_included");
    });

    it("2. reusing an artifact from an older run → fails", () => {
      const a = syntheticCompleteArtifact();
      // Two runs' records stitched together is not one run.
      const keys = Object.keys(a.suites);
      a.suites[keys[0]].runId = "an-older-run";
      failsWith(a, "stitched from");
    });

    it("3. modifying a browser suite after execution → fails", () => {
      const a = syntheticCompleteArtifact();
      const browserSuite = discoverScenarioSuites("BROWSER", ROOT)[0];
      a.suites[browserSuite].sha256 = "0".repeat(64);
      const verdict = evaluatePoint7Closure({ root: ROOT, artifact: a });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.browserSuitesHashValid).toBe(false);
      expect(verdict.metrics.staleArtifacts).toBeGreaterThan(0);
    });

    it("4. adding a fictional plan → fails", () => {
      // Simulated at the reconciliation boundary the gate actually enforces:
      // a scenario naming a plan the CATALOG does not have cannot be credited,
      // and a catalog plan with no scenario cannot be closed. Both directions
      // are checked; here we prove the second, which is the one an author
      // trying to add a plan would hit.
      const a = syntheticCompleteArtifact();
      // Drop every scenario the MANIFEST attributes to ENTERPRISE. Filtering by
      // id prefix was wrong once the corrective pass added ENTERPRISE
      // scenarios under `p7.obs.*` and `p7.sem.*`: the prefix stopped being a
      // proxy for the plan, so the plan stayed fully executed and the negative
      // case silently stopped negating anything.
      const enterpriseIds = new Set(
        SCENARIOS.filter((s) => s.plan === "ENTERPRISE").map((s) => s.id),
      );
      for (const record of Object.values(a.suites)) {
        record.scenarios = record.scenarios.filter((id) => !enterpriseIds.has(id));
      }
      const verdict = evaluatePoint7Closure({ root: ROOT, artifact: a });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.plansExecutedInCurrentRun).toBeLessThan(
        CANONICAL_PLANS.length,
      );
      expect(
        verdict.failures.some((f) => f.includes("ENTERPRISE was not behaviourally executed")),
      ).toBe(true);
    });

    it("5. marking a required scenario skipped → fails", () => {
      // A skipped scenario records nothing, which is exactly a missing id.
      const a = syntheticCompleteArtifact();
      const target = "p7.team.direct_api.ui_locked_action_denied";
      for (const record of Object.values(a.suites)) {
        record.scenarios = record.scenarios.filter((id) => id !== target);
      }
      failsWith(a, target);
    });

    it("6. removing one cross-tenant scenario → fails", () => {
      const a = syntheticCompleteArtifact();
      const target = "p7.xtenant.foreign_ids_concealed_without_side_effects";
      for (const record of Object.values(a.suites)) {
        record.scenarios = record.scenarios.filter((id) => id !== target);
      }
      failsWith(a, target);
    });

    it("7. crediting server-only proof as browser proof → fails", () => {
      const a = syntheticCompleteArtifact();
      // Strip the BROWSER records entirely, leaving a complete SERVER set.
      // The server half being complete must not close a scenario that owes
      // both — the exact substitution the layer model exists to refuse.
      for (const [file, record] of Object.entries(a.suites)) {
        if (record.layer === "BROWSER") delete a.suites[file];
      }
      const verdict = evaluatePoint7Closure({ root: ROOT, artifact: a });
      expect(verdict.ok).toBe(false);
      expect(
        verdict.missing.every((m) => m.layer === "BROWSER"),
        "only BROWSER proof should be missing",
      ).toBe(true);
      expect(verdict.missing.length).toBeGreaterThan(0);
    });

    it("8. crediting DOM-only proof without API/database evidence → fails", () => {
      // Structurally: a BROWSER record whose suite no longer matches the bytes
      // that were executed. A spec edited down to DOM assertions is a changed
      // suite, and a changed suite loses its credit until it is re-run —
      // which is the only mechanism that can distinguish the two, because the
      // artifact records ids rather than assertion bodies.
      const a = syntheticCompleteArtifact();
      const browserSuite = discoverScenarioSuites("BROWSER", ROOT)[0];
      a.suites[browserSuite].sha256 = createHash("sha256")
        .update("a spec rewritten to assert only on the DOM")
        .digest("hex");
      failsWith(a, "changed since it was proven");
    });

    it("9. mixing multiple build ids → fails", () => {
      const a = syntheticCompleteArtifact();
      const keys = Object.keys(a.suites);
      a.suites[keys[0]].buildId = "f".repeat(64);
      const verdict = evaluatePoint7Closure({ root: ROOT, artifact: a });
      expect(verdict.ok).toBe(false);
      expect(
        verdict.failures.some((f) =>
          f.includes("different build of the production authority"),
        ),
      ).toBe(true);
    });

    it("10. a complete fresh run → passes", () => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: cleanProductLedger(),
        canaryLedger: canaryLedger(),
      });
      expect(
        verdict.ok,
        `a complete run must close; failures: ${verdict.failures.join(" | ")}`,
      ).toBe(true);
      expect(verdict.metrics.skippedRequiredScenarios).toBe(0);
      expect(verdict.metrics.unknownScenarios).toBe(0);
      expect(verdict.metrics.staleArtifacts).toBe(0);
      expect(verdict.metrics.oneRunId).toBe(true);
      expect(verdict.metrics.oneBuildId).toBe(true);
    });

    it("an artifact claiming a scenario the manifest does not require → fails", () => {
      const a = syntheticCompleteArtifact();
      const first = Object.keys(a.suites)[0];
      a.suites[first].scenarios = [
        ...a.suites[first].scenarios,
        "p7.free.this.scenario.does.not.exist",
      ];
      failsWith(a, "unknown scenario");
    });

    // =======================================================================
    // PHASE 12 — POINT 7 (final pass): the external-attempt battery.
    //
    // The corrected run's artifact was accepted while its product ledger held
    // 18 refused attempts at `api.resend.com`, 12 at `fonts.googleapis.com`
    // and 1 at `registry.npmjs.org`. Nothing had CONNECTED, so the gate's
    // allowed-host check was satisfied — and the sentence written from it,
    // "no production destination was attempted", was false. These eleven cases
    // are what makes the distinction load-bearing.
    // =======================================================================

    const ledgerFailsWith = (
      entries: SyntheticLedgerEntry[],
      fragment: string,
      opts?: { canary?: string },
    ): void => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: writeLedger("case", entries),
        canaryLedger: opts?.canary ?? canaryLedger(),
      });
      expect(
        verdict.ok,
        "the gate accepted a product run that reached outside",
      ).toBe(false);
      expect(
        verdict.failures.some((f) => f.includes(fragment)),
        `expected a failure mentioning "${fragment}", got: ${verdict.failures.join(" | ")}`,
      ).toBe(true);
    };

    it("X1. a BLOCKED Resend attempt in the product ledger → fails", () => {
      ledgerFailsWith(
        [
          { host: "127.0.0.1", category: "loopback-disposable", outcome: "ALLOWED" },
          { host: "api.resend.com", category: "email", outcome: "BLOCKED" },
        ],
        "api.resend.com",
      );
    });

    it("X2. a BLOCKED Google Fonts attempt → fails", () => {
      ledgerFailsWith(
        [{ host: "fonts.googleapis.com", outcome: "BLOCKED" }],
        "fonts.googleapis.com",
      );
    });

    it("X3. a BLOCKED npm registry attempt → fails", () => {
      ledgerFailsWith(
        [{ host: "registry.npmjs.org", outcome: "BLOCKED" }],
        "registry.npmjs.org",
      );
    });

    it("X4. a CONNECTED external destination → fails, and is not called an attempt", () => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: writeLedger("connected", [
          { host: "api.proovra.com", category: "proovra-production", outcome: "ALLOWED" },
        ]),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.outbound.unexpectedExternalConnections).toBe(1);
      expect(verdict.metrics.outbound.unexpectedExternalAttempts).toBe(0);
      expect(verdict.metrics.outbound.productionDestinationConnections).toBe(1);
      expect(verdict.failures.some((f) => f.includes("CONNECTED"))).toBe(true);
    });

    it("X5. a production destination is counted as production, not merely external", () => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: writeLedger("prod-attempt", [
          { host: "o123.ingest.de.sentry.io", category: "sentry", outcome: "BLOCKED" },
        ]),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.outbound.productionDestinationAttempts).toBe(1);
      expect(verdict.failures.some((f) => f.includes("PRODUCTION"))).toBe(true);
    });

    it("X6. a MISSING product ledger → fails", () => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: ".p7tmp/gate-fixtures/there-is-no-such-ledger.jsonl",
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.outbound.productLedgerPresent).toBe(false);
      expect(verdict.failures.some((f) => f.includes("no product-run outbound ledger"))).toBe(
        true,
      );
    });

    it("X7. a canary attempt written into the PRODUCT ledger → fails", () => {
      // The canary must be able neither to excuse a product run nor to accuse
      // one. Its deliberate forbidden attempt belongs in its own artifact.
      ledgerFailsWith(
        [
          {
            host: "o123.ingest.de.sentry.io",
            category: "sentry",
            outcome: "BLOCKED",
            phase: "canary",
          },
        ],
        "written into the PRODUCT ledger",
      );
    });

    it("X8. ledger records from a different run → fails", () => {
      ledgerFailsWith(
        [
          {
            host: "127.0.0.1",
            category: "loopback-disposable",
            outcome: "ALLOWED",
            runId: "some-older-run",
          },
        ],
        "different run id",
      );
    });

    it("X9. the CANARY's own deliberate attempt does not contaminate a clean run", () => {
      // The positive counterpart of X7: the canary ledger holds a forbidden
      // destination, the product ledger does not, and closure is unaffected.
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: cleanProductLedger(),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok, verdict.failures.join(" | ")).toBe(true);
      expect(verdict.metrics.outbound.canaryAttempts).toBe(1);
      expect(verdict.metrics.outbound.unexpectedExternalAttempts).toBe(0);
      expect(verdict.metrics.outbound.canaryRecordsInProductLedger).toBe(0);
    });

    it("X10. loopback traffic is allowed and is not counted as external", () => {
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: syntheticCompleteArtifact(),
        productLedger: writeLedger("loopback", [
          { host: "127.0.0.1", category: "loopback-disposable", outcome: "ALLOWED" },
          { host: "localhost", category: "loopback-disposable", outcome: "ALLOWED" },
          { host: "::1", category: "loopback-disposable", outcome: "ALLOWED" },
        ]),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok, verdict.failures.join(" | ")).toBe(true);
      expect(verdict.metrics.outbound.productLocalAllowed).toBe(3);
      expect(verdict.metrics.outbound.unexpectedExternalAttempts).toBe(0);
    });

    it("X12. a browser proof recorded in DEVELOPMENT mode → fails", () => {
      // The strict-CSP hydration failure existed ONLY on a production build.
      // `next dev` renders every route per request, so it never met the
      // static-HTML / per-request-nonce mismatch that left the whole
      // application unhydrated — a dev-mode browser proof was, for that entire
      // class of defect, evidence of nothing.
      const a = syntheticCompleteArtifact();
      for (const [, record] of Object.entries(a.suites)) {
        if (record.layer === "BROWSER") record.webRuntimeMode = "development";
      }
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: a,
        productLedger: cleanProductLedger(),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.productionBuildBrowserProof).toBe(false);
      expect(
        verdict.failures.some((f) => f.includes("next build + next start")),
      ).toBe(true);
    });

    it("X13. a browser proof that does not DECLARE its runtime mode → fails", () => {
      // Absent is not the same as false, and neither is creditable. An
      // artifact that says nothing about how the web tier was served cannot be
      // told apart from one that quietly avoided the failure.
      const a = syntheticCompleteArtifact();
      for (const [, record] of Object.entries(a.suites)) {
        if (record.layer === "BROWSER") delete record.webRuntimeMode;
      }
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: a,
        productLedger: cleanProductLedger(),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.failures.some((f) => f.includes("undeclared"))).toBe(true);
    });

    it("X14. a browser proof recorded WITHOUT strict CSP → fails", () => {
      // The policy under test must be the one production serves. A run with
      // the nonce policy switched off proves the application works in an
      // environment no user is in.
      const a = syntheticCompleteArtifact();
      for (const [, record] of Object.entries(a.suites)) {
        if (record.layer === "BROWSER") record.strictCsp = false;
      }
      const verdict = evaluatePoint7Closure({
        root: ROOT,
        artifact: a,
        productLedger: cleanProductLedger(),
        canaryLedger: canaryLedger(),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.metrics.strictCspEnabled).toBe(false);
      expect(verdict.failures.some((f) => f.includes("strict CSP"))).toBe(true);
    });

    it("X11. a browser email journey must not read the invite token from the database", () => {
      // Not an artifact case — a STATIC one. The database bypass passed
      // identically in a run where every send was refused, so it has to be
      // impossible to reintroduce rather than merely absent today.
      const specs = discoverScenarioSuites("BROWSER", ROOT);
      expect(specs.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const rel of specs) {
        // Comments are stripped first. The check is about what the spec DOES;
        // a comment explaining why the bypass was removed is not the bypass,
        // and a gate that cannot tell the difference teaches people to stop
        // writing the explanation.
        const source = readFileSync(resolve(ROOT, rel), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/.*$/, ""))
          .join("\n");
        if (/SELECT\s+token\s+FROM\s+team_invites/i.test(source)) offenders.push(rel);
        if (/SELECT\s+[^;]*\btoken\b[^;]*FROM\s+\w*invite/i.test(source)) offenders.push(rel);
      }
      expect(
        [...new Set(offenders)],
        "a browser journey read an invitation token out of the database instead of the recorded message",
      ).toEqual([]);
    });

    it("an artifact bound to a different scenario inventory → fails", () => {
      const a = syntheticCompleteArtifact();
      a.suites[Object.keys(a.suites)[0]].binding = "9".repeat(64);
      failsWith(a, "different scenario inventory");
    });

    // -----------------------------------------------------------------------
    // POINT 7 CORRECTIVE PASS — the isolation predicates.
    //
    // The first run's artifact passed every structural check above and was
    // produced by processes contacting the production Sentry project and the
    // production evidence bucket. These three are what make that impossible to
    // repeat: the boundary is now part of what a proof asserts.
    // -----------------------------------------------------------------------

    it("11. a proof missing the outbound-network ledger → fails", () => {
      const a = syntheticCompleteArtifact();
      for (const record of Object.values(a.suites)) {
        delete (record as { isolation?: unknown }).isolation;
      }
      failsWith(a, "no outbound-network ledger");
    });

    it("12. a proof containing a real external destination → fails", () => {
      const a = syntheticCompleteArtifact();
      const first = Object.keys(a.suites)[0];
      // The exact host the first Point-7 run actually reached.
      a.suites[first].isolation.allowedHosts = [
        "127.0.0.1",
        "o4511404920864768.ingest.de.sentry.io",
      ];
      failsWith(a, "reached external destination");
    });

    it("13. a proof recording an expected denial as an error event → fails", () => {
      const a = syntheticCompleteArtifact();
      const first = Object.keys(a.suites)[0];
      a.suites[first].isolation.observabilityErrorEvents = 1;
      failsWith(a, "error-level observability event");
    });

    it("14. the ambiguous personal-workspace field stays removed", () => {
      // A stays-removed gate rather than a scenario: this is an absence claim
      // about the catalog, and the thing it prevents is the semantic
      // contradiction being re-derived under the old name. `getPlanCapabilities`
      // is the running catalog, so this cannot pass against a stale build.
      const caps = PLAN_CAPABILITIES.TEAM as Record<string, unknown>;
      expect(
        "allowsPersonalWorkspace" in caps,
        "the ambiguous field is back — it answered both 'may this plan be bought for a personal workspace' and 'may this identity have one'",
      ).toBe(false);
      expect("allowsPersonalWorkspacePurchase" in caps).toBe(true);
      // WORKSPACE AND COLLABORATION ARCHITECTURE RECONCILIATION — the purchase
      // rule INVERTED, by product decision, and this gate is about the field's
      // meaning rather than its value.
      //
      // TEAM is a commercial plan, not a domain object. Buying it creates no
      // workspace and transforms none; it raises the entitlement of the
      // Personal Workspace the buyer already has — to 10 seats and 5
      // collaboration groups. Refusing the purchase on a personal workspace
      // was the last place the old "TEAM is a kind of workspace" reading
      // survived: it made a plan unbuyable by exactly the people it is sold to.
      //
      // What this gate exists for is unchanged and asserted above: the single
      // ambiguous field that answered two different questions stays removed,
      // and the surviving field still answers only the purchase question.
      expect(caps.allowsPersonalWorkspacePurchase).toBe(true);
      // The field is still the ONE authority for the purchase question — the
      // separation this gate was created to protect. Nothing else in the
      // catalog answers it, and the exported predicate reads it rather than
      // re-deriving it from a plan name.
      expect(canPlanPurchasePersonalWorkspacePlan("TEAM")).toBe(
        caps.allowsPersonalWorkspacePurchase,
      );
    });
  });

  // =========================================================================
  // The REAL artifact
  // =========================================================================

  describe("current-run evidence", () => {
    it("reports the closure verdict for the artifact on disk", (ctx) => {
      const artifact = loadArtifact();
      const verdict = evaluatePoint7Closure({ root: ROOT, artifact });

      // CLOSURE CANNOT BE ASSERTED BY A RUN THAT DID NOT MEASURE IT.
      //
      // The gate requires a product-run outbound ledger, and only the
      // INTEGRATION project writes one. In the unit project — which is what
      // ordinary CI runs — no ledger exists, so this asserted a closure no
      // unit run could ever have established and failed on every CI build.
      // It passed locally only because a developer's `.p7tmp` still held
      // ledgers from an earlier integration run, which is the worst kind of
      // green: an artifact of the machine, not of the tree.
      //
      // Skipping is the honest answer, and it is NOT a weakening. "No ledger"
      // means this run recorded nothing about the outbound boundary, which is
      // a different statement from "the boundary is unsound" — and the gate
      // still fails closed wherever a ledger IS expected, which the negative
      // cases above pin explicitly.
      const noProductLedger = verdict.failures.some((f) =>
        f.includes("no product-run outbound ledger"),
      );
      if (noProductLedger) {
        ctx.skip(
          "no product-run outbound ledger on disk — this is the unit project; " +
            "run the integration project to produce one, then this asserts closure.",
        );
        return;
      }
      // Reported, not silently swallowed: a run that has not executed both
      // layers under one run id has NOT closed, and the failure list says
      // exactly which scenarios are outstanding.
      if (!verdict.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `POINT 7 NOT CLOSED — ${verdict.failures.length} failure(s):\n  ` +
            verdict.failures.join("\n  "),
        );
      }
      expect(
        verdict.ok,
        `Point 7 closure gate failed:\n${verdict.failures.join("\n")}`,
      ).toBe(true);
    });
  });
});
