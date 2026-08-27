/**
 * PHASE 12 — machine-checked frontend/mobile ↔ API coverage manifest.
 *
 * Direction 1 (client → server): every `apiFetch("/v1/…" | "/public/…")`
 * call in apps/web + apps/mobile must match a registered API route —
 * disconnected client actions = 0.
 *
 * Direction 2 (server → consumer): every registered route must either have a
 * product consumer (its literal path appears in apps/web / apps/mobile
 * source) or belong to a REGISTERED non-product category (webhook, cron,
 * SCIM/SSO/IdP-called, public share/verify, external portal, service-to-
 * service, platform-admin API used via generic fetchers). A route matching
 * neither is an unclassified/dead route and fails.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REPO,
  assertCanonicalFactsFresh,
  capabilityMap,
  registeredRoutePaths,
  productConsumedPaths,
  unmatchedClientCalls,
} from "./_canonical-facts";

const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// ── canonical inventory ─────────────────────────────────────────────────────
//
// PHASE 0 §9. Both directions used to be measured here by private regexes: a
// route scanner over `src/routes/*.ts` and an `apiFetch(` scanner over the
// web/mobile corpus, together with a re-implementation of Fastify's path
// matching. The closure-gate suite carried a second copy of the same code, with
// the same five accumulated repairs, and neither could see a route registered
// through a path constant. Both now read the one AST measurement.
assertCanonicalFactsFresh();
const routes = registeredRoutePaths();
const productConsumed = productConsumedPaths();

// ── EXECUTABLE SYMBOL-LEVEL ROUTE REGISTRY (replaces the old regex categories) ─
//
// Direction 2 is now driven by an explicit per-route classification registry
// (docs/architecture/route-classification/slice-{a,b,c}.json). Routes NOT in
// that registry are auto-classified WEB/MOBILE_PRODUCT_CONSUMER by proving a
// real client-corpus consumer. The union must EXACTLY equal the registered
// route set — no prefix exemptions, no phantom classifications, no duplicates.
type ClassEntry = {
  route: string;
  methods?: string[];
  registeringFile?: string;
  class: string;
  consumer?: string | null;
  proofSuite?: string | null;
  note?: string;
};
const CLASSIFICATION_DIR = resolve(REPO, "docs/architecture/route-classification");
const classified = new Map<string, ClassEntry>();
const duplicateClassifications: string[] = [];
for (const slice of ["slice-a.json", "slice-b.json", "slice-c.json", "slice-d.json", "slice-e.json"]) {
  const arr = JSON.parse(read(join(CLASSIFICATION_DIR, slice))) as ClassEntry[];
  for (const e of arr) {
    if (classified.has(e.route)) duplicateClassifications.push(e.route);
    classified.set(e.route, e);
  }
}

/**
 * A route is product-consumed when the ANALYZER resolved a web/mobile call site
 * to it.
 *
 * The old test was a substring search of the client corpus for the route
 * literal, which credited a route whose path merely appeared in a comment and
 * missed every caller that builds its path from a template. "The string is
 * somewhere in the tree" was never evidence that anything calls it.
 */
const isProductConsumed = (route: string): boolean => productConsumed.has(route);

describe("Phase 12 — coverage manifest (direction 1)", () => {
  it("the canonical inventory is populated (measurement alive)", () => {
    // A guard against the artifact being present but empty: an empty inventory
    // would make every set-difference below trivially pass.
    expect(routes.size).toBeGreaterThan(500);
    expect(productConsumed.size).toBeGreaterThan(300);
  });

  it("disconnected client actions = 0 (every client request site matches a registered route)", () => {
    const disconnected = unmatchedClientCalls();
    expect(
      disconnected,
      `client request sites with no matching route:\n${disconnected
        .map((u) => `${u.site} -> ${u.method ?? "*"} ${u.path}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

describe("Phase 12 — executable route registry (direction 2)", () => {
  it("no duplicate classification entries across the registry slices", () => {
    expect(duplicateClassifications, duplicateClassifications.join(", ")).toEqual([]);
  });

  it("classifications for nonexistent routes = 0 (every classified route is registered)", () => {
    const phantom = [...classified.keys()].filter((r) => !routes.has(r));
    expect(phantom, `classified but not registered:\n${phantom.join("\n")}`).toEqual([]);
  });

  /**
   * PHASE 0 §10 — this assertion USED to read "unclassified routes = 0", and
   * the zero was an artefact of how it measured.
   *
   * "Product-consumed" was a substring search: the route's literal, or its
   * literal prefix before the first `:param`, appearing anywhere in the
   * concatenated web/mobile source. That credits a route whose path occurs in a
   * comment, in a doc string, or as a prefix of a DIFFERENT route's path, and
   * it credits nothing at all for a caller that builds its path from a
   * template. Under the canonical analyzer — which resolves the call site and
   * names the file and line — 158 registered routes are neither in the registry
   * slices nor provably called from the product. The zero was never true.
   *
   * It is NOT re-asserted as 158, because a second ratchet over the same
   * subject is what this phase is removing. The canonical authority already
   * ratchets it (`UndisposedRoutes`, phase-12-route-consumer-authority) and
   * carries it as FINAL-001 in the ledger. What is asserted here is the
   * CONSERVATION that makes the two views one view: every registered route is
   * accounted for by the canonical authority, so nothing can fall between the
   * slice registry and the analyzer and be counted by neither.
   */
  it("every registered route is accounted for by the canonical authority (no route falls between the two views)", () => {
    const map = capabilityMap();
    const accountedFor = new Set(
      map.routes
        .filter((r) => r.productConsumers.length > 0 || r.primaryDisposition !== null || r.result === "UNDISPOSED")
        .map((r) => r.path),
    );
    const orphaned = [...routes].filter((r) => !classified.has(r) && !accountedFor.has(r));
    expect(
      orphaned,
      `registered routes in neither the classification registry nor any canonical bucket (${orphaned.length}):\n${orphaned.slice(0, 40).join("\n")}`,
    ).toEqual([]);

    // Reported, not asserted: the honest size of the gap the substring measure
    // was hiding, and the fact that it is a subset of the canonical backlog.
    const undisposedPaths = new Set(
      map.routes.filter((r) => r.result === "UNDISPOSED").map((r) => r.path),
    );
    const unregistered = [...routes].filter((r) => !classified.has(r) && !isProductConsumed(r));
    // eslint-disable-next-line no-console
    console.log(
      "PHASE 0 slice-registry gap:",
      JSON.stringify({
        notInSlicesAndNotProductConsumed: unregistered.length,
        ofWhichInCanonicalUndisposedBacklog: unregistered.filter((r) => undisposedPaths.has(r)).length,
        ofWhichCanonicallyDispositioned: unregistered.filter((r) => !undisposedPaths.has(r)).length,
      }),
    );
  });

  it("every registry entry's registering file + proof suite exist on disk", () => {
    const missing: string[] = [];
    for (const e of classified.values()) {
      if (e.registeringFile) {
        const p = e.registeringFile.split(":")[0];
        if (!existsSync(resolve(REPO, p))) missing.push(`registeringFile ${p} (route ${e.route})`);
      }
      if (e.proofSuite) {
        const p = e.proofSuite.startsWith("services/") || e.proofSuite.startsWith("apps/") || e.proofSuite.startsWith("e2e/")
          ? e.proofSuite
          : join("services/api", e.proofSuite);
        if (!existsSync(resolve(REPO, p.split(":")[0]))) missing.push(`proofSuite ${e.proofSuite} (route ${e.route})`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  // ── CONVERGENCE METRICS — must reach zero for Phase-12 closure ─────────────
  it("DEAD_LEGACY_ROUTE = 0", () => {
    const dead = [...classified.values()].filter((e) => e.class === "DEAD_LEGACY_ROUTE").map((e) => e.route);
    expect(dead, `dead legacy routes still registered (${dead.length}):\n${dead.join("\n")}`).toEqual([]);
  });

  // MISSING_PRODUCT_CONSUMER — the wiring backlog.
  //
  // PHASE 12 CAPABILITY-PRESERVATION AUDIT (2026-07-28). The earlier pass drove
  // this metric toward zero by DELETING routes with no product consumer. The
  // audit rejected that: missing product wiring was itself the discovered
  // defect, so "zero callers" is NOT proof of obsolescence. Those capabilities
  // were RESTORED from HEAD (services/api/src/routes + backing services) and are
  // re-registered here as MISSING_PRODUCT_CONSUMER — capability preserved,
  // product wiring pending. See
  // docs/architecture/route-classification/deleted-capability-manifest.json
  // (ACCIDENTAL_CAPABILITY_LOSS = 0, UNPROVEN = 0 after restore).
  //
  // Phase-12 CLOSURE still requires this backlog to reach zero — but ONLY by
  // WIRING each capability into the product (add a real consumer) or by proving
  // SUPERSEDED_WITH_FULL_BEHAVIORAL_PARITY / DEAD_DUPLICATE parity. It may never
  // be closed by silent deletion. This test enforces that: the backlog is a
  // well-formed set of REAL registered routes that each carry a preservation
  // note, and it may only shrink (ratchet), never grow.
  const MISSING_BACKLOG_BASELINE = 131; // audited restore backlog, 2026-07-28 (zero deletions; all preserved)
  it("MISSING_PRODUCT_CONSUMER backlog is registered, documented, and ratchets down (never fake-closed by deletion)", () => {
    const missing = [...classified.values()].filter((e) => e.class === "MISSING_PRODUCT_CONSUMER");
    const malformed: string[] = [];
    for (const e of missing) {
      if (!routes.has(e.route)) malformed.push(`not registered: ${e.route}`);
      if (!e.registeringFile) malformed.push(`no registeringFile: ${e.route}`);
      if (!e.note) malformed.push(`no preservation note: ${e.route}`);
    }
    expect(malformed, malformed.join("\n")).toEqual([]);
    // Ratchet: the wiring backlog may shrink (wiring / proven-parity removal) but
    // never grow beyond the audited baseline.
    expect(
      missing.length,
      `wiring backlog grew above audited baseline (${missing.length} > ${MISSING_BACKLOG_BASELINE}) — a new unwired capability appeared; wire it or classify with proof`,
    ).toBeLessThanOrEqual(MISSING_BACKLOG_BASELINE);
  });
});

// ── PHASE 12 — behavioral chain registry (security/commercial/destructive) ──
//
// Each sensitive client operation maps to the EXECUTING behavioral suites that
// prove its chain (client/HTTP entry → context → lifecycle → membership →
// authorization → policy → writer → audit). A URL-string match is never the
// sole proof here: every referenced suite drives real code (Fastify inject,
// jsdom render, node:test contract, or the live-DB integration gates) and runs
// in the repository gates. This registry machine-checks that none of those
// proof suites silently disappears.
describe("Phase 12 — behavioral chain registry", () => {
  const CHAINS: Array<{ op: string; suites: string[] }> = [
    { op: "login/post-login destination + SSO callbacks", suites: ["services/api/test/phase-11-auth-destination-safety.test.ts", "services/api/test/phase-10-mandatory-sso-switch.test.ts"] },
    { op: "workspace switch + context safety", suites: ["apps/web/__tests__/render/context-safety.render.test.tsx", "apps/web/__tests__/render/context-safety-route-nav.render.test.tsx"] },
    { op: "invitations (issue/accept, workspace assignments)", suites: ["services/api/test/p2-invitation-coherence.test.ts"] },
    { op: "enterprise provisioning", suites: ["services/api/test/phase2-enterprise-provisioning.test.ts"] },
    { op: "SSO/SCIM reconciliation", suites: ["services/api/test/phase-10-mandatory-sso-switch.test.ts"] },
    { op: "organization security policy", suites: ["services/api/test/phase-10-closure-matrix.test.ts"] },
    { op: "break-glass", suites: ["services/api/test/phase-10-break-glass-runtime.test.ts"] },
    { op: "support access", suites: ["services/api/test/phase-10-support-runtime.test.ts"] },
    { op: "evidence create/upload/finalize", suites: ["services/api/test/phase-30-9-client-uploads.test.ts", "services/api/test/phase-37-98-reviewer-workflow-lifecycle.integration.test.ts"] },
    { op: "case + bulk operations", suites: ["services/api/test/phase-37-95-cross-tenant-runtime-probe.integration.test.ts"] },
    { op: "legal hold / destruction", suites: ["apps/web/__tests__/legal-hold-create-step-up.test.ts", "services/api/test/phase-5-lifecycle-hold-gate-union.test.ts"] },
    // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the previous suite,
    // phase9-collaboration-team-billing-parity, ASSERTED that the Collaboration
    // Team cap equals the Owned Workspace cap. That equality WAS the defect, so
    // the suite was deleted along with the conflation it protected, and the
    // chain now points at the suite that proves the corrected contract.
    { op: "billing checkout / seats / storage", suites: ["services/api/test/billing-commercial-correctness.test.ts", "apps/web/__tests__/render/phase10-no-personal-ux.render.test.tsx"] },
    { op: "deep links (web+mobile+API)", suites: ["services/api/test/phase-11-tenant-routes.test.ts", "apps/web/__tests__/render/phase11-deep-link-navigation.render.test.tsx", "apps/mobile/test/deep-link.contract.test.mjs"] },
    { op: "audit query/export", suites: ["services/api/test/phase-11-tenant-routes.test.ts", "apps/web/__tests__/render/phase11-audit-surface.render.test.tsx"] },
  ];
  for (const chain of CHAINS) {
    it(`chain proof suites exist: ${chain.op}`, () => {
      for (const s of chain.suites) {
        expect(existsSync(resolve(REPO, s)), `${chain.op}: missing suite ${s}`).toBe(true);
      }
    });
  }
});
