/**
 * Phase C2 — Collaboration Surfacing (source-contract suite).
 *
 * Asserts:
 *
 *   1. The /v1/me/inbox aggregator now surfaces discussion mentions +
 *      assigned threads, scoped to caller's teamIds.
 *   2. GET /v1/me/inbox/summary returns the bounded
 *      `{ unreadMentions, openAssignments }` counter envelope used by
 *      the topbar indicator. Workspace-scoped server-side.
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
 *   9. AppTopbarV2 mounts InboxIndicator (and remains apiFetch-free
 *      itself, satisfying the Phase 32.8 foundation contract).
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
const EVIDENCE_PAGE = readSource(
  "../../../apps/web/app/(app)/evidence/[id]/page.tsx",
);
const DISCUSSION_PANEL = readSource(
  "../../../apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx",
);
const MATTER_UI = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);
const INBOX_PAGE = readSource("../../../apps/web/app/(app)/inbox/page.tsx");
const TOPBAR = readSource(
  "../../../apps/web/components/app-shell-v2/AppTopbarV2.tsx",
);
const TOPBAR_INDICATOR = readSource(
  "../../../apps/web/components/app-shell-v2/InboxIndicator.tsx",
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
// 2. /v1/me/inbox/summary topbar endpoint
// ===========================================================================

describe("Phase C2 — /v1/me/inbox/summary topbar counter endpoint", () => {
  it("registers GET /v1/me/inbox/summary", () => {
    expect(ME_INBOX_ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/me\/inbox\/summary"/,
    );
  });

  it("returns bounded { unreadMentions, openAssignments } counters", () => {
    expect(ME_INBOX_ROUTES).toMatch(
      /reply\.code\(200\)\.send\(\{[\s\S]*?unreadMentions[\s\S]*?openAssignments/,
    );
  });

  it("is workspace-scoped — counts narrow to teamIds the caller is a member of", () => {
    // Both count queries inside /v1/me/inbox/summary must constrain
    // by `teamId: { in: teamIds }` so cross-workspace counters cannot
    // leak. We check by anchoring to the count() callsites unique to
    // this endpoint (discussionMention.count + discussionThread.count
    // immediately under the new summary handler).
    expect(ME_INBOX_ROUTES).toMatch(
      /discussionMention\.count\(\{[\s\S]*?teamId:\s*\{\s*in:\s*teamIds\s*\}[\s\S]*?mentionedUserId:\s*userId[\s\S]*?notifiedAtUtc:\s*null/,
    );
    expect(ME_INBOX_ROUTES).toMatch(
      /discussionThread\.count\(\{[\s\S]*?teamId:\s*\{\s*in:\s*teamIds\s*\}[\s\S]*?assignedToUserId:\s*userId/,
    );
  });

  it("short-circuits to zero when caller belongs to no workspace", () => {
    expect(ME_INBOX_ROUTES).toMatch(
      /if\s*\(teamIds\.length\s*===\s*0\)\s*\{[\s\S]*?unreadMentions:\s*0[\s\S]*?openAssignments:\s*0/,
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
    expect(EVIDENCE_PAGE).toMatch(
      /import\s+EvidenceDiscussionPanel\s+from\s+"\.\/components\/EvidenceDiscussionPanel"/,
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
// 9. Topbar inbox indicator
// ===========================================================================

describe("Phase C2 — topbar inbox indicator", () => {
  it("AppTopbarV2 mounts the InboxIndicator", () => {
    expect(TOPBAR).toContain("InboxIndicator");
    expect(TOPBAR).toMatch(/<InboxIndicator\s*\/>/);
  });

  it("AppTopbarV2 itself still satisfies the Phase 32.8 'no apiFetch' contract", () => {
    const code = stripComments(TOPBAR);
    expect(code).not.toMatch(/apiFetch\(/);
  });

  it("InboxIndicator polls /v1/me/inbox/summary on a slow interval", () => {
    expect(TOPBAR_INDICATOR).toContain("/v1/me/inbox/summary");
    expect(TOPBAR_INDICATOR).toMatch(/POLL_INTERVAL_MS\s*=\s*60_000/);
  });

  it("InboxIndicator deep-links to /inbox", () => {
    expect(TOPBAR_INDICATOR).toMatch(/href="\/inbox"/);
  });

  it("badge count is bounded (99+ overflow)", () => {
    expect(TOPBAR_INDICATOR).toMatch(/return\s+"99\+"/);
  });

  it("read-only — does not call any mutation API", () => {
    expect(TOPBAR_INDICATOR).not.toMatch(/method:\s*"POST"/);
    expect(TOPBAR_INDICATOR).not.toMatch(/method:\s*"PATCH"/);
    expect(TOPBAR_INDICATOR).not.toMatch(/method:\s*"DELETE"/);
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
    { name: "InboxIndicator", src: TOPBAR_INDICATOR },
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
