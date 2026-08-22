/**
 * Operations Center / Notification Preferences — UX-adaptation
 * contracts (participation + actual-item override, 2026-07-15).
 *
 * RUNTIME BEHAVIOR tests: the adaptation rules live in pure, imported
 * functions (deriveOperationsUiContext + the filter/preference/override
 * policy), so we EXECUTE them across the real persona matrix rather than
 * grepping source. A small source-contract section pins the copy/wiring
 * that has no executable form (labels, CTA placement, single-workspace
 * hiding, adaptive copy, backend consumption).
 *
 * The canonical visibility rule under test:
 *     VISIBLE = STATIC ELIGIBILITY  ||  AN AUTHORIZED ITEM EXISTS
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveOperationsUiContext,
  type OperationsUiContextInput,
} from "../lib/notifications/useOperationsUiContext";
import type { PlatformContextOperationalEligibility } from "../lib/platform-context/types";
import {
  PRIMARY_OPERATIONS_FILTERS,
  SECONDARY_OPERATIONS_FILTERS,
  buildActualItemSignal,
  preferenceGroupVisible,
  shouldOfferMarkAllRead,
  shouldOfferMarkCategoryRead,
  toneTileDisabled,
  visiblePrimaryFilters,
  visibleSecondaryFilters,
  type ActualItemSignal,
  type InboxCategoryKey,
  type OperationsFilterKey,
} from "../lib/notifications/operationsFilterPolicy";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Eligibility fixture builders — mirror what the BACKEND derives so the
// pure resolver + policy can be exercised without a live envelope.
// ---------------------------------------------------------------------------

function eligibility(
  over: DeepPartial<PlatformContextOperationalEligibility> = {},
): PlatformContextOperationalEligibility {
  const base: PlatformContextOperationalEligibility = {
    collaboration: {
      hasActiveMembership: false,
      hasPendingInvitation: false,
      canOwnTeams: false,
    },
    reviews: { canParticipate: false, canManage: false },
    assignments: {
      hasCaseAssignmentCapability: false,
      hasReviewAssignmentCapability: false,
      hasCollaborationAssignmentCapability: false,
    },
    deadlines: { hasEligibleSource: false },
    security: { hasPersonalSurface: true, hasAdminSurface: false },
    governance: { canViewOperational: false },
  };
  return {
    collaboration: { ...base.collaboration, ...over.collaboration },
    reviews: { ...base.reviews, ...over.reviews },
    assignments: { ...base.assignments, ...over.assignments },
    deadlines: { ...base.deadlines, ...over.deadlines },
    security: { ...base.security, ...over.security },
    governance: { ...base.governance, ...over.governance },
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

function planFeatures(p: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE") {
  const M = {
    FREE: [false, false, false, false, false, false, false],
    PAYG: [true, true, true, false, false, false, false],
    PRO: [true, true, true, true, false, false, true],
    TEAM: [true, true, true, true, true, true, true],
    ENTERPRISE: [true, true, true, true, true, true, true],
  }[p];
  return {
    reportsIncluded: M[0],
    verificationPackageIncluded: M[1],
    intakeIncluded: M[2],
    casesIncluded: M[3],
    reviewerOperationsIncluded: M[4],
    reviewQueuesIncluded: M[5],
    teamCollaborationIncluded: M[6],
  };
}

function ctx(
  plan: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE",
  elig: PlatformContextOperationalEligibility,
  opts: {
    spaceType?: "PERSONAL" | "ORGANIZATION";
    orgs?: OperationsUiContextInput["organizations"];
  } = {},
) {
  return deriveOperationsUiContext({
    activeSpaceType: opts.spaceType ?? "PERSONAL",
    activeSpaceId: "s-1",
    personalSpaceId: "p-1",
    organizations: opts.orgs ?? [],
    hasGovernanceCapability: elig.governance.canViewOperational,
    planFeatures: planFeatures(plan),
    operationalEligibility: elig,
  });
}

function items(
  byCategory: Partial<Record<InboxCategoryKey, number>> = {},
  deadlines: { dueSoon?: number; overdue?: number } = {},
): ActualItemSignal {
  return buildActualItemSignal({
    byCategory,
    deadlines: { dueSoon: deadlines.dueSoon ?? 0, overdue: deadlines.overdue ?? 0 },
  });
}

function allFilters(
  c: ReturnType<typeof ctx>,
  sig: ActualItemSignal = buildActualItemSignal(null),
): string[] {
  return [
    ...visiblePrimaryFilters(c, "all", sig),
    ...visibleSecondaryFilters(c, "all", sig),
  ];
}

// ---------------------------------------------------------------------------
// Resolver derivation — output shape + field projection
// ---------------------------------------------------------------------------

test("resolver projects the canonical eligibility field set", () => {
  const out = ctx("FREE", eligibility()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out).sort(), [
    "canCollaborate",
    "canOwnTeamCollaboration",
    "canParticipateInReviews",
    "canReceiveAssignments",
    "canReceiveGovernance",
    "canUseIntake",
    "canUseReports",
    "canUseVerificationPackages",
    "canViewAdminAttention",
    "hasEligibleDeadlineSource",
    "hasOrganizations",
    "hasPendingInvitation",
    "isPersonalWorkspace",
    "workspaceId",
  ]);
});

test("degraded envelope (no operationalEligibility) collapses participation to FALSE", () => {
  const c = deriveOperationsUiContext({
    activeSpaceType: "PERSONAL",
    activeSpaceId: "p-1",
    personalSpaceId: "p-1",
    organizations: [],
    hasGovernanceCapability: false,
    planFeatures: planFeatures("TEAM"),
    operationalEligibility: null,
  });
  assert.equal(c.canCollaborate, false);
  assert.equal(c.canParticipateInReviews, false);
  assert.equal(c.canReceiveAssignments, false);
  assert.equal(c.hasEligibleDeadlineSource, false);
  // Universal plan-gated surfaces still project from planFeatures.
  assert.equal(c.canUseReports, true);
});

// ---------------------------------------------------------------------------
// COLLABORATION / MENTIONS / INVITATIONS participation (§1)
// ---------------------------------------------------------------------------

test("FREE standalone: Collaboration + Mentions + Invitations hidden", () => {
  const f = allFilters(ctx("FREE", eligibility()));
  for (const k of ["collaboration", "mentions", "invitations"]) {
    assert.ok(!f.includes(k), `standalone FREE must hide ${k}`);
  }
});

test("FREE with a pending paid-Team invite: Invitations shown, Collaboration still hidden", () => {
  const f = allFilters(
    ctx("FREE", eligibility({ collaboration: { hasPendingInvitation: true } })),
  );
  assert.ok(f.includes("invitations"), "pending invite reveals Invitations");
  assert.ok(!f.includes("collaboration"), "invite alone is not membership");
});

test("FREE active member of a paid Team: Collaboration + Mentions shown", () => {
  const f = allFilters(
    ctx(
      "FREE",
      eligibility({
        collaboration: { hasActiveMembership: true },
        assignments: { hasCollaborationAssignmentCapability: true },
      }),
    ),
  );
  assert.ok(f.includes("collaboration"), "active membership reveals Collaboration");
  assert.ok(f.includes("mentions"), "active membership reveals Mentions");
});

test("FREE standalone WITH a real mention item: Mentions + Collaboration revealed (override)", () => {
  const f = allFilters(
    ctx("FREE", eligibility()),
    items({ discussion_mention: 1 }),
  );
  assert.ok(f.includes("mentions"), "actual mention item reveals Mentions");
  assert.ok(f.includes("collaboration"), "actual mention reveals Collaboration");
});

// ---------------------------------------------------------------------------
// REVIEWER visibility (§2)
// ---------------------------------------------------------------------------

test("TEAM ordinary member without review capability/assignment: Reviews hidden", () => {
  const f = allFilters(ctx("TEAM", eligibility()));
  assert.ok(!f.includes("review"), "no reviewer participation → Reviews hidden");
});

test("TEAM reviewer (writer capability): Reviews shown", () => {
  const f = allFilters(
    ctx("TEAM", eligibility({ reviews: { canParticipate: true } })),
  );
  assert.ok(f.includes("review"), "reviewer participation → Reviews shown");
});

test("Enterprise member WITH an actual review item but no capability: Reviews revealed (override)", () => {
  const f = allFilters(
    ctx("ENTERPRISE", eligibility(), {
      spaceType: "ORGANIZATION",
      orgs: [{ membershipStatus: "ACTIVE", role: "MEMBER" }],
    }),
    items({ review_escalation: 1 }),
  );
  assert.ok(f.includes("review"), "assigned escalation reveals Reviews");
});

test("Enterprise reviewer/operator: Reviews shown by capability", () => {
  const f = allFilters(
    ctx("ENTERPRISE", eligibility({ reviews: { canParticipate: true, canManage: true } }), {
      spaceType: "ORGANIZATION",
      orgs: [{ membershipStatus: "ACTIVE", role: "ADMIN" }],
    }),
  );
  assert.ok(f.includes("review"), "reviewer capability → Reviews shown");
});

// ---------------------------------------------------------------------------
// ASSIGNED TO ME source eligibility (§3)
// ---------------------------------------------------------------------------

test("no valid assignment source: Assigned to me hidden", () => {
  const f = allFilters(ctx("PAYG", eligibility()));
  assert.ok(!f.includes("assigned_to_me"), "PAYG standalone has no assignment source");
});

test("PRO with personal cases: Assigned to me shown", () => {
  const f = allFilters(
    ctx("PRO", eligibility({ assignments: { hasCaseAssignmentCapability: true } })),
  );
  assert.ok(f.includes("assigned_to_me"), "case assignment capability shows Assigned");
});

test("actual case_assignment item reveals Assigned to me (downgrade/history override)", () => {
  const f = allFilters(ctx("FREE", eligibility()), items({ case_assignment: 1 }));
  assert.ok(f.includes("assigned_to_me"), "real assignment reveals the filter");
});

// ---------------------------------------------------------------------------
// DUE SOON / OVERDUE source eligibility (§4)
// ---------------------------------------------------------------------------

test("no deadline source: Due soon / Overdue hidden", () => {
  const f = allFilters(ctx("FREE", eligibility()));
  assert.ok(!f.includes("due_soon"), "no deadline source → Due soon hidden");
  assert.ok(!f.includes("overdue"), "no deadline source → Overdue hidden");
});

test("PAYG intake deadline source: Due soon / Overdue available", () => {
  const f = allFilters(
    ctx("PAYG", eligibility({ deadlines: { hasEligibleSource: true } })),
  );
  assert.ok(f.includes("due_soon"), "intake source enables Due soon");
  assert.ok(f.includes("overdue"), "intake source enables Overdue");
});

test("actual overdue item reveals Overdue even without a static source", () => {
  const f = allFilters(ctx("FREE", eligibility()), items({}, { overdue: 1 }));
  assert.ok(f.includes("overdue"), "real overdue item reveals the filter");
});

// ---------------------------------------------------------------------------
// SECURITY separation (§5) — the filter is universal; admin-security items
// are aggregation-gated (never in a non-admin's scope), so they cannot leak
// through the generic Security filter.
// ---------------------------------------------------------------------------

test("Security filter is universal (personal security is always relevant)", () => {
  assert.ok(allFilters(ctx("FREE", eligibility())).includes("security"));
  assert.ok(allFilters(ctx("PAYG", eligibility())).includes("security"));
});

test("Admin filter is role-gated (org OWNER/ADMIN only)", () => {
  const member = ctx("ENTERPRISE", eligibility({ security: { hasAdminSurface: false } }), {
    spaceType: "ORGANIZATION",
    orgs: [{ membershipStatus: "ACTIVE", role: "MEMBER" }],
  });
  const admin = ctx("ENTERPRISE", eligibility({ security: { hasAdminSurface: true } }), {
    spaceType: "ORGANIZATION",
    orgs: [{ membershipStatus: "ACTIVE", role: "ADMIN" }],
  });
  assert.ok(!allFilters(member).includes("admin"), "ordinary member: no Admin filter");
  assert.ok(allFilters(admin).includes("admin"), "org admin: Admin filter shown");
});

// ---------------------------------------------------------------------------
// PRO PERSONAL GOVERNANCE (§6) — Outcome B: no operational governance queue
// unless a real personal-team governance item exists.
// ---------------------------------------------------------------------------

test("PRO Personal governance: hidden (Outcome B — controls live in Settings)", () => {
  const f = allFilters(ctx("PRO", eligibility({ governance: { canViewOperational: false } })));
  assert.ok(!f.includes("governance"), "Pro Personal has no operational governance queue");
});

test("Org member with GOVERNANCE_VIEW: governance shown", () => {
  const f = allFilters(
    ctx("ENTERPRISE", eligibility({ governance: { canViewOperational: true } }), {
      spaceType: "ORGANIZATION",
      orgs: [{ membershipStatus: "ACTIVE", role: "MEMBER" }],
    }),
  );
  assert.ok(f.includes("governance"), "GOVERNANCE_VIEW → governance shown");
});

test("actual governance item reveals governance even for Pro Personal (override)", () => {
  const f = allFilters(
    ctx("PRO", eligibility({ governance: { canViewOperational: false } })),
    items({ governance: 1 }),
  );
  assert.ok(f.includes("governance"), "real governance item reveals the category");
});

// ---------------------------------------------------------------------------
// Preferences groups use the SAME predicate (§8)
// ---------------------------------------------------------------------------

test("preference groups mirror the filter eligibility (one predicate)", () => {
  const standalone = ctx("FREE", eligibility());
  assert.equal(preferenceGroupVisible("integrity", standalone), true);
  assert.equal(preferenceGroupVisible("collaboration", standalone), false);
  assert.equal(preferenceGroupVisible("review", standalone), false);
  assert.equal(preferenceGroupVisible("intake", standalone), false);
  assert.equal(preferenceGroupVisible("governance", standalone), false);

  const member = ctx("PAYG", eligibility({ collaboration: { hasActiveMembership: true } }));
  assert.equal(preferenceGroupVisible("collaboration", member), true);
  assert.equal(preferenceGroupVisible("intake", member), true); // PAYG intake plan
});

// ---------------------------------------------------------------------------
// intake_link_expiring classification (2026-07-15) — an INTAKE operational
// deadline, NOT a governance event. Behavior via the exported filter policy.
// ---------------------------------------------------------------------------

test("intake_link_expiring reveals Intake via the actual-item override, never Governance", () => {
  // No static eligibility anywhere; only a real expiring-link item in scope.
  const c = ctx("FREE", eligibility());
  const f = allFilters(c, items({ intake_link_expiring: 1 }));
  assert.ok(f.includes("intake"), "expiring link reveals Intake (core)");
  assert.ok(!f.includes("governance"), "expiring link must NOT reveal Governance");
});

test("Governance is still revealed only by real governance items (retention/hold/destruction path unchanged)", () => {
  const c = ctx("FREE", eligibility());
  assert.ok(allFilters(c, items({ governance: 1 })).includes("governance"));
  assert.ok(allFilters(c, items({ access_review_pending: 1 })).includes("governance"));
  // …and an expiring intake link alone does not.
  assert.ok(!allFilters(c, items({ intake_link_expiring: 1 })).includes("governance"));
});

test("intake_link_expiring drives Due soon / Overdue via the deadline signal, not the category", () => {
  const c = ctx("FREE", eligibility());
  assert.ok(
    allFilters(c, items({ intake_link_expiring: 1 }, { dueSoon: 1 })).includes("due_soon"),
    "in-window expiry reveals Due soon",
  );
  assert.ok(
    allFilters(c, items({ intake_link_expiring: 1 }, { overdue: 1 })).includes("overdue"),
    "actual overdue reveals Overdue",
  );
  assert.ok(
    !allFilters(c, items({ intake_link_expiring: 1 }, { dueSoon: 1 })).includes("overdue"),
    "due-soon (not expired) must NOT reveal Overdue",
  );
});

test("governance capability still shows the Governance filter (reclassification did not touch it)", () => {
  const c = ctx("ENTERPRISE", eligibility({ governance: { canViewOperational: true } }), {
    spaceType: "ORGANIZATION",
    orgs: [{ membershipStatus: "ACTIVE", role: "MEMBER" }],
  });
  assert.ok(allFilters(c).includes("governance"));
});

test("a real item reveals its preference group (no preference hidden while items exist)", () => {
  const standalone = ctx("FREE", eligibility());
  assert.equal(
    preferenceGroupVisible("review", standalone, items({ review_escalation: 1 })),
    true,
  );
  assert.equal(
    preferenceGroupVisible("collaboration", standalone, items({ discussion_mention: 1 })),
    true,
  );
});

// ---------------------------------------------------------------------------
// Bulk actions + tile states + filter partition (unchanged invariants)
// ---------------------------------------------------------------------------

test("every filter is exactly primary or secondary — nothing lost or duplicated", () => {
  // `snoozed` is the ONE deliberate exception: the reminder action was
  // withdrawn from the UI, so its chip could only ever be empty, and its
  // eligibility is universal — no category count could reveal it selectively,
  // so "More filters" would have shown everyone an empty view forever. The
  // key and its backend state remain, and a snoozed item still returns to the
  // list on its own when the reminder falls due.
  //
  // Naming the exception, rather than lowering a count, keeps the partition
  // honest: any OTHER key that silently leaves both rows still fails here.
  const all = [...PRIMARY_OPERATIONS_FILTERS, ...SECONDARY_OPERATIONS_FILTERS];
  assert.equal(new Set(all).size, all.length, "no filter appears in both rows");
  assert.ok(!all.includes("snoozed"), "the reminder filter is withdrawn");
  const EXPECTED: ReadonlyArray<OperationsFilterKey> = [
    "all",
    "unread",
    "critical",
    "failures",
    "integrity",
    "assigned_to_me",
    "review",
    "history",
    "mentions",
    "collaboration",
    "invitations",
    "reports",
    "packages",
    "intake",
    "due_soon",
    "overdue",
    "security",
    "governance",
    "admin",
  ];
  assert.deepEqual([...all].sort(), [...EXPECTED].sort());
});

test("the active secondary filter is promoted into the primary row", () => {
  const c = ctx("TEAM", eligibility({ collaboration: { hasActiveMembership: true } }));
  assert.ok(visiblePrimaryFilters(c, "mentions").includes("mentions"));
  assert.ok(!visibleSecondaryFilters(c, "mentions").includes("mentions"));
});

test("bulk read actions never render with zero unread; category variant needs rows too", () => {
  assert.equal(shouldOfferMarkAllRead(0), false);
  assert.equal(shouldOfferMarkAllRead(3), true);
  assert.equal(shouldOfferMarkCategoryRead(3, 0, true), false);
  assert.equal(shouldOfferMarkCategoryRead(3, 2, true), true);
  assert.equal(shouldOfferMarkCategoryRead(3, 2, false), false);
});

test("zero-count severity tiles are disabled unless active", () => {
  assert.equal(toneTileDisabled(0, false), true);
  assert.equal(toneTileDisabled(0, true), false);
  assert.equal(toneTileDisabled(5, false), false);
});

// ---------------------------------------------------------------------------
// Source contracts — copy + wiring with no executable form
// ---------------------------------------------------------------------------

const PAGE = read("app/(app)/inbox/page.tsx");
const PANEL = read("components/notifications/NotificationPreferencesPanel.tsx");
const BELL = read("components/app-shell-v2/NotificationBell.tsx");
const RESOLVER = read("lib/notifications/useOperationsUiContext.ts");
const SERVICE_TYPES = read("lib/platform-context/types.ts");

test("resolver + filters consume the backend operationalEligibility projection", () => {
  assert.match(RESOLVER, /operationalEligibility/);
  assert.match(SERVICE_TYPES, /PlatformContextOperationalEligibility/);
});

test("page threads the actual-item override into the filter policy", () => {
  assert.match(PAGE, /buildActualItemSignal\(/);
  assert.match(PAGE, /visiblePrimaryFilters\(uiCtx, filter, itemSignal\)/);
  assert.match(PAGE, /visibleSecondaryFilters\(uiCtx, filter, itemSignal\)/);
});

test("preferences panel uses the SAME predicate + actual-item override", () => {
  assert.match(PANEL, /preferenceGroupVisible\(g\.domain, uiCtx, itemSignal\)/);
  assert.match(PANEL, /buildActualItemSignal\(/);
  // Collaboration group is now participation-gated (domain: "collaboration").
  assert.match(PANEL, /domain: "collaboration"/);
  assert.match(PANEL, /domain: "governance"/);
});

test("Preferences: delivery column renamed Inbox → In-app (no stray Inbox copy)", () => {
  // 2026-07-17 remediation §8.4 — the header additionally pins nowrap so
  // the narrow column can never hyphen-break "In-app".
  assert.match(
    PANEL,
    /<th style=\{\{ textAlign: "center", whiteSpace: "nowrap" \}\}>In-app<\/th>/,
  );
  assert.doesNotMatch(PANEL, /Inbox/);
});

test("OpsCenter: subtitle + empty-state are adaptive (no hardcoded reviews/governance list)", () => {
  assert.doesNotMatch(
    PAGE,
    /reviews, mentions, invitations, governance, security, and integrity signals/,
  );
  // WHAT THIS USED TO ASSERT, AND WHY IT CHANGED.
  //
  // The subtitle used to enumerate what could arrive — "integrity signals,
  // report failures, intake activity…" — and `describeAttentionAreas` existed
  // to build that list per capability, because enumerating it wrongly for a
  // Free account was a real defect.
  //
  // The subtitle no longer enumerates anything: one short sentence, true for
  // every plan, so there is nothing to adapt and the machinery is gone. That
  // satisfies the original property more completely than the adaptive list
  // did — a sentence that names no capability cannot name the wrong one.
  assert.doesNotMatch(PAGE, /function describeAttentionAreas/);
  assert.match(
    PAGE,
    /subtitle="Updates, assignments, mentions and integrity alerts relevant to you\."/,
  );
});

test("OpsCenter: workspace scope selector is hidden for single-workspace users", () => {
  assert.match(PAGE, /workspaceOptions\.length > 2 &&/);
});

test("Notifications: the empty state offers no CTA at all", () => {
  // The empty state used to branch — Organizations for org users, the evidence
  // library for everyone else — beneath a primary "Open workspace command
  // center" that sent a Personal Free user to Home for a workbench they do not
  // have. There is nothing useful to DO from an empty notification list, and a
  // button that merely navigates elsewhere is worse than its honest absence.
  assert.doesNotMatch(PAGE, /data-action="empty-open-home"/);
  assert.doesNotMatch(PAGE, /data-action="empty-open-evidence"/);
  assert.doesNotMatch(PAGE, /data-action="empty-open-organizations"/);
  assert.match(PAGE, /title="You're all caught up"/);
});

test("bell popover manages focus (trap + restore to trigger); no Bell-only eligibility logic", () => {
  // The trigger element is CAPTURED while the popover is open and focused
  // from the cleanup. Pinning `triggerRef.current?.focus()` pinned the
  // stale-ref read that Phase 12 Point 4 (Pass H) removed — the requirement
  // is that focus returns to the trigger, not which expression does it.
  assert.match(BELL, /const trigger = triggerRef\.current;/);
  assert.match(BELL, /trigger\?\.focus\(\);/);
  assert.match(BELL, /onTrapKeyDown/);
  // Parity is structural: the Bell renders only backend-authorized items and
  // applies no client eligibility gate of its own.
  assert.doesNotMatch(BELL, /operationalEligibility/);
});

test("terminology: the page names itself Notifications, and nothing else", () => {
  // It was `eyebrow="Account · Operations Center"` — which filed a personal
  // feed under a shared operational surface, and borrowed a name /operations
  // already owns. The page is its own destination now: a plain title, no
  // eyebrow, and no operational vocabulary in anything the reader sees.
  assert.match(PAGE, /title="Notifications"/);
  assert.doesNotMatch(PAGE, /eyebrow=/);
  // Checked in the positions the reader can actually see — a quoted prop value
  // or JSX text — so the design note above `remindItem`, which still cites the
  // old name to explain what was withdrawn, is not mistaken for a regression.
  for (const forbidden of ["Operations Center", "Operational inbox"]) {
    for (const rendered of [`"${forbidden}"`, `>${forbidden}<`]) {
      assert.ok(
        !PAGE.includes(rendered),
        `the page must not present itself as "${forbidden}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// PHASE 12 POINT 4 PASS C5 — the browser holds no role authority.
//
// With a degraded / pre-migration envelope (no operationalEligibility block)
// the admin-attention surface used to be decided in the browser from raw
// organization roles: `activeOrgs.some(role === "OWNER" || role === "ADMIN")`.
// The server decides; its absence hides the surface.
// ---------------------------------------------------------------------------

test("no eligibility projection: admin attention is HIDDEN, not inferred from roles", () => {
  const c = deriveOperationsUiContext({
    activeSpaceType: "ORGANIZATION",
    activeSpaceId: "s-1",
    personalSpaceId: "p-1",
    // An OWNER of an ACTIVE organization — the exact input the removed
    // client-side rule would have granted the admin surface to.
    organizations: [
      {
        organizationId: "o-1",
        organizationName: "Acme",
        role: "OWNER",
        membershipStatus: "ACTIVE",
      },
    ] as never,
    hasGovernanceCapability: false,
    planFeatures: null,
    operationalEligibility: null,
  });
  assert.equal(c.canViewAdminAttention, false);
});

test("with the projection present, the server's verdict is what renders", () => {
  const base = {
    activeSpaceType: "ORGANIZATION" as const,
    activeSpaceId: "s-1",
    personalSpaceId: "p-1",
    organizations: [] as never,
    hasGovernanceCapability: false,
    planFeatures: null,
  };
  const granted = deriveOperationsUiContext({
    ...base,
    operationalEligibility: eligibility({ security: { hasAdminSurface: true } }),
  });
  const denied = deriveOperationsUiContext({
    ...base,
    operationalEligibility: eligibility({ security: { hasAdminSurface: false } }),
  });
  assert.equal(granted.canViewAdminAttention, true);
  assert.equal(denied.canViewAdminAttention, false);
});
