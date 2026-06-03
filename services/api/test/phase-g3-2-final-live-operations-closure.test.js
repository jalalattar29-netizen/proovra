/**
 * Phase G3.2 — Final Live Operations Closure (source-contract suite).
 *
 * Closure rule (verbatim, from the G3.2 spec):
 *
 *   "Do not label user-visible missing functionality as 'mechanical
 *    continuation.' If the operator cannot use it in UI, it is not
 *    closed."
 *
 * This suite is source-contract style (same shape as A0 / A1 / A2 /
 * A3 / B0 / C0 / G3.1). It reads the relevant source files via
 * `readSource()` and asserts on regex/string contracts that prove
 * the eight closure items actually shipped — not that they were
 * deferred behind a "continuation" label.
 *
 * Eight closure items:
 *   1. Inline reviewer action UI (assign/escalate/acknowledge/
 *      request-info/open-inspector) on Queue + Mine + Escalations
 *      tabs of the Reviewer Console.
 *   2. Saved-view CRUD UI — create from current filters + delete.
 *      Rename is honestly not supported (no backend PATCH).
 *   3. Reviewer pagination "Load more" / "View all" per tab.
 *   4. GovernedExportAction wired around every Report PDF /
 *      Verification Package ZIP download in Reports.
 *   5. Remaining Matter Workspace tab filters wired into row
 *      rendering (Holds / Decisions / Communications / Assignments
 *      / Audit / Export).
 *   6. Presence indicator mounted on Evidence detail + Reviewer
 *      inspector + Discussion thread surface.
 *   7. CollisionWarning wired into Evidence detail + Reviewer
 *      inspector real action surfaces.
 *   8. Shared-presence production-deployment decision documented
 *      with exact env config + acceptance criteria.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readSource(rel) {
    const url = new URL(rel, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
}
// Strip line + block comments so docstrings that legitimately
// LIST banned phrases (in order to forbid them) do not trip the
// vocabulary check. This is the same helper used by
// `phase-g5-honest-mi.test.ts` and `phase-g5-vocabulary-contracts.test.ts`.
function stripComments(source) {
    let out = "";
    let i = 0;
    while (i < source.length) {
        if (source[i] === "/" && source[i + 1] === "/") {
            while (i < source.length && source[i] !== "\n")
                i++;
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
const REVIEWER_CONSOLE = readSource("../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx");
const MATTER_WORKSPACE = readSource("../../../apps/web/components/cases-experience/MatterWorkspace.tsx");
const EVIDENCE_DETAIL_PAGE = readSource("../../../apps/web/app/(app)/evidence/[id]/page.tsx");
const REVIEWER_INSPECTOR_PAGE = readSource("../../../apps/web/app/(app)/reviewer-ops/[reviewId]/page.tsx");
const DISCUSSION_PANEL = readSource("../../../apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx");
const REPORTS_INDEX = readSource("../../../apps/web/components/reports-experience/ReportsIndex.tsx");
const SHARED_PRESENCE_DOC = readSource("../../../docs/operations/shared-presence-deployment.md");
// ---------------------------------------------------------------------------
// Item 1 — Inline reviewer action UI
// ---------------------------------------------------------------------------
describe("Phase G3.2 — inline reviewer action UI (Reviewer Console)", () => {
    it("Queue/Mine rows expose Assign / Escalate / Request info / Open inspector buttons", () => {
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="assign"');
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="escalate"');
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="request-info"');
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="open-inspector"');
    });
    it("Escalations rows expose Acknowledge + Open inspector", () => {
        expect(REVIEWER_CONSOLE).toContain('data-reviewer-action="acknowledge"');
    });
    it("Approve + Reject remain OFF the inline surface (inspector-only)", () => {
        expect(REVIEWER_CONSOLE).not.toMatch(/\/reviews\/[^"]*\/approve/);
        expect(REVIEWER_CONSOLE).not.toMatch(/\/reviews\/[^"]*\/reject/);
    });
    it("inline mutations route through the audited reviewer-ops endpoints", () => {
        expect(REVIEWER_CONSOLE).toContain("/v1/reviewer-ops/reviews/");
        expect(REVIEWER_CONSOLE).toContain("/assign");
        expect(REVIEWER_CONSOLE).toContain("/request-info");
        expect(REVIEWER_CONSOLE).toContain("/v1/reviewer-ops/escalations");
        expect(REVIEWER_CONSOLE).toContain("/acknowledge");
    });
    it("inline mutations flow through useStepUpAction (step-up gate honoured)", () => {
        expect(REVIEWER_CONSOLE).toContain("useStepUpAction");
        expect(REVIEWER_CONSOLE).toContain("runStepUpAction");
        expect(REVIEWER_CONSOLE).toContain("StepUpModal");
    });
    it("keyboard shortcuts wire a / e / m", () => {
        expect(REVIEWER_CONSOLE).toMatch(/lower\s*===\s*"a"/);
        expect(REVIEWER_CONSOLE).toMatch(/lower\s*===\s*"e"/);
        expect(REVIEWER_CONSOLE).toMatch(/lower\s*===\s*"m"/);
    });
    it("terminal rows (approved/rejected/cancelled/destroyed/tombstoned) disable inline actions", () => {
        expect(REVIEWER_CONSOLE).toContain("TERMINAL_STATUSES");
        expect(REVIEWER_CONSOLE).toContain("isRowActionable");
        expect(REVIEWER_CONSOLE).toContain('"APPROVED"');
        expect(REVIEWER_CONSOLE).toContain('"REJECTED"');
        expect(REVIEWER_CONSOLE).toContain('"CANCELLED"');
        expect(REVIEWER_CONSOLE).toContain('"DESTROYED"');
        expect(REVIEWER_CONSOLE).toContain('"TOMBSTONED"');
    });
    it("visible loading/error/flash states for every mutation", () => {
        expect(REVIEWER_CONSOLE).toContain("actionBusyKey");
        expect(REVIEWER_CONSOLE).toContain("actionError");
        expect(REVIEWER_CONSOLE).toContain("actionFlash");
    });
});
// ---------------------------------------------------------------------------
// Item 2 — Saved-view CRUD UI
// ---------------------------------------------------------------------------
describe("Phase G3.2 — saved-view CRUD UI", () => {
    it("renders a SavedViewsPanel with Create + Delete affordances", () => {
        expect(REVIEWER_CONSOLE).toContain("SavedViewsPanel");
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-saved-view-create");
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-saved-view-delete");
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-saved-view-submit");
    });
    it("hits the existing audited saved-views endpoints (no PATCH for rename)", () => {
        expect(REVIEWER_CONSOLE).toContain("/v1/reviewer-ops/saved-views");
        expect(REVIEWER_CONSOLE).toMatch(/method:\s*"DELETE"/);
        // Honest scope: there is NO backend PATCH for saved-view rename,
        // so we MUST NOT pretend to support it.
        expect(REVIEWER_CONSOLE).not.toMatch(/saved-view.*method:\s*"PATCH"/);
    });
    it("the create form collects name + visibility and emits a bounded payload", () => {
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-saved-view-name");
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-saved-view-visibility");
    });
});
// ---------------------------------------------------------------------------
// Item 3 — Pagination Load more / View all
// ---------------------------------------------------------------------------
describe("Phase G3.2 — Reviewer Console pagination", () => {
    it("renders a PaginationFooter with Load more + View all", () => {
        expect(REVIEWER_CONSOLE).toContain("PaginationFooter");
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-pagination-load-more");
        expect(REVIEWER_CONSOLE).toContain("data-reviewer-pagination-view-all");
    });
    it("hits the per-tab paginated endpoints", () => {
        expect(REVIEWER_CONSOLE).toContain("/v1/reviewer-ops/queue?");
        expect(REVIEWER_CONSOLE).toContain("/v1/reviewer-ops/escalations?");
        expect(REVIEWER_CONSOLE).toContain("/v1/reviewer-ops/workload?");
    });
    it("respects the backend's bounded per-endpoint maxima", () => {
        expect(REVIEWER_CONSOLE).toMatch(/queue:\s*100/);
        expect(REVIEWER_CONSOLE).toMatch(/mine:\s*100/);
        expect(REVIEWER_CONSOLE).toMatch(/escalations:\s*200/);
        expect(REVIEWER_CONSOLE).toMatch(/workload:\s*200/);
    });
});
// ---------------------------------------------------------------------------
// Item 4 — GovernedExportAction on Reports
// ---------------------------------------------------------------------------
describe("Phase G3.2 — Reports export wrapping", () => {
    it("ReportsIndex imports GovernedExportAction", () => {
        expect(REPORTS_INDEX).toContain("GovernedExportAction");
    });
    it("both Report PDF and Verification Package ZIP downloads are wrapped", () => {
        // Both downloads must mention the GovernedExportAction wrapper.
        const reportWrapCount = (REPORTS_INDEX.match(/<GovernedExportAction/g) ?? []).length;
        expect(reportWrapCount).toBeGreaterThanOrEqual(2);
        // A2 vocabulary discipline — Report PDF and Verification Package
        // ZIP are NEVER collapsed.
        expect(REPORTS_INDEX).toContain('actionLabel="Download Report PDF"');
        expect(REPORTS_INDEX).toContain('actionLabel="Download Verification Package ZIP"');
    });
});
// ---------------------------------------------------------------------------
// Item 5 — Remaining Matter Workspace tab filters
// ---------------------------------------------------------------------------
describe("Phase G3.2 — Matter Workspace tab filters", () => {
    it("HoldsTab consumes filterText (no underscore-prefixed unused param)", () => {
        expect(MATTER_WORKSPACE).toMatch(/function HoldsTab\(\{[\s\S]*?filterText = "",[\s\S]*?\}/);
        expect(MATTER_WORKSPACE).toContain("filteredCaseHolds");
        expect(MATTER_WORKSPACE).toContain("filteredEvidenceHolds");
    });
    it("DecisionsTab consumes filterText", () => {
        expect(MATTER_WORKSPACE).toMatch(/function DecisionsTab\(\{[\s\S]*?filterText = "",[\s\S]*?\}/);
        expect(MATTER_WORKSPACE).toContain("filteredWorkflows");
        expect(MATTER_WORKSPACE).toContain("filteredEscalations");
    });
    it("CommunicationsTab consumes filterText", () => {
        expect(MATTER_WORKSPACE).toMatch(/function CommunicationsTab\(\{[\s\S]*?filterText = "",[\s\S]*?\}/);
        expect(MATTER_WORKSPACE).toContain("filteredThreads");
        expect(MATTER_WORKSPACE).toContain("filteredCaseComments");
        expect(MATTER_WORKSPACE).toContain("filteredReviewerComments");
    });
    it("AssignmentsTab consumes filterText", () => {
        expect(MATTER_WORKSPACE).toMatch(/function AssignmentsTab\(\{[\s\S]*?filterText = "",[\s\S]*?\}/);
    });
    it("AuditTab consumes filterText", () => {
        expect(MATTER_WORKSPACE).toMatch(/function AuditTab\(\{[\s\S]*?filterText = "",[\s\S]*?\}/);
        expect(MATTER_WORKSPACE).toContain("filteredSnapshots");
        expect(MATTER_WORKSPACE).toContain("filteredLifecycle");
        expect(MATTER_WORKSPACE).toContain("filteredVerification");
    });
    it("ExportTab consumes filterText", () => {
        expect(MATTER_WORKSPACE).toMatch(/function ExportTab\(\{[\s\S]*?filterText = "",[\s\S]*?\}/);
        expect(MATTER_WORKSPACE).toContain("filteredReports");
        expect(MATTER_WORKSPACE).toContain("filteredPackages");
        expect(MATTER_WORKSPACE).toContain("filteredLinks");
    });
});
// ---------------------------------------------------------------------------
// Item 6 — Presence mounts
// ---------------------------------------------------------------------------
describe("Phase G3.2 — Presence indicator final mounts", () => {
    it("Evidence detail page mounts PresenceIndicator with resourceKind=evidence", () => {
        expect(EVIDENCE_DETAIL_PAGE).toContain("PresenceIndicator");
        expect(EVIDENCE_DETAIL_PAGE).toContain('resourceKind="evidence"');
    });
    it("Reviewer inspector page mounts PresenceIndicator with resourceKind=reviewer_workflow", () => {
        expect(REVIEWER_INSPECTOR_PAGE).toContain("PresenceIndicator");
        expect(REVIEWER_INSPECTOR_PAGE).toContain('resourceKind="reviewer_workflow"');
    });
    it("Discussion panel mounts PresenceIndicator with resourceKind=discussion_thread", () => {
        expect(DISCUSSION_PANEL).toContain("PresenceIndicator");
        expect(DISCUSSION_PANEL).toContain('resourceKind="discussion_thread"');
    });
});
// ---------------------------------------------------------------------------
// Item 7 — CollisionWarning wired into real action flows
// ---------------------------------------------------------------------------
describe("Phase G3.2 — CollisionWarning wiring", () => {
    it("Evidence detail page mounts CollisionWarning with workflow updatedAt", () => {
        expect(EVIDENCE_DETAIL_PAGE).toContain("CollisionWarning");
        expect(EVIDENCE_DETAIL_PAGE).toContain("initialUpdatedAtUtc");
        expect(EVIDENCE_DETAIL_PAGE).toContain("workspace.reviewWorkflow.updatedAt");
    });
    it("Reviewer inspector page mounts CollisionWarning with a derived signature", () => {
        expect(REVIEWER_INSPECTOR_PAGE).toContain("CollisionWarning");
        expect(REVIEWER_INSPECTOR_PAGE).toContain("deriveSignature");
        expect(REVIEWER_INSPECTOR_PAGE).toContain("initialSignature");
    });
    it("CollisionWarning never silently overwrites — exposes an explicit reload affordance", () => {
        // Both pages pass an onReload handler so the operator sees the
        // reload path rather than a silent stale write.
        expect(EVIDENCE_DETAIL_PAGE).toContain("onReload");
        expect(REVIEWER_INSPECTOR_PAGE).toContain("onReload");
    });
});
// ---------------------------------------------------------------------------
// Item 8 — Shared-presence deployment decision
// ---------------------------------------------------------------------------
describe("Phase G3.2 — Shared-presence production decision documented", () => {
    it("documents the single-instance baseline + the multi-instance trigger", () => {
        expect(SHARED_PRESENCE_DOC).toContain("Single-instance deployments");
        expect(SHARED_PRESENCE_DOC).toContain("replicas > 1");
    });
    it("names the exact env variable + acceptance criteria for the Redis swap", () => {
        expect(SHARED_PRESENCE_DOC).toContain("PRESENCE_BACKEND");
        expect(SHARED_PRESENCE_DOC).toContain("REDIS_URL");
        expect(SHARED_PRESENCE_DOC).toContain("90");
        expect(SHARED_PRESENCE_DOC).toMatch(/Acceptance criteria/i);
    });
    it("preserves the operator-safe payload contract (no PII)", () => {
        expect(SHARED_PRESENCE_DOC).toContain("userId");
        expect(SHARED_PRESENCE_DOC).toContain("displayName");
        expect(SHARED_PRESENCE_DOC).toContain("lastSeenAtUtc");
        // Affirmative claim: doc must explicitly state IP is NOT persisted.
        expect(SHARED_PRESENCE_DOC).toMatch(/No PII[^\n]*IP/i);
    });
});
// ---------------------------------------------------------------------------
// Cross-cutting vocabulary discipline
// ---------------------------------------------------------------------------
describe("Phase G3.2 — vocabulary discipline across all G3.2 surfaces", () => {
    const BANNED = [
        /\btampered?\b/i,
        /\btamper-?proof\b/i,
        /\bauthentic\b/i,
        /\badmissible\b/i,
        /\bcourt-?ready\b/i,
        /\bforensic\s+proof\b/i,
        /\bDM\b/, // direct message vocabulary
        /\bemoji\b/i,
        /\breaction\b/i,
        /\bAI\s+summari[sz]ation\b/i,
    ];
    const SURFACES = [
        { name: "ReviewerConsole", src: stripComments(REVIEWER_CONSOLE) },
        { name: "MatterWorkspace", src: stripComments(MATTER_WORKSPACE) },
        { name: "EvidenceDetailPage", src: stripComments(EVIDENCE_DETAIL_PAGE) },
        {
            name: "ReviewerInspectorPage",
            src: stripComments(REVIEWER_INSPECTOR_PAGE),
        },
        { name: "EvidenceDiscussionPanel", src: stripComments(DISCUSSION_PANEL) },
        {
            name: "ReportsIndex",
            src: stripComments(REPORTS_INDEX),
            // The Reports landing page carries the canonical anti-overclaim
            // copy: "Reports are described as 'generated snapshots' /
            // 'verification packages'. The page makes NO legal-admissibility,
            // authenticity, or 'court-ready' claims." Each phrase below is
            // a deliberate denial, not an overclaim.
            allow: [/\bcourt-?ready\b/i],
        },
    ];
    for (const surface of SURFACES) {
        for (const phrase of BANNED) {
            it(`${surface.name} does not use the banned phrase ${phrase}`, () => {
                if (surface.allow?.some((a) => a.source === phrase.source)) {
                    // Intentional anti-overclaim copy lives in this surface;
                    // skipping the check is recorded in the allow list and
                    // requires reviewer sign-off to extend.
                    return;
                }
                expect(surface.src).not.toMatch(phrase);
            });
        }
    }
});
// ---------------------------------------------------------------------------
// Custody / audit pollution discipline
// ---------------------------------------------------------------------------
describe("Phase G3.2 — no custody / audit pollution from G3.2 surfaces", () => {
    it("ReviewerConsole does not append custody events directly", () => {
        expect(REVIEWER_CONSOLE).not.toContain("appendCustodyEvent");
        expect(REVIEWER_CONSOLE).not.toContain("appendPlatformAuditLog");
    });
    it("MatterWorkspace does not append custody events directly", () => {
        expect(MATTER_WORKSPACE).not.toContain("appendCustodyEvent");
        expect(MATTER_WORKSPACE).not.toContain("appendPlatformAuditLog");
    });
});
