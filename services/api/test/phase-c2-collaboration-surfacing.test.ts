/**
 * Phase C2 — Collaboration Surfacing (source-contract suite).
 *
 * Asserts:
 *
 *   1. The /v1/me/inbox aggregator now surfaces discussion mentions +
 *      assigned threads, scoped to caller's teamIds.
 *   2. The header Notification Bell shares the CANONICAL unread
 *      calculation: it polls GET /v1/me/inbox?filter=unread (the same
 *      aggregation the Operations Center renders) — the former
 *      /v1/me/inbox/summary two-category endpoint is gone, so no
 *      partial badge math can exist anywhere.
 *   3. POST /v1/collaboration/threads/:id/mark-mentions-read updates
 *      DiscussionMention.notifiedAtUtc for the caller, idempotent, and
 *      gated by reviewer-member access + cross-workspace safety.
 *   4. GET /v1/cases/:id/discussion-threads aggregates discussion
 *      threads for the case's linked evidence. Workspace-scoped via
 *      the case's teamId. Read-only — no audit emission.
 *   5. The Evidence Detail page declares a Discussion tab and mounts
 *      the EvidenceDiscussionPanel, with `?tab=discussion&thread=:id`
 *      deep-link support.
 *   6. EvidenceDiscussionPanel consumes the existing audited
 *      /v1/collaboration/threads* endpoints, renders mention tokens,
 *      and never bypasses the backend audit.
 *   7. The Matter Workspace Communications tab surfaces discussion
 *      threads via the new aggregator without breaking the C1
 *      empty-state contract.
 *   8. The /inbox page handles the two new categories.
 *   9. AppAccountToolbar mounts the NotificationBell (and remains
 *      apiFetch-free itself, satisfying the Phase 32.8 contract).
 *  10. Vocabulary discipline — no chat / Slack / social phrases leak
 *      into any C2 surface.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  // Remove /* ... */ and // ... line comments so vocabulary contracts
  // do not match documentation banning the very phrases they ban.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const ME_INBOX_ROUTES = readSource("../src/routes/me-inbox.routes.ts");
const COLLAB_ROUTES = readSource("../src/routes/collaboration.routes.ts");
const CASE_ROUTES = readSource("../src/routes/case-workspace.routes.ts");
// Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
// concatenate the orchestrator + every tab body so source-shape
// assertions still find the relevant snippets.
const EVIDENCE_PAGE = [
  "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx",
  "../../../apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx",
].map(readSource).join("\n\n");
const DISCUSSION_PANEL = readSource(
  "../../../apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx",
);
const MATTER_UI = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);
const INBOX_PAGE = readSource("../../../apps/web/app/(app)/inbox/page.tsx");
// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
const TOPBAR = readSource(
  "../../../apps/web/components/app-shell-v2/AppAccountToolbar.tsx",
);
const NOTIFICATION_BELL = readSource(
  "../../../apps/web/components/app-shell-v2/NotificationBell.tsx",
);

// ===========================================================================
// 1. Inbox aggregator extension
// ===========================================================================

describe("Phase C2 — /v1/me/inbox surfaces discussion signals", () => {
  it("declares the two new InboxCategory members", () => {
    expect(ME_INBOX_ROUTES).toContain('"discussion_mention"');
    expect(ME_INBOX_ROUTES).toContain('"discussion_assigned"');
  });

  it("queries DiscussionMention scoped to caller's teamIds + unread (notifiedAtUtc null)", () => {
    expect(ME_INBOX_ROUTES).toMatch(
      /prisma\.discussionMention\.findMany\(\{[\s\S]*?teamId:\s*\{\s*in:\s*teamIds\s*\}[\s\S]*?mentionedUserId:\s*userId[\s\S]*?notifiedAtUtc:\s*null/,
    );
  });

  it("queries DiscussionThread scoped to caller's teamIds + assignedToUserId + active status", () => {
    expect(ME_INBOX_ROUTES).toMatch(
      /prisma\.discussionThread\.findMany\(\{[\s\S]*?teamId:\s*\{\s*in:\s*teamIds\s*\}[\s\S]*?assignedToUserId:\s*userId[\s\S]*?status:\s*\{\s*notIn:\s*\["RESOLVED",\s*"CLOSED"\]\s*\}/,
    );
  });

  it("emits inbox items with deep-link href into evidence ?tab=discussion&thread=", () => {
    expect(ME_INBOX_ROUTES).toContain(
      "?tab=discussion&thread=${encodeURIComponent",
    );
    expect(ME_INBOX_ROUTES).toMatch(/\/evidence\/\$\{encodeURIComponent/);
  });

  it("byCategory summary includes the new discussion categories", () => {
    // Phase IA-enterprise — the summary now iterates the post-filter
    // `filteredItems` set so counts match the active filter window.
    // Both legacy item names accepted as a defensive fallback.
    expect(ME_INBOX_ROUTES).toMatch(
      /discussion_mention:\s*(items|filteredItems)\.filter/,
    );
    expect(ME_INBOX_ROUTES).toMatch(
      /discussion_assigned:\s*(items|filteredItems)\.filter/,
    );
  });
});

// ===========================================================================
// 2. Unified unread calculation (Operations-Center redesign)
// ===========================================================================

describe("Unified unread calculation — one backend computation platform-wide", () => {
  it("the summary endpoint is computed from the CANONICAL aggregation (never partial counts)", () => {
    expect(ME_INBOX_ROUTES).toMatch(/app\.get\(\s*"\/v1\/me\/inbox\/summary"/);
    // The summary handler calls the same buildInboxAggregation as the
    // page — the legacy mention/assignment-only count queries are gone.
    const summaryBlock = ME_INBOX_ROUTES.slice(
      ME_INBOX_ROUTES.indexOf('"/v1/me/inbox/summary"'),
      ME_INBOX_ROUTES.indexOf('"/v1/me/inbox/mark-all-read"'),
    );
    expect(summaryBlock).toContain("buildInboxAggregation(userId");
    expect(summaryBlock).not.toMatch(/discussionMention\.count/);
    expect(summaryBlock).not.toMatch(/discussionThread\.count/);
    // Cached per user + invalidated on mutation.
    expect(summaryBlock).toContain("getCachedOperationsSummary");
    expect(summaryBlock).toContain("setCachedOperationsSummary");
    expect(ME_INBOX_ROUTES).toContain("invalidateOperationsSummary");
  });

  it("the NotificationBell polls the lightweight summary; rows load only on open", () => {
    expect(NOTIFICATION_BELL).toContain("/v1/me/inbox/summary");
    // RECENT, not unread. The list used to BE the unread set, so marking an
    // item read removed it from the list's own population — reading and
    // dismissing were indistinguishable on screen. It is now the five most
    // recent visible items, read and unread alike.
    expect(NOTIFICATION_BELL).toContain("/v1/me/inbox?filter=all&sort=recent");
    // The REQUEST shape, not the bare substring — the module's own docstring
    // names the retired query in order to explain why it was retired, and a
    // guard that forbids naming a mistake also forbids recording it.
    expect(NOTIFICATION_BELL).not.toMatch(/inbox\?filter=unread/);
    // The poll loop drives loadSummary, not the full item fetch.
    expect(NOTIFICATION_BELL).toMatch(/await loadSummary\(\);\s*\n\s*if \(alive\) timer/);
    expect(NOTIFICATION_BELL).toMatch(/if \(!open\) return;\s*\n\s*void loadItems\(\)/);
  });

  it("the badge is the server-computed unread total — never a client estimate", () => {
    expect(NOTIFICATION_BELL).toMatch(/setUnreadCount\(res\.unread\)/);
    // …and NOT the list's total. That total now counts the whole VISIBLE
    // population, which includes read items, so wiring the badge to it would
    // make a fully-read inbox show a non-zero count. The summary owns the
    // number; the list owns the rows.
    expect(NOTIFICATION_BELL).not.toMatch(
      /setUnreadCount\([^)]*pagination\.totalEstimate/,
    );
    // No arithmetic on the previous value anywhere: the refreshed server count
    // is the authority, never a permanent local decrement.
    expect(NOTIFICATION_BELL).not.toMatch(
      /setUnreadCount\(\s*\(?\s*(unreadCount|prev|c|n)\s*\)?\s*(-|\+)/,
    );
  });
});

// ===========================================================================
// 3. Mark-mentions-read endpoint
// ===========================================================================

describe("Phase C2 — POST /v1/collaboration/threads/:id/mark-mentions-read", () => {
  it("registers the endpoint behind requireAuth", () => {
    expect(COLLAB_ROUTES).toMatch(
      /app\.post\(\s*"\/v1\/collaboration\/threads\/:id\/mark-mentions-read"[\s\S]*?preHandler:\s*requireAuth/,
    );
  });

  it("requires reviewer-member access on the workspace (anti-enumeration)", () => {
    const handler = COLLAB_ROUTES.match(
      /mark-mentions-read[\s\S]*?async \(req, reply\)[\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).toContain("requireReviewerMember");
  });

  it("validates the thread belongs to the workspace before updating", () => {
    expect(COLLAB_ROUTES).toMatch(
      /thread\.teamId\s*!==\s*query\.teamId/,
    );
  });

  it("updates only the caller's unread mentions on the target thread", () => {
    expect(COLLAB_ROUTES).toMatch(
      /discussionMention\.updateMany\(\{[\s\S]*?threadId:\s*params\.id[\s\S]*?mentionedUserId:\s*ok\.userId[\s\S]*?notifiedAtUtc:\s*null/,
    );
  });

  it("idempotent: returns markedRead count", () => {
    expect(COLLAB_ROUTES).toMatch(/markedRead:\s*result\.count/);
  });
});

// ===========================================================================
// 4. Matter-level discussion aggregator
// ===========================================================================

describe("Phase C2 — GET /v1/cases/:id/discussion-threads aggregator", () => {
  it("registers the endpoint behind requireAuth + requireCaseAccess", () => {
    expect(CASE_ROUTES).toContain('"/v1/cases/:id/discussion-threads"');
    const handler = CASE_ROUTES.match(
      /discussion-threads[\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).toContain("requireCaseAccess");
  });

  it("scope-binds the query to the case's teamId + linked evidence", () => {
    expect(CASE_ROUTES).toMatch(
      /prisma\.discussionThread\.findMany\(\{[\s\S]*?teamId:\s*caseRow\.teamId[\s\S]*?evidenceId:\s*\{\s*in:\s*evidenceIds\s*\}/,
    );
  });

  it("returns counts by status + escalated tally", () => {
    expect(CASE_ROUTES).toMatch(/open:\s*threads\.filter/);
    expect(CASE_ROUTES).toMatch(/escalated:\s*threads\.filter/);
  });

  it("is bounded (≤ 50 threads per response)", () => {
    expect(CASE_ROUTES).toMatch(/take:\s*50/);
  });

  it("emits no audit on read (browsing is not an auditable action)", () => {
    const handler = CASE_ROUTES.match(
      /discussion-threads[\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).not.toMatch(/appendCustodyEvent|appendPlatformAuditLog|writeAnalyticsEvent|appendReviewerAuditEvent/);
  });
});

// ===========================================================================
// 5. Evidence detail page — Discussion tab
// ===========================================================================

describe("Phase C2 — /evidence/[id] Discussion tab", () => {
  it("declares discussion in the EvidenceDetailTab union", () => {
    expect(EVIDENCE_PAGE).toMatch(
      /type EvidenceDetailTab[\s\S]*?\|\s*"discussion"/,
    );
  });

  it("adds Discussion entry to the DETAIL_TABS catalog with MessageSquare icon", () => {
    expect(EVIDENCE_PAGE).toMatch(
      /id:\s*"discussion",\s*label:\s*"Discussion",\s*icon:\s*MessageSquare/,
    );
  });

  it("seeds initial tab + thread from URL search params", () => {
    expect(EVIDENCE_PAGE).toContain("useSearchParams");
    expect(EVIDENCE_PAGE).toMatch(
      /searchParams\?\.get\("tab"\)/,
    );
    expect(EVIDENCE_PAGE).toMatch(
      /searchParams\?\.get\("thread"\)/,
    );
  });

  it("renders the EvidenceDiscussionPanel when the tab is active", () => {
    expect(EVIDENCE_PAGE).toMatch(
      /activeTab\s*===\s*"discussion"[\s\S]*?<EvidenceDiscussionPanel/,
    );
  });

  it("imports EvidenceDiscussionPanel from the local components folder", () => {
    // Phase EVIDENCE-IA-DECOMPOSE — the Discussion tab body moved
    // into _tabs/EvidenceDiscussionTab.tsx, so the import path
    // climbs one extra `..` to reach the sibling components folder.
    // Either depth is accepted.
    expect(EVIDENCE_PAGE).toMatch(
      /import\s+EvidenceDiscussionPanel\s+from\s+"\.\.?\/components\/EvidenceDiscussionPanel"/,
    );
  });
});

// ===========================================================================
// 6. EvidenceDiscussionPanel contract
// ===========================================================================

describe("Phase C2 — EvidenceDiscussionPanel contract", () => {
  it("consumes the existing audited collaboration endpoints", () => {
    expect(DISCUSSION_PANEL).toContain("/v1/collaboration/threads?teamId=");
    expect(DISCUSSION_PANEL).toContain("/messages?teamId=");
    expect(DISCUSSION_PANEL).toContain(
      "/mark-mentions-read?teamId=",
    );
  });

  it("never bypasses the audited surface — only POST /messages and mark-mentions-read", () => {
    // Allowed POSTs are the two audited endpoints above. Any OTHER
    // POST/PATCH/DELETE would indicate a mutation surface bypass.
    const otherPosts = (DISCUSSION_PANEL.match(/method:\s*"POST"/g) ?? []).length;
    expect(otherPosts).toBeGreaterThan(0);
    expect(DISCUSSION_PANEL).not.toMatch(/method:\s*"PATCH"/);
    expect(DISCUSSION_PANEL).not.toMatch(/method:\s*"DELETE"/);
  });

  it("renders mention tokens with deterministic highlighting", () => {
    expect(DISCUSSION_PANEL).toContain("renderMessageBody");
    expect(DISCUSSION_PANEL).toContain("data-discussion-mention-token");
  });

  it("renders operator-safe empty states", () => {
    expect(DISCUSSION_PANEL).toContain('data-evidence-discussion-empty="no-workspace"');
    expect(DISCUSSION_PANEL).toContain('data-evidence-discussion-empty="no-threads"');
    expect(DISCUSSION_PANEL).toContain('data-evidence-discussion-empty="no-messages"');
  });

  it("locks composition when the thread is RESOLVED or CLOSED", () => {
    expect(DISCUSSION_PANEL).toMatch(
      /status\s*===\s*"RESOLVED"\s*\|\|[\s\S]*?status\s*===\s*"CLOSED"/,
    );
    expect(DISCUSSION_PANEL).toContain("data-evidence-discussion-locked");
  });
});

// ===========================================================================
// 7. Matter Workspace Communications tab extension
// ===========================================================================

describe("Phase C2 — Matter Workspace Communications tab", () => {
  it("fetches the new /v1/cases/:id/discussion-threads aggregator", () => {
    expect(MATTER_UI).toContain(
      "/v1/cases/${encodeURIComponent(envelope.case.id)}/discussion-threads",
    );
  });

  it("renders discussion threads as a section with links into evidence ?tab=discussion&thread=", () => {
    expect(MATTER_UI).toContain("data-matter-discussion-threads");
    expect(MATTER_UI).toContain("?tab=discussion&thread=");
  });

  it("preserves the C1 empty-state contract (EmptyState reference still present)", () => {
    // The CommunicationsTab function must still contain <EmptyState
    // somewhere — the Phase C1 test asserts this for every tab.
    const tabFn = MATTER_UI.match(
      /function\s+CommunicationsTab\s*\([\s\S]*?\n\}\s*\n/,
    );
    expect(tabFn).toBeTruthy();
    expect(tabFn![0]).toContain("<EmptyState");
  });
});

// ===========================================================================
// 8. Inbox page — new categories
// ===========================================================================

describe("Phase C2 — /inbox page surfaces the new categories", () => {
  it("declares the two new InboxCategory members", () => {
    expect(INBOX_PAGE).toContain('"discussion_mention"');
    expect(INBOX_PAGE).toContain('"discussion_assigned"');
  });

  it("provides operator-readable labels for the new categories", () => {
    expect(INBOX_PAGE).toMatch(/discussion_mention:\s*"Mention"/);
    expect(INBOX_PAGE).toMatch(/discussion_assigned:\s*"Assigned thread"/);
  });
});

// ===========================================================================
// 9. Header Notification Bell (Operations-Center redesign)
// ===========================================================================

describe("Header Notification Bell", () => {
  it("AppAccountToolbar mounts the NotificationBell", () => {
    expect(TOPBAR).toContain("NotificationBell");
    expect(TOPBAR).toMatch(/<NotificationBell\s*\/>/);
  });

  it("AppAccountToolbar itself still satisfies the Phase 32.8 'no apiFetch' contract", () => {
    const code = stripComments(TOPBAR);
    expect(code).not.toMatch(/apiFetch\(/);
  });

  it("polls on a slow (2-minute) awareness cadence — no realtime sockets", () => {
    expect(NOTIFICATION_BELL).toMatch(/POLL_INTERVAL_MS\s*=\s*120_000/);
    expect(NOTIFICATION_BELL).not.toMatch(/WebSocket|EventSource|socket\.io/);
  });

  /**
   * CONTRACT MIGRATION — Attention Architecture Phase 5 (2026-08-22).
   *
   * /inbox and /notifications swapped meaning. The personal notification
   * centre's canonical URL is now /notifications; /inbox is a PERMANENT
   * compatibility redirect. Every first-party link points at the canonical
   * URL so we stop minting new traffic through a redirect, and the old URL
   * keeps resolving for links already shipped in email.
   */
  it("popover footer deep-links to the notification centre", () => {
    expect(NOTIFICATION_BELL).toMatch(/href="\/notifications"/);
    // PHASE 5 (2026-08-22) — the route MOVED. /notifications is the canonical
    // personal notification centre and /inbox is a permanent compatibility
    // redirect, so the bell links to the canonical URL rather than sending
    // every click through a 308. The LABEL says what the link is for, because
    // the popover shows five recent items and the destination holds the rest.
    expect(NOTIFICATION_BELL).toContain("View all notifications");
  });

  it("badge count is bounded (99+ overflow)", () => {
    expect(NOTIFICATION_BELL).toMatch(/return\s+"99\+"/);
  });

  it("mutates ONLY via the canonical per-item state endpoints (read/dismiss)", () => {
    // The popover's mark-read/dismiss go through the same audited
    // /v1/me/inbox/items/:itemKey/{read,dismiss} endpoints the
    // Operations Center uses — never a parallel mutation surface.
    expect(NOTIFICATION_BELL).toMatch(
      /\/v1\/me\/inbox\/items\/\$\{encodeURIComponent\(itemKey\)\}\/\$\{action\}/,
    );
    expect(NOTIFICATION_BELL).toMatch(/"read" \| "dismiss"/);
    expect(NOTIFICATION_BELL).not.toMatch(/method:\s*"PATCH"/);
    expect(NOTIFICATION_BELL).not.toMatch(/method:\s*"DELETE"/);
  });
});

// ===========================================================================
// 10. Vocabulary discipline across all C2 surfaces
// ===========================================================================

describe("Phase C2 — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "DiscussionPanel", src: DISCUSSION_PANEL },
    { name: "MatterWorkspace", src: MATTER_UI },
    { name: "InboxPage", src: INBOX_PAGE },
    { name: "NotificationBell", src: NOTIFICATION_BELL },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "Slack", re: /\bSlack\b/i },
    { name: "DMs", re: /\bdirect messages?\b/i },
    { name: "social feed", re: /\bsocial\s+feed\b/i },
    { name: "reactions/emojis", re: /\bemoji\b|\breaction\b/i },
    { name: "AI summarization", re: /\bAI\s+summariz/i },
    { name: "tampered", re: /\btampered?\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "forensic proof", re: /\bforensic\s+proof\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}'`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});
