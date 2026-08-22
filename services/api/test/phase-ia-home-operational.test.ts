/**
 * Phase IA-home-operational — the world-class operational Home contract.
 *
 * Home is an operating surface, not a second sidebar. This pins the new
 * operational widgets — Operational Queue, Intake Pipeline, Report
 * Production, Verification Health, Workspace Health, Active Matters —
 * against the testing requirements in the execution brief:
 *
 *   2  Operational Queue is the first major widget
 *   3  Intake Pipeline shows real status from intake + communications
 *   4  Report Production shows ready / pending / failed
 *   5  Verification Health shows live / suspended / unpublished
 *   6  Workspace Health summarizes work state (good/warn/problem)
 *  11  No widget is static marketing copy
 *  12  No fake TSA/OTS/signature values
 *  13  Empty states include useful next actions
 *
 * (1, 9, 10, 14 live in the no-dup-cta + cta-validation suites; 7, 8 in
 * phase-ia-home-v2.)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  normalizeHomeViewModel,
  type HomeBillingInput,
  type HomeCommandCenterInput,
  type HomeCommunicationsInput,
  type HomeInboxInput,
  type HomeIntakeLinksInput,
  type HomeReportsInput,
  type HomeTrustSummaryInput,
  type NormalizeInputs,
} from "../../../apps/web/components/home-experience/home-view-model";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const SECTIONS = readWeb("components/home-experience/HomeSections.tsx");
const WS = "00000000-0000-0000-0000-0000000000aa";
const NOW = Date.UTC(2026, 5, 12, 12, 0, 0);

const CC: HomeCommandCenterInput = {
  sections: {
    caseOperations: {
      status: "ok",
      data: {
        activeCasesCount: 3,
        casesWithEvidenceGapsCount: 1,
        topCases: [
          { caseId: "c-1", caseName: "Jones v Smith", evidenceCount: 12, unreviewedCount: 2, overdueReviewCount: 1, openEscalationsCount: 0, hasActiveLegalHold: true, lastActivityAtUtc: "2026-06-12T08:00:00Z" },
          { caseId: "c-2", caseName: "Clean matter", evidenceCount: 4, unreviewedCount: 0, overdueReviewCount: 0, openEscalationsCount: 0, hasActiveLegalHold: false, lastActivityAtUtc: "2026-06-10T08:00:00Z" },
        ],
      },
    },
    pipelineDetail: {
      status: "ok",
      data: {
        evidence: { uploaded: 2, signed: 3, reported: 5 },
        reports: { ready: 5, queued: 1, failed: 2, missingFromSigned: 3 },
        packages: { ready: 4, queued: 0, blocked: 1, failed: 1, missingFromReported: 2 },
        publicVerify: { published: 4, unpublished: 6, suspended: 1 },
      },
    },
    timeline: { status: "ok", items: [] },
  },
};

const TRUST: HomeTrustSummaryInput = {
  totalEvidence: 11,
  tsa: { stamped: 9, pending: 1, failed: 1 },
  ots: { anchored: 8, pending: 2, failed: 1 },
  signed: 10,
  publicVerify: { published: 4, unpublished: 6, suspended: 1 },
  needingAttention: 2,
};

const REPORTS: HomeReportsInput = {
  items: [
    { evidenceId: "ev-1", title: "Door cam", report: { available: true, version: 3, generatedAtUtc: "2026-06-12T10:00:00Z" }, package: { available: true } },
    { evidenceId: "ev-2", title: "Voice memo", report: { available: true, version: 1, generatedAtUtc: "2026-06-12T09:00:00Z" }, package: { available: false } },
  ],
};

const INTAKE: HomeIntakeLinksInput = {
  links: [
    { id: "lk-1", recipientLabel: "Witness A", status: "ACTIVE", usedCount: 1, maxUses: 1, expiresAtUtc: "2026-07-01T00:00:00Z", createdAt: "2026-06-12T08:00:00Z" },
    { id: "lk-2", recipientLabel: "Witness B", status: "ACTIVE", usedCount: 0, maxUses: 1, expiresAtUtc: "2026-07-01T00:00:00Z", createdAt: "2026-06-12T08:00:00Z" },
  ],
};

const COMMS: HomeCommunicationsInput = {
  messages: [
    { id: "m-1", channel: "SMS", status: "DELIVERED", createdAt: "2026-06-12T08:05:00Z", deliveredAtUtc: "2026-06-12T08:06:00Z", relatedIntakeLinkId: "lk-1" },
    { id: "m-2", channel: "WHATSAPP", status: "FAILED", createdAt: "2026-06-12T08:05:00Z", failedAtUtc: "2026-06-12T08:06:00Z", relatedIntakeLinkId: "lk-2" },
  ],
};

const INBOX: HomeInboxInput = {
  items: [
    { id: "intake_submission_pending_review:r-1", category: "intake_submission_pending_review", title: "Witness statement", href: "/evidence-requests/r-1", occurredAt: "2026-06-12T07:00:00Z", context: { teamId: WS, status: "RESPONSE_RECEIVED" } },
    { id: "report_failure:i-1", category: "report_failure", title: "Report generation failure", body: "x", href: "/evidence/ev-3?tab=integrity", occurredAt: "2026-06-12T06:00:00Z", context: { teamId: WS } },
  ],
};

function build(overrides: Partial<NormalizeInputs> = {}) {
  return normalizeHomeViewModel({
    plan: "PRO",
    workspaceId: WS,
    activeSpaceType: "ORGANIZATION",
    commandCenter: CC,
    trustSummary: TRUST,
    billing: null,
    reports: REPORTS,
    intakeLinks: INTAKE,
    inbox: INBOX,
    communications: COMMS,
    orgs: null,
    nowMs: NOW,
    ...overrides,
  });
}

// ============================================================================
// 2. Operational Queue
// ============================================================================

/**
 * CONTRACT MIGRATION — Attention Architecture Phase 4C (2026-08-22).
 *
 * These five tests exercised `vm.operationalQueue`, which Home built for
 * itself out of the caller's own `/v1/me/inbox` feed and then rendered as the
 * WORKSPACE'S operational state. The queue is gone, and with it every one of
 * the properties tested here — ordering, capping, inline-retry-vs-fallback —
 * because those are properties of a WORK SURFACE and Home is not one.
 *
 * They are not lost. They moved to where the work actually lives:
 *
 *   ordering / capping / paging   -> /operations (Phase 6 console)
 *   inline vs fallback actions    -> /operations, capability-gated
 *   "no actionable work" hero     -> Home, but now gated on whether the
 *                                    canonical summary could be READ, which
 *                                    the old empty-queue check could not
 *                                    distinguish from "we saw nothing".
 *
 * What replaces them here is the property Home must now have: it CONSUMES a
 * shared summary and derives nothing.
 */
describe("Phase IA-home-operational — Operations summary is consumed, not built", () => {
  it("Home exposes no operational queue of its own", () => {
    const vm = build();
    expect(
      (vm as unknown as Record<string, unknown>).operationalQueue,
    ).toBeUndefined();
  });

  it("Home carries the canonical summary and a link to act on it", () => {
    const vm = build();
    expect(vm.operations).toBeDefined();
    expect(vm.operations.href).toBe("/operations");
  });

  it("without a summary Home says UNAVAILABLE rather than showing zero work", () => {
    // The old empty-queue assertion could not tell "nothing to do" from
    // "we could not look". This one can, and must.
    const vm = build();
    expect(vm.operations.available).toBe(false);
    expect(vm.operations.mayAssertAllClear).toBe(false);
  });

  it("a rich notification feed does not populate the workspace summary", () => {
    // The coupling this phase removed, asserted directly: personal items in
    // the feed contribute nothing to shared operational counts.
    const vm = build();
    expect(vm.operations.open).toBe(0);
    expect(vm.operations.critical).toBe(0);
  });
});

// ============================================================================
// 3. Intake Pipeline
// ============================================================================

describe("Phase IA-home-operational — Intake Pipeline", () => {
  it("shows real lifecycle counts from intake links + communications", () => {
    // Phase HOME-FIELD-WIRING (Ticket 2) — every stage is a DISTINCT
    // real count; the old "received" stage (which duplicated the
    // pending-review number) is gone.
    const vm = build();
    const byKey = Object.fromEntries(vm.intakePipeline.stages.map((s) => [s.key, s.count]));
    expect(byKey.active).toBe(2); // lk-1 + lk-2 ACTIVE
    expect(byKey.delivered).toBe(1); // m-1 has deliveredAtUtc
    expect(byKey.awaiting).toBe(1); // lk-2 unused
    expect(byKey.in_review).toBe(1); // r-1 pending-review inbox item
    expect(byKey.needs_more).toBe(0); // no intake_required_items_missing
    expect(byKey.failed).toBe(1); // m-2 failed
    expect(byKey.received).toBeUndefined(); // duplicated stage removed
  });

  it("pending review and needs-more-info come from DIFFERENT inbox categories", () => {
    const vm = build({
      inbox: {
        items: [
          ...(INBOX.items ?? []),
          { id: "intake_required_items_missing:r-2", category: "intake_required_items_missing", title: "More material needed", href: "/evidence-requests/r-2", occurredAt: "2026-06-12T07:30:00Z", context: { teamId: WS, status: "NEEDS_MORE_INFO" } },
        ],
      },
    });
    const byKey = Object.fromEntries(vm.intakePipeline.stages.map((s) => [s.key, s.count]));
    expect(byKey.in_review).toBe(1);
    expect(byKey.needs_more).toBe(1);
  });

  it("the failed stage is toned danger when there are failed sends", () => {
    const vm = build();
    const failed = vm.intakePipeline.stages.find((s) => s.key === "failed");
    expect(failed?.tone).toBe("danger");
  });

  it("is empty only when there is genuinely no intake activity", () => {
    const vm = build({ intakeLinks: null, communications: null, inbox: null });
    expect(vm.intakePipeline.empty).toBe(true);
  });

  it("the card renders a locked/upgrade explanation (not a blank) when intake is not included", () => {
    expect(SECTIONS).toMatch(/data-intake-locked/);
    expect(SECTIONS).toMatch(/data-intake-upgrade/);
    // PHASE 12B Track 1A — the lock is the SERVER-projected entitlement
    // (features.intakeIncluded), never a client plan-name decision.
    const DASH = readWeb("components/home-experience/SelfServeHomeDashboard.tsx");
    expect(DASH).toMatch(/locked=\{!intakeIncluded\}/);
  });
});

// ============================================================================
// 4. Report Production
// ============================================================================

describe("Phase IA-home-operational — Report Production", () => {
  it("surfaces ready / pending / failed from the real pipeline projection", () => {
    // Phase HOME-FIELD-WIRING (Ticket 1) — the API's missingFromSigned/
    // missingFromReported are LITERAL ALIASES of `queued`; pending now
    // reads the single authoritative counter (never the sum).
    const vm = build();
    expect(vm.reportProduction.reportsReady).toBe(5);
    expect(vm.reportProduction.packagesReady).toBe(4);
    expect(vm.reportProduction.reportsPending).toBe(1); // queued only
    expect(vm.reportProduction.packagesPending).toBe(0); // queued only
    expect(vm.reportProduction.reportsFailed).toBe(2);
    expect(vm.reportProduction.packagesFailed).toBe(1 + 1); // failed + blocked
  });

  it("duplicate-alias payload never double-counts (queued=5 alias=5 ⇒ pending=5)", () => {
    const vm = build({
      commandCenter: {
        sections: {
          pipelineDetail: {
            status: "ok",
            data: {
              reports: { ready: 0, queued: 5, failed: 0, missingFromSigned: 5 },
              packages: { ready: 0, queued: 3, blocked: 0, failed: 0, missingFromReported: 3 },
            },
          },
        },
      },
    });
    expect(vm.reportProduction.reportsPending).toBe(5);
    expect(vm.reportProduction.packagesPending).toBe(3);
  });

  it("older payloads carrying only the alias still surface pending (fallback, not zero)", () => {
    const vm = build({
      commandCenter: {
        sections: {
          pipelineDetail: {
            status: "ok",
            data: {
              reports: { ready: 0, failed: 0, missingFromSigned: 7 },
              packages: { ready: 0, failed: 0, missingFromReported: 2 },
            },
          },
        },
      },
    });
    expect(vm.reportProduction.reportsPending).toBe(7);
    expect(vm.reportProduction.packagesPending).toBe(2);
  });

  it("the card renders a failed status stat (not only ready rows)", () => {
    expect(SECTIONS).toMatch(/data-report-production-stats/);
    expect(SECTIONS).toMatch(/label="Failed"/);
  });
});

// ============================================================================
// 5. Verification Health
// ============================================================================

describe("Phase IA-home-operational — Verification Health", () => {
  it("shows live / unpublished / suspended from real publicVerify counts", () => {
    const vm = build();
    expect(vm.verificationHealth.live).toBe(4);
    expect(vm.verificationHealth.suspended).toBe(1);
    // unpublished = total − live − suspended = 11 − 4 − 1 = 6.
    expect(vm.verificationHealth.unpublished).toBe(6);
  });

  it("lists verifiable records (those with a ready package + verify link)", () => {
    const vm = build();
    expect(vm.verificationHealth.verifiable.map((v) => v.evidenceId)).toContain("ev-1");
    expect(vm.verificationHealth.verifiable.find((v) => v.evidenceId === "ev-2")).toBeUndefined(); // no package
  });

  it("is a zero scaffold when there is no evidence (no fabricated state)", () => {
    const vm = build({ commandCenter: null, trustSummary: { totalEvidence: 0 }, reports: null });
    expect(vm.verificationHealth.empty).toBe(true);
    expect(vm.verificationHealth.live).toBe(0);
    expect(SECTIONS).toMatch(/data-verify-empty/);
  });
});

// ============================================================================
// 6. Workspace Health
// ============================================================================

describe("Phase IA-home-operational — Workspace Health", () => {
  it("summarizes work state with good/warn/problem verdicts, not raw inventory", () => {
    const vm = build();
    const byKey = Object.fromEntries(vm.workspaceHealth.map((m) => [m.key, m]));
    expect(byKey.complete.value).toBe(5);
    expect(byKey.complete.tone).toBe("ok");
    expect(byKey.need_report.tone).toBe("warn"); // missingFromSigned = 3
    expect(byKey.integrity.tone).toBe("danger"); // needingAttention + failures > 0
    expect(byKey.submissions.tone).toBe("warn"); // 1 submission waiting
  });

  it("storage metric reflects the real usage tone", () => {
    const billing: HomeBillingInput = {
      workspaces: { personal: { storage: { usedLabel: "9 GB", limitLabel: "10 GB", usagePercent: 92, nearLimit: true, limitReached: false } } },
    };
    const vm = build({ billing });
    const storage = vm.workspaceHealth.find((m) => m.key === "storage");
    expect(storage?.tone).toBe("warn");
  });
});

// ============================================================================
// 11 + 12. No static marketing / no fake trust values
// ============================================================================

describe("Phase IA-home-operational — honesty guards", () => {
  it("the operational widgets contain no static marketing / fake-trust copy", () => {
    const banned = [
      /military-grade/i,
      /bank-grade/i,
      /world-class/i,
      /100% secure/i,
      /✓\s*Verified\b/, // a hardcoded green check, not a live count
      /Digital signatures on every captured record/,
    ];
    for (const re of banned) expect(SECTIONS).not.toMatch(re);
  });

  it("trust + verification values are computed from inputs, never literals", () => {
    // The trust card reads live fields; verification reads publicVerify.
    expect(SECTIONS).toMatch(/trust\.tsaStamped/);
    expect(SECTIONS).toMatch(/trust\.otsAnchored/);
    expect(SECTIONS).toMatch(/health\.live/);
    expect(SECTIONS).toMatch(/health\.suspended/);
  });
});

// ============================================================================
// 13. Empty states carry a useful next action
// ============================================================================

describe("Phase IA-home-operational — useful empty states", () => {
  it("intake pipeline empty → create-intake-link CTA", () => {
    expect(SECTIONS).toMatch(/data-collection-cta="create-intake-link"/);
    expect(SECTIONS).toMatch(/href="\/intake-links\?new=1"/);
  });
  it("active matters empty → create-case CTA", () => {
    expect(SECTIONS).toMatch(/data-case-cta="create-case"/);
  });
  it("trust state empty → capture-first CTA + zero scaffold", () => {
    expect(SECTIONS).toMatch(/data-trust-cta="capture-first"/);
    expect(SECTIONS).toMatch(/data-trust-empty/);
  });
  it("report production empty is plan-aware", () => {
    expect(SECTIONS).toMatch(/Pay-Per-Evidence, Pro, and Team/);
  });
});
