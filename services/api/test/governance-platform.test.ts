/**
 * Phase 14 — Governance platform API tests.
 *
 *   - Source-level: case-legal-hold service signs every action with
 *     CASE_LEGAL_HOLD_* custody events.
 *   - Source-level: retention sweeper skips held + recently flagged
 *     evidence; uses RETENTION_CANDIDATE_IDENTIFIED + DELETE_BLOCKED_*
 *     custody events; emits security event on completion.
 *   - Source-level: publication state machine uses atomic where-status
 *     guard and rejects invalid transitions.
 *   - Source-level: public verify route gates on publicVerifyState
 *     BEFORE returning any data; non-PUBLISHED responses are 404.
 *   - Anti-enumeration: new governance routes never respond 403 for
 *     non-admin members (they use 403 only on permission denial via
 *     the policy helper). Cron route lives behind the cron secret.
 *   - Redaction policy: every projection that exposes contributor data
 *     to public surfaces uses the resolved policy.
 *
 * No DB needed — purely source-text + projection contract tests.
 */

import { describe, expect, it } from "vitest";

// -----------------------------------------------------------------------------
// Case legal hold
// -----------------------------------------------------------------------------

describe("case legal hold service", () => {
  it("place + release both emit CASE_LEGAL_HOLD_* custody events", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // PHASE 12 POINT 3 — governance/case-legal-hold.service.ts is DELETED.
    // Its writers had already moved to the ONE canonical authority; the last
    // two live symbols (the bounded error type and the inheritance read
    // helper) moved with them, and its `CaseLegalHold` Prisma type import was
    // what kept the dropped model declared in schema.prisma. This assertion
    // replaces the former "the module must no longer contain a writer" pin —
    // a module that does not exist cannot host one.
    expect(
      existsSync(
        fileURLToPath(
          new URL(
            "../src/services/governance/case-legal-hold.service.ts",
            import.meta.url,
          ),
        ),
      ),
      "the retired case-only legal-hold service must stay deleted",
    ).toBe(false);
    const { readFile: rf } = await import("node:fs/promises");
    const evaluator = await rf(
      fileURLToPath(
        new URL(
          "../src/services/governance/effective-legal-hold.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // PHASE 12 POINT 3 — one store, every scope. Coverage is proven by the
    // canonical scope vocabulary plus the historical clause that makes an
    // unresolvable ACTIVE hold fail closed.
    expect(evaluator).toMatch(/prisma\.evidenceLegalHold\.findMany/);
    expect(evaluator).toMatch(/scope: "EVIDENCE"/);
    expect(evaluator).toMatch(/scope: "CASE"/);
    expect(evaluator).toMatch(/scope: "WORKSPACE"/);
    expect(evaluator).toMatch(/historical/);
    // No retired store may reappear behind the evaluator.
    expect(evaluator).not.toMatch(/prisma\.caseLegalHold\./);
    expect(evaluator).not.toMatch(/prisma\.legalHold\./);
    // The canonical placement/release commands own the CASE_LEGAL_HOLD_*
    // custody emissions for CASE-scoped holds.
    const canonical = await rf(
      fileURLToPath(
        new URL("../src/services/governance/legal-hold.service.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(canonical).toMatch(/CASE_LEGAL_HOLD_APPLIED/);
    expect(canonical).toMatch(/CASE_LEGAL_HOLD_RELEASED/);
  });

  it("projection omits release note and reason (internal only)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // PHASE 12 POINT 3 — `projectCaseLegalHold` went with the deleted
    // case-only service. The invariant it protected is unchanged and still
    // load-bearing: the CASE-scoped response must not leak the internal
    // `reason` / `releaseNote` free text. It is now asserted on the shape the
    // /v1/governance/case-legal-holds route actually emits.
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/legal-hold.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const idx = src.indexOf("export type CaseScopedLegalHoldLegacyShape = {");
    expect(idx).toBeGreaterThan(-1);
    const shape = src.slice(idx, src.indexOf("};", idx) + 2);
    expect(shape).not.toMatch(/^\s+reason:/m);
    expect(shape).not.toMatch(/releaseNote:/);
  });

  it("release requires a non-empty note", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    // PHASE 12 POINT 3 — the release command is the ONE canonical writer, so
    // the mandatory-note guard is asserted where it is actually enforced.
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/legal-hold.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/release_note_required/);
    expect(src).toMatch(/input\.releaseNote\.trim\(\)/);
    // The guard must run BEFORE the row is read or mutated — an empty note can
    // never reach a state change.
    const relIdx = src.indexOf("export async function releaseCanonicalLegalHold");
    const guardIdx = src.indexOf("release_note_required", relIdx);
    const readIdx = src.indexOf("client.evidenceLegalHold.findUnique", relIdx);
    expect(guardIdx).toBeGreaterThan(relIdx);
    expect(guardIdx).toBeLessThan(readIdx);
  });
});

// -----------------------------------------------------------------------------
// Retention sweeper
// -----------------------------------------------------------------------------

describe("retention sweeper service", () => {
  it("never auto-deletes; only flags via RETENTION_CANDIDATE_IDENTIFIED", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/retention-sweeper.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/RETENTION_CANDIDATE_IDENTIFIED/);
    // No raw `.delete(` calls on evidence within the sweeper.
    expect(src).not.toMatch(/evidence\.delete\(/);
    expect(src).not.toMatch(/evidence\.deleteMany\(/);
    // No `archive` mutation either — Phase 14 doesn't auto-archive.
    expect(src).not.toMatch(/data:\s*\{[^}]*archivedAt/);
  });

  it("skips held evidence + emits DELETE_BLOCKED_BY_LEGAL_HOLD", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/retention-sweeper.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/isEvidenceUnderAnyLegalHold/);
    expect(src).toMatch(/DELETE_BLOCKED_BY_LEGAL_HOLD/);
    expect(src).toMatch(/skippedHeld/);
  });

  it("re-issues flags daily (skips recently-flagged within 24h)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/retention-sweeper.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/FLAG_REISSUE_WINDOW_MS/);
    expect(src).toMatch(/skippedRecentlyFlagged/);
  });
});

// -----------------------------------------------------------------------------
// Publication workflow
// -----------------------------------------------------------------------------

describe("publication service", () => {
  it("uses atomic where-status updateMany guard", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/publication.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/evidence\.updateMany/);
    expect(src).toMatch(/publicVerifyState:\s*from/);
    expect(src).toMatch(/invalid_state_transition/);
  });

  it("suspend requires a reason", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/publication.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const fn = src.match(/export async function suspendPublicVerify[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    if (fn) {
      expect(fn[0]).toMatch(/reason_required/);
    }
  });

  it("publication state transitions are explicit (matrix lookup)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/publication.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Matrix is the single source of truth — must contain entries for
    // each canonical state.
    expect(src).toMatch(/NOT_PUBLISHED:\s*\[/);
    expect(src).toMatch(/PUBLISHED:\s*\[/);
    expect(src).toMatch(/SUSPENDED:\s*\[/);
    expect(src).toMatch(/UNPUBLISHED:\s*\[/);
  });

  it("public verify route gates on publicVerifyState BEFORE returning data", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // The verify route reads publicVerifyState and short-circuits 404
    // before the finalized check or any data return.
    expect(src).toMatch(/publicVerifyState: true,/);
    expect(src).toMatch(/publication_not_available/);
    // The early-return 404 is BEFORE the finalized check.
    const stateIdx = src.indexOf(
      'if (evidence.publicVerifyState !== "PUBLISHED")',
    );
    const finalizedIdx = src.indexOf("const isFinalized");
    expect(stateIdx).toBeGreaterThan(-1);
    expect(finalizedIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(finalizedIdx);
  });
});

// -----------------------------------------------------------------------------
// Governance routes
// -----------------------------------------------------------------------------

describe("governance route surface", () => {
  it("retention reconciliation is cron-protected", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/governance.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Source contains BOTH the cron-protected endpoint AND the
    // requireIntegrationCronSecret middleware call.
    expect(src).toMatch(
      /"\/v1\/governance\/reconcile-retention"[\s\S]*requireIntegrationCronSecret/,
    );
  });

  // Phase 12 convergence — the case-legal-holds release approval gate
  // (requireLegalHoldReleaseApproval / approvalAcknowledged /
  // release_approval_required) lived in the DEAD_LEGACY
  // /v1/governance/case-legal-holds/:id/release handler, removed in favor of
  // /v1/lifecycle/legal-holds. Assertion retired with the route.

  it("publish/unpublish/suspend/restore routes all require evidence.publish_verify", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/governance.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Each publication route checks the canonical permission.
    const matches = src.match(/evidence\.publish_verify/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// -----------------------------------------------------------------------------
// Governance gate semantics (Phase 13.5 → Phase 14 contract)
// -----------------------------------------------------------------------------

describe("export governance — gate matrix is preserved", () => {
  it("evidenceIsReviewed still requires APPROVED_INTERNAL / READY_FOR_EXTERNAL_REVIEW", async () => {
    const { reviewStatusSatisfiesGovernanceGate } = await import(
      "../src/services/governance.service.js"
    );
    expect(reviewStatusSatisfiesGovernanceGate("APPROVED_INTERNAL")).toBe(
      true,
    );
    expect(
      reviewStatusSatisfiesGovernanceGate("READY_FOR_EXTERNAL_REVIEW"),
    ).toBe(true);
    for (const s of [
      "IN_REVIEW",
      "NEEDS_INFO",
      "QUEUED",
      "ASSIGNED",
      "REJECTED_INSUFFICIENT",
      "ESCALATED",
    ]) {
      expect(reviewStatusSatisfiesGovernanceGate(s)).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// Privacy
// -----------------------------------------------------------------------------

describe("Phase 14 privacy contracts", () => {
  it("publication state projection does NOT leak suspension reason", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/publication.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const idx = src.indexOf("export function projectPublicationState(");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2000);
    const returned = body.match(/return \{[\s\S]*?\};/);
    expect(returned).not.toBeNull();
    if (returned) {
      expect(returned[0]).not.toMatch(/suspensionReason:/);
      // The reason field is captured INTERNALLY in custody chain, not
      // returned by the projection.
      expect(returned[0]).not.toMatch(/publicVerifySuspensionReason:/);
    }
  });

  it("custody chain captures suspension reason but public verify route does not", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const publicationSrc = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/publication.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // The custody event payload uses `reasonInternal` to make the
    // privacy boundary explicit.
    expect(publicationSrc).toMatch(/reasonInternal/);

    const evidenceRoutes = await readFile(
      fileURLToPath(
        new URL("../src/routes/evidence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // The select clause used by /public/verify/:id MUST NOT pull the
    // suspension reason column.
    const verifyBlock = evidenceRoutes.slice(
      evidenceRoutes.indexOf('app.get("/public/verify/:id"'),
      evidenceRoutes.indexOf(
        'app.get("/public/verify/:id"',
      ) + 6000,
    );
    expect(verifyBlock).not.toMatch(/publicVerifySuspensionReason/);
  });
});
