/**
 * Phase 4 (Enterprise Administration) — SCOPE C/D/F contract + logic tests.
 *
 * Covers:
 *   - MEMBERS page (organizations/[id]/admin/members/page.tsx): wired to the
 *     REAL org endpoints (invite / role-change / suspend-i.e.-remove), org-admin
 *     gated, enterprise-only, surfaces the honest SSO/SCIM/MFA source note,
 *     mounts the Seats card, links to the Roles reference.
 *   - ROLES page (organizations/[id]/admin/roles/page.tsx): renders the
 *     role → capability reference, no custom roles, gated.
 *   - SEATS card + model: included / used / over derivation.
 *   - EVIDENCE-SAFETY: removing a member is a membership delete, never a user
 *     delete; org member endpoints never touch evidence.
 *
 * Two styles, matching the sibling web tests:
 *   (A) PURE-LOGIC unit tests over `_lib/orgRoles.ts` + `_lib/seatsModel.ts`.
 *   (B) SOURCE-SCANNING contract tests over the page/component files + the
 *       backend route file (to pin the evidence-safety claim to real code).
 *
 * Runs under Node's built-in test runner via the shared run-tests.mjs loader.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_ORG_ROLES,
  ORG_ROLE_RANK,
  ROLE_CAPABILITIES,
  CAPABILITY_DEFS,
  canManageMembers,
  roleMeetsMin,
  type OrgRole,
} from "../app/(app)/organizations/[id]/admin/_lib/orgRoles";
import { deriveSeatsPosture } from "../app/(app)/organizations/[id]/admin/_lib/seatsModel";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = resolve(
  APP_ROOT,
  "app",
  "(app)",
  "organizations",
  "[id]",
  "admin",
);
const MEMBERS_PAGE = readFileSync(
  resolve(ADMIN_DIR, "members", "page.tsx"),
  "utf8",
);
const ROLES_PAGE = readFileSync(
  resolve(ADMIN_DIR, "roles", "page.tsx"),
  "utf8",
);
const SEATS_CARD = readFileSync(
  resolve(ADMIN_DIR, "_lib", "SeatsCard.tsx"),
  "utf8",
);
const TIERS = readFileSync(
  resolve(APP_ROOT, "lib", "surface", "tiers.ts"),
  "utf8",
);
const ORG_ROUTES = readFileSync(
  resolve(
    APP_ROOT,
    "..",
    "..",
    "services",
    "api",
    "src",
    "routes",
    "organizations.routes.ts",
  ),
  "utf8",
);

// ===========================================================================
// (A) PURE LOGIC — ORG roles model.
// ===========================================================================

test("exactly the six built-in ORG roles exist — no custom roles", () => {
  assert.deepEqual(
    [...ALL_ORG_ROLES].sort(),
    [
      "ORG_ADMIN",
      "ORG_AUDITOR",
      "ORG_BILLING_ADMIN",
      "ORG_MEMBER",
      "ORG_OWNER",
      "ORG_SECURITY_ADMIN",
    ],
    "role set must match enum OrganizationRole exactly",
  );
});

test("role precedence matches the backend precedence ladder", () => {
  assert.equal(ORG_ROLE_RANK.ORG_OWNER, 5);
  assert.equal(ORG_ROLE_RANK.ORG_ADMIN, 4);
  // Security + billing admins are peers (rank 3).
  assert.equal(ORG_ROLE_RANK.ORG_SECURITY_ADMIN, 3);
  assert.equal(ORG_ROLE_RANK.ORG_BILLING_ADMIN, 3);
  assert.equal(ORG_ROLE_RANK.ORG_AUDITOR, 2);
  assert.equal(ORG_ROLE_RANK.ORG_MEMBER, 1);
});

test("canManageMembers is true only for ORG_ADMIN and above", () => {
  assert.equal(canManageMembers("ORG_OWNER"), true);
  assert.equal(canManageMembers("ORG_ADMIN"), true);
  assert.equal(canManageMembers("ORG_SECURITY_ADMIN"), false);
  assert.equal(canManageMembers("ORG_BILLING_ADMIN"), false);
  assert.equal(canManageMembers("ORG_AUDITOR"), false);
  assert.equal(canManageMembers("ORG_MEMBER"), false);
});

test("roleMeetsMin respects the ladder", () => {
  assert.equal(roleMeetsMin("ORG_ADMIN", "ORG_ADMIN"), true);
  assert.equal(roleMeetsMin("ORG_OWNER", "ORG_ADMIN"), true);
  assert.equal(roleMeetsMin("ORG_MEMBER", "ORG_ADMIN"), false);
});

test("every role has an access level for every defined capability", () => {
  const capKeys = CAPABILITY_DEFS.map((c) => c.key);
  for (const role of ALL_ORG_ROLES) {
    const row = ROLE_CAPABILITIES[role];
    for (const cap of capKeys) {
      assert.ok(
        row[cap] === "MANAGE" || row[cap] === "READ" || row[cap] === "NONE",
        `role ${role} missing/invalid access for capability ${cap}`,
      );
    }
  }
});

test("evidence is NONE for every org role — org roles never grant evidence", () => {
  for (const role of ALL_ORG_ROLES) {
    assert.equal(
      ROLE_CAPABILITIES[role].evidence,
      "NONE",
      `role ${role} must not grant evidence access at org scope`,
    );
  }
});

test("role → member-management capability matches the enforced gate", () => {
  // MANAGE members exactly when canManageMembers() (ORG_ADMIN+).
  for (const role of ALL_ORG_ROLES as OrgRole[]) {
    const canManage = ROLE_CAPABILITIES[role].members === "MANAGE";
    assert.equal(
      canManage,
      canManageMembers(role),
      `members MANAGE for ${role} must agree with canManageMembers()`,
    );
  }
});

test("only billing-capable roles can MANAGE billing/seats", () => {
  assert.equal(ROLE_CAPABILITIES.ORG_OWNER.billing, "MANAGE");
  assert.equal(ROLE_CAPABILITIES.ORG_ADMIN.billing, "MANAGE");
  assert.equal(ROLE_CAPABILITIES.ORG_BILLING_ADMIN.billing, "MANAGE");
  assert.equal(ROLE_CAPABILITIES.ORG_SECURITY_ADMIN.billing, "NONE");
  assert.equal(ROLE_CAPABILITIES.ORG_MEMBER.billing, "NONE");
});

// ===========================================================================
// (A) PURE LOGIC — Seats derivation model.
// ===========================================================================

test("seats: within capacity is ok with correct remaining", () => {
  const p = deriveSeatsPosture({
    workspaces: [
      { includedSeats: 10, overSeatLimit: false, billingOwnerUserId: "owner-1" },
    ],
    memberCount: 6,
    pendingInviteCount: 1,
  });
  assert.equal(p.includedSeats, 10);
  assert.equal(p.usedSeats, 6);
  assert.equal(p.pendingSeats, 1);
  assert.equal(p.remainingSeats, 4);
  assert.equal(p.status, "ok");
  assert.equal(p.overSeatLimit, false);
  assert.deepEqual(p.billingOwnerUserIds, ["owner-1"]);
});

test("seats: over the limit is flagged over with negative remaining", () => {
  const p = deriveSeatsPosture({
    workspaces: [
      { includedSeats: 5, overSeatLimit: false, billingOwnerUserId: null },
    ],
    memberCount: 8,
    pendingInviteCount: 0,
  });
  assert.equal(p.overSeatLimit, true);
  assert.equal(p.status, "over");
  assert.equal(p.remainingSeats, -3);
});

test("seats: pending invites that would exceed the cap raise a warning", () => {
  const p = deriveSeatsPosture({
    workspaces: [
      { includedSeats: 10, overSeatLimit: false, billingOwnerUserId: null },
    ],
    memberCount: 9,
    pendingInviteCount: 3,
  });
  assert.equal(p.overSeatLimit, false);
  assert.equal(p.projectedOverLimit, true);
  assert.equal(p.projectedSeats, 12);
  assert.equal(p.status, "warning");
});

test("seats: workspace overSeatLimit flag alone marks over", () => {
  const p = deriveSeatsPosture({
    workspaces: [
      { includedSeats: 10, overSeatLimit: true, billingOwnerUserId: null },
    ],
    memberCount: 3,
    pendingInviteCount: 0,
  });
  assert.equal(p.anyWorkspaceOverLimit, true);
  assert.equal(p.status, "over");
});

test("seats: included is the SUM of visible workspace seats", () => {
  const p = deriveSeatsPosture({
    workspaces: [
      { includedSeats: 5, overSeatLimit: false, billingOwnerUserId: "o1" },
      { includedSeats: 8, overSeatLimit: false, billingOwnerUserId: "o2" },
    ],
    memberCount: 4,
    pendingInviteCount: 0,
  });
  assert.equal(p.includedSeats, 13);
  assert.deepEqual([...p.billingOwnerUserIds].sort(), ["o1", "o2"]);
});

test("seats: no billing visibility (all null) is not falsely marked over", () => {
  const p = deriveSeatsPosture({
    workspaces: [
      { includedSeats: null, overSeatLimit: null, billingOwnerUserId: null },
    ],
    memberCount: 50,
    pendingInviteCount: 0,
  });
  assert.equal(p.hasBillingVisibility, false);
  assert.equal(p.overSeatLimit, false);
  assert.equal(p.status, "ok");
});

// ===========================================================================
// (B) CONTRACT — Members page.
// ===========================================================================

test("members page is gated via PageRouteGate with the org-detail route id", () => {
  assert.match(MEMBERS_PAGE, /PageRouteGate/);
  assert.match(MEMBERS_PAGE, /routeId="account\.organization-detail"/);
});

test("members page is enterprise-only (organizations prefix is ENTERPRISE)", () => {
  assert.match(
    TIERS,
    /pathPrefix:\s*"\/organizations",\s*tier:\s*"ENTERPRISE"/,
  );
});

test("members page invites against the real invite endpoint with a role", () => {
  assert.match(MEMBERS_PAGE, /\/v1\/orgs\/\$\{orgId\}\/invites`/);
  assert.match(MEMBERS_PAGE, /invite-role-select/);
  assert.match(MEMBERS_PAGE, /body:\s*JSON\.stringify\(\{\s*email,\s*role: inviteRole\s*\}\)/);
});

test("members page changes org role via PATCH on the real members endpoint", () => {
  assert.match(
    MEMBERS_PAGE,
    /apiFetch\(`\/v1\/orgs\/\$\{orgId\}\/members\/\$\{m\.membershipId\}`,\s*\{\s*\n\s*method:\s*"PATCH"/,
  );
});

test("members page removes (suspend-equivalent) via DELETE on the members endpoint", () => {
  assert.match(
    MEMBERS_PAGE,
    /apiFetch\(`\/v1\/orgs\/\$\{orgId\}\/members\/\$\{m\.membershipId\}`,\s*\{\s*\n\s*method:\s*"DELETE"/,
  );
});

test("members page resends and revokes invites against the real endpoints", () => {
  assert.match(MEMBERS_PAGE, /\/v1\/orgs\/\$\{orgId\}\/invites\/\$\{i\.inviteId\}\/resend`/);
  assert.match(MEMBERS_PAGE, /\/v1\/orgs\/\$\{orgId\}\/invites\/\$\{i\.inviteId\}`/);
});

test("members page uses ConfirmActionModal (no raw window.confirm)", () => {
  assert.match(MEMBERS_PAGE, /useConfirmAction/);
  // No actual window.confirm( CALL — the JSDoc header prose that mentions
  // "NO raw window.confirm" is a documented constraint, not a call.
  assert.doesNotMatch(MEMBERS_PAGE, /window\.confirm\s*\(/);
});

test("members page uses toSafeUserError as the error path (no raw passthrough)", () => {
  assert.match(MEMBERS_PAGE, /toSafeUserError/);
});

test("members page is org-admin gated in the UI via canManageMembers", () => {
  assert.match(MEMBERS_PAGE, /canManageMembers/);
  assert.match(MEMBERS_PAGE, /const canMutate = callerRole !== null && canManageMembers\(callerRole\)/);
});

test("members page surfaces the honest SSO/SCIM/MFA source note (no fabrication)", () => {
  assert.match(MEMBERS_PAGE, /SSO \/ SCIM source/);
  assert.match(MEMBERS_PAGE, /not exposed on the org member list/);
});

test("members page mounts the Seats card and links to the Roles reference", () => {
  assert.match(MEMBERS_PAGE, /<SeatsCard orgId=\{orgId\}\s*\/>/);
  assert.match(MEMBERS_PAGE, /members-roles-reference-link/);
  assert.match(MEMBERS_PAGE, /\/organizations\/\$\{orgId\}\/admin\/roles/);
});

test("members page does NOT invent a second members endpoint or custom roles", () => {
  assert.doesNotMatch(MEMBERS_PAGE, /custom-?role/i);
  // Every apiFetch CALL SITE targets the canonical /v1/orgs/${orgId}/* surface.
  const calls = MEMBERS_PAGE.match(/apiFetch\(`([^`]+)`/g) ?? [];
  assert.ok(calls.length >= 5, "expected the canonical org apiFetch calls");
  for (const c of calls) {
    assert.ok(
      c.includes("/v1/orgs/${orgId}"),
      `unexpected non-canonical apiFetch path: ${c}`,
    );
  }
});

// ===========================================================================
// (B) CONTRACT — Roles page.
// ===========================================================================

test("roles page exists on disk", () => {
  assert.ok(existsSync(resolve(ADMIN_DIR, "roles", "page.tsx")));
});

test("roles page is gated via PageRouteGate with the org-detail route id", () => {
  assert.match(ROLES_PAGE, /PageRouteGate/);
  assert.match(ROLES_PAGE, /routeId="account\.organization-detail"/);
});

test("roles page renders the role → capability reference matrix", () => {
  assert.match(ROLES_PAGE, /role-capability-matrix/);
  assert.match(ROLES_PAGE, /ROLE_CAPABILITIES/);
  assert.match(ROLES_PAGE, /CAPABILITY_DEFS/);
  assert.match(ROLES_PAGE, /ORG_ROLE_SUMMARY/);
});

test("roles page is a reference — it does NOT mutate roles itself", () => {
  // No PATCH/POST/DELETE against members from the roles reference tab.
  assert.doesNotMatch(ROLES_PAGE, /method:\s*"(PATCH|POST|DELETE)"/);
  // It points assignment at the Members tab instead.
  assert.match(ROLES_PAGE, /roles-assign-link/);
  assert.match(ROLES_PAGE, /\/organizations\/\$\{orgId\}\/admin\/members/);
});

test("roles page does not invent custom roles", () => {
  assert.doesNotMatch(ROLES_PAGE, /custom-?role/i);
  assert.doesNotMatch(ROLES_PAGE, /createRole|addRole|newRole/i);
});

// ===========================================================================
// (B) CONTRACT — Seats card reuses existing endpoints only.
// ===========================================================================

test("seats card reads existing org + workspaces endpoints (no new endpoint)", () => {
  assert.match(SEATS_CARD, /\/v1\/orgs\/\$\{orgId\}\/workspaces`/);
  assert.match(SEATS_CARD, /\/v1\/orgs\/\$\{orgId\}`/);
  assert.match(SEATS_CARD, /deriveSeatsPosture/);
});

test("seats card has a contact-sales CTA and no self-serve checkout", () => {
  assert.match(SEATS_CARD, /seats-contact-sales/);
  assert.match(SEATS_CARD, /Contact sales/);
  // No self-serve purchase machinery — a checkout URL, stripe SDK, or a
  // buy/purchase button. (The word "checkout" in the disclaimer prose is fine.)
  assert.doesNotMatch(SEATS_CARD, /stripe|\/checkout|createCheckout|buy-?seats|purchase/i);
});

// ===========================================================================
// (B) EVIDENCE-SAFETY — pinned to the real backend route.
// ===========================================================================

test("backend member removal deletes the MEMBERSHIP row, never the user", () => {
  // The DELETE members handler removes organizationMembership, not user.
  assert.match(
    ORG_ROUTES,
    /organizationMembership\.delete\(\{\s*where:\s*\{\s*id:\s*target\.id\s*\}\s*\}\)/,
  );
  // The DELETE members handler must NOT delete a user record.
  const deleteMembersBlock = ORG_ROUTES.slice(
    ORG_ROUTES.indexOf("DELETE /v1/orgs/:id/members/:memberId"),
  );
  assert.doesNotMatch(
    deleteMembersBlock.slice(0, 3000),
    /prisma\.user\.delete|tx\.user\.delete/,
    "removing an org member must never delete the user (evidence history)",
  );
});

test("backend member endpoints never mutate evidence/cases", () => {
  const membersSection = ORG_ROUTES.slice(
    ORG_ROUTES.indexOf("PATCH /v1/orgs/:id/members/:memberId"),
    ORG_ROUTES.indexOf("GET /v1/orgs/:id/audit-events"),
  );
  assert.doesNotMatch(membersSection, /evidence\.(delete|update|create)/i);
  assert.doesNotMatch(membersSection, /\bcase\.(delete|update)/i);
});

test("backend enforces last-owner + self-modify protection on role change", () => {
  assert.match(ORG_ROUTES, /last_owner_protected/);
  assert.match(ORG_ROUTES, /self_modify_blocked/);
  assert.match(ORG_ROUTES, /owner_change_requires_owner/);
});
