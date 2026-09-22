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
