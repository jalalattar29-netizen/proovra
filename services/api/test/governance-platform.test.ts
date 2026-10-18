/**
 * Phase 14 — Governance platform API tests.
 *
 *   - Source-level: case-legal-hold service signs every action with
 *     CASE_LEGAL_HOLD_* custody events.
 *   - Source-level: retention sweeper skips held + recently flagged
 *     evidence; uses RETENTION_CANDIDATE_IDENTIFIED + DELETE_BLOCKED_*
 *     custody events; emits security event on completion.
 *   - Source-level (2026-10-18): the verification disclosure authority is a
 *     compare-and-swap on verificationDisclosureVersion under the record's
 *     advisory lock, with its custody event in the same transaction (the
 *     Phase 14 publication state machine was retired).
 *   - Source-level: public verify never reads publicVerifyState; it gates on
 *     the canonical access state and lifecycle, then applies the disclosure
 *     decision and the one projection.
 *   - Anti-enumeration: new governance routes never respond 403 for
 *     non-admin members (they use 403 only on permission denial via
 *     the policy helper). Cron route lives behind the cron secret.
 *   - Redaction policy: every projection that exposes contributor data
 *     to public surfaces uses the resolved policy.
 *
 * No DB needed — purely source-text + projection contract tests.
 */

import { describe, expect, it } from "vitest";
import { functionSource } from "../../../scripts/source-contract/index.mjs";

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
          "../../../packages/shared-runtime/src/governance/effective-legal-hold.ts",
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
    // custody emissions for CASE-scoped holds — since ET-CUS-03 through the
    // shared hold-custody authority (per covered record, reconciled).
    const canonical = await rf(
      fileURLToPath(
        new URL("../src/services/governance/legal-hold.service.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(canonical).toMatch(/reconcileLegalHoldCustody\(/);
    const holdCustody = await rf(
      fileURLToPath(
        new URL("../../../packages/shared-runtime/src/governance/legal-hold-custody.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(holdCustody).toMatch(/CASE_LEGAL_HOLD_APPLIED/);
    expect(holdCustody).toMatch(/CASE_LEGAL_HOLD_RELEASED/);
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
// Verification disclosure authority (2026-10-18 — replaces the retired
// Phase 14 publication workflow: publication.service.ts was deleted)
// -----------------------------------------------------------------------------

async function readSrc(rel: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  return readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("verification disclosure authority", () => {
  it("the retired publication service is gone", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    expect(
      existsSync(fileURLToPath(new URL("../src/services/governance/publication.service.ts", import.meta.url))),
    ).toBe(false);
  });

  it("uses a compare-and-swap updateMany on verificationDisclosureVersion under the advisory lock", async () => {
    const src = await readSrc("../src/services/public-verify/verification-disclosure.service.ts");
    const fn = functionSource(src, "changeVerificationDisclosure");
    expect(fn).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
    expect(fn).toMatch(
      /tx\.evidence\.updateMany\(\{\s*where:\s*\{\s*id:\s*input\.evidenceId,\s*verificationDisclosureVersion:\s*input\.expectedVersion\s*\}/,
    );
    expect(fn).toMatch(/verificationDisclosureVersion:\s*input\.expectedVersion \+ 1/);
    // A lost swap is a CONFLICT, never a silent overwrite.
    expect(fn).toMatch(/if \(swapped\.count !== 1\) return \{ outcome: "CONFLICT"/);
    // The custody event is appended in the SAME transaction, after the swap.
    const swapIdx = fn.indexOf("tx.evidence.updateMany");
    const custodyIdx = fn.indexOf("appendCustodyEventTx(tx,");
    expect(swapIdx).toBeGreaterThan(-1);
    expect(custodyIdx).toBeGreaterThan(swapIdx);
    expect(fn).toMatch(/eventType:\s*"VERIFICATION_DISCLOSURE_CHANGED"/);
    // It never touches access, and never the retired publication column.
    expect(src).not.toMatch(/verificationAccessState:/);
    expect(src).not.toMatch(/publicVerifyState/);
  });

  it("recorded location requires content preview — refused before any transaction", async () => {
    const { changeVerificationDisclosure, DisclosurePolicyInvalid } = await import(
      "../src/services/public-verify/verification-disclosure.service.js"
    );
    await expect(
      changeVerificationDisclosure({
        evidenceId: "00000000-0000-4000-8000-000000000000",
        actorUserId: "00000000-0000-4000-8000-000000000001",
        mode: "VERIFICATION_ONLY",
        showRecordedLocation: true,
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(DisclosurePolicyInvalid);
  });

  it("what counts as WIDENING (and so needs a fresh step-up) is explicit", async () => {
    const { disclosureWidens } = await import(
      "../src/services/public-verify/verification-disclosure.service.js"
    );
    const VO = { mode: "VERIFICATION_ONLY", showRecordedLocation: false } as const;
    const CP = { mode: "CONTENT_PREVIEW", showRecordedLocation: false } as const;
    const CPL = { mode: "CONTENT_PREVIEW", showRecordedLocation: true } as const;
    expect(disclosureWidens(VO, CP)).toBe(true);
    expect(disclosureWidens(VO, CPL)).toBe(true);
    expect(disclosureWidens(CP, CPL)).toBe(true);
    expect(disclosureWidens(CP, VO)).toBe(false);
    expect(disclosureWidens(CPL, CP)).toBe(false);
    expect(disclosureWidens(CPL, VO)).toBe(false);
    expect(disclosureWidens(CP, CP)).toBe(false);
  });

  it("public verify never reads publicVerifyState; access gates, then the disclosure decision, then the projection", async () => {
    const src = await readSrc("../src/routes/evidence.routes.ts");
    const start = src.indexOf('app.get("/public/verify/:id"');
    expect(start).toBeGreaterThan(-1);
    const route = src.slice(start);
    expect(src).not.toMatch(/publicVerifyState/);
    expect(src).not.toMatch(/publication_not_available/);
    const accessIdx = route.indexOf('if (canonical.status !== "AVAILABLE")');
    const decisionIdx = route.indexOf("const disclosure = resolvePublicVerifyDisclosure(");
    const finalizedIdx = route.indexOf("const isFinalized");
    expect(accessIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(accessIdx);
    expect(finalizedIdx).toBeGreaterThan(decisionIdx);
    // The decision is applied once, by the projection, on the way out.
    expect(src).toMatch(/projectPublicVerification\(fullFacts as unknown as Record<string, unknown>, disclosure/);
    expect(src).toMatch(/projectBasicPublicVerification\(/);
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

  it("the publication routes are retired; PUT verification-disclosure requires evidence.publish_verify", async () => {
    const governance = await readSrc("../src/routes/governance.routes.ts");
    for (const leg of ["publish", "unpublish", "suspend", "restore"]) {
      expect(governance).not.toContain(`"/v1/governance/evidence/:id/${leg}"`);
    }
    const routes = await readSrc("../src/routes/evidence-retention-verification.routes.ts");
    const start = routes.indexOf('app.put("/v1/evidence/:id/verification-disclosure"');
    expect(start).toBeGreaterThan(-1);
    const handler = routes.slice(start, start + 6000);
    expect(handler).toMatch(/authorize\(req, reply, id, "evidence\.publish_verify"/);
    expect(handler).toMatch(/DISCLOSURE_CHANGE_NOT_PERMITTED/);
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
  it("the disclosure custody payload carries the policy change only — no free text", async () => {
    const src = await readSrc("../src/services/public-verify/verification-disclosure.service.ts");
    const fn = functionSource(src, "changeVerificationDisclosure");
    const payload = fn.match(/payload:\s*\{([\s\S]*?)\}/);
    expect(payload).not.toBeNull();
    const keys = [...payload![1].matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    expect(keys).toEqual([
      "changedByUserId",
      "fromMode",
      "fromShowRecordedLocation",
      "toMode",
      "toShowRecordedLocation",
    ]);
  });

  it("the public verify route never selects the retired publication columns", async () => {
    const evidenceRoutes = await readSrc("../src/routes/evidence.routes.ts");
    const verifyBlock = evidenceRoutes.slice(
      evidenceRoutes.indexOf('app.get("/public/verify/:id"'),
      evidenceRoutes.indexOf('app.get("/public/verify/:id"') + 30000,
    );
    expect(verifyBlock).not.toMatch(/publicVerifySuspensionReason/);
    expect(verifyBlock).not.toMatch(/publicVerifyState/);
    // The policy is read for the decision — never as a gate.
    expect(verifyBlock).toMatch(/verificationDisclosureMode: true,/);
    expect(verifyBlock).toMatch(/showRecordedLocation: true,/);
  });
});
