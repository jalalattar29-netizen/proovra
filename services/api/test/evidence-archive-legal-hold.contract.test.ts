/**
 * ARCHIVE UNDER A LEGAL HOLD — the SOURCE contract.
 *
 * The integration suite proves the behaviour against a real database. This one
 * proves the SHAPE: that the verdict has exactly one author and that every
 * other surface reads it rather than re-deciding it. The two are different
 * guarantees. A behavioural test passes right up until somebody adds a second
 * archive check somewhere new that happens to agree today; the structure is
 * what stops that, and the structure is not visible from any one file.
 *
 * The failure mode being locked out is the one that shipped: the projection
 * said `canArchive = active && !locked`, the governance layer refused a held
 * record, and the governance layer skipped itself entirely for personal-scope
 * evidence. Three answers, and the one that ran depended on the tenancy of the
 * row.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/** Strip comments — a prose mention of a retired pattern is not a violation. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const AUTHORITY = src("packages/shared/src/evidence-retention-lifecycle.ts");
const LIFECYCLE_SERVICE = src(
  "services/api/src/services/evidence/evidence-lifecycle.service.ts",
);
const EVIDENCE_ROUTES = src("services/api/src/routes/evidence.routes.ts");
const WEB_TYPES = src("apps/web/app/(app)/evidence/lib/evidence-library-types.ts");
const REVIEW_TAB = src(
  "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
);
const BULK_TOOLBAR = src(
  "apps/web/app/(app)/evidence/components/BulkActionsToolbar.tsx",
);

describe("the archive verdict has ONE author", () => {
  it("the shared authority computes an explicit archiveBlockReason", () => {
    expect(AUTHORITY).toMatch(/archiveBlockReason: EvidenceLifecycleBlockReason \| null/);
    expect(AUTHORITY).toMatch(/const archiveBlockReason: EvidenceLifecycleBlockReason \| null/);
  });

  it("canArchive is DERIVED from it, not computed beside it", () => {
    expect(code(AUTHORITY)).toMatch(
      /canArchive: active && archiveBlockReason === null,/,
    );
    // The retired predicate. It ignored the hold, which is the whole defect.
    expect(code(AUTHORITY)).not.toMatch(/canArchive: active && !locked/);
  });

  it("a legal hold is one of the reasons it can produce", () => {
    const decision = AUTHORITY.slice(
      AUTHORITY.indexOf("const archiveBlockReason"),
    ).slice(0, 400);
    expect(decision).toContain("LEGAL_HOLD_ACTIVE");
    expect(decision).toContain("TERMINAL_DESTROYED");
    expect(decision).toContain("EVIDENCE_LOCKED");
  });

  it("retention is NOT one of them — the boundary stays on destruction", () => {
    const decision = AUTHORITY.slice(
      AUTHORITY.indexOf("const archiveBlockReason"),
    ).slice(0, 400);
    for (const banned of [
      "appRetentionUntil",
      "objectLockRetainUntil",
      "RETENTION",
    ]) {
      expect(
        decision,
        `archive availability must not consult ${banned}`,
      ).not.toContain(banned);
    }
  });

  it("the wire projection carries the reason so no client re-derives it", () => {
    expect(AUTHORITY).toMatch(/archiveBlockReason: caps\.archiveBlockReason,/);
    expect(WEB_TYPES).toMatch(/\n {2}archiveBlockReason:/);
  });
});

describe("the write path refuses with the SAME reason the projection reports", () => {
  it("the canonical mutation service maps an ARCHIVE refusal to archiveBlockReason", () => {
    expect(code(LIFECYCLE_SERVICE)).toMatch(
      /input\.action === "ARCHIVE"\s*\?\s*\(caps\.archiveBlockReason \?\? "ALREADY_IN_STATE"\)/,
    );
  });

  it("the capability gate runs BEFORE the governance gate", () => {
    const body = code(LIFECYCLE_SERVICE);
    const capability = body.indexOf("computeEvidenceLifecycleCapabilities");
    const governance = body.indexOf("runDestructiveActionGate");
    expect(capability).toBeGreaterThan(-1);
    expect(governance).toBeGreaterThan(-1);
    // This ordering is what closes the personal-scope gap: the governance gate
    // returns `allowed` unconditionally when the evidence has no teamId, so a
    // hold that is only enforced there is not enforced for personal records.
    expect(
      capability,
      "the hold must be decided before the gate that skips itself for personal scope",
    ).toBeLessThan(governance);
  });

  it("the hold is resolved by the UNION evaluator, for every scope", () => {
    expect(LIFECYCLE_SERVICE).toMatch(/evaluateEffectiveLegalHold\(/);
    // teamId is passed through as-is, including null. Nothing here branches on
    // tenancy to decide WHETHER to look.
    expect(code(LIFECYCLE_SERVICE)).toMatch(/teamId: evidence\.teamId \?\? null,/);
  });

  it("no plan NAME reaches the lifecycle decision", () => {
    // A plan is a commercial fact. Tenancy comes from the workspace and the
    // membership; the refusal comes from the hold. The harness records a
    // classifier that once derived workspace KIND from `plan FREE`, so this is
    // asserted rather than assumed — and asserted on the two files that
    // actually decide, not repo-wide, because a plan literal is legitimate in
    // billing and entitlement code.
    for (const [label, body] of [
      ["the canonical authority", code(AUTHORITY)],
      ["the lifecycle mutation service", code(LIFECYCLE_SERVICE)],
    ] as const) {
      for (const plan of ["FREE", "PAYG", "PRO", "ENTERPRISE"]) {
        expect(
          body,
          `${label} must not branch on the plan name ${plan}`,
        ).not.toContain(`"${plan}"`);
      }
      for (const token of ["entitlement", "Entitlement", "PlanType", "planType"]) {
        expect(
          body,
          `${label} must not read ${token}`,
        ).not.toContain(token);
      }
    }
  });

  it("single and bulk archive call the same function", () => {
    // Counted on the raw source: the block-comment stripper is too blunt for a
    // 7,000-line route file (a `*/` inside a regex literal swallows the span
    // after it), and undercounting here would turn a structural guard into a
    // flaky one.
    const calls = EVIDENCE_ROUTES.match(/applyEvidenceLifecycleAction\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // No route re-implements the check beside it.
    expect(code(EVIDENCE_ROUTES)).not.toMatch(
      /canArchive\s*=\s*[^;]*lockedAt/,
    );
  });
});

describe("the browser offers no action the backend will refuse", () => {
  it("Evidence Details gates the Archive control on the projection", () => {
    expect(REVIEW_TAB).toMatch(/lifecycle\?\.canArchive \? \(/);
  });

  it("…and reports the archive reason rather than leaving a missing button unexplained", () => {
    expect(REVIEW_TAB).toMatch(/data-evidence-archive-reason=/);
    expect(REVIEW_TAB).toMatch(/lifecycle\?\.archiveBlockReason/);
  });

  it("the blocked-lifecycle heading covers BOTH actions under a hold", () => {
    expect(REVIEW_TAB).toMatch(/Lifecycle changes are unavailable/);
    expect(REVIEW_TAB).toMatch(/trashBlockReason === "LEGAL_HOLD_ACTIVE"/);
  });

  it("the bulk toolbar reads canArchive off the same projection", () => {
    expect(BULK_TOOLBAR).toMatch(/getEvidenceLifecycle\(item\)/);
    expect(BULK_TOOLBAR).toContain("lifecycle.canArchive");
  });

  it("no web surface decides archive from a raw column", () => {
    for (const [name, body] of [
      ["Evidence Details", code(REVIEW_TAB)],
      ["the bulk toolbar", code(BULK_TOOLBAR)],
    ] as const) {
      for (const column of [
        "storageObjectLockLegalHoldStatus",
        "lockedAt",
      ]) {
        expect(
          body,
          `${name} must not re-derive archive availability from ${column}`,
        ).not.toContain(`${column} ?`);
      }
    }
  });
});
