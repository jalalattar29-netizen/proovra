/**
 * Phase O active-blocker closure contract suite.
 *
 * Covers the implementation deliverables for:
 *   A-1  cases DELETE role gate          (OWNER/ADMIN only)
 *   A-2  cross-team evidence attach IDOR (case.teamId === evidence.teamId)
 *   A-4  Stripe webhook timestamp tolerance
 *   B-4  custody-event observability (no silent `.catch(() => null)`)
 *   C-1  cover PDF tone-derived compactValue
 *   D-1  frontend double-`.json()` sweep
 *
 * Pure unit/contract assertions — no DB calls. Heavier integration
 * coverage of the route paths is added in
 * `phase-o-blockers-routes.test.ts` (created alongside this file).
 */

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateCaseMutationPermission,
  evaluateCrossTeamAttach,
} from "../src/services/cases/case-permission.service.js";
import {
  STRIPE_SIGNATURE_TOLERANCE_SEC,
  StripeSignatureError,
  verifyStripeSignature,
} from "../src/services/stripe.service.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf8");
}

// ---------------------------------------------------------------------------
// A-1: cases DELETE role gate (matrix unit tests)
// ---------------------------------------------------------------------------

describe("A-1 — case DELETE / MANAGE_SETTINGS role gate", () => {
  // The matrix doesn't hit the DB; we drive it with synthetic
  // CaseAccessRole values and assert the contract.
  it("OWNER access role can DELETE", () => {
    const r = evaluateCaseMutationPermission({
      mutation: "DELETE",
      accessRole: "OWNER",
      assignmentRoles: [],
    });
    expect(r.allowed).toBe(true);
  });
  it("ADMIN access role can DELETE", () => {
    const r = evaluateCaseMutationPermission({
      mutation: "DELETE",
      accessRole: "ADMIN",
      assignmentRoles: [],
    });
    expect(r.allowed).toBe(true);
  });
  it("MEMBER access role CANNOT DELETE", () => {
    const r = evaluateCaseMutationPermission({
      mutation: "DELETE",
      accessRole: "MEMBER",
      assignmentRoles: [],
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false ? r.reason : "").toMatch(
      /OWNER or ADMIN/i,
    );
  });
  it("VIEWER access role CANNOT DELETE", () => {
    const r = evaluateCaseMutationPermission({
      mutation: "DELETE",
      accessRole: "VIEWER",
      assignmentRoles: [],
    });
    expect(r.allowed).toBe(false);
  });
  it("CaseAssignment role (REVIEWER/INVESTIGATOR/GOVERNANCE/OBSERVER) does NOT elevate DELETE", () => {
    for (const assignment of [
      "INVESTIGATOR",
      "REVIEWER",
      "GOVERNANCE",
      "OBSERVER",
    ] as const) {
      const r = evaluateCaseMutationPermission({
        mutation: "DELETE",
        accessRole: "MEMBER",
        assignmentRoles: [assignment],
      });
      expect.soft(
        r.allowed,
        `MEMBER + ${assignment} must NOT delete`,
      ).toBe(false);
    }
  });
  it("MANAGE_SETTINGS (rename) follows the same gate", () => {
    expect(
      evaluateCaseMutationPermission({
        mutation: "MANAGE_SETTINGS",
        accessRole: "MEMBER",
        assignmentRoles: [],
      }).allowed,
    ).toBe(false);
    expect(
      evaluateCaseMutationPermission({
        mutation: "MANAGE_SETTINGS",
        accessRole: "ADMIN",
        assignmentRoles: [],
      }).allowed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A-2: cross-team evidence attach IDOR
// ---------------------------------------------------------------------------

describe("A-2 — cross-team evidence attach gate", () => {
  it("same teamId on case and evidence is allowed", () => {
    const r = evaluateCrossTeamAttach({
      caseTeamId: "11111111-1111-1111-1111-111111111111",
      evidenceTeamId: "11111111-1111-1111-1111-111111111111",
    });
    expect(r.allowed).toBe(true);
  });
  it("different teamIds are blocked with CROSS_TEAM_ATTACH_BLOCKED", () => {
    const r = evaluateCrossTeamAttach({
      caseTeamId: "11111111-1111-1111-1111-111111111111",
      evidenceTeamId: "22222222-2222-2222-2222-222222222222",
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false ? r.code : "").toBe(
      "CROSS_TEAM_ATTACH_BLOCKED",
    );
  });
  it("personal case + team evidence is blocked", () => {
    const r = evaluateCrossTeamAttach({
      caseTeamId: null,
      evidenceTeamId: "22222222-2222-2222-2222-222222222222",
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false ? r.code : "").toBe(
      "CROSS_TEAM_ATTACH_BLOCKED",
    );
  });
  it("team case + personal evidence is blocked", () => {
    const r = evaluateCrossTeamAttach({
      caseTeamId: "11111111-1111-1111-1111-111111111111",
      evidenceTeamId: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.allowed === false ? r.code : "").toBe(
      "CROSS_TEAM_ATTACH_BLOCKED",
    );
  });
  it("personal case + personal evidence is allowed", () => {
    const r = evaluateCrossTeamAttach({
      caseTeamId: null,
      evidenceTeamId: null,
    });
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A-4: Stripe webhook timestamp tolerance
// ---------------------------------------------------------------------------

describe("A-4 — Stripe webhook signature timestamp tolerance", () => {
  // We rely on `STRIPE_WEBHOOK_SECRET` being set in the test env.
  // For these tests we set it inline.
  const TEST_SECRET = "whsec_test_only";
  function withEnv<T>(fn: () => T): T {
    const prev = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = TEST_SECRET;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = prev;
    }
  }

  function sign(tsSec: number, body: string): string {
    const sig = createHmac("sha256", TEST_SECRET)
      .update(`${tsSec}.${body}`)
      .digest("hex");
    return `t=${tsSec},v1=${sig}`;
  }

  it("tolerance is the documented 5 minutes (300 s)", () => {
    expect(STRIPE_SIGNATURE_TOLERANCE_SEC).toBe(300);
  });

  it("accepts a signature within the tolerance window", () => {
    withEnv(() => {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0);
      const ts = Math.floor(now / 1000) - 60; // 1 minute old
      const body = '{"id":"evt_test"}';
      const header = sign(ts, body);
      expect(() =>
        verifyStripeSignature(Buffer.from(body), header, { nowMs: now }),
      ).not.toThrow();
    });
  });

  it("rejects a signature older than the tolerance window", () => {
    withEnv(() => {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0);
      const ts = Math.floor(now / 1000) - (STRIPE_SIGNATURE_TOLERANCE_SEC + 60);
      const body = '{"id":"evt_test"}';
      const header = sign(ts, body);
      let thrown: unknown = null;
      try {
        verifyStripeSignature(Buffer.from(body), header, { nowMs: now });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StripeSignatureError);
      expect((thrown as StripeSignatureError).code).toBe(
        "TIMESTAMP_OUT_OF_TOLERANCE",
      );
    });
  });

  it("rejects a future-dated signature outside the tolerance window", () => {
    withEnv(() => {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0);
      const ts = Math.floor(now / 1000) + (STRIPE_SIGNATURE_TOLERANCE_SEC + 60);
      const body = '{"id":"evt_test"}';
      const header = sign(ts, body);
      let thrown: unknown = null;
      try {
        verifyStripeSignature(Buffer.from(body), header, { nowMs: now });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StripeSignatureError);
      expect((thrown as StripeSignatureError).code).toBe(
        "TIMESTAMP_OUT_OF_TOLERANCE",
      );
    });
  });

  it("rejects a garbage timestamp before HMAC compare", () => {
    withEnv(() => {
      const body = '{"id":"evt_test"}';
      const header = "t=abc,v1=" + "0".repeat(64);
      expect(() =>
        verifyStripeSignature(Buffer.from(body), header, { nowMs: Date.now() }),
      ).toThrow(StripeSignatureError);
    });
  });

  it("rejects a missing v1 segment", () => {
    withEnv(() => {
      const body = '{"id":"evt_test"}';
      const header = `t=${Math.floor(Date.now() / 1000)}`;
      let thrown: unknown = null;
      try {
        verifyStripeSignature(Buffer.from(body), header);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StripeSignatureError);
      expect((thrown as StripeSignatureError).code).toBe("MISSING_FIELDS");
    });
  });
});

// ---------------------------------------------------------------------------
// C-1: cover PDF compactValue derived from tone (no hard-coded "Verified")
// ---------------------------------------------------------------------------

describe("C-1 — cover PDF compactValue is derived from tone", () => {
  const COVER = "services/worker/src/report-v2/sections/cover.ts";

  it("immutable_storage warning tone does NOT render the word 'Verified'", () => {
    // Source-contract assertion: the literal `compactValue = "Verified"`
    // assignment under the `immutable storage` branch must be gone.
    // The new branch reads tone first.
    const src = read(COVER);
    // Find the `immutable storage` branch body.
    const m = src.match(
      /includes\("immutable storage"\)\)\s*\{([\s\S]*?)\}\s*\n/,
    );
    expect(m).toBeTruthy();
    const body = m![1];
    expect.soft(body).toMatch(/params\.tone/);
    expect.soft(body).not.toMatch(/compactValue\s*=\s*"Verified"/);
    expect.soft(body).toMatch(/Storage protected/);
    expect.soft(body).toMatch(/Storage protection failed|Storage protection unavailable/);
  });

  it("core_integrity branch is also tone-derived (no hard-coded literal)", () => {
    const src = read(COVER);
    const m = src.match(
      /includes\("core integrity"\)\)\s*\{([\s\S]*?)\}\s*else/,
    );
    expect(m).toBeTruthy();
    const body = m![1];
    expect.soft(body).toMatch(/params\.tone/);
  });

  it("trust signals NEVER render 'Verified' when tone is danger", () => {
    // Brute-force a synthetic invocation by inspecting the source for
    // any branch that emits the literal "Verified" without a tone check
    // (we already exclude the success path via the tone derivation).
    const src = read(COVER);
    // Find every assignment of `compactValue = "Verified"` and assert
    // it is preceded by a tone === "success" check in the same line
    // chain. We accept the new pattern:
    //    params.tone === "success" ? "Verified" : ... }
    const literalAssigns = src.match(
      /compactValue\s*=\s*"Verified"(?!\s*[?:])/g,
    );
    expect(
      literalAssigns,
      "No bare `compactValue = \"Verified\"` should remain.",
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-1: frontend double-`.json()` sweep — no `await X.json()` after apiFetch
// ---------------------------------------------------------------------------

describe("D-1 — frontend double-.json() sweep is complete", () => {
  it("no apps/web/** file has `const res = await apiFetch(...)\\n const X = await res.json()` pattern", () => {
    // Re-read the test fixture's grep proof would require a fs walk;
    // we instead reference a curated list of the 14 originally-flagged
    // files and assert none contains the offending two-line pattern.
    const FIXED_FILES = [
      "apps/web/app/(app)/inbox/page.tsx",
      // Operations-Center redesign — InboxIndicator.tsx was replaced by
      // NotificationBell.tsx (same double-.json() rule applies).
      "apps/web/components/app-shell-v2/NotificationBell.tsx",
      "apps/web/components/governance/RetentionInheritanceSummary.tsx",
      "apps/web/components/command-center/AccountPrioritiesBanner.tsx",
      "apps/web/components/governance/RetentionConflictAlert.tsx",
      // ExportEligibilityPreflight was deleted in Phase 12 Point 4 as a
      // duplicate of GovernedExportAction; the wrapper below is the
      // surviving call site and carries the same D-1 invariant.
      "apps/web/components/governance/GovernedExportAction.tsx",
      "apps/web/components/governance/DestructionImpactPreview.tsx",
      "apps/web/components/governance/DestructionCertificate.tsx",
      "apps/web/components/notifications/NotificationPreferencesPanel.tsx",
      "apps/web/app/(app)/organizations/[id]/page.tsx",
      "apps/web/app/(app)/organizations/page.tsx",
      "apps/web/app/(app)/evidence-requests/[id]/page.tsx",
      "apps/web/app/(app)/org-invites/[token]/accept/page.tsx",
      "apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx",
    ];
    const offenders: string[] = [];
    for (const path of FIXED_FILES) {
      const src = read(path);
      // The bug pattern is: `await apiFetch(...)` followed within ~250
      // chars by `await <ident>.json()` where the same ident is the
      // captured `res`. After the fix every such call site uses
      // `(await apiFetch(...)) as Type`.
      // Heuristic: there must be NO `await res.json()` AND no
      // `await response.json()` in any block that also calls apiFetch.
      const hits =
        src.match(/await\s+apiFetch[\s\S]{0,400}?await\s+(res|response)\.json\(\)/g) ??
        [];
      if (hits.length > 0) offenders.push(`${path} (${hits.length})`);
    }
    expect(
      offenders,
      `D-1 sweep incomplete in: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B-4: custody-event silent-swallow removal — no `.catch(() => null)` pattern
//
// Asserts the legacy silent-catch pattern is purged from mutating
// custody-event call sites. Best-effort read paths are allowed to
// continue using `.catch(() => undefined)` (different shape; surfaced
// in source as bounded log only).
// ---------------------------------------------------------------------------

describe("B-4 — no silent `.catch(() => null)` on appendCustodyEvent", () => {
  // The handler is replaced with a logged + metric-bumping wrapper
  // in the next patch (see appendCustodyEventObservable). The contract
  // asserts: the legacy text `appendCustodyEvent(...).catch(() => null)`
  // must not appear in source.
  it("evidence.routes.ts uses observable catch (no silent null swallow)", () => {
    const src = read("services/api/src/routes/evidence.routes.ts");
    expect.soft(src).not.toMatch(
      /appendCustodyEvent\([\s\S]{0,400}?\)\s*\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/,
    );
  });
});
