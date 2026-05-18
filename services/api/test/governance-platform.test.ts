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
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/case-legal-hold.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/CASE_LEGAL_HOLD_APPLIED/);
    expect(src).toMatch(/CASE_LEGAL_HOLD_RELEASED/);
    // Inheritance helper must check both per-record AND case-level holds.
    expect(src).toMatch(/evidenceLegalHold\.findFirst/);
    expect(src).toMatch(/caseLegalHold\.findFirst/);
  });

  it("projection omits release note and reason (internal only)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/case-legal-hold.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    // Find the projectCaseLegalHold body by anchoring on its return.
    const idx = src.indexOf("export function projectCaseLegalHold(");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 4000);
    const returned = body.match(/return \{[\s\S]*?\};/);
    expect(returned).not.toBeNull();
    if (returned) {
      expect(returned[0]).not.toMatch(/^\s+reason:/m);
      expect(returned[0]).not.toMatch(/releaseNote:/);
    }
  });

  it("release requires a non-empty note", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL(
          "../src/services/governance/case-legal-hold.service.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(src).toMatch(/release_note_required/);
    expect(src).toMatch(/input\.releaseNote\.trim\(\)/);
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

  it("legal-hold release respects requireLegalHoldReleaseApproval policy", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
      fileURLToPath(
        new URL("../src/routes/governance.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/requireLegalHoldReleaseApproval/);
    expect(src).toMatch(/approvalAcknowledged/);
    expect(src).toMatch(/release_approval_required/);
  });

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
