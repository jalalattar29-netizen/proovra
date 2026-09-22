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

test("the detail reads through either envelope shape", () => {
  const wrapped = O.parseOrgDetail({ organization: { id: "o1", name: "Acme" } });
  const bare = O.parseOrgDetail({ id: "o1", name: "Acme" });
  assert.equal(wrapped.id, "o1");
  assert.equal(bare.name, "Acme");
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
