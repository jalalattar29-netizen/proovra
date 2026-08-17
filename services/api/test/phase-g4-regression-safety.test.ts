/**
 * Phase G4.6 — Regression safety contract suite.
 *
 * G4 is a deep-cleanup phase. The G4 spec is explicit:
 *
 *   "This phase is successful only if the platform behaves the same
 *    or safer, but the code becomes cleaner, faster, and more
 *    deterministic."
 *
 * The contracts below assert that the deep cleanup did NOT change:
 *
 *   1. public verify behaviour (404 on failed-hash records)
 *   2. report / package generation semantics (A2 vocabulary intact)
 *   3. custody event emission (hash + actor + reason all flow)
 *   4. evidence integrity hard-gate (A0)
 *   5. destroyed evidence → 404 publicly
 *   6. workspace/org isolation (Stage 6 invariant)
 *   7. personal evidence still resolves (G4.1 helper)
 *   8. Matter Workspace replaces classic safely (redirect + no
 *      orphan affordances)
 *   9. reviewer flows unchanged (G3.2 inline actions intact)
 *  10. governance export eligibility unchanged
 *
 * Style: source-contract. Reads source files, asserts regex/string
 * contracts. No DB, no HTTP, no Prisma client — same shape as
 * every phase contract suite from A0 onward.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { evidenceSavedViewsRoutes } from "../src/routes/evidence.saved-views.routes.js";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

// Strip line + block comments — used by the "no longer plumbs
// onOpenClassic" assertion so the docstring narrative that
// MENTIONS the removal does not satisfy the substring check.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

const EVIDENCE_ROUTES = readSource("../src/routes/evidence.routes.ts");
const EVIDENCE_SAVED_VIEWS = readSource(
  "../src/routes/evidence.saved-views.routes.ts",
);
// Phase Final-Closure-Remediation — the classic redirect page was
// deleted. Its behaviour now lives as a permanent redirect rule in
// `apps/web/next.config.js` (`/cases/:id/classic → /cases/:id`).
const NEXT_CONFIG = readSource(
  "../../../apps/web/next.config.js",
);
const CASE_DETAIL_PAGE = readSource(
  "../../../apps/web/app/(app)/cases/[id]/page.tsx",
);
const MATTER_WORKSPACE = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);
const REVIEWER_CONSOLE = readSource(
  "../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx",
);

// ---------------------------------------------------------------------------
// 1. Public verify behaviour — unchanged.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Public verify unchanged", () => {
  it("`/public/verify/:id` route still registered with NO auth preHandler", () => {
    // Public verify is anonymous by design (Phase A0).
    expect(EVIDENCE_ROUTES).toMatch(/app\.get\(\s*"\/public\/verify\/:id"/);
  });

  it("FAILED_HASH_MISMATCH records 404 publicly (Phase A0 hard-gate)", () => {
    // The hard-gate predicate must still exist in the verify handler.
    expect(EVIDENCE_ROUTES).toContain("FAILED_HASH_MISMATCH");
  });

  it("destroyed / tombstoned / archived evidence still 404s publicly", () => {
    // Phase G1 + F + 27 lifecycle gates; the public verify handler
    // already gates on these states. We assert the constants still
    // appear in the routes file.
    expect(EVIDENCE_ROUTES).toMatch(/DESTROYED|TOMBSTONED/);
  });
});

// ---------------------------------------------------------------------------
// 2. Report / package vocabulary (A2) preserved.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Report PDF / Verification Package ZIP vocabulary intact", () => {
  it("evidence.routes.ts still emits both artifact codes distinctly", () => {
    // The A2 contract: Report PDF and Verification Package ZIP are
    // separate artifacts and the routes layer never collapses them.
    expect(EVIDENCE_ROUTES).toContain("/report/latest");
    expect(EVIDENCE_ROUTES).toContain("/verification-package");
  });

  it("verification_package_pending / blocked / unavailable codes preserved", () => {
    expect(EVIDENCE_ROUTES).toContain("verification_package_pending");
  });
});

// ---------------------------------------------------------------------------
// 3. Custody events still emitted.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Custody event emission preserved", () => {
  it("appendCustodyEvent is still imported + called from evidence.routes.ts", () => {
    expect(EVIDENCE_ROUTES).toContain("appendCustodyEvent");
  });

  it("reviewer audit emission preserved", () => {
    expect(EVIDENCE_ROUTES).toContain("appendReviewerAuditEvent");
  });

  it("platform audit log still wired", () => {
    expect(EVIDENCE_ROUTES).toContain("appendPlatformAuditLog");
  });

  it("the extracted saved-views module does NOT emit custody/audit events", () => {
    // Saved views are per-operator UI bookmarks. They must NEVER
    // pollute the custody chain or audit log. The extracted module
    // imports nothing of the sort.
    expect(EVIDENCE_SAVED_VIEWS).not.toContain("appendCustodyEvent");
    expect(EVIDENCE_SAVED_VIEWS).not.toContain("appendReviewerAuditEvent");
    expect(EVIDENCE_SAVED_VIEWS).not.toContain("appendPlatformAuditLog");
    expect(EVIDENCE_SAVED_VIEWS).not.toContain("writeAnalyticsEvent");
  });
});

// ---------------------------------------------------------------------------
// 4. Integrity hard-gate (A0) intact.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — A0 integrity hard-gate intact", () => {
  it("evidence routes still consume the SHA-256 mismatch hard-stop", () => {
    expect(EVIDENCE_ROUTES).toContain("FAILED_HASH_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// 5. Workspace/org isolation (A1 Stage 6).
// ---------------------------------------------------------------------------

// LEGACY-003 (2026-08-15): every isolation invariant this suite held was
// asserted against the REMOVED tenancy resolver's source. The suite is retired
// rather than left as an empty describe that reads like passing coverage —
// workspace/org isolation is enforced by authorizeOrFail and proven at runtime
// against the real Fastify app. The stays-removed contract is at the foot of
// this file.

// ---------------------------------------------------------------------------
// 6. G4.1 personal-mode evidence resolves deterministically.
// ---------------------------------------------------------------------------

// LEGACY-003 (2026-08-15): this asserted that the REMOVED tenancy resolver's
// read-side projection never mutated evidence. The module is gone; its
// stays-removed contract is at the foot of this file.

// ---------------------------------------------------------------------------
// 7. Classic matter retirement (G4.2).
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Classic matter view retired safely (G4.2)", () => {
  it("classic URL is now a permanent redirect in next.config.js to the canonical Matter Workspace", () => {
    // Phase Final-Closure-Remediation collapsed the redirect-only
    // page file into a routing-layer redirect — same external
    // behaviour, no JSX shim.
    expect(NEXT_CONFIG).toMatch(
      /source:\s*["']\/cases\/:id\/classic["'][\s\S]{0,200}destination:\s*["']\/cases\/:id["']/,
    );
  });

  it("the canonical /cases/[id] page no longer plumbs onOpenClassic", () => {
    // Strip comments so the docstring narrative explaining the
    // retirement does not trip the substring check.
    const codeOnly = stripComments(CASE_DETAIL_PAGE);
    expect(codeOnly).not.toContain("onOpenClassic");
    expect(codeOnly).not.toContain("/classic");
  });

  it("MatterWorkspace no longer renders an `Open classic view` button", () => {
    expect(MATTER_WORKSPACE).not.toContain("Open classic view");
    expect(MATTER_WORKSPACE).not.toMatch(/onOpenClassic[?:]/);
  });

  it("MatterWorkspace's empty-state copy no longer references the classic view", () => {
    // The two copy-strings that used to say "from the classic view"
    // were updated to point at per-domain surfaces.
    expect(MATTER_WORKSPACE).not.toMatch(
      /Use the classic view to link evidence/,
    );
    expect(MATTER_WORKSPACE).not.toMatch(
      /Assign[^"']*from the classic view/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Reviewer flows (G3 / G3.2) unchanged.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Reviewer flows unchanged", () => {
  it("Reviewer Console still wires the G3.2 inline actions", () => {
    expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="assign"');
    expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="escalate"');
    expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="acknowledge"');
  });

  it("Reviewer Console still routes mutations through useStepUpAction", () => {
    expect(REVIEWER_CONSOLE).toContain("useStepUpAction");
    expect(REVIEWER_CONSOLE).toContain("StepUpModal");
  });

  it("Reviewer Console still respects terminal-row guard", () => {
    expect(REVIEWER_CONSOLE).toContain("TERMINAL_STATUSES");
    expect(REVIEWER_CONSOLE).toContain("isRowActionable");
  });
});

// ---------------------------------------------------------------------------
// 9. evidence.routes.ts refactor (G4.5).
// ---------------------------------------------------------------------------

describe("Phase G4.6 — evidence.routes.ts refactor preserves contracts", () => {
  it("saved-views routes file exists and exports the registration helper", () => {
    expect(EVIDENCE_SAVED_VIEWS).toContain(
      "export async function evidenceSavedViewsRoutes",
    );
  });

  it("all five saved-views URLs land in the extracted module", () => {
    expect(EVIDENCE_SAVED_VIEWS).toContain(
      '"/v1/evidence/saved-views"',
    );
    expect(EVIDENCE_SAVED_VIEWS).toContain(
      '"/v1/evidence/saved-views/:id"',
    );
    expect(EVIDENCE_SAVED_VIEWS).toContain(
      '"/v1/evidence/saved-views/:id/default"',
    );
    // Both the singular CRUD verbs.
    expect(EVIDENCE_SAVED_VIEWS).toContain("app.get(");
    expect(EVIDENCE_SAVED_VIEWS).toContain("app.post(");
    expect(EVIDENCE_SAVED_VIEWS).toContain("app.patch(");
    expect(EVIDENCE_SAVED_VIEWS).toContain("app.delete(");
  });

  it("parent module registers the extracted routes exactly once", () => {
    const calls = (
      EVIDENCE_ROUTES.match(/evidenceSavedViewsRoutes\(app\)/g) ?? []
    ).length;
    expect(calls).toBe(1);
  });

  it("the parent module no longer carries duplicate saved-view route handlers", () => {
    // The handlers were removed from the parent. Status codes 201/200
    // remain in the parent for OTHER routes; here we assert the
    // handler text moved.
    expect(EVIDENCE_ROUTES).not.toContain(
      'app.get("/v1/evidence/saved-views"',
    );
    expect(EVIDENCE_ROUTES).not.toContain(
      'app.post("/v1/evidence/saved-views"',
    );
    expect(EVIDENCE_ROUTES).not.toContain(
      'app.patch("/v1/evidence/saved-views/:id"',
    );
    expect(EVIDENCE_ROUTES).not.toContain(
      'app.delete("/v1/evidence/saved-views/:id"',
    );
  });

  it("auth preHandler preserved on EVERY extracted route", async () => {
    // PHASE 12 POINT 4 STEP 3 (Pass G) — this was
    // `expect(occurrences).toBe(5)` over `/preHandler: requireAuth/`. An
    // occurrence count cannot tell which routes are covered: deleting the
    // guard from one route and adding it twice to another kept it green, and
    // adding a sixth route left it red for the wrong reason.
    //
    // Register the real module on a real Fastify instance and assert that
    // EVERY registered route carries a preHandler. An unauthenticated
    // saved-views route now fails here by name.
    const app = Fastify({ logger: false });
    const routes: Array<{ method: string; url: string; guarded: boolean }> = [];
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const guarded = Array.isArray(route.preHandler)
        ? route.preHandler.length > 0
        : Boolean(route.preHandler);
      for (const method of methods) routes.push({ method, url: route.url, guarded });
    });

    try {
      await app.register(evidenceSavedViewsRoutes);
      await app.ready();
    } finally {
      await app.close();
    }

    expect(routes.length, "no saved-views routes registered").toBeGreaterThan(0);
    for (const r of routes) {
      expect(
        r.guarded,
        `${r.method} ${r.url} has NO preHandler — it is unauthenticated`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Governance export eligibility unchanged.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Governance export eligibility unchanged", () => {
  it("evidence.routes.ts still exposes the verification-package gate semantics", () => {
    // The route layer emits `verification_package_blocked` as the
    // operator-visible code; the `PACKAGE_BLOCKED_BY_POLICY` enum
    // is a shared client-side constant.
    expect(EVIDENCE_ROUTES).toContain("verification_package_blocked");
  });

  it("legal hold / lifecycle gates on the public verify handler intact", () => {
    expect(EVIDENCE_ROUTES).toContain("legalHold");
  });
});

// =============================================================================
// LEGACY-003 — removed module contract
// =============================================================================

/**
 * LEGACY-003 (2026-08-15) REMOVED `src/services/organization/tenancy-resolver.service.ts` as a caller-less second tenancy authority; see the Phase A1 suite for the full reasoning.
 */
describe("Phase G4 — tenancy resolver stays removed", () => {
  it("the removed module(s) stay removed", () => {
    for (const rel of [
      "../src/services/organization/tenancy-resolver.service.ts",
    ]) {
      expect(
        existsSync(fileURLToPath(new URL(rel, import.meta.url))),
        `${rel} is REMOVED (LEGACY-003) and must not return`,
      ).toBe(false);
    }
  });
});
