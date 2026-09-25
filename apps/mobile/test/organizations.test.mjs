/**
 * ORGANIZATIONS — governance projections.
 *
 * The claim that matters most is about what this module does NOT do. The
 * endpoint filters to CUSTOMER organizations the caller is an ACTIVE member
 * of, and both filters exist for stated reasons: the internal 1:1 bootstrap
 * container every workspace owns is not a customer organization, and a
 * suspended membership must not appear and then refuse on arrival. Re-applying
 * either filter here would create a second authority that disagrees with the
 * server the moment one of them changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/product/organizations.ts"), "utf8");
const js = ts.transpileModule(SRC.replace(/^import type .*$/m, ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const O = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const org = (over = {}) => ({
  organizationId: "o1",
  name: "Acme Legal",
  status: "ACTIVE",
  role: "ORG_ADMIN",
  orgCreatedAt: "2026-01-01T00:00:00.000Z",
  memberSince: "2026-02-01T00:00:00.000Z",
  memberCount: 12,
  workspaceCount: 3,
  pendingInviteCount: 0,
  ...over,
});

/* -------------------------------------------------------------------- paths */

test("the paths address the canonical organization endpoints", () => {
  assert.equal(O.MY_ORGS_PATH, "/v1/me/orgs");
  assert.equal(O.buildOrgPath("o1"), "/v1/orgs/o1");
  assert.equal(O.buildOrgMembersPath("o1"), "/v1/orgs/o1/members");
  assert.equal(O.buildOrgWorkspacesPath("o1"), "/v1/orgs/o1/workspaces");
  assert.equal(O.buildOrgInvitesPath("o1"), "/v1/orgs/o1/invites");
});

/* ---------------------------------------------------- no second filter here */

test("the client re-applies none of the server's filters", () => {
  // A row the server chose to send is rendered. Filtering again here would
  // hide an organization the server considers the caller a member of.
  const list = O.parseMyOrgs({
    orgs: [
      org({ organizationId: "a", status: "ACTIVE" }),
      org({ organizationId: "b", status: "SUSPENDED" }),
      org({ organizationId: "c", status: "" }),
    ],
  });
  assert.deepEqual(list.map((o) => o.organizationId), ["a", "b", "c"]);
});

test("the module declares no kind or membership-status filter of its own", () => {
  for (const forbidden of [/kind\s*===\s*["']CUSTOMER["']/, /status\s*===\s*["']ACTIVE["']\s*\)/]) {
    assert.doesNotMatch(SRC, forbidden, "a server-side filter is duplicated in the client");
  }
});

test("an org row with no id is dropped rather than rendered", () => {
  const list = O.parseMyOrgs({ orgs: [org(), { name: "nameless" }, null] });
  assert.equal(list.length, 1);
});

/* ------------------------------------------------------------------ counts */

test("the server's total is read separately from the list length", () => {
  assert.equal(O.parseMyOrgsTotal({ summary: { totalOrgs: 7 } }), 7);
  // Absent is null, never a count derived from the rows — a mismatch is a
  // signal, not something to paper over.
  assert.equal(O.parseMyOrgsTotal({ orgs: [org(), org()] }), null);
});

test("the summary line names pending invitations only when there are any", () => {
  assert.equal(O.orgSummaryLine(org()), "12 members · 3 workspaces");
  assert.equal(
    O.orgSummaryLine(org({ pendingInviteCount: 1 })),
    "12 members · 3 workspaces · 1 pending invitation",
  );
  assert.equal(
    O.orgSummaryLine(org({ memberCount: 1, workspaceCount: 1 })),
    "1 member · 1 workspace",
  );
});

/* ------------------------------------------------------------------ detail */

test("an organization with no id is not an organization", () => {
  assert.equal(O.parseOrgDetail({}), null);
  assert.equal(O.parseOrgDetail(null), null);
  assert.equal(O.parseOrgDetail({ organization: { name: "x" } }), null);
});

test("the detail reads the server's FLAT shape keyed organizationId, with its summary", () => {
  const d = O.parseOrgDetail({ organizationId: "o1", name: "Acme", callerRole: "ORG_OWNER", summary: { memberCount: 1, workspaceCount: 0, pendingInviteCount: 3 } });
  assert.equal(d.id, "o1", "the organization id the server sends was not read");
  assert.equal(d.name, "Acme");
  assert.equal(d.callerRole, "ORG_OWNER");
  assert.equal(d.memberCount, 1);
  assert.equal(d.pendingInviteCount, 3);
});

test("a member with no name falls back to email, then to unnamed", () => {
  const members = O.parseOrgMembers({
    members: [
      { id: "m1", user: { email: "a@b.test" } },
      { id: "m2", user: {} },
      { userId: "u3", displayName: "Sam" },
      { role: "ORG_ADMIN" },
    ],
  });
  assert.deepEqual(members.map((m) => m.displayName), ["a@b.test", "Unnamed member", "Sam"]);
});

/* ------------------------------------------------------------ presentation */

test("status tones never render a suspension as healthy", () => {
  assert.equal(O.orgStatusTone("ACTIVE"), "verified");
  assert.equal(O.orgStatusTone("SUSPENDED"), "risk");
  assert.equal(O.orgStatusTone("CLOSED"), "risk");
  assert.equal(O.orgStatusTone("PENDING_VERIFICATION"), "pending");
  assert.equal(O.orgStatusTone("SOMETHING_NEW"), "neutral");
});

test("roles read as words and the admin gate mirrors the server's", () => {
  assert.equal(O.orgRoleLabel("ORG_OWNER"), "Owner");
  assert.equal(O.orgRoleLabel("ORG_ADMIN"), "Admin");
  assert.equal(O.orgRoleLabel(""), "Member");
  assert.equal(O.isOrgAdminRole("ORG_OWNER"), true);
  assert.equal(O.isOrgAdminRole("ORG_ADMIN"), true);
  assert.equal(O.isOrgAdminRole("ORG_MEMBER"), false);
});

/* ---------------------------------------------- audit timeline + lifecycle */

test("the audit path carries the page size and the cursor", () => {
  assert.equal(O.buildOrgAuditPath("o1"), "/v1/orgs/o1/audit-events?take=50");
  assert.equal(
    O.buildOrgAuditPath("o1", { take: 25, cursor: "e9" }),
    "/v1/orgs/o1/audit-events?take=25&cursor=e9",
  );
});

test("an unresolved actor is absent, never a raw id in a name's place", () => {
  const page = O.parseOrgAuditPage({
    summary: { totalEvents: 2, nextCursor: "e2" },
    events: [
      { id: "e1", eventType: "org.member_added", actorDisplayName: "Ada", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "e2", eventType: "org.settings_changed", actorUserId: "u-9" },
      { eventType: "no id" },
    ],
  });
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].actorLabel, "Ada");
  // An id is not a person. The surface says "System" rather than printing it.
  assert.equal(page.events[1].actorLabel, null);
  assert.equal(page.nextCursor, "e2");
  assert.equal(page.totalEvents, 2);
});

test("an actor known only by email is still named", () => {
  const page = O.parseOrgAuditPage({ events: [{ id: "e1", actorEmail: "a@b.test" }] });
  assert.equal(page.events[0].actorLabel, "a@b.test");
});

test("an event type reads as words", () => {
  assert.equal(O.auditEventLabel("org.member_added"), "Org member added");
  assert.equal(O.auditEventLabel(""), "Event");
});

test("the lifecycle paths are the canonical ones", () => {
  assert.equal(O.buildOrgLeavePath("o1"), "/v1/orgs/o1/leave");
  assert.equal(O.buildOrgTransferPath("o1"), "/v1/orgs/o1/transfer-ownership");
  assert.equal(O.buildOrgClosurePath("o1"), "/v1/orgs/o1/closure");
  assert.equal(O.buildOrgClosureCancelPath("o1", "r1"), "/v1/orgs/o1/closure/r1/cancel");
});

test("the caller's own role comes from the server, not from the member list", () => {
  const org = O.parseOrgDetail({ organization: { id: "o1" }, callerRole: "ORG_OWNER" });
  assert.equal(org.callerRole, "ORG_OWNER");
  assert.equal(O.isOrgOwner(org), true);
  assert.equal(O.isOrgOwner(O.parseOrgDetail({ organization: { id: "o1" } })), false);
});

test("the membership id and the user id are not the same identifier", () => {
  // Transfer addresses the USER; member mutations address the MEMBERSHIP.
  // Collapsing them sent a membership id as targetUserId and was refused as
  // target_not_member — the right rule named for the wrong reason.
  const [m] = O.parseOrgMembers({ members: [{ id: "mem-1", userId: "usr-1", role: "ORG_ADMIN" }] });
  assert.equal(m.id, "mem-1");
  assert.equal(m.userId, "usr-1");
});

test("ownership is never offered to a suspended or revoked member", () => {
  const members = O.parseOrgMembers({
    members: [
      { id: "m1", userId: "u1", role: "ORG_OWNER", status: "ACTIVE" },
      { id: "m2", userId: "u2", role: "ORG_ADMIN", status: "ACTIVE" },
      { id: "m3", userId: "u3", role: "ORG_ADMIN", status: "REVOKED" },
      { id: "m4", userId: "u4", role: "ORG_MEMBER", status: "SUSPENDED" },
      { id: "m5", role: "ORG_MEMBER", status: "ACTIVE" },
    ],
  });
  assert.deepEqual(O.transferTargets(members).map((m) => m.userId), ["u2"]);
});

test("a named refusal says what happened, not that something failed", () => {
  const named = (code) => O.orgLifecycleFailureMessage({ body: { error: { code } } }, "fallback");
  assert.match(named("owner_required"), /owner/i);
  assert.match(named("target_not_member"), /no longer a member/i);
  assert.match(named("confirmation_mismatch"), /does not match/i);
  assert.match(named("closure_request_active"), /already open/i);
  assert.equal(named("something_else"), "fallback");
});


/*
 * THE DEFECT: GET /v1/orgs/:id/workspaces sends each row as `workspaceId`
 * (organizations.routes.ts). The parser read only `id`, so it dropped every
 * row and the screen told an administrator their organization had none.
 */
test("org workspaces are read from the server's real row shape (workspaceId, billing)", () => {
  const rows = O.parseOrgWorkspaces({
    organizationId: "o1",
    summary: { totalWorkspaces: 2 },
    callerCanSeeBilling: true,
    workspaces: [
      { workspaceId: "w1", name: "Claims", isPersonal: false, createdAt: "2026-01-02T00:00:00.000Z", billing: { plan: "TEAM", status: "PAST_DUE", includedSeats: 5, overSeatLimit: true } },
      { workspaceId: "w2", name: "Mine", isPersonal: true, createdAt: "2026-01-03T00:00:00.000Z" },
    ],
  });
  assert.equal(rows.length, 2, "rows were dropped");
  assert.equal(rows[0].id, "w1");
  assert.deepEqual(rows[0].billing, { plan: "TEAM", status: "PAST_DUE", includedSeats: 5, overSeatLimit: true });
  assert.equal(rows[1].isPersonal, true);
  assert.equal(rows[1].billing, null, "billing invented for a caller who may not see it");
  assert.equal(O.orgPlanLabel("TEAM"), "Team");
  assert.equal(O.orgWorkspaceBillingStatusLabel("PAST_DUE"), "Payment failed");
});

test("an org member row's id is the MEMBERSHIP id the server sends", () => {
  const [m] = O.parseOrgMembers({ members: [{ membershipId: "mem-9", userId: "u-9", role: "ORG_ADMIN", status: "ACTIVE", user: { email: "a@x.test", displayName: "Ada" } }] });
  assert.equal(m.id, "mem-9");
  assert.equal(m.userId, "u-9");
});
