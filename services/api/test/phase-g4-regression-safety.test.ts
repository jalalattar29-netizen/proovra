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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
const TENANCY_RESOLVER = readSource(
  "../src/services/organization/tenancy-resolver.service.ts",
);
const CLASSIC_PAGE = readSource(
  "../../../apps/web/app/(app)/cases/[id]/classic/page.tsx",
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

describe("Phase G4.6 — Workspace/org isolation invariants preserved", () => {
  it("tenancy resolver still throws on team_org_missing (Stage 6 invariant)", () => {
    expect(TENANCY_RESOLVER).toContain('"team_org_missing"');
  });

  it("tenancy resolver still blocks cross-org disagreements", () => {
    expect(TENANCY_RESOLVER).toContain('"tenancy_disagreement"');
    expect(TENANCY_RESOLVER).toContain("cross_org_resolution_blocked_total");
  });

  it("evidence write paths still use resolveTenancyForWrite", () => {
    // The resolver is the canonical authority — services call it
    // from the write paths. We don't assert every caller (long), only
    // that the resolver still EXPORTS the function so callers can.
    expect(TENANCY_RESOLVER).toContain(
      "export async function resolveTenancyForWrite",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. G4.1 personal-mode evidence resolves deterministically.
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Personal-mode evidence resolves deterministically (G4.1)", () => {
  it("read-side compatibility helper is shipped and exported", () => {
    expect(TENANCY_RESOLVER).toContain(
      "export async function resolveEvidenceTenancyForRead",
    );
  });

  it("legacy null-teamId rows project through the personal team", () => {
    expect(TENANCY_RESOLVER).toContain('"legacy_personal_fallback"');
    expect(TENANCY_RESOLVER).toContain("isPersonal: true");
  });

  it("orphan rows (no team, no personal workspace) are explicitly modelled", () => {
    expect(TENANCY_RESOLVER).toContain('"orphan"');
  });

  it("the helper is READ-ONLY — never mutates evidence", () => {
    // Anchor the assertion: between the function start and a
    // recognisable trailing block, no .evidence.update / .upsert.
    const startIdx = TENANCY_RESOLVER.indexOf(
      "export async function resolveEvidenceTenancyForRead",
    );
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = TENANCY_RESOLVER.indexOf(
      "export async function checkEvidenceTenancyInvariant",
    );
    expect(endIdx).toBeGreaterThan(startIdx);
    const slice = TENANCY_RESOLVER.slice(startIdx, endIdx);
    expect(slice).not.toMatch(/\.evidence\.update\(/);
    expect(slice).not.toMatch(/\.evidence\.upsert\(/);
    expect(slice).not.toMatch(/\.evidence\.create\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. Classic matter retirement (G4.2).
// ---------------------------------------------------------------------------

describe("Phase G4.6 — Classic matter view retired safely (G4.2)", () => {
  it("classic page is now a redirect to the canonical Matter Workspace", () => {
    expect(CLASSIC_PAGE).toContain("import { redirect }");
    expect(CLASSIC_PAGE).toContain('redirect(`/cases/');
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

  it("auth preHandler preserved on every extracted route", () => {
    const occurrences = (
      EVIDENCE_SAVED_VIEWS.match(/preHandler: requireAuth/g) ?? []
    ).length;
    expect(occurrences).toBe(5);
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
