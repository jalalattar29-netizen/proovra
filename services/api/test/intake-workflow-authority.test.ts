/**
 * EXTERNAL INTAKE — workflow authority, not workspace administration.
 *
 * Creating an intake link, sending it, revoking it and archiving it are steps
 * in a workflow. None of them touches workspace settings, billing, membership,
 * SSO, retention or governance, and none of them should have required a
 * workspace administrator.
 *
 * They did. Every one of those routes ran the canonical primitive and then
 * ALSO required the DB role to be OWNER or ADMIN. The comment that stood over
 * that guard said why in as many words: "the intake_link.* caps are also held
 * by REVIEWER, so the role check is retained ... to avoid widening this
 * administration surface". That is a raw role-name check placed on top of the
 * capability model precisely because the two disagreed — and the capability
 * model was right.
 *
 * The result was an incoherent product. Canonical REVIEWER — which is what the
 * DB role MEMBER maps to — could open an intake record, read the recipient's
 * full contact details, search by them, and review the evidence that arrived,
 * but could not create the link that starts any of it.
 *
 * The role check is gone; the capability is the whole answer. NO PERMISSION
 * WAS GRANTED TO ANY ROLE by that change — the registry is untouched — so
 * nothing outside intake can widen with it. That property is asserted here
 * too, because "we only meant to change one thing" is exactly the claim an
 * authorization change should have to prove.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mapTeamRoleToCanonical, roleHasPermission } from "@proovra/shared";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const ROUTES = read("services/api/src/routes/workflow-intake-links.routes.ts");

/** The five workflow routes and the capability each one requires. */
const WORKFLOW_ROUTES = [
  ["create", "workflow.intake_link.create"],
  ["send", "workflow.intake_link.create"],
  ["unarchive", "workflow.intake_link.create"],
  ["revoke", "workflow.intake_link.revoke"],
  ["archive", "workflow.intake_link.revoke"],
] as const;

// ===========================================================================
// The guard
// ===========================================================================
describe("the intake workflow gate", () => {
  it("no longer layers a role-name check over the capability", () => {
    expect(ROUTES).not.toContain("requireAdmin");
    expect(ROUTES).not.toContain('hasRole(membership.role, "ADMIN")');
    // And no other shape of the same thing crept in.
    expect(ROUTES).not.toMatch(/membership\.role\s*(===|!==)\s*"(OWNER|ADMIN)"/);
    expect(ROUTES).not.toContain('from "../services/rbac.js"');
  });

  it("is the canonical primitive and nothing else", () => {
    const guard = ROUTES.slice(
      ROUTES.indexOf("async function requireIntakeWorkflowActor("),
      ROUTES.indexOf("\n}", ROUTES.indexOf("async function requireIntakeWorkflowActor(")),
    );
    expect(guard).toContain("authorizeOrFail(req, reply, {");
    expect(guard).toContain("antiEnumeration: true");
    // The capability arrives from the call site; the guard never picks one.
    expect(guard).toContain("permission,");
    expect(guard).not.toContain("teamMember.findUnique");
  });

  it("gates every workflow route on the capability it needs", () => {
    for (const [action, permission] of WORKFLOW_ROUTES) {
      expect(
        ROUTES,
        `${action} must route through the workflow gate`,
      ).toContain(`requireIntakeWorkflowActor(req, reply,`);
      expect(ROUTES, `${action} needs ${permission}`).toContain(`"${permission}"`);
    }
    // Five call sites: create, send, unarchive, revoke, archive.
    expect((ROUTES.match(/requireIntakeWorkflowActor\(req, reply,/g) ?? []).length).toBe(5);
  });

  it("leaves reads on the member gate, so a VIEWER can still look", () => {
    // Reading an intake record is not operating it. VIEWER holds evidence.read
    // and keeps the masked, read-only view the disclosure policy allows.
    expect(ROUTES).toContain('permission: "evidence.read"');
    expect(roleHasPermission("VIEWER", "evidence.read")).toBe(true);
  });
});

// ===========================================================================
// Who the capability model actually admits
// ===========================================================================
describe("the intake workflow actors", () => {
  it("are the roles the registry already named", () => {
    for (const role of ["OWNER", "ADMIN", "REVIEWER"] as const) {
      expect(roleHasPermission(role, "workflow.intake_link.create")).toBe(true);
      expect(roleHasPermission(role, "workflow.intake_link.revoke")).toBe(true);
    }
    for (const role of ["CONTRIBUTOR", "VIEWER"] as const) {
      expect(roleHasPermission(role, "workflow.intake_link.create")).toBe(false);
      expect(roleHasPermission(role, "workflow.intake_link.revoke")).toBe(false);
    }
  });

  it("include an ordinary team MEMBER, which is the whole point", () => {
    expect(mapTeamRoleToCanonical("MEMBER")).toBe("REVIEWER");
    expect(roleHasPermission("REVIEWER", "workflow.intake_link.create")).toBe(true);
  });

  it("see the recipient contact on exactly the same authority", () => {
    /*
     * The two questions are answered by different permissions, deliberately —
     * administration and disclosure are separate. But they must admit the same
     * people, or the product goes back to a member who can send a request and
     * cannot see who it went to.
     */
    for (const role of ["OWNER", "ADMIN", "REVIEWER", "CONTRIBUTOR", "VIEWER"] as const) {
      expect(
        roleHasPermission(role, "workflow.intake_recipient_contact.reveal"),
        `${role} disagrees with its own intake authority`,
      ).toBe(roleHasPermission(role, "workflow.intake_link.create"));
    }
  });
});

// ===========================================================================
// Nothing else moved
// ===========================================================================
describe("no privilege expanded outside intake", () => {
  it("grants an operational member none of the administration capabilities", () => {
    /*
     * This change removed a check; it granted nothing. The assertion is here
     * anyway, because an authorization change should have to prove the
     * negative rather than assert that it meant well.
     */
    for (const permission of [
      "governance.retention.manage",
      "governance.policy.manage",
      "governance.legal_hold.manage",
      "integration.api_key.manage",
      "integration.webhook.manage",
      "audit.export",
      "evidence.delete",
      "workflow.template.manage",
      "review.sla.configure",
      "intelligence.policy.manage",
    ] as const) {
      expect(
        roleHasPermission("REVIEWER", permission),
        `REVIEWER must not hold ${permission}`,
      ).toBe(false);
    }
  });

  it("does not touch the identity administration boundary", () => {
    // Reading membership is a normal collaboration need and REVIEWER already
    // had it; MUTATING it is administration and REVIEWER still cannot.
    expect(roleHasPermission("REVIEWER", "identity.member.read")).toBe(true);
    for (const permission of [
      "identity.member.invite",
      "identity.member.revoke",
      "identity.member.suspend",
      "identity.member.role.change",
      "identity.org_policy.manage",
    ] as const) {
      expect(
        roleHasPermission("REVIEWER", permission),
        `REVIEWER must not hold ${permission}`,
      ).toBe(false);
    }
  });

  it("leaves the commercial gate exactly where it was", () => {
    /*
     * Availability and authority are different questions. A FREE or PAYG
     * workspace still cannot create an intake link at all, and that refusal
     * comes from the plan catalog rather than from anybody's role.
     */
    expect(ROUTES).toContain("assertWorkspaceAllowsIntake(scope)");
  });
});
