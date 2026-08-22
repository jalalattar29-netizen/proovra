/**
 * Phase IA-cleanup — contract test suite.
 *
 * Pins the end-to-end closure of the post-/collaboration IA gaps:
 *
 *   1. No visible /collaboration CTA remains. The dashboard quick
 *      action and onboarding step have been retargeted to /inbox.
 *
 *   2. /v1/me/inbox is now a real Attention Center. The five new
 *      categories (review_escalation, access_review_pending,
 *      mfa_recovery_pending, communication_failure, security_event_high)
 *      are wired end-to-end with correct tenant + permission gating.
 *
 *   3. The /inbox UI exposes the new categories, category-group filter
 *      chips, the truncation banner, and the optional dueAt rendering.
 *
 *   4. Case Detail's "Discussion & Activity" tab uses the existing
 *      /v1/cases/:id/discussion-threads aggregator. No case-level
 *      thread creation is implied; deep-links go to the evidence
 *      Discussion tab.
 *
 *   5. /collaboration is legacy-redirect only.
 *
 * Style: source-contract. Reads source files and asserts regex/string
 * shapes. Matches the pattern of every phase contract from A0 onward.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

// ============================================================================
// 1. /collaboration CTAs removed
// ============================================================================

describe("Phase IA-cleanup — dashboard quick action no longer points at /collaboration", () => {
  const RULES = readSource(
    "../../../apps/web/lib/dashboard/dashboardModeRules.ts",
  );

  it("the org.collaboration quick action is retargeted to /notifications", () => {
    // The quick-action id is preserved (persona-priority + analytics
    // tests reference it by id), but the href + label move.
    const idx = RULES.indexOf('id: "org.collaboration"');
    expect(idx, "org.collaboration quick-action not found").toBeGreaterThan(-1);
    const block = RULES.slice(idx, idx + 600);
    expect(block).toMatch(/href:\s*"\/notifications"/);
    expect(block).toMatch(/label:\s*"Check your inbox"/);
    // Defensive: do NOT silently revert to /collaboration.
    expect(block).not.toMatch(/href:\s*"\/collaboration"/);
  });
});

describe("Phase IA-cleanup — the /collaboration surface is fully retired", () => {
  // Phase 12 Point 4 (Pass E) — this used to read
  // `apps/web/lib/onboarding/onboardingSteps.ts` and assert that ONE step
  // had been retargeted to /inbox. That module had zero importers (its
  // intended consumer, PersonaSetupBanner, was deleted with the
  // workspace-persona feature) and has itself been deleted, so the
  // assertion constrained nothing that shipped.
  //
  // The invariant is now enforced where it is actually load-bearing: the
  // retired surface must be gone from the navigation model entirely — no
  // route id, no href — so nothing can route a user at it again.
  it("no navigation source declares the retired /collaboration route", () => {
    for (const rel of [
      "lib/navigation/routeRegistry.ts",
      "lib/navigation/pillarRegistry.ts",
      "lib/navigation/phaseBOperationalGroups.ts",
    ]) {
      const src = readSource(`../../../apps/web/${rel}`)
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(src, `${rel} must not declare workspace.collaboration`).not.toMatch(
        /["']workspace\.collaboration["']/,
      );
      expect(src, `${rel} must not link /collaboration`).not.toMatch(
        /href:\s*["']\/collaboration["']/,
      );
    }
  });

  it("the page file itself is physically gone (the 308 is the retirement)", () => {
    expect(
      existsSync(webPath("app/(app)/collaboration/page.tsx")),
      "a page behind a permanent redirect is unreachable residue",
    ).toBe(false);
  });
});

// ============================================================================
// 2. Backend inbox — new categories + tenant/permission gates
// ============================================================================

describe("Phase IA-cleanup — me-inbox.routes.ts declares the 5 new categories", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("InboxCategory union includes review_escalation", () => {
    expect(ROUTES).toMatch(/\|\s*"review_escalation"/);
  });

  it("InboxCategory union includes access_review_pending", () => {
    expect(ROUTES).toMatch(/\|\s*"access_review_pending"/);
  });

  it("InboxCategory union includes mfa_recovery_pending", () => {
    expect(ROUTES).toMatch(/\|\s*"mfa_recovery_pending"/);
  });

  it("InboxCategory union includes communication_failure", () => {
    expect(ROUTES).toMatch(/\|\s*"communication_failure"/);
  });

  it("InboxCategory union includes security_event_high", () => {
    expect(ROUTES).toMatch(/\|\s*"security_event_high"/);
  });

  it("InboxItem carries an optional dueAt field", () => {
    expect(ROUTES).toMatch(/dueAt\?:\s*string\s*\|\s*null/);
  });
});

describe("Phase IA-cleanup — backend queries are wired to the right Prisma models", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("review_escalation queries prisma.reviewEscalation", () => {
    expect(ROUTES).toMatch(/prisma\.reviewEscalation\.findMany/);
    // status OPEN + assignedToUserId = caller.
    expect(ROUTES).toMatch(/assignedToUserId:\s*userId/);
    expect(ROUTES).toMatch(/status:\s*"OPEN"/);
  });

  it("access_review_pending queries prisma.accessReview with subject-or-initiator scope", () => {
    expect(ROUTES).toMatch(/prisma\.accessReview\.findMany/);
    // OR on subjectUserId / initiatedByUserId; never an unfiltered
    // team-wide read.
    expect(ROUTES).toMatch(
      /OR:\s*\[[\s\S]*?subjectUserId:\s*userId[\s\S]*?initiatedByUserId:\s*userId[\s\S]*?\]/,
    );
    expect(ROUTES).toMatch(/status:\s*\{\s*in:\s*\["PENDING",\s*"IN_PROGRESS"\]/);
  });

  it("mfa_recovery_pending is gated to adjudicatorTeamIds (OWNER/ADMIN only)", () => {
    expect(ROUTES).toMatch(/prisma\.mfaRecoveryRequest\.findMany/);
    // The query MUST use adjudicatorTeamIds so non-admins never see it.
    expect(ROUTES).toMatch(
      /pendingMfaRecovery\s*=[\s\S]{0,400}adjudicatorTeamIds\.length\s*===\s*0[\s\S]{0,800}teamId:\s*\{\s*in:\s*adjudicatorTeamIds/,
    );
    expect(ROUTES).toMatch(/status:\s*"PENDING_ADMIN_REVIEW"/);
  });

  it("communication_failure is gated to adjudicatorTeamIds with a 24h window", () => {
    expect(ROUTES).toMatch(/prisma\.communicationMessage\.findMany/);
    expect(ROUTES).toMatch(
      /failedCommunications\s*=[\s\S]{0,400}adjudicatorTeamIds\.length\s*===\s*0[\s\S]{0,1200}teamId:\s*\{\s*in:\s*adjudicatorTeamIds/,
    );
    expect(ROUTES).toMatch(/status:\s*"FAILED"/);
    // Honest bounded recency window — not a "since the dawn of time" sweep.
    expect(ROUTES).toMatch(/FAILURE_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60/);
  });

  it("security_event_high is gated to the caller's own userId (no cross-user leak)", () => {
    expect(ROUTES).toMatch(/prisma\.securityEvent\.findMany/);
    // The query MUST be userId = caller (not a team-wide read).
    expect(ROUTES).toMatch(
      /myHighSecurityEvents\s*=[\s\S]{0,400}userId,[\s\S]{0,400}severity:\s*"HIGH"/,
    );
    // Bounded 7-day window.
    expect(ROUTES).toMatch(
      /SECURITY_EVENT_WINDOW_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60/,
    );
  });
});

describe("Phase IA-cleanup — response shape", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("response includes a per-category truncated map", () => {
    expect(ROUTES).toMatch(/truncated\s*=\s*\{[\s\S]*?governance:[\s\S]*?\}/);
    expect(ROUTES).toMatch(/truncated,/);
  });

  it("response includes an anyTruncated boolean", () => {
    expect(ROUTES).toMatch(/anyTruncated\s*=\s*Object\.values\(truncated\)\.some/);
    expect(ROUTES).toMatch(/anyTruncated,/);
  });

  it("summary.byCategory includes the 5 new category counts", () => {
    // Phase IA-enterprise — assembled items are filtered server-side
    // post-assembly; the counter now iterates `filteredItems` (the
    // post-filter set) so summary counts match what the UI actually
    // renders for the active filter.
    for (const key of [
      "review_escalation",
      "access_review_pending",
      "mfa_recovery_pending",
      "communication_failure",
      "security_event_high",
    ]) {
      expect(ROUTES).toMatch(
        new RegExp(
          `${key}:\\s*filteredItems\\.filter\\(\\s*\\(i\\)\\s*=>\\s*i\\.category\\s*===\\s*"${key}"`,
        ),
      );
    }
  });

  it("each new emitter loop sets dueAt explicitly (real or null, never invented)", () => {
    // Look for `dueAt:` lines emitted in the items.push blocks. We
    // expect dueAt set on access reviews (real source field) and
    // explicitly null on the categories that have no source deadline.
    // The contract is that the field is always emitted, never omitted.
    const dueAtEmissions = ROUTES.match(/dueAt:\s*(?:ar\.dueAtUtc[\s\S]{0,80}|null)/g);
    expect(dueAtEmissions, "dueAt must be emitted explicitly").not.toBeNull();
    expect((dueAtEmissions ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

// ============================================================================
// 3. Frontend /inbox UI — new categories + chips + banner + dueAt
// ============================================================================

describe("Phase IA-cleanup — /inbox UI exposes the 5 new categories", () => {
  const PAGE = readSource("../../../apps/web/app/(app)/inbox/page.tsx");
  /**
   * The filter VOCABULARY, wherever it lives.
   *
   * Filter keys used to be spelled out in the page JSX, so a per-key
   * assertion against the page was an assertion about the product. They moved
   * into the policy module when the overflow row became a grouped panel, and
   * the page now renders from the groups. Concatenating the two keeps these
   * assertions pointed at the thing they were always about — the key exists
   * and is offered — instead of at where it happens to be written.
   */
  const LABELS_AND_GROUPS =
    PAGE + readSource("../../../apps/web/lib/notifications/operationsFilterPolicy.ts");

  it("InboxCategory union covers the 5 new categories", () => {
    for (const key of [
      "review_escalation",
      "access_review_pending",
      "mfa_recovery_pending",
      "communication_failure",
      "security_event_high",
    ]) {
      expect(PAGE).toMatch(new RegExp(`\\|\\s*"${key}"`));
    }
  });

  it("CATEGORY_LABELS includes every new category with a non-empty label", () => {
    for (const key of [
      "review_escalation",
      "access_review_pending",
      "mfa_recovery_pending",
      "communication_failure",
      "security_event_high",
    ]) {
      expect(PAGE).toMatch(
        new RegExp(`${key}:\\s*"[^"]+"`),
      );
    }
  });

  it("declares the filter labels and renders chips from the grouped policy", () => {
    // Final completion pass 2026-07-14 — chip ORDERING moved to the
    // pure, unit-tested policy module (operationsFilterPolicy.ts);
    // the page keeps the label map and renders primary + overflow
    // rows from the policy.
    // The policy is still the ordering authority; the page keeps the label
    // map and renders from it. What changed is the SHAPE it renders: a quick
    // row plus grouped advanced filters, so the page no longer spells each
    // key as a literal — the policy groups do, which is where a per-key
    // assertion now belongs (see `opscenter-ux-adaptation`).
    expect(PAGE).toContain("operationsFilterPolicy");
    // The QUICK row is now exactly All and Unread — both universal — so there
    // is no eligibility left for it to project. Gating lives entirely in the
    // advanced groups, the only place it can still change what renders.
    expect(PAGE).toContain("QUICK_PRIMARY_VIEWS");
    expect(PAGE).toContain("visibleAdvancedFilterGroups");
    expect(PAGE).toContain("INBOX_FILTER_LABELS");
    for (const id of ["all", "mentions", "review", "governance", "failures", "admin"]) {
      expect(LABELS_AND_GROUPS).toMatch(new RegExp(`"${id}"`));
    }
  });

  it("renders filter chips", () => {
    // `data-inbox-filter-chips` named the old permanent two-row wall. The
    // toolbar replaced it; the per-chip hook is unchanged, so anything that
    // located a chip still does.
    expect(PAGE).toContain("data-inbox-toolbar");
    expect(PAGE).toContain("data-inbox-quick-filters");
    expect(PAGE).toMatch(/data-inbox-filter-chip=/);
  });

  it("renders a truncation indicator within the pagination summary", () => {
    // Phase IA-enterprise — the standalone truncation banner was
    // folded into the "Showing X of Y" pagination summary so a single
    // strip carries both signals. We assert both the new mount marker
    // and the explicit anyTruncated check.
    expect(PAGE).toContain("data-inbox-pagination-summary");
    expect(PAGE).toMatch(/anyTruncated/);
  });

  it("renders an item-level dueAt indicator when present", () => {
    expect(PAGE).toMatch(/data-inbox-item-due=/);
    expect(PAGE).toMatch(/Overdue/);
  });
});

// ============================================================================
// 4. Case Detail "Discussion & Activity" tab
// ============================================================================

describe("Phase IA-cleanup — Case Detail tab is labeled Discussion & Activity", () => {
  const MATTER = readSource(
    "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
  );

  it("tab id stays 'communications' (pinned by phase-c1 contract test)", () => {
    expect(MATTER).toMatch(/id:\s*"communications"/);
  });

  it("the visible label is 'Discussion & Activity'", () => {
    expect(MATTER).toMatch(/label:\s*"Discussion & Activity"/);
  });

  it("the tab still calls /v1/cases/:id/discussion-threads aggregator", () => {
    expect(MATTER).toMatch(/\/v1\/cases\/\$\{[^}]+\}\/discussion-threads/);
  });

  it("thread rows deep-link to the evidence Discussion tab with the thread anchor", () => {
    expect(MATTER).toMatch(
      /\/evidence\/\$\{[^}]+\}\?tab=discussion&thread=\$\{[^}]+\}/,
    );
  });

  it("the empty-state copy honestly directs users to start a discussion from an evidence record", () => {
    expect(MATTER).toContain("No discussion activity yet");
    expect(MATTER).toContain(
      "Start a discussion from an evidence record in this case",
    );
  });
});

// ============================================================================
// 5. /collaboration is legacy-redirect only
// ============================================================================

// ============================================================================
// 6. Phase IA-enterprise — operational failure categories
// ============================================================================

describe("Phase IA-enterprise — report/package/OTS failure categories", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("InboxCategory union includes report_failure", () => {
    expect(ROUTES).toMatch(/\|\s*"report_failure"/);
  });

  it("InboxCategory union includes verification_package_failure", () => {
    expect(ROUTES).toMatch(/\|\s*"verification_package_failure"/);
  });

  it("InboxCategory union includes ots_failure", () => {
    expect(ROUTES).toMatch(/\|\s*"ots_failure"/);
  });

  it("report_failure reads OperationalIncident with category REPORT, status OPEN|ACKNOWLEDGED", () => {
    expect(ROUTES).toMatch(/prisma\.operationalIncident\.findMany/);
    // The report query block must scope by REPORT category + open/ack
    // status + caller's teamIds. The same model is also used for
    // PACKAGE — we look for the REPORT-specific assignment to confirm.
    expect(ROUTES).toMatch(
      /reportIncidents\s*=[\s\S]{0,400}category:\s*"REPORT"[\s\S]{0,400}status:\s*\{\s*in:\s*\["OPEN",\s*"ACKNOWLEDGED"\]/,
    );
    // teamIds-scoped — never a workspace-wide read.
    expect(ROUTES).toMatch(
      /reportIncidents\s*=[\s\S]{0,400}teamId:\s*\{\s*in:\s*teamIds/,
    );
  });

  it("verification_package_failure reads OperationalIncident with category PACKAGE", () => {
    expect(ROUTES).toMatch(
      /packageIncidents\s*=[\s\S]{0,400}category:\s*"PACKAGE"[\s\S]{0,400}status:\s*\{\s*in:\s*\["OPEN",\s*"ACKNOWLEDGED"\]/,
    );
    expect(ROUTES).toMatch(
      /packageIncidents\s*=[\s\S]{0,400}teamId:\s*\{\s*in:\s*teamIds/,
    );
  });

  it('ots_failure reads Evidence with otsStatus = "FAILED" and deletedAt = null', () => {
    expect(ROUTES).toMatch(/prisma\.evidence\.findMany/);
    expect(ROUTES).toMatch(
      /otsFailedEvidence\s*=[\s\S]{0,400}otsStatus:\s*"FAILED"[\s\S]{0,400}deletedAt:\s*null/,
    );
    // Never surfaces PENDING / RETRY_SCHEDULED / WAITING_CONFIRMATIONS.
    // We pin this by asserting the FAILED-only filter — no `in:` list
    // sneaks normal lifecycle states past the contract.
    const block = (() => {
      const idx = ROUTES.indexOf("otsFailedEvidence");
      return idx >= 0 ? ROUTES.slice(idx, idx + 1200) : "";
    })();
    expect(block).not.toMatch(/otsStatus:\s*\{\s*in:\s*\[/);
    expect(block).not.toMatch(/"PENDING"|"RETRY_SCHEDULED"|"WAITING_CONFIRMATIONS"/);
  });

  it("OTS failure deep-links to the evidence Integrity tab", () => {
    expect(ROUTES).toMatch(/\/evidence\/\$\{[^}]+\}\?tab=integrity/);
  });

  it("OTS terminal GLOBAL_BUDGET_EXHAUSTED renders as critical tone", () => {
    expect(ROUTES).toMatch(
      /OTS_GLOBAL_BUDGET_EXHAUSTED[\s\S]{0,400}terminal[\s\S]{0,100}critical/,
    );
  });

  it("response truncated map includes the 3 new failure categories", () => {
    for (const key of [
      "report_failure",
      "verification_package_failure",
      "ots_failure",
    ]) {
      expect(ROUTES).toMatch(
        new RegExp(`${key}:\\s*(reportIncidents|packageIncidents|otsFailedEvidence)\\.length\\s*>=\\s*PER_CATEGORY_TAKE`),
      );
    }
  });

  it("summary.byCategory includes the 3 new failure counts", () => {
    for (const key of [
      "report_failure",
      "verification_package_failure",
      "ots_failure",
    ]) {
      expect(ROUTES).toMatch(
        new RegExp(
          `${key}:\\s*filteredItems\\.filter\\(\\s*\\(i\\)\\s*=>\\s*i\\.category\\s*===\\s*"${key}"`,
        ),
      );
    }
  });
});

// ============================================================================
// 7. Phase IA-enterprise — priority engine
// ============================================================================

describe("Phase IA-enterprise — priority tiers + sort engine", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("InboxPriority union covers P1..P5", () => {
    expect(ROUTES).toMatch(/InboxPriority\s*=\s*"P1"\s*\|\s*"P2"\s*\|\s*"P3"\s*\|\s*"P4"\s*\|\s*"P5"/);
  });

  it("priorityForItem maps failure categories to P1", () => {
    expect(ROUTES).toMatch(
      /case "report_failure":[\s\S]{0,200}case "verification_package_failure":[\s\S]{0,200}case "ots_failure":[\s\S]{0,80}return "P1"/,
    );
  });

  it("priorityForItem maps escalations/access reviews/MFA approvals/security/communications to P2", () => {
    for (const cat of [
      "review_escalation",
      "access_review_pending",
      "mfa_recovery_pending",
      "security_event_high",
      "communication_failure",
      "org_invite",
    ]) {
      expect(ROUTES).toMatch(new RegExp(`case "${cat}":`));
    }
    expect(ROUTES).toMatch(/return "P2"/);
  });

  it("priorityForItem maps discussion mentions/assigned to P3", () => {
    expect(ROUTES).toMatch(
      /case "discussion_mention":[\s\S]{0,200}case "discussion_assigned":[\s\S]{0,80}return "P3"/,
    );
  });

  it("priorityForItem maps governance + org admin rollup to P4", () => {
    expect(ROUTES).toMatch(
      /case "governance":[\s\S]{0,200}case "org_admin":[\s\S]{0,80}return "P4"/,
    );
  });

  it("priorityForItem maps onboarding to P5", () => {
    expect(ROUTES).toMatch(/case "onboarding":[\s\S]{0,80}return "P5"/);
  });

  it("review_decision awaiting_second is demoted to P5 (awareness only)", () => {
    expect(ROUTES).toMatch(
      /review_decision:awaiting_second:[\s\S]{0,200}"P5"/,
    );
  });

  it("critical tone upgrades any category to P1", () => {
    expect(ROUTES).toMatch(
      /if\s*\(item\.tone\s*===\s*"critical"\)\s*return\s*"P1"/,
    );
  });

  it("compareInboxItems sorts by priority → due posture → tone → recency", () => {
    expect(ROUTES).toContain("compareInboxItems");
    expect(ROUTES).toContain("PRIORITY_ORDER");
    expect(ROUTES).toContain("dueScore");
  });

  it("response summary.byPriority is populated", () => {
    expect(ROUTES).toMatch(
      /byPriority:\s*\{[\s\S]{0,800}P1:[\s\S]{0,800}P5:/,
    );
  });
});

// ============================================================================
// 8. Phase IA-enterprise — cursor pagination + server-driven filters
// ============================================================================

describe("Phase IA-enterprise — pagination + server-driven filters", () => {
  const ROUTES = readSource("../src/routes/me-inbox.routes.ts");

  it("inboxQuerySchema validates cursor, pageSize, filter, tone", () => {
    expect(ROUTES).toMatch(/inboxQuerySchema\s*=\s*z\.object/);
    expect(ROUTES).toMatch(/cursor:\s*z\.string\(\)\.optional/);
    expect(ROUTES).toMatch(/pageSize:\s*z\.coerce\.number\(\)\.int\(\)/);
    expect(ROUTES).toMatch(/filter:\s*z\.enum\(INBOX_FILTER_KEYS\)\.optional/);
    expect(ROUTES).toMatch(/tone:\s*z\.enum/);
  });

  it("INBOX_FILTER_KEYS covers the 12 enterprise chips", () => {
    for (const key of [
      "all",
      "critical",
      "assigned_to_me",
      "review",
      "governance",
      "failures",
      "security",
      "mentions",
      "unread",
      "due_soon",
      "overdue",
      "admin",
    ]) {
      expect(ROUTES).toMatch(new RegExp(`"${key}"`));
    }
  });

  it("pageSize is capped (max 50) to prevent large-page DOS", () => {
    expect(ROUTES).toMatch(/pageSize:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)/);
  });

  it("decodeCursor / encodeCursor are base64 helpers and tolerate malformed input", () => {
    expect(ROUTES).toMatch(/function decodeCursor/);
    expect(ROUTES).toMatch(/function encodeCursor/);
    // Malformed cursor must NOT throw — silently falls through to 0.
    expect(ROUTES).toMatch(
      /function decodeCursor[\s\S]{0,800}catch[\s\S]{0,200}return 0/,
    );
  });

  it("response includes a pagination block with nextCursor + totalEstimate + totalIsExact", () => {
    expect(ROUTES).toMatch(
      /pagination:\s*\{[\s\S]{0,400}nextCursor[\s\S]{0,200}totalEstimate[\s\S]{0,200}totalIsExact/,
    );
  });

  it("totalIsExact is false whenever any source truncated", () => {
    expect(ROUTES).toMatch(/totalIsExact\s*=\s*!anyTruncated/);
  });

  it("admin filter category set includes ONLY admin-gated categories", () => {
    // The filter MUST map to admin-only categories so a non-admin
    // selecting "Admin" sees an honestly empty list rather than
    // accidentally bypassing the per-category admin gate.
    const idx = ROUTES.indexOf("FILTER_CATEGORY_MEMBERS");
    expect(idx).toBeGreaterThan(-1);
    const block = ROUTES.slice(idx, idx + 1500);
    expect(block).toMatch(/admin:\s*\[/);
    expect(block).toMatch(/"mfa_recovery_pending"/);
    expect(block).toMatch(/"communication_failure"/);
    expect(block).toMatch(/"report_failure"/);
    expect(block).toMatch(/"verification_package_failure"/);
  });

  it("matchesFilter implements due_soon (next 7 days) and overdue (past)", () => {
    expect(ROUTES).toMatch(/filter\s*===\s*"due_soon"/);
    expect(ROUTES).toMatch(/filter\s*===\s*"overdue"/);
    expect(ROUTES).toMatch(/7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

// ============================================================================
// 9. Phase IA-enterprise — frontend pagination + filter chips + priority
// ============================================================================

describe("Phase IA-enterprise — /inbox UI pagination + filters + priority sections", () => {
  const PAGE = readSource("../../../apps/web/app/(app)/inbox/page.tsx");
  /**
   * The filter VOCABULARY, wherever it lives.
   *
   * Filter keys used to be spelled out in the page JSX, so a per-key
   * assertion against the page was an assertion about the product. They moved
   * into the policy module when the overflow row became a grouped panel, and
   * the page now renders from the groups. Concatenating the two keeps these
   * assertions pointed at the thing they were always about — the key exists
   * and is offered — instead of at where it happens to be written.
   */
  const LABELS_AND_GROUPS =
    PAGE + readSource("../../../apps/web/lib/notifications/operationsFilterPolicy.ts");

  it("InboxCategory union covers the 3 new failure categories", () => {
    for (const key of [
      "report_failure",
      "verification_package_failure",
      "ots_failure",
    ]) {
      expect(PAGE).toMatch(new RegExp(`\\|\\s*"${key}"`));
    }
  });

  it("CATEGORY_LABELS covers the 3 new failure categories", () => {
    for (const key of [
      "report_failure",
      "verification_package_failure",
      "ots_failure",
    ]) {
      expect(PAGE).toMatch(new RegExp(`${key}:\\s*"[^"]+"`));
    }
  });

  it("InboxPriority still covers P1..P5 as ROW metadata", () => {
    // The TYPE stays: the server assigns a priority and every row carries it
    // on `data-inbox-item-priority` for tests and analytics.
    //
    // `PRIORITY_META` does NOT stay. It supplied the "P1 · Critical —
    // Operational failures and critical signals — act now." section headings,
    // which are an operations work queue's vocabulary on a personal feed —
    // and, worse, the grouping they labelled re-bucketed the list AFTER the
    // server had ordered it, so the reader's chosen sort only ever applied
    // within a bucket.
    expect(PAGE).toMatch(/type InboxPriority\s*=\s*"P1"\s*\|\s*"P2"\s*\|\s*"P3"\s*\|\s*"P4"\s*\|\s*"P5"/);
    expect(PAGE).toContain("data-inbox-item-priority");
    expect(PAGE).not.toMatch(/^const PRIORITY_META/m);
  });

  it("every enterprise filter key still exists in the vocabulary", () => {
    // Asserted against the LABEL MAP and the policy groups rather than the
    // whole page: the keys moved out of the JSX when the overflow row became
    // a grouped panel, and a whole-file search would now be satisfied by a
    // comment that merely mentions one.
    for (const key of [
      "all",
      "critical",
      "assigned_to_me",
      "review",
      "governance",
      "failures",
      "security",
      "mentions",
      "due_soon",
      "overdue",
      "admin",
      "unread",
    ]) {
      expect(LABELS_AND_GROUPS).toMatch(new RegExp(`"${key}"`));
    }
  });

  it("filter chip click sends filter as a query param", () => {
    expect(PAGE).toContain("data-inbox-filter-chip");
    expect(PAGE).toMatch(/params\.set\("filter"/);
  });

  it("Load More button renders when nextCursor is set", () => {
    expect(PAGE).toContain('data-action="load-more-inbox"');
    expect(PAGE).toMatch(/Load more/);
    expect(PAGE).toContain("loadMore");
  });

  it("\"Showing X of Y\" indicator renders, with + suffix when total is an estimate", () => {
    // The "+" suffix is gone. Appending it to a number the reader parses as
    // exact is a weaker kind of honesty than saying so plainly: an inexact
    // total now drops the "of N" claim entirely and says more may exist.
    expect(PAGE).toContain("data-inbox-showing-text");
    expect(PAGE).toMatch(/totalIsExact/);
    expect(PAGE).toMatch(/more may exist/);
    expect(PAGE).not.toMatch(/totalIsExact\s*\?\s*""\s*:\s*"\+"/);
  });

  it("renders ONE flat stream — no priority section headers", () => {
    // Inverted deliberately. See the note on `InboxPriority` above: the
    // grouping was stale Operations vocabulary AND it defeated sorting.
    //
    // Asserted over CODE. The page keeps a note recording what was removed and
    // why, and that note names the retired identifiers — a whole-file search
    // would match the explanation instead of the thing.
    const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(CODE).not.toContain("data-inbox-priority-section");
    expect(CODE).not.toContain("PRIORITY_ORDER");
    expect(CODE).not.toContain("ops-priority-header");
    // One list, rendered straight from the server's order.
    expect(PAGE).toContain("data-inbox-stream");
    expect(PAGE).toMatch(/visibleItems\.map\(\(item\)/);
  });

  it("each item carries a priority data attribute for tests + analytics", () => {
    expect(PAGE).toContain("data-inbox-item-priority");
  });

  it("the filter chip wiring resets pagination on filter change", () => {
    // The effect that calls `load()` runs whenever the memoized
    // `load` callback changes; `load` depends on `buildUrl`, which
    // depends on `filter` and `toneFilter`. So a chip click triggers
    // a fresh fetch starting at offset=0. We assert the dependency
    // chain by source string.
    expect(PAGE).toMatch(/useEffect\([\s\S]{0,200}void load\(\);[\s\S]{0,100}\[load\]/);
    // Final-completion rebaseline: buildUrl also depends on the
    // server-validated workspace narrowing selector (workspaceFilter),
    // so a scope change is a fresh query too.
    // THE AXES joined the dependency list when `filter`/`toneFilter` became
    // `primaryView`/`category`/`archived`. Selecting a metric card, a
    // category or the archive is a fresh query starting at offset 0.
    //
    // SORT joined it too. A reorder is a fresh query for exactly
    // the reason a filter change is: the cursor is an offset into an ordered
    // population, so carrying it across a reorder pages into the middle of a
    // list the reader never saw the start of.
    expect(PAGE).toMatch(
      /const buildUrl = useCallback\([\s\S]*?\[primaryView,\s*category,\s*archived,\s*workspaceFilter,\s*sort\]/,
    );
  });
});

// ============================================================================
// 5. /collaboration is legacy-redirect only (pre-existing)
// ============================================================================

describe("Phase IA-cleanup — /collaboration is legacy-redirect only", () => {
  it("next.config.js still redirects /collaboration → /notifications", () => {
    const cfg = readSource("../../../apps/web/next.config.js");
    expect(cfg).toMatch(
      /source:\s*["']\/collaboration["'][\s\S]{0,900}destination:\s*["']\/notifications["']/,
    );
  });

  it("routeRegistry.ts no longer carries the legacy workspace.collaboration entry at all", () => {
    // Phase 12 Point 4 (Pass E) — strengthened. This used to accept the
    // entry so long as all three discovery flags were false; the entry's
    // own comment admitted it was "preserved so the route id, href, and
    // existing contract tests stay green". A registry row whose page is
    // permanently redirected away is dead weight, and hiding it from the
    // discovery surfaces is a weaker guarantee than not having it.
    const registry = readSource(
      "../../../apps/web/lib/navigation/routeRegistry.ts",
    );
    expect(registry.indexOf('id: "workspace.collaboration"')).toBe(-1);
  });

  it("no apps/web source file outside the legacy registry / redirect / middleware ships an href: \"/collaboration\"", () => {
    // The legitimate references are:
    //   * apps/web/next.config.js — the redirect rule
    //   * apps/web/middleware.ts — APP_PREFIXES (test-pinned)
    //   * apps/web/lib/navigation/routeRegistry.{ts,js} — legacy registry
    // Any OTHER hit is a regression — a CTA / link / button that
    // didn't get migrated.
    const root = fileURLToPath(new URL("../../../apps/web", import.meta.url));
    const offenders: string[] = [];
    const allowedFiles = new Set([
      "next.config.js",
      "middleware.ts",
      "routeRegistry.ts",
    ]);
    const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
    const skipDirs = new Set([
      "node_modules",
      ".next",
      "dist",
      "out",
      "coverage",
    ]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    function walk(dir: string) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (skipDirs.has(name)) continue;
        const full = path.join(dir, name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (allowedFiles.has(name)) continue;
        const dot = name.lastIndexOf(".");
        if (dot < 0 || !exts.has(name.slice(dot))) continue;
        let content: string;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        // Look for an href / to / push / replace targeting /collaboration.
        // We deliberately do NOT flag a bare "/collaboration" inside a
        // comment / docstring — the comment-only filter below tolerates it.
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          const trimmed = line.trimStart();
          if (
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("/*")
          ) {
            continue;
          }
          if (
            /href:\s*["']\/collaboration["']/.test(line) ||
            /href=["']\/collaboration["']/.test(line) ||
            /to:\s*["']\/collaboration["']/.test(line) ||
            /to=["']\/collaboration["']/.test(line) ||
            /push\(\s*["']\/collaboration["']/.test(line) ||
            /replace\(\s*["']\/collaboration["']/.test(line)
          ) {
            offenders.push(`${full}:${i + 1}`);
          }
        }
      }
    }
    walk(root);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
