/**
 * Phase R16 — Collaboration Completion source-contract test.
 *
 * Pins the Phase 7 deliverables documented in
 * `docs/architecture/phase-7-collaboration-completion-final.md`.
 *
 * Stages covered:
 *   - Stage 2 — User directory enrichment vocabulary + helper
 *   - Stage 3 — Comments service + routes + UI panel
 *   - Stage 4 — Mention parser
 *   - Stage 5 — In-app notifications service + routes
 *   - Stage 6 — Notification preferences
 *   - Stage 7 — Guest foundation
 *   - Stage 8 — Access review foundation
 *   - Stage 9 — Activity v2 filtered endpoint
 *   - Constitutional rules — no fake workspace types; personal users
 *     can use Phase 7 features without an Organization.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COLLABORATION_TEAM_ACCESS_REVIEW_DECISIONS,
  COLLABORATION_TEAM_ACCESS_REVIEW_STATUSES,
  COLLABORATION_TEAM_COMMENT_STATUSES,
  COLLABORATION_TEAM_COMMENT_TARGETS,
  COLLABORATION_TEAM_DIGEST_MODES,
  COLLABORATION_TEAM_GUEST_STATUSES,
  COLLABORATION_TEAM_MENTION_TYPES,
  COLLABORATION_TEAM_NOTIFICATION_TYPES,
  COLLABORATION_TEAM_SPECIAL_MENTIONS,
  buildCollaborationTeamUserDirectoryEntry,
  isSpecialCollaborationTeamMention,
  parseCollaborationTeamMentionHandles,
  sanitiseCollaborationTeamCommentBody,
} from "@proovra/shared";
import { isCollaborationTeamModerator } from "../src/services/collaboration-team/collaboration-team.service.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  const full = join(repoRoot, rel);
  if (!existsSync(full)) throw new Error(`R16: missing required file: ${rel}`);
  return readFileSync(full, "utf8");
}
function exists(rel: string): boolean {
  return existsSync(join(repoRoot, rel));
}

// =============================================================================
// Shared vocabulary additions
// =============================================================================

describe("Phase R16 — shared vocabulary", () => {
  it("exports the 5 comment target categories", () => {
    expect(COLLABORATION_TEAM_COMMENT_TARGETS).toEqual([
      "TEAM",
      "ASSIGNMENT",
      "CASE",
      "EVIDENCE",
      "REVIEW",
    ]);
  });

  it("exports the 3 comment statuses", () => {
    expect(COLLABORATION_TEAM_COMMENT_STATUSES).toEqual([
      "ACTIVE",
      "EDITED",
      "DELETED",
    ]);
  });

  it("exports the 3 mention types + 2 special mentions", () => {
    expect(COLLABORATION_TEAM_MENTION_TYPES).toEqual([
      "USER",
      "TEAM",
      "LEAD",
    ]);
    expect(COLLABORATION_TEAM_SPECIAL_MENTIONS).toEqual(["team", "lead"]);
  });

  it("exports the 10 notification types covering the documented Phase 7 events", () => {
    const required = [
      "MENTION_IN_COMMENT",
      "ASSIGNMENT_ASSIGNED",
      "ASSIGNMENT_DUE_SOON",
      "ASSIGNMENT_COMPLETED",
      "INVITE_ACCEPTED",
      "ROLE_CHANGED",
      "MEMBER_ADDED",
      "MEMBER_REMOVED",
      "GUEST_ACCEPTED",
      "ACCESS_REVIEW_OPENED",
    ];
    for (const t of required) {
      expect(COLLABORATION_TEAM_NOTIFICATION_TYPES).toContain(t);
    }
  });

  // WORKSPACE AND COLLABORATION RECONCILIATION — "DAILY" was offered, stored
  // on the row, and consumed by nothing: no digest job exists anywhere in the
  // worker and the fan-out only ever branched on MUTED, so a person who chose
  // it to get fewer emails got exactly as many. The offered set must equal the
  // implemented set, which is what this pins.
  it("offers only the digest modes the fan-out actually implements", () => {
    expect(COLLABORATION_TEAM_DIGEST_MODES).toEqual(["INSTANT", "MUTED"]);
    const notify = read(
      "services/api/src/services/collaboration-team/collaboration-completion.service.ts",
    );
    // The one non-default mode has a branch that honours it …
    expect(notify).toContain('digest === "MUTED"');
    // … and nothing branches on a mode that is no longer offered.
    expect(codeOnly(notify)).not.toContain('"DAILY"');
  });

  it("exports the 4 guest statuses + 3 access-review statuses + 4 decisions", () => {
    expect(COLLABORATION_TEAM_GUEST_STATUSES).toEqual([
      "PENDING",
      "ACCEPTED",
      "REVOKED",
      "EXPIRED",
    ]);
    expect(COLLABORATION_TEAM_ACCESS_REVIEW_STATUSES).toEqual([
      "OPEN",
      "COMPLETED",
      "CANCELLED",
    ]);
    expect(COLLABORATION_TEAM_ACCESS_REVIEW_DECISIONS).toEqual([
      "PENDING",
      "KEEP",
      "REMOVE",
      "CHANGE_ROLE",
    ]);
  });
});

// =============================================================================
// Mention parser
// =============================================================================

describe("Phase R16 — mention parser", () => {
  it("extracts simple @handle tokens", () => {
    const out = parseCollaborationTeamMentionHandles(
      "@alice please review with @bob",
    );
    expect(out).toEqual(["alice", "bob"]);
  });

  it("recognises @team and @lead as special mentions", () => {
    const out = parseCollaborationTeamMentionHandles(
      "Heads-up @team — @lead please weigh in.",
    );
    expect(out).toContain("team");
    expect(out).toContain("lead");
    expect(isSpecialCollaborationTeamMention("team")).toBe(true);
    expect(isSpecialCollaborationTeamMention("lead")).toBe(true);
    expect(isSpecialCollaborationTeamMention("alice")).toBe(false);
  });

  it("does NOT pick up @ inside emails or URLs", () => {
    const out = parseCollaborationTeamMentionHandles(
      "Ping support@example.com or https://x.com/@foo",
    );
    expect(out).not.toContain("example");
    expect(out).not.toContain("foo");
  });

  it("dedupes case-insensitively", () => {
    const out = parseCollaborationTeamMentionHandles("@Alice @alice @ALICE");
    expect(out).toEqual(["alice"]);
  });
});

// =============================================================================
// Comment body sanitiser
// =============================================================================

describe("Phase R16 — comment body sanitiser", () => {
  it("rejects empty bodies", () => {
    const out = sanitiseCollaborationTeamCommentBody("   \n  \n  ");
    expect(out.ok).toBe(false);
  });

  it("collapses 3+ consecutive newlines to 2", () => {
    const out = sanitiseCollaborationTeamCommentBody("a\n\n\n\nb");
    if (out.ok) {
      expect(out.body).toBe("a\n\nb");
    } else throw new Error("expected ok");
  });

  it("preserves mention tokens (parser needs them)", () => {
    const out = sanitiseCollaborationTeamCommentBody(
      "Hello @alice and @team",
    );
    if (out.ok) {
      expect(out.body).toContain("@alice");
      expect(out.body).toContain("@team");
    } else throw new Error("expected ok");
  });

  it("rejects bodies over 4000 chars", () => {
    const out = sanitiseCollaborationTeamCommentBody("a".repeat(4001));
    expect(out.ok).toBe(false);
  });
});

// =============================================================================
// User directory enrichment helper
// =============================================================================

describe("Phase R16 — user directory helper", () => {
  const user = {
    id: "u-1",
    email: "alice@example.com",
    displayName: "Alice Aaronson",
    firstName: "Alice",
    lastName: "Aaronson",
    avatarUrl: null,
  };

  it("exposes full email for workspace-member viewers", () => {
    const e = buildCollaborationTeamUserDirectoryEntry(user, {
      viewerIsWorkspaceMember: true,
    });
    expect(e.email).toBe("alice@example.com");
    expect(e.emailMasked).toMatch(/^a\*\*\*@/);
    expect(e.displayName).toBe("Alice Aaronson");
    expect(e.initials).toBe("AA");
  });

  it("hides email for non-workspace-member viewers", () => {
    const e = buildCollaborationTeamUserDirectoryEntry(user, {
      viewerIsWorkspaceMember: false,
    });
    expect(e.email).toBeNull();
    expect(e.emailMasked).toMatch(/^a\*\*\*@/);
  });

  it("falls back gracefully when displayName + email missing", () => {
    const e = buildCollaborationTeamUserDirectoryEntry(
      {
        id: "u-2",
        email: null,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
      { viewerIsWorkspaceMember: true },
    );
    expect(e.displayName).toBe("Team member");
    // Initials derived from the fallback display name ("Team member" → TM).
    // Either deterministic initials OR the explicit "??" placeholder is
    // acceptable — both communicate "unknown user" to the operator.
    expect(["TM", "??"]).toContain(e.initials);
  });
});

// =============================================================================
// Schema + migration
// =============================================================================

describe("Phase R16 — schema + migration", () => {
  const schema = read("services/api/prisma/schema.prisma");

  it("declares the 7 Phase 7 Prisma models", () => {
    for (const m of [
      "CollaborationTeamComment",
      "CollaborationTeamCommentMention",
      "CollaborationTeamNotification",
      "CollaborationTeamNotificationPreference",
      "CollaborationTeamGuest",
      "CollaborationTeamAccessReview",
      "CollaborationTeamAccessReviewItem",
    ]) {
      expect(schema).toMatch(new RegExp(`model ${m}\\b`));
    }
  });

  it("ships the Phase 7 hardened migration", () => {
    const migPath =
      "services/api/prisma/migrations/20270301000000_phase_7_collaboration_completion/migration.sql";
    expect(exists(migPath)).toBe(true);
    const sql = read(migPath);
    // Every table inside a DO block with pg_tables guard.
    expect(sql).toMatch(/DO \$\$[\s\S]{0,2000}pg_tables[\s\S]{0,2000}CREATE TABLE/);
    expect(sql).toMatch(/information_schema\.columns/);
    // No tokens persisted.
    expect(sql).not.toMatch(/"raw_token"\s+VARCHAR/);
  });

  it("notifications carry readAt for in-app inbox semantics", () => {
    expect(schema).toMatch(
      /model CollaborationTeamNotification[\s\S]{0,2000}readAt\s+DateTime\?/,
    );
  });

  it("guests are time-bounded (expiresAtUtc) + revocable + auditable", () => {
    const block = (() => {
      const idx = schema.indexOf("model CollaborationTeamGuest");
      return schema.slice(idx, idx + 2000);
    })();
    expect(block).toMatch(/expiresAtUtc\s+DateTime/);
    expect(block).toMatch(/revokedAtUtc/);
    expect(block).toMatch(/revokedByUserId/);
  });
});

// =============================================================================
// Service module surface
// =============================================================================

describe("Phase R16 — service module", () => {
  const svc = read(
    "services/api/src/services/collaboration-team/collaboration-completion.service.ts",
  );

  it("exports the canonical Phase 7 service functions", () => {
    const required = [
      "resolveUserDirectoryEntries",
      "createComment",
      "listComments",
      "editComment",
      "deleteComment",
      "listMyNotifications",
      "markNotificationRead",
      "markAllNotificationsRead",
      "emitTeamNotifications",
      "getMyNotificationPreference",
      "updateMyNotificationPreference",
      "inviteGuest",
      "listGuests",
      "revokeGuest",
      "openAccessReview",
      "listAccessReviews",
      "decideAccessReviewItem",
      "completeAccessReview",
      "listTeamActivityFiltered",
    ];
    for (const sym of required) {
      expect(svc, `missing export ${sym}`).toMatch(
        new RegExp(`export async function ${sym}\\b`),
      );
    }
  });

  it("comments emit a CollaborationTeamActivity row with COMMENT_CREATED event", () => {
    // The createComment service function calls recordActivity with the
    // COMMENT_CREATED event type. The transaction wrapping is enforced
    // by the surrounding `$transaction(async (tx) => { ... })` block.
    expect(svc).toMatch(/eventType:\s*"COMMENT_CREATED"/);
    // And the activity is recorded inside the same $transaction block.
    expect(svc).toMatch(/\$transaction[\s\S]{0,8000}eventType:\s*"COMMENT_CREATED"/);
  });

  it("notification fanout never targets the actor themselves", () => {
    // The comment mention fanout filters out the author.
    expect(svc).toMatch(
      /u\.mentionedUserId\s*!==\s*input\.actorUserId/,
    );
    expect(svc).toMatch(/m\.userId\s*!==\s*input\.actorUserId/);
    // The shared `emitTeamNotifications` helper filters args.actorUserId.
    expect(svc).toMatch(/id\s*!==\s*args\.actorUserId/);
  });

  it("preferences gate fanout — MUTED + mentions: false suppress notifications", () => {
    expect(svc).toMatch(/p\.digest === "MUTED"/);
    expect(svc).toMatch(/p\.mentions !== false/);
  });

  // The guest registry never granted access: no email was sent, no read path
  // consulted it, the status never left PENDING. A TTL on a grant that does
  // not exist proves nothing, so the contract is the retirement itself — the
  // operation refuses, and rows already written stay readable so an operator
  // can see and revoke what they believed they had granted.
  it("guest invitation is retired at the service, and existing rows stay readable", () => {
    const body = svc.slice(svc.indexOf("export async function inviteGuest"));
    const inviteBody = body.slice(
      0,
      body.indexOf("export async function listGuests"),
    );
    expect(inviteBody).toContain("COLLABORATION_TEAM_GUESTS_RETIRED");
    expect(inviteBody).not.toContain("collaborationTeamGuest.create(");
    expect(svc).toContain("export async function listGuests");
  });

  it("access review items only decidable by LEAD/ADMIN", () => {
    // PHASE 12 POINT 4 STEP 1 — this was a source regex over
    // `decideAccessReviewItem ... role !== "LEAD" && role !== "ADMIN"`. The
    // literal comparison is gone: the gate and the `viewerCapabilities`
    // projection the web console renders now share ONE predicate, so the
    // affordance and the enforcement cannot drift. Assert the predicate's
    // behaviour, and that the gate still consumes it.
    expect(isCollaborationTeamModerator("LEAD")).toBe(true);
    expect(isCollaborationTeamModerator("ADMIN")).toBe(true);
    for (const role of ["MEMBER", "VIEWER", "EXTERNAL", "", null, undefined]) {
      expect(
        isCollaborationTeamModerator(role),
        `${String(role)} must not moderate`,
      ).toBe(false);
    }
    // Every moderator-gated entry point rejects through the shared predicate
    // rather than an inline role comparison of its own.
    for (const fn of [
      "decideAccessReviewItem",
      "openAccessReview",
      "completeAccessReview",
    ]) {
      expect(
        svc,
        `${fn} must gate through isCollaborationTeamModerator`,
      ).toMatch(
        new RegExp(`${fn}[\\s\\S]{0,900}!isCollaborationTeamModerator\\(role\\)`),
      );
    }
    expect(svc).not.toMatch(/role !== "LEAD" && role !== "ADMIN"/);
  });
});

// =============================================================================
// API routes
// =============================================================================

describe("Phase R16 — API routes", () => {
  const routes = read(
    "services/api/src/routes/collaboration-completion.routes.ts",
  );
  const server = read("services/api/src/server.ts");

  it("registers comments endpoints", () => {
    expect(routes).toContain('"/v1/collaboration-teams/:teamId/comments"');
    expect(routes).toContain(
      '"/v1/collaboration-teams/:teamId/comments/:commentId"',
    );
  });

  it("registers notification endpoints", () => {
    expect(routes).toContain('"/v1/collaboration-team-notifications"');
    expect(routes).toContain(
      '"/v1/collaboration-team-notifications/:notificationId/read"',
    );
    expect(routes).toContain('"/v1/collaboration-team-notifications/read-all"');
  });

  it("registers preferences endpoints", () => {
    expect(routes).toContain(
      '"/v1/collaboration-teams/:teamId/notification-preferences"',
    );
  });

  it("registers guest endpoints (invite + revoke + list)", () => {
    expect(routes).toContain('"/v1/collaboration-teams/:teamId/guests"');
    expect(routes).toContain(
      '"/v1/collaboration-teams/:teamId/guests/invite"',
    );
    expect(routes).toContain(
      '"/v1/collaboration-teams/:teamId/guests/:guestId/revoke"',
    );
  });

  it("registers access-review endpoints (open/decide/complete)", () => {
    expect(routes).toContain('"/v1/collaboration-teams/:teamId/access-review"');
    expect(routes).toContain(
      '"/v1/collaboration-teams/:teamId/access-review/items/:itemId"',
    );
    expect(routes).toContain(
      '"/v1/collaboration-teams/:teamId/access-review/:reviewId/complete"',
    );
  });

  it("registers activity v2 filtered endpoint", () => {
    expect(routes).toContain('"/v1/collaboration-teams/:teamId/activity/v2"');
  });

  it("wires the routes into the Fastify app via server.ts", () => {
    expect(server).toMatch(/collaborationCompletionRoutes/);
    expect(server).toMatch(
      /await app\.register\(collaborationCompletionRoutes\)/,
    );
  });

  it("every mutation calls the canonical emitTenantAudit facade via the audit helper", () => {
    // PHASE 11 §3 Batch A — migrated off the ad-hoc `category:
    // "collaboration_team"` field onto the canonical tenant-audit
    // facade, which writes an authoritative `workspaceId` DB column
    // (proven via the same requireMemberRole check the mutation itself
    // already ran) instead of a free-form category string.
    expect(routes).toMatch(/emitTenantAudit/);
    expect(routes).toMatch(/workspaceId: args\.workspaceId/);
  });

  // WORKSPACE AND COLLABORATION RECONCILIATION — the rule is unchanged (ONE
  // canonical resolution of the workspace an operation runs in, never a
  // per-route guess) and the helper is now the collaboration binding, which
  // resolves the workspace, authorizes the permission inside it, and confirms
  // the group belongs to that workspace — in one place, for every route.
  it("resolves + authorizes the workspace through the ONE canonical binding", () => {
    expect(routes).toContain("authorizeCollaborationTeam(");
    expect(routes).toContain(
      "collaboration-team/collaboration-authorization.js",
    );
    // No route re-derives the workspace from the caller-supplied path param.
    expect(codeOnly(routes)).not.toContain("workspaceId: req.params.teamId");
  });
});

// =============================================================================
// Frontend
// =============================================================================

describe("Phase R16 — frontend", () => {
  it("Phase 7 collaboration hub page exists", () => {
    expect(
      exists(
        "apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
      ),
    ).toBe(true);
  });

  it("Phase 7 frontend API client exists with all functions", () => {
    const client = read("apps/web/lib/api/collaboration-completion.ts");
    const required = [
      "listComments",
      "createComment",
      "editComment",
      "deleteComment",
      "listNotifications",
      "markNotificationRead",
      "markAllNotificationsRead",
      "getNotificationPreference",
      "updateNotificationPreference",
      "listGuests",
      "inviteGuest",
      "revokeGuest",
      "listAccessReviews",
      "openAccessReview",
      "decideAccessReviewItem",
      "completeAccessReview",
      "listActivityV2",
    ];
    for (const fn of required) {
      expect(client).toMatch(
        new RegExp(`export async function ${fn}\\b`),
      );
    }
  });

  // WORKSPACE AND COLLABORATION RECONCILIATION — the Hub was a second page for
  // one group, holding five panels. Three of them did nothing: guests granted
  // no access, access review enforced no decision, and the daily digest had no
  // consumer. Two duplicated surfaces that already exist — the inbox and
  // Settings. What remained is the group's conversation, and it now sits
  // beside the group's members and its work as the Discussion tab. The old URL
  // redirects rather than 404s, because those links are in people's history.
  it("the retired hub URL redirects into the team's Discussion tab", () => {
    const hub = read(
      "apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
    );
    expect(hub).toContain("router.replace(");
    expect(hub).toContain("?tab=discussion");
    expect(hub).toContain('data-testid="collaboration-hub-retired"');
  });

  it("the discussion the hub carried survives, with its interaction hooks", () => {
    const discussion = read(
      "apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx",
    );
    for (const t of ["comments-panel", "comment-create-form", "comment-submit"]) {
      expect(discussion, `missing testid ${t}`).toMatch(
        new RegExp(`data-testid="${t}"`),
      );
    }
  });

  // The affordance survives; its destination is a tab on the same page rather
  // than a second page, so the hook id stays and the href becomes a tab switch.
  it("Team detail page still offers the discussion affordance, now as a tab", () => {
    const detail = read(
      "apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx",
    );
    expect(detail).toMatch(/data-testid="collaboration-hub-link"/);
    expect(detail).toContain('goTab("discussion")');
    // It no longer navigates to the retired second page.
    expect(codeOnly(detail)).not.toContain("}/collaboration");
  });

  it("collaboration hub route is registered (not ORGANIZATION_ONLY)", () => {
    const registry = read("apps/web/lib/navigation/routeRegistry.ts");
    const idx = registry.indexOf('"workspace.collaboration_team_hub"');
    expect(idx).toBeGreaterThan(0);
    const blockStart = registry.lastIndexOf("{", idx);
    const blockEnd = registry.indexOf("},", idx);
    const block = registry.slice(blockStart, blockEnd);
    expect(block).toMatch(/requiredActiveSpace:\s*"PERSONAL_OR_ORG"/);
    expect(block).not.toMatch(/requiredActiveSpace:\s*"ORGANIZATION_ONLY"/);
  });
});

// =============================================================================
// Constitutional rules
// =============================================================================

describe("Phase R16 — constitutional rules", () => {
  const files = [
    "apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
    "apps/web/lib/api/collaboration-completion.ts",
    "services/api/src/services/collaboration-team/collaboration-completion.service.ts",
    "services/api/src/routes/collaboration-completion.routes.ts",
  ];

  it("no Phase 7 file contains forbidden fake-workspace literals", () => {
    const forbidden = [
      "Team Workspace",
      "Reviewer Workspace",
      "Governance Workspace",
      "Operations Workspace",
    ];
    for (const f of files) {
      const body = read(f);
      for (const token of forbidden) {
        expect(body, `${f} contains forbidden "${token}"`).not.toContain(
          token,
        );
      }
    }
  });

  it("Phase 7 features do not require Organization (no ORGANIZATION_ONLY route)", () => {
    const registry = read("apps/web/lib/navigation/routeRegistry.ts");
    const idx = registry.indexOf('"workspace.collaboration_team_hub"');
    const blockStart = registry.lastIndexOf("{", idx);
    const blockEnd = registry.indexOf("},", idx);
    const block = registry.slice(blockStart, blockEnd);
    expect(block).not.toMatch(/ORGANIZATION_ONLY/);
    expect(block).not.toMatch(/CREATE_ORG/);
  });

  it("guests never become full workspace members in this phase", () => {
    // Schema documents `accepted_user_id` but the service NEVER creates
    // a `TeamMember` row from a guest. We pin by ensuring the service
    // file does not write to `client.teamMember.create(`.
    const svc = read(
      "services/api/src/services/collaboration-team/collaboration-completion.service.ts",
    );
    expect(svc).not.toMatch(/teamMember\.create\(/);
  });

  it("no cross-workspace leak — every comment/notification read filters on workspace + team", () => {
    const svc = read(
      "services/api/src/services/collaboration-team/collaboration-completion.service.ts",
    );
    // The `requireMemberRole` gate filters on `teamId, userId`. Every
    // mutation/read calls it first.
    expect(svc).toMatch(/requireMemberRole\(/);
    // listMyNotifications filters on userId + workspaceId.
    expect(svc).toMatch(
      /listMyNotifications[\s\S]{0,1500}userId:\s*input\.actorUserId[\s\S]{0,400}workspaceId:\s*input\.workspaceId/,
    );
  });
});

// =============================================================================
// PHASE 12 POINT 4 PASS C0 — guest invitation: server decides, client renders
// =============================================================================
//
// Guest invitation was gated ONLY by `if (!guestsAllowed) return;` in the
// browser, where `guestsAllowed` came from a hardcoded
// `plan === "PRO" || plan === "TEAM"`. Neither the route nor the service
// checked the plan, so a FREE workspace could invite external collaborators by
// calling the API directly — and ENTERPRISE was wrongly excluded from the
// affordance. The commercial decision now lives at the canonical authority and
// the client only renders the server projection.

/** Executable lines only — a comment naming the removed pattern is not a use. */
function codeOnly(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("Phase 12 Point 4 — guest invitation is server-enforced", () => {
  const SERVICE = read(
    "services/api/src/services/collaboration-team/collaboration-completion.service.ts",
  );

  // WORKSPACE AND COLLABORATION RECONCILIATION — the gate this pinned guarded
  // an operation that granted nothing, so the operation went and the gate with
  // it. What remains is stronger than a correctly-subjected plan decision: the
  // service makes NO commercial decision here at all, which is the one shape
  // that cannot be got wrong for any workspace kind.
  it("the service makes no commercial decision here — it refuses, for everyone", () => {
    const body = SERVICE.slice(SERVICE.indexOf("export async function inviteGuest"));
    const inviteBody = body.slice(
      0,
      body.indexOf("export async function listGuests"),
    );
    expect(inviteBody).toContain("COLLABORATION_TEAM_GUESTS_RETIRED");
    // No plan list, no raw plan column, no entitlement call — nothing that
    // could resolve to "allowed" for anybody.
    expect(codeOnly(inviteBody)).not.toMatch(/===\s*"(PRO|TEAM|FREE|ENTERPRISE)"/);
    expect(codeOnly(inviteBody)).not.toContain("billingPlan");
    expect(codeOnly(inviteBody)).not.toContain("assertCanInvite");
  });

  // There is no invitation mutation left to precede: authorization still runs
  // first (a foreign team is concealed, an inactive member is refused), and
  // then the operation refuses without opening a transaction.
  it("the refusal reaches no writer at all", () => {
    const body = SERVICE.slice(SERVICE.indexOf("export async function inviteGuest"));
    const inviteBody = body.slice(
      0,
      body.indexOf("export async function listGuests"),
    );
    // Authorization is still the first thing that happens.
    const authIdx = inviteBody.indexOf("requireMemberRole");
    const refusalIdx = inviteBody.indexOf("COLLABORATION_TEAM_GUESTS_RETIRED");
    expect(authIdx).toBeGreaterThan(-1);
    expect(refusalIdx).toBeGreaterThan(authIdx);
    // And nothing is written on the way out.
    expect(inviteBody).not.toContain("$transaction");
    expect(inviteBody).not.toContain("collaborationTeamGuest.create(");
  });

  // The projection stays catalog-derived rather than a plan-name list. It has
  // no consumer while the surface is retired; keeping it derived means that if
  // external collaboration is ever offered from a workspace surface again, the
  // eligibility it reads is the catalog's, not a hardcoded tier list.
  it("the guest eligibility projection is catalog-derived, not a plan-name list", () => {
    const ctx = read(
      "services/api/src/services/platform-context/platform-context.service.ts",
    );
    expect(ctx).toMatch(/canInviteGuests:\s*planCaps\.allowsSharedWorkspace/);
  });

  // The surface that held the browser-side plan decision is retired entirely.
  // A page that renders nothing but a redirect cannot decide eligibility, and
  // the discussion that replaced it decides none either.
  it("no collaboration surface decides eligibility from a plan name", () => {
    const page = read(
      "apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
    );
    expect(page).not.toContain("useAccessReviewPlanGate");
    expect(codeOnly(page)).not.toMatch(/plan\s*===\s*"(PRO|TEAM|FREE|ENTERPRISE)"/);

    const discussion = read(
      "apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/DiscussionTab.tsx",
    );
    expect(codeOnly(discussion)).not.toMatch(
      /plan\s*===\s*"(PRO|TEAM|FREE|ENTERPRISE)"/,
    );
  });
});
