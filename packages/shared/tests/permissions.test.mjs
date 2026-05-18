import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_ROLES,
  DB_TEAM_ROLES,
  PERMISSIONS,
  PermissionSchema,
  listRolePermissions,
  mapTeamRoleToCanonical,
  roleHasPermission,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Surface
// -----------------------------------------------------------------------------

test("permission catalog covers every documented area", () => {
  for (const expected of [
    "evidence.read",
    "evidence.create",
    "evidence.delete",
    "evidence.archive",
    "evidence.generate_report",
    "evidence.generate_package",
    "evidence.publish_verify",
    "workflow.intake_link.create",
    "workflow.intake_link.revoke",
    "evidence_request.create",
    "evidence_request.review",
    "evidence_request.close",
    "notification.delivery.read",
    "notification.delivery.resend",
    "governance.policy.read",
    "governance.policy.manage",
    "governance.legal_hold.manage",
    "governance.retention.manage",
    "audit.read",
    "audit.export",
  ]) {
    assert.ok(PERMISSIONS.includes(expected), `missing permission: ${expected}`);
  }
});

test("canonical roles cover the documented set", () => {
  for (const expected of [
    "OWNER",
    "ADMIN",
    "REVIEWER",
    "CONTRIBUTOR",
    "VIEWER",
    "EXTERNAL_CONTRIBUTOR",
    "PUBLIC_VERIFIER",
  ]) {
    assert.ok(CANONICAL_ROLES.includes(expected), expected);
  }
});

test("DB team roles match the existing TeamRole enum", () => {
  assert.deepEqual([...DB_TEAM_ROLES].sort(), ["ADMIN", "MEMBER", "OWNER", "VIEWER"]);
});

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

test("PermissionSchema rejects unknown permissions", () => {
  assert.equal(PermissionSchema.safeParse("evidence.read").success, true);
  assert.equal(PermissionSchema.safeParse("evidence.YOLO").success, false);
});

// -----------------------------------------------------------------------------
// Role mapping
// -----------------------------------------------------------------------------

test("mapTeamRoleToCanonical maps each DB role to its canonical counterpart", () => {
  assert.equal(mapTeamRoleToCanonical("OWNER"), "OWNER");
  assert.equal(mapTeamRoleToCanonical("ADMIN"), "ADMIN");
  assert.equal(mapTeamRoleToCanonical("MEMBER"), "REVIEWER");
  assert.equal(mapTeamRoleToCanonical("VIEWER"), "VIEWER");
});

// -----------------------------------------------------------------------------
// roleHasPermission — owner is the superset
// -----------------------------------------------------------------------------

test("OWNER holds every permission", () => {
  for (const perm of PERMISSIONS) {
    assert.equal(
      roleHasPermission("OWNER", perm),
      true,
      `OWNER must have ${perm}`,
    );
  }
});

test("ADMIN holds the operational + governance set", () => {
  for (const perm of [
    "evidence.delete",
    "evidence.archive",
    "governance.policy.manage",
    "governance.legal_hold.manage",
    "governance.retention.manage",
    "audit.export",
  ]) {
    assert.equal(
      roleHasPermission("ADMIN", perm),
      true,
      `ADMIN must have ${perm}`,
    );
  }
});

test("REVIEWER (= DB MEMBER) cannot manage retention / legal hold / policy", () => {
  for (const perm of [
    "governance.policy.manage",
    "governance.legal_hold.manage",
    "governance.retention.manage",
    "evidence.delete",
    "evidence.archive",
    "audit.export",
    "workflow.template.manage",
  ]) {
    assert.equal(
      roleHasPermission("MEMBER", perm),
      false,
      `MEMBER (REVIEWER) must NOT have ${perm}`,
    );
  }
});

test("VIEWER has only read-ish permissions", () => {
  // VIEWER may hold ONLY these explicit read-only permissions. Adding
  // a write/mutation permission here would be a privilege escalation,
  // so the allow-list is exhaustive and the test is bidirectional.
  const VIEWER_ALLOWED = new Set([
    "evidence.read",
    "evidence.download_report",
    "evidence.download_package",
    "workflow.external_submission.read",
    "notification.delivery.read",
    "governance.policy.read",
    // Phase 16 — VIEWER can see collaboration threads but never post.
    "collaboration.thread.read",
    // Phase 17 — VIEWER can read identity surfaces (member roster +
    // org policy) but never mutate them.
    "identity.member.read",
    "identity.org_policy.read",
  ]);
  for (const perm of PERMISSIONS) {
    const allowed = roleHasPermission("VIEWER", perm);
    if (VIEWER_ALLOWED.has(perm)) {
      assert.equal(allowed, true, `VIEWER should have ${perm}`);
    } else {
      assert.equal(allowed, false, `VIEWER should NOT have ${perm}`);
    }
  }
});

test("EXTERNAL_CONTRIBUTOR has zero permissions", () => {
  for (const perm of PERMISSIONS) {
    assert.equal(roleHasPermission("EXTERNAL_CONTRIBUTOR", perm), false, perm);
  }
});

test("PUBLIC_VERIFIER has zero permissions", () => {
  for (const perm of PERMISSIONS) {
    assert.equal(roleHasPermission("PUBLIC_VERIFIER", perm), false, perm);
  }
});

test("null role returns false for every permission", () => {
  for (const perm of PERMISSIONS) {
    assert.equal(roleHasPermission(null, perm), false);
    assert.equal(roleHasPermission(undefined, perm), false);
  }
});

test("listRolePermissions returns a non-empty set for every member tier", () => {
  for (const role of ["OWNER", "ADMIN", "REVIEWER", "CONTRIBUTOR", "VIEWER"]) {
    const perms = listRolePermissions(role);
    assert.ok(perms.length > 0, `${role} should have at least one permission`);
  }
  // External roles intentionally empty.
  assert.equal(listRolePermissions("EXTERNAL_CONTRIBUTOR").length, 0);
  assert.equal(listRolePermissions("PUBLIC_VERIFIER").length, 0);
});

// -----------------------------------------------------------------------------
// Privacy-significant boundary
// -----------------------------------------------------------------------------

test("only OWNER and ADMIN can manage governance policy", () => {
  assert.equal(roleHasPermission("OWNER", "governance.policy.manage"), true);
  assert.equal(roleHasPermission("ADMIN", "governance.policy.manage"), true);
  assert.equal(roleHasPermission("MEMBER", "governance.policy.manage"), false);
  assert.equal(roleHasPermission("VIEWER", "governance.policy.manage"), false);
});

test("only OWNER and ADMIN can manage legal holds", () => {
  assert.equal(
    roleHasPermission("OWNER", "governance.legal_hold.manage"),
    true,
  );
  assert.equal(
    roleHasPermission("ADMIN", "governance.legal_hold.manage"),
    true,
  );
  assert.equal(
    roleHasPermission("MEMBER", "governance.legal_hold.manage"),
    false,
  );
  assert.equal(
    roleHasPermission("VIEWER", "governance.legal_hold.manage"),
    false,
  );
});

test("REVIEWER can run reviews and create requests but cannot close governance", () => {
  assert.equal(roleHasPermission("MEMBER", "evidence_request.create"), true);
  assert.equal(roleHasPermission("MEMBER", "evidence_request.review"), true);
  assert.equal(roleHasPermission("MEMBER", "evidence_request.close"), true);
  // But NOT:
  assert.equal(
    roleHasPermission("MEMBER", "governance.legal_hold.manage"),
    false,
  );
});
