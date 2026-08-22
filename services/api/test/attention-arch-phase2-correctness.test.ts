/**
 * ATTENTION ARCHITECTURE — PHASE 2 (2026-08-22).
 *
 * Every defect pinned here was live in the tree at the start of this phase.
 * The two that matter most are release-blocking on their own:
 *
 *   2.2  ABSENCE FROM A PARTIAL READ WAS TREATED AS RESOLUTION.
 *        One failed `findMany` marked an entire category of outstanding
 *        integrity failures RESOLVED, with system provenance attached.
 *
 *   2.5  TWO SOURCES HAD NO TENANCY GATE AT ALL.
 *        `AccessReview` was scoped by "the caller is the subject" and
 *        `CollaborationTeamNotification` by "the caller is the addressee".
 *        Neither is a tenancy gate, so a REVOKED member kept receiving a
 *        workspace's rows — content and deep links — indefinitely.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildSourceCompleteness,
  exhaustivelyEvaluatedSources,
  mayInferResolutionFromAbsence,
} from "../src/services/notifications/source-completeness.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const INBOX_ROUTES = readSource("../src/routes/me-inbox.routes.ts");

// ============================================================================
// 2.2 — truncation / degradation must never read as resolution
// ============================================================================

describe("Phase 2.2 — resolution requires positive evidence", () => {
  const KNOWN = ["tsa_failure", "ots_failure", "governance", "org_invite"];

  it("a clean run may draw conclusions from absence", () => {
    const c = buildSourceCompleteness({
      knownSources: KNOWN,
      degradedSources: [],
      truncated: {},
    });
    expect(c.anyIncomplete).toBe(false);
    expect(c.mayAssertAllClear).toBe(true);
    for (const source of KNOWN) {
      expect(mayInferResolutionFromAbsence(c, source)).toBe(true);
    }
  });

  it("a FAILED source may not — its empty array is not an empty set", () => {
    const c = buildSourceCompleteness({
      knownSources: KNOWN,
      degradedSources: ["tsa_failure"],
      truncated: {},
    });
    expect(mayInferResolutionFromAbsence(c, "tsa_failure")).toBe(false);
    expect(c.bySource.tsa_failure).toEqual({
      status: "INCOMPLETE",
      reason: "SOURCE_FAILED",
    });
    // The blast radius is exactly one source. A degraded TSA read must not
    // stop the OTS category from resolving normally.
    expect(mayInferResolutionFromAbsence(c, "ots_failure")).toBe(true);
  });

  it("a CAPPED source may not — item 51 of 50 was never read", () => {
    const c = buildSourceCompleteness({
      knownSources: KNOWN,
      degradedSources: [],
      truncated: { ots_failure: true },
    });
    expect(mayInferResolutionFromAbsence(c, "ots_failure")).toBe(false);
    expect(c.bySource.ots_failure).toEqual({
      status: "INCOMPLETE",
      reason: "CAP_REACHED",
    });
  });

  it("fails CLOSED on a source nobody declared", () => {
    const c = buildSourceCompleteness({
      knownSources: KNOWN,
      degradedSources: [],
      truncated: {},
    });
    // A source the aggregation grew and forgot to declare is a source nothing
    // can vouch for. The cost of refusing is a stale History row; the cost of
    // trusting it is a fabricated resolution.
    expect(mayInferResolutionFromAbsence(c, "some_new_source")).toBe(false);
  });

  it("records an undeclared source that FAILED rather than dropping it", () => {
    const c = buildSourceCompleteness({
      knownSources: KNOWN,
      degradedSources: ["undeclared_source"],
      truncated: {},
    });
    expect(c.bySource.undeclared_source).toEqual({
      status: "INCOMPLETE",
      reason: "SOURCE_FAILED",
    });
    expect(c.incompleteSources).toContain("undeclared_source");
  });

  it("exhaustivelyEvaluatedSources returns exactly the trustworthy set", () => {
    const c = buildSourceCompleteness({
      knownSources: KNOWN,
      degradedSources: ["tsa_failure"],
      truncated: { governance: true },
    });
    expect(exhaustivelyEvaluatedSources(c).sort()).toEqual([
      "org_invite",
      "ots_failure",
    ]);
  });

  it("the snapshot sync REQUIRES a completeness verdict and honours it", () => {
    // The signature change is the guard: a caller cannot forget to pass it.
    expect(INBOX_ROUTES).toMatch(
      /export async function syncInboxSnapshots\([\s\S]{0,400}completeness: SourceCompleteness,\s*\)/,
    );
    // And the auto-resolution is narrowed to the exhaustively-read sources.
    expect(INBOX_ROUTES).toContain(
      "const resolvableSourceTypes = exhaustivelyEvaluatedSources(completeness);",
    );
    expect(INBOX_ROUTES).toMatch(
      /sourceType: \{ in: resolvableSourceTypes \}/,
    );
  });

  it("auto-resolution is skipped entirely when nothing is trustworthy", () => {
    expect(INBOX_ROUTES).toMatch(
      /if \(resolvableSourceTypes\.length > 0\) \{[\s\S]{0,900}resolutionSource: "SOURCE_STATE"/,
    );
  });

  it("every declared source prefix is covered by the completeness descriptor", () => {
    // TOTAL over the itemKey prefixes, derived rather than re-typed, so a new
    // source cannot silently escape the gate.
    expect(INBOX_ROUTES).toMatch(
      /const INBOX_EVALUATED_SOURCES: readonly string\[\] = Object\.freeze\(\[\s*\.\.\.INBOX_ITEM_KEY_PREFIXES,?\s*\]\)/,
    );
  });
});

// ============================================================================
// 2.3 — degraded-state honesty
// ============================================================================

describe("Phase 2.3 — never claim all-clear over a partial read", () => {
  it("mayAssertAllClear is false whenever ANYTHING was incomplete", () => {
    expect(
      buildSourceCompleteness({
        knownSources: ["a", "b"],
        degradedSources: ["a"],
        truncated: {},
      }).mayAssertAllClear,
    ).toBe(false);
    expect(
      buildSourceCompleteness({
        knownSources: ["a", "b"],
        degradedSources: [],
        truncated: { b: true },
      }).mayAssertAllClear,
    ).toBe(false);
  });

  it("the list envelope carries the verdict, not just the two raw flags", () => {
    expect(INBOX_ROUTES).toMatch(
      /completeness: \{\s*bySource: completeness\.bySource,[\s\S]{0,400}mayAssertAllClear: completeness\.mayAssertAllClear,/,
    );
  });

  it("the bell summary carries it too — a confident 0 is the same lie", () => {
    expect(INBOX_ROUTES).toMatch(
      /completeness: \{\s*anyIncomplete: agg\.completeness\.anyIncomplete,[\s\S]{0,300}mayAssertAllClear: agg\.completeness\.mayAssertAllClear,/,
    );
  });

  it("the Operations incident list says whether it reached the end", () => {
    const OPS = readSource("../src/routes/ops.routes.ts");
    expect(OPS).toMatch(
      /completeness: \{\s*complete: page\.complete,\s*mayAssertAllClear: page\.complete,/,
    );
  });
});

// ============================================================================
// 2.1 — two histories, named apart
// ============================================================================

describe("Phase 2.1 — notification history is not Operations history", () => {
  it("the history envelope declares which history it is", () => {
    expect(INBOX_ROUTES).toContain('historyKind: "PERSONAL_NOTIFICATION"');
    expect(INBOX_ROUTES).toContain("isOperationsLifecycleHistory: false");
  });

  it("emits sourceClearedAt beside the legacy resolvedAt name", () => {
    // The snapshot column is called `resolvedAtUtc`, and it means "the source
    // stopped addressing this to me" — a personal-feed fact. Reading it as
    // the workspace's resolution status is precisely the conflation 2.1
    // forbids, so the honest name ships alongside the compatible one.
    const occurrences = INBOX_ROUTES.match(/sourceClearedAt: s\.resolvedAtUtc/g);
    expect(occurrences?.length).toBe(2);
  });

  it("the UI no longer labels a personal-feed fact 'Resolved'", () => {
    const PAGE = readSource("../../../apps/web/app/(app)/inbox/page.tsx");
    expect(PAGE).toContain("No longer active");
    expect(PAGE).not.toMatch(/Resolved \{formatUserDate/);
  });
});

// ============================================================================
// 2.4 — notification scope
// ============================================================================

describe("Phase 2.4 — narrowing to a workspace is not discarding", () => {
  it("an item with no workspace binding survives workspace narrowing", () => {
    expect(INBOX_ROUTES).toMatch(
      /if \(itemWorkspaceId == null\) return true;\s*\n\s*return itemWorkspaceId === workspaceId;/,
    );
  });

  it("the list filter resolves through the SHARED predicate, not a copy", () => {
    // The second inline copy of the rule is gone; both the counts and the
    // list now call `isInWorkspaceScope`.
    expect(INBOX_ROUTES).not.toMatch(
      /requestedWorkspaceId &&\s*\n?\s*it\.context\?\.teamId !== requestedWorkspaceId/,
    );
    const calls = INBOX_ROUTES.match(/isInWorkspaceScope\(/g) ?? [];
    // definition + scopeItems + filteredItems + summary scope
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("history narrowing keeps account-tier rows too", () => {
    expect(INBOX_ROUTES).toMatch(
      /OR: \[\{ teamId: requestedWorkspaceId \}, \{ teamId: null \}\]/,
    );
  });

  it("scope is declared per category by the classification authority", async () => {
    const { scopeForCategory } = await import(
      "../src/services/notifications/notification-classification.js"
    );
    // The four the audit calls out by name.
    expect(scopeForCategory("org_invite")).toBe("ORGANIZATION");
    expect(scopeForCategory("discussion_mention")).toBe("WORKSPACE");
    expect(scopeForCategory("security_event_high")).toBe("ACCOUNT");
    expect(scopeForCategory("tsa_failure")).toBe("WORKSPACE");
    expect(scopeForCategory("case_assignment")).toBe("WORKSPACE");
  });
});

// ============================================================================
// 2.5 — tenant isolation
// ============================================================================

describe("Phase 2.5 — every source is gated on ACCESSIBLE workspaces", () => {
  it("AccessReview is scoped to the caller's accessible workspaces", () => {
    const start = INBOX_ROUTES.indexOf("prisma.accessReview.findMany({");
    expect(start).toBeGreaterThan(0);
    const block = INBOX_ROUTES.slice(start, start + 1800);
    expect(block).toMatch(/teamId: \{ in: teamIds \}/);
    // Subject-hood is not a tenancy gate; both predicates must be present.
    expect(block).toMatch(/subjectUserId: userId/);
  });

  it("CollaborationTeamNotification is scoped by workspaceId, not teamId", () => {
    const start = INBOX_ROUTES.indexOf(
      "prisma.collaborationTeamNotification.findMany({",
    );
    expect(start).toBeGreaterThan(0);
    const block = INBOX_ROUTES.slice(start, start + 1600);
    expect(block).toMatch(/workspaceId: \{ in: teamIds \}/);
    // `teamId` on this model is the CollaborationTeam, a feature entity —
    // gating on it would have gated on the wrong concept entirely.
    expect(block).not.toMatch(/\bteamId: \{ in: teamIds \}/);
  });

  it("`teamIds` comes from the ONE canonical accessible-workspace resolver", () => {
    expect(INBOX_ROUTES).toMatch(
      /const accessibleWorkspaces = await listAccessibleWorkspaces\(\{ userId \}\);/,
    );
    expect(INBOX_ROUTES).toMatch(
      /const teamIds = accessibleWorkspaces\.map\(\(w\) => w\.workspaceId\);/,
    );
  });

  it("EVERY workspace-scoped source in the aggregation gates on teamIds", () => {
    // A source that reads a tenanted table without the gate is the defect
    // class; this counts them rather than trusting a reviewer to notice a new
    // one. Both spellings of the gate are accepted.
    const gated = (INBOX_ROUTES.match(/(teamId|workspaceId): \{ in: teamIds \}/g) ?? [])
      .length;
    expect(gated).toBeGreaterThanOrEqual(10);
  });
});

// ============================================================================
// 2.6 — workspace-switch stale response
// ============================================================================

describe("Phase 2.6 — the latest request wins", () => {
  const HOOK = readSource("../../../apps/web/lib/net/useLatestRequest.ts");
  const PAGE = readSource("../../../apps/web/app/(app)/inbox/page.tsx");

  it("supersedes BEFORE aborting, so a dying attempt cannot commit", () => {
    expect(HOOK).toMatch(
      /generation\.current \+= 1;\s*\n\s*const id = generation\.current;\s*\n\s*controller\.current\?\.abort\(\);/,
    );
  });

  it("isCurrent() also requires the host to still be mounted", () => {
    expect(HOOK).toMatch(
      /isCurrent: \(\) => mounted\.current && generation\.current === id/,
    );
  });

  it("the notifications page guards every commit path", () => {
    expect(PAGE).toContain("const attempt = request.begin();");
    // success path, error path, and the paging path
    const guards = PAGE.match(/if \(!attempt\.isCurrent\(\)\) return;/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    expect(PAGE).toMatch(/signal: attempt\.signal/);
  });

  it("a superseded abort never renders as an error banner", () => {
    // The catch block returns before touching state when it is not current.
    expect(PAGE).toMatch(
      /\} catch \(err: unknown\) \{[\s\S]{0,400}if \(!attempt\.isCurrent\(\)\) return;[\s\S]{0,400}setState\(\{ kind: "error"/,
    );
  });
});

// ============================================================================
// 2.7 — stable ordering + keyset paging
// ============================================================================

describe("Phase 2.7 — deterministic order, cursor paging", () => {
  it("both inbox comparators end in a UNIQUE tie-break", () => {
    // Recency comparator (the bell) already did; the priority comparator
    // (the paginated list) ended at `occurredAt`, which ties.
    const byRecency = INBOX_ROUTES.indexOf("function compareInboxItemsByRecency");
    const byPriority = INBOX_ROUTES.indexOf("function compareInboxItems(");
    expect(byRecency).toBeGreaterThan(0);
    expect(byPriority).toBeGreaterThan(0);
    for (const start of [byRecency, byPriority]) {
      const body = INBOX_ROUTES.slice(start, INBOX_ROUTES.indexOf("\n}", start));
      expect(body).toMatch(/itemKey\.localeCompare\(/);
    }
  });

  it("the incident list orders totally and pages by keyset", () => {
    const SVC = readSource("../src/services/observability/incident.service.ts");
    expect(SVC).toMatch(
      /orderBy: \[\{ status: "asc" \}, \{ lastSeenAtUtc: "desc" \}, \{ id: "desc" \}\]/,
    );
    expect(SVC).toMatch(/cursor: \{ id: input\.cursor \}, skip: 1/);
    // limit + 1 is how "is there more" is answered without a second read of a
    // collection that can change between the two.
    expect(SVC).toMatch(/take: limit \+ 1/);
  });

  it("the incident list reports nextCursor rather than silently capping", () => {
    const OPS = readSource("../src/routes/ops.routes.ts");
    expect(OPS).toMatch(/nextCursor: page\.nextCursor/);
    expect(OPS).toMatch(/cursor: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });
});
