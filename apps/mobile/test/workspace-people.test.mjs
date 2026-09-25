/**
 * WORKSPACE PEOPLE — projections for members, seats and invitations.
 *
 * The claims that matter:
 *   - the counts are the SERVER'S. The detail read returns a bounded first
 *     page plus the true total, so counting the page would under-report every
 *     workspace bigger than one page and tell an owner they have seats they
 *     do not;
 *   - an unknown seat allowance is NULL, not zero. A plan that publishes no
 *     limit has an unknown allowance, and "0 available" would tell an owner
 *     they cannot invite anyone when nobody has said so;
 *   - a member with no display name is shown by email, never as a blank row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/workspace-people.ts"), "utf8").replace(
  /^import type .*$/m,
  "",
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const W = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/* ------------------------------------------------------------------- paths */

test("the paths address the canonical workspace endpoints", () => {
  assert.equal(W.buildWorkspacePath("t1"), "/v1/teams/t1");
  assert.equal(W.buildWorkspaceMembersPath("t1"), "/v1/teams/t1/members");
  assert.equal(W.buildWorkspaceMembersPath("t1", "c9"), "/v1/teams/t1/members?cursor=c9");
  assert.equal(W.buildWorkspaceInvitesPath("t1"), "/v1/teams/t1/invites");
  assert.equal(W.buildWorkspaceInvitePath("t1", "i1"), "/v1/teams/t1/invites/i1");
  assert.equal(W.buildWorkspaceInviteResendPath("t1", "i1"), "/v1/teams/t1/invites/i1/resend");
});

/* ---------------------------------------------------------------- the count */

test("the member count comes from stats, not from the page that was sent", () => {
  const ov = W.parseWorkspaceOverview({
    id: "t1",
    name: "Acme",
    stats: { memberCount: 412, seatLimit: 500, seatUsed: 412, seatAvailable: 88 },
    memberPage: { total: 412, returned: 25, hasMore: true },
  });

  assert.equal(ov.seats.memberCount, 412);
  assert.equal(ov.hasMoreMembers, true);
});

test("an unpublished seat limit is unknown, not zero", () => {
  const ov = W.parseWorkspaceOverview({ stats: { memberCount: 3 } });
  assert.equal(ov.seats.seatLimit, null);
  assert.equal(W.seatsSummary(ov.seats), null);
  // And the invite affordance must not be disabled on an unknown allowance.
  assert.equal(W.canInviteMore(ov.seats), null);
});

test("seats are summarised only when the server gave enough to say it", () => {
  assert.equal(
    W.seatsSummary({ memberCount: 4, seatLimit: 10, seatUsed: 4, seatAvailable: 6 }),
    "4 of 10 seats used · 6 available",
  );
  // Available is derived when absent, rather than dropping the summary.
  assert.equal(
    W.seatsSummary({ memberCount: 4, seatLimit: 10, seatUsed: 4, seatAvailable: null }),
    "4 of 10 seats used · 6 available",
  );
  assert.equal(W.canInviteMore({ seatLimit: 10, seatUsed: 10, seatAvailable: 0 }), false);
  assert.equal(W.canInviteMore({ seatLimit: 10, seatUsed: 4, seatAvailable: 6 }), true);
});

test("management flags are not assumed", () => {
  const ov = W.parseWorkspaceOverview({ stats: {} });
  assert.equal(ov.canManageMembers, false);
  assert.equal(ov.canManageWorkspace, false);
});

/* ----------------------------------------------------------------- members */

test("a member with no display name is shown by email, never blank", () => {
  const { members } = W.parseWorkspaceMembers({
    members: [
      { id: "m1", userId: "u1", role: "ADMIN", status: "ACTIVE", user: { email: "a@b.test" } },
      { id: "m2", userId: "u2", role: "MEMBER", status: "ACTIVE", user: {} },
      { id: "m3", userId: "u3", role: "MEMBER", status: "ACTIVE", user: { displayName: "Sam" } },
    ],
  });

  assert.equal(members[0].displayName, "a@b.test");
  assert.equal(members[1].displayName, "Unnamed member");
  assert.equal(members[2].displayName, "Sam");
});

test("a member row with no id is dropped rather than rendered", () => {
  const { members } = W.parseWorkspaceMembers({
    members: [{ id: "m1", user: {} }, { user: {} }, null],
  });
  assert.equal(members.length, 1);
});

test("member status tones never render a suspension as healthy", () => {
  assert.equal(W.memberStatusTone("ACTIVE"), "verified");
  assert.equal(W.memberStatusTone("SUSPENDED"), "risk");
  assert.equal(W.memberStatusTone("REVOKED"), "risk");
  assert.equal(W.memberStatusTone("INVITED"), "pending");
  assert.equal(W.memberStatusTone("SOMETHING_NEW"), "neutral");
});

/* ----------------------------------------------------------------- invites */

test("invitations without an id or an email are dropped", () => {
  const invites = W.parseWorkspaceInvites({
    invites: [
      { id: "i1", email: "a@b.test", role: "MEMBER" },
      { id: "i2" },
      { email: "c@d.test" },
    ],
  });
  assert.equal(invites.length, 1);
  assert.equal(invites[0].email, "a@b.test");
});

test("ownership is not offered as an invitable role", () => {
  // Ownership moves by transfer, not invitation; offering it would produce a
  // request the server refuses.
  assert.equal(W.INVITABLE_ROLES.includes("OWNER"), false);
  assert.deepEqual([...W.INVITABLE_ROLES], ["ADMIN", "MEMBER", "VIEWER"]);
});

test("the email check rejects what would obviously fail server-side", () => {
  assert.equal(W.looksLikeEmail("a@b.test"), true);
  assert.equal(W.looksLikeEmail("  a@b.test  "), true);
  for (const bad of ["", "a", "a@b", "a b@c.test", "@b.test", "a@"]) {
    assert.equal(W.looksLikeEmail(bad), false, JSON.stringify(bad));
  }
});

test("roles read as words, and an unknown role still renders", () => {
  assert.equal(W.roleLabel("OWNER"), "Owner");
  assert.equal(W.roleLabel("VIEWER"), "Viewer");
  assert.equal(W.roleLabel("SOME_NEW_ROLE"), "some new role");
});

/* ------------------------------------------- role changes on a real member */

const member = (over = {}) => ({
  id: "mem-1",
  userId: "usr-1",
  role: "MEMBER",
  status: "ACTIVE",
  displayName: "Ada",
  email: "ada@example.test",
  joinedAtIso: null,
  ...over,
});

test("the role PATCH addresses the membership, not the user", () => {
  // The route resolves :memberId against TeamMember.id (WCR-02). A user id
  // sent here answers 404.
  assert.equal(W.buildWorkspaceMemberPath("t1", "mem-1"), "/v1/teams/t1/members/mem-1");
  assert.deepEqual(W.buildRoleChangeBody("ADMIN"), { role: "ADMIN" });
});

test("ownership is not among the roles a member can be moved to", () => {
  // Ownership is transferred, not assigned. Offering it in a role picker
  // would be a different action under the wrong name.
  assert.deepEqual([...W.MANAGEABLE_ROLES], ["ADMIN", "MEMBER", "VIEWER"]);
  assert.equal(W.MANAGEABLE_ROLES.includes("OWNER"), false);
});

test("a role change is offered only where it can actually be made", () => {
  assert.equal(W.canChangeRole(member(), true), true);
  assert.equal(W.canChangeRole(member(), false), false);
  // The owner's role is not changed from here.
  assert.equal(W.canChangeRole(member({ role: "OWNER" }), true), false);
  // Changing a revoked member's role would look like restoring them.
  assert.equal(W.canChangeRole(member({ status: "REVOKED" }), true), false);
  assert.equal(W.canChangeRole(member({ status: "SUSPENDED" }), true), false);
});

test("an accepted role change is not reported as a completed one", () => {
  // The outcome comes from the RELOADED row. Announcing it from the request
  // would be the client asserting what the server has not confirmed.
  const m = member();
  assert.equal(W.describeRoleChange(m, "ADMIN", null).ok, false);
  assert.match(W.describeRoleChange(m, "ADMIN", null).message, /could not be reloaded/i);

  const contradicted = W.describeRoleChange(m, "ADMIN", member({ role: "VIEWER" }));
  assert.equal(contradicted.ok, false);
  assert.match(contradicted.message, /shows a different role/i);

  const confirmed = W.describeRoleChange(m, "ADMIN", member({ role: "ADMIN" }));
  assert.equal(confirmed.ok, true);
  assert.match(confirmed.message, /Ada is now Admin/);
});

/* -------------------------------------------------------------- case links */

test("linking and unlinking are two permissions, not one", () => {
  // POST /cases/link is MEMBER+; DELETE /cases/:caseId is ADMIN+. A MEMBER can
  // bring a case in and cannot take one out.
  assert.equal(W.canLinkCase("MEMBER"), true);
  assert.equal(W.canUnlinkCase("MEMBER"), false);
  assert.equal(W.canUnlinkCase("ADMIN"), true);
  assert.equal(W.canUnlinkCase("OWNER"), true);
  assert.equal(W.canLinkCase("VIEWER"), false);
});

test("the case paths are the canonical ones", () => {
  assert.equal(W.buildWorkspaceCasesPath("t1"), "/v1/teams/t1/cases");
  assert.equal(W.buildWorkspaceCaseLinkPath("t1"), "/v1/teams/t1/cases/link");
  assert.equal(W.buildWorkspaceCaseUnlinkPath("t1", "c1"), "/v1/teams/t1/cases/c1");
});

test("a case row with no id is dropped rather than rendered", () => {
  const list = W.parseWorkspaceCases({ items: [{ id: "c1", name: "Flood" }, {}, null] });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Flood");
});

test("an unnamed case is named, never blank", () => {
  assert.equal(W.parseWorkspaceCases({ items: [{ id: "c1" }] })[0].name, "Untitled case");
});

test("the picker cannot offer a link that already exists", () => {
  const all = W.parseWorkspaceCases({ items: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] });
  const linked = W.parseWorkspaceCases({ items: [{ id: "c2" }] });
  assert.deepEqual(W.linkableCases(all, linked).map((c) => c.id), ["c1", "c3"]);
});

/* ---------------------------------------------------------------- activity */

test("the activity read is bounded", () => {
  assert.equal(W.buildWorkspaceActivityPath("t1"), "/v1/teams/t1/activity?limit=50");
  assert.equal(W.buildWorkspaceActivityPath("t1", 25), "/v1/teams/t1/activity?limit=25");
});

test("an unresolved actor is absent, not a raw id", () => {
  const list = W.parseWorkspaceActivity({
    activities: [
      { id: "a1", eventType: "team.member_added", actor: { displayName: "Ada" } },
      { id: "a2", eventType: "team.case_linked", actor: null },
      { eventType: "no id" },
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].actorLabel, "Ada");
  assert.equal(list[1].actorLabel, null);
});

test("an event type reads as words", () => {
  assert.equal(W.activityLabel("team.case_linked"), "Team case linked");
  assert.equal(W.activityLabel(""), "Activity");
});

/* ------------------------------------------------------------------ rename */

test("a blank workspace name is refused before the request", () => {
  assert.match(W.validateWorkspaceName("   "), /needs a name/i);
  assert.equal(W.validateWorkspaceName("Field team"), null);
  assert.deepEqual(W.buildRenameBody("  Field team  "), { name: "Field team" });
});

/* ----------------------------------------- workspace ownership and closure */

test("the workspace transfer names its own field", () => {
  // This route takes newOwnerUserId; the organization route spells the same
  // thing targetUserId. A shared helper would have papered over that.
  assert.equal(W.buildWorkspaceTransferPath("t1"), "/v1/teams/t1/transfer-ownership");
  assert.deepEqual(W.buildWorkspaceTransferBody("u1"), { newOwnerUserId: "u1" });
});

test("the workspace closure paths are the canonical ones", () => {
  assert.equal(W.buildWorkspaceClosurePath("t1"), "/v1/teams/t1/closure");
  assert.equal(W.buildWorkspaceClosureCancelPath("t1", "r1"), "/v1/teams/t1/closure/r1/cancel");
});

test("only the owner is offered transfer and closure", () => {
  const ov = (role) => ({ currentUserRole: role });
  assert.equal(W.isWorkspaceOwner(ov("OWNER")), true);
  assert.equal(W.isWorkspaceOwner(ov("ADMIN")), false);
  assert.equal(W.isWorkspaceOwner(ov(null)), false);
});

test("a workspace is never handed to a suspended or revoked member", () => {
  const list = [
    member({ id: "m1", userId: "u1", role: "OWNER" }),
    member({ id: "m2", userId: "u2", role: "ADMIN" }),
    member({ id: "m3", userId: "u3", status: "REVOKED" }),
    member({ id: "m4", userId: "u4", status: "SUSPENDED" }),
    member({ id: "m5", userId: null }),
  ];
  assert.deepEqual(W.workspaceTransferTargets(list).map((m) => m.userId), ["u2"]);
});

test("a named refusal says what happened, in workspace words", () => {
  const named = (code) => W.workspaceLifecycleFailureMessage({ body: { error: { code } } }, "fallback");
  assert.match(named("owner_required"), /workspace owner/i);
  assert.match(named("target_not_member"), /this workspace/i);
  assert.equal(named("something_else"), "fallback");
});

/* ------------------------------------------------- web parity (teams/[id]) */

test("the case picker drops cases the link route refuses (already in any workspace)", () => {
  const all = W.parseWorkspaceCases({ items: [{ id: "c1", name: "A", teamId: null }, { id: "c2", name: "B", teamId: "t9" }, { id: "c3", name: "C" }] });
  assert.deepEqual(W.linkableCases(all, []).map((c) => c.id), ["c1", "c3"]);
});

test("activity reads in the web's words, and an unmapped SHOUTY type does not shout", () => {
  assert.equal(W.activityLabel("invite_created"), "Invitation sent");
  assert.equal(W.activityLabel("SOMETHING_NEW"), "Something new");
  assert.equal(W.describeActivity({ eventType: "member_added", actorLabel: "Ada" }), "Person added — Ada");
  assert.equal(W.describeActivity({ eventType: "member_added", actorLabel: null }), "Person added");
});

test("the overview resolves the owner from the embedded page, or states nothing", () => {
  const ov = W.parseWorkspaceOverview({ ownerUserId: "u1", members: [{ userId: "u1", user: { displayName: "Olivia" } }], stats: { pendingInviteCount: 2, caseCount: 3 } });
  assert.equal(ov.ownerLabel, "Olivia");
  assert.equal(ov.pendingInviteCount, 2);
  assert.equal(W.parseWorkspaceOverview({ ownerUserId: "u9", members: [] }).ownerLabel, null);
});

test("transfer candidates come from the server's eligible list, never offering the caller", () => {
  assert.equal(W.buildTransferCandidatesPath("t1", " ada ", "m5"), "/v1/teams/t1/members?eligible=ownership_transfer&limit=50&q=ada&cursor=m5");
  const page = W.parseTransferCandidates({ members: [{ userId: "me", label: "Me" }, { userId: "u2", label: "Workspace member" }], nextCursor: null, total: 2 }, "me");
  assert.deepEqual(page.rows, [{ userId: "u2", label: "Workspace member" }]);
  assert.equal(page.total, 2);
});

test("a resend is reported from the re-read list and the route's emailSent", () => {
  const inv = { id: "i1", email: "a@x.io" };
  assert.equal(W.resendOutcome(inv, true, [{ id: "i1" }]).tone, "success");
  assert.equal(W.resendOutcome(inv, false, [{ id: "i1" }]).tone, "warning");
  assert.equal(W.resendOutcome(inv, true, []).tone, "error");
  assert.equal(W.resendOutcome(inv, true, null).tone, "error");
  assert.match(W.resendErrorCopy({ code: "INVITE_NOT_FOUND" }), /no longer exists/);
});
