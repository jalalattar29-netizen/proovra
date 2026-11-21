/**
 * Organization ownership transfer + closure contracts (lifecycle Phase 6,
 * 2026-07-17).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { routeSource } from "../../../scripts/source-contract/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const ROUTES = read("../src/routes/organizations.routes.ts");
const PREFLIGHT = read(
  "../src/services/identity/account-lifecycle-preflight.service.ts",
);
const CLOSURE = read("../src/services/organization/org-closure.service.ts");
const ORG_ACCESS = read("../src/services/organization/org-access.ts");
const ORG_AUDIT = read("../src/services/organization/org-audit.service.ts");
const OFFER = read("../src/services/organization/org-ownership-offer.service.ts");
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
// Members audit LIFE-11 — closures run through THE lifecycle tick, which the
// digest run and the worker's lifecycle sweep both invoke.
const LIFECYCLE_TICK = read("../src/services/lifecycle/lifecycle-scheduler.service.ts");
const MIGRATION = read(
  "../prisma/migrations/20270921000000_organization_closure_requests/migration.sql",
);

describe("ownership transfer", () => {
  it("is ORG_OWNER-only and step-up gated with a dedicated action", () => {
    expect(ROUTES).toMatch(
      /\/v1\/orgs\/:id\/transfer-ownership[\s\S]{0,900}minRole:\s*"ORG_OWNER"/,
    );
    expect(ROUTES).toMatch(/"org_ownership_transfer"/);
  });

  it("target must be an existing member; self-transfer is rejected", () => {
    expect(ROUTES + OFFER).toMatch(/target_not_member/);
    expect(ROUTES).toMatch(/transfer_to_self/);
  });

  // NEW-RG-26-4 / owner decision E — the route records an OFFER; the transfer
  // legs run at the recipient's stepped-up acceptance, in the offer service
  // (behaviour: rg26-org-ownership-offer.integration.test.ts).
  it("the route only offers; the swap runs atomically at acceptance (never zero or two owners)", () => {
    const block = routeSource(ROUTES, "POST", "/v1/orgs/:id/transfer-ownership");
    expect(block).toMatch(/offerOrganizationOwnership/);
    expect(block).not.toMatch(/updateOrganizationMembershipRole/);
    // PHASE 3: atomic swap via the canonical orchestrator (both legs in
    // the same tx, provenance-recorded).
    expect(OFFER).toMatch(/\$transaction/);
    expect(OFFER).toMatch(/role:\s*"ORG_OWNER"/);
    expect(OFFER).toMatch(/role:\s*"ORG_ADMIN"/);
    expect(OFFER).toMatch(/updateOrganizationMembershipRole/);
  });

  it("billing ownership does not follow the owner (decision E)", () => {
    expect(ROUTES).not.toMatch(/billingOwnerUserId:\s*body\.targetUserId/);
    expect(OFFER).not.toMatch(/billingOwnerUserId:\s*actorUserId/);
    expect(OFFER).not.toMatch(/contractOwnerUserId:/);
  });

  it("audited in the org stream and on BOTH parties' personal timelines", () => {
    expect(ORG_AUDIT).toMatch(/"ORG_OWNERSHIP_TRANSFERRED"/);
    expect(ORG_AUDIT).toMatch(/"ORG_OWNERSHIP_OFFERED"/);
    expect(OFFER).toMatch(/ORG_OWNERSHIP_TRANSFERRED/);
    expect(OFFER).toMatch(/\["previous_owner"|"previous_owner"\]/);
    expect(OFFER).toMatch(/"new_owner"/);
    expect(OFFER).toMatch(/identity\.organization_ownership_transferred/);
  });
});

describe("organization closure preflight", () => {
  it("carries the four stable blocker codes", () => {
    expect(PREFLIGHT).toMatch(/"ORG_MEMBERS_ACTIVE"/);
    expect(PREFLIGHT).toMatch(/"BILLING_CONTRACT_ACTIVE"/);
    expect(PREFLIGHT).toMatch(/"PERSONAL_WORKSPACE_ORGANIZATION"/);
    expect(PREFLIGHT).toMatch(/evaluateOrganizationClosurePreflight/);
  });

  it("personal-workspace organizations can never close via org closure", () => {
    expect(PREFLIGHT).toMatch(/isPersonal:\s*true/);
  });

  it("active billing (incl. sales-led ENTERPRISE contract) blocks closure", () => {
    expect(PREFLIGHT).toMatch(/billingStatus:\s*\{\s*in:\s*\["ACTIVE",\s*"PAST_DUE"\]\s*\}/);
  });
});

describe("organization closure routes", () => {
  it("are ORG_OWNER-only with typed confirmation validated server-side", () => {
    expect(ROUTES).toMatch(
      /ORG_CLOSURE_CONFIRMATION_PHRASE = "close this organization"/,
    );
    expect(ROUTES).toMatch(/"org_closure_request"/);
    // Every closure route resolves owner access before acting.
    const closureStart = ROUTES.indexOf('"/v1/orgs/:id/closure"');
    const closureBlock = ROUTES.slice(closureStart);
    expect(
      (closureBlock.match(/minRole:\s*"ORG_OWNER"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("one open request per org; cancel is status-guarded", () => {
    expect(ROUTES).toMatch(/closure_request_active/);
    expect(ROUTES).toMatch(/CANCELLABLE_ORG_CLOSURE_STATUSES/);
    expect(ROUTES).toMatch(/closure_not_cancellable/);
  });
});

describe("closure execution", () => {
  it("worker re-runs preflight and claims atomically", () => {
    expect(CLOSURE).toMatch(
      // A contract termination filters two self-service blockers between the
      // preflight and the BLOCKED write (members audit LIFE-16).
      /evaluateOrganizationClosurePreflight\([\s\S]{0,1400}outcome:\s*"BLOCKED"/,
    );
    expect(CLOSURE).toMatch(/if \(claimed\.count === 0\) continue;/);
    expect(SCHEDULER).toMatch(/runLifecycleTick\(now\)/);
    expect(LIFECYCLE_TICK).toMatch(/processOrganizationClosures\(now\)/);
  });

  it("ARCHIVES the org and checkOrgAccess denies archived AND suspended orgs", () => {
    expect(CLOSURE).toMatch(/data:\s*\{\s*status:\s*"ARCHIVED"\s*\}/);
    // PHASE 4 §7.6 (2026-07-22) — SUSPENDED joined ARCHIVED in the deny.
    expect(ORG_ACCESS).toMatch(
      /org\.status === "ARCHIVED" \|\| org\.status === "SUSPENDED"/,
    );
  });

  it("revokes workspace memberships + machine credentials/webhooks", () => {
    // Members audit LIFE-10/12 — the ONE closure leg set, which revokes
    // memberships (mass helper), credentials and webhooks; see the workspace
    // closure tests for the legs themselves.
    expect(CLOSURE).toMatch(/closeWorkspacesTx\(tx,/);
    const WS = read("../src/services/workspace/workspace-closure.service.ts");
    expect(WS).toMatch(/massRevokeWorkspaceMemberships/);
    expect(WS).toMatch(/apiCredential\.updateMany[\s\S]{0,300}"REVOKED"/);
    expect(WS).toMatch(/webhookEndpoint\.updateMany[\s\S]{0,200}"DISABLED"/);
  });

  it("NEVER deletes evidence, teams, orgs, or memberships", () => {
    expect(CLOSURE).not.toMatch(/\.delete\(|deleteMany\(/);
  });

  it("closure lifecycle is fully audited in both streams", () => {
    for (const t of [
      "ORG_CLOSURE_REQUESTED",
      "ORG_CLOSURE_BLOCKED",
      "ORG_CLOSURE_CANCELLED",
      "ORG_CLOSURE_COMPLETED",
    ]) {
      expect(ORG_AUDIT).toMatch(new RegExp(`"${t}"`));
    }
    expect(CLOSURE).toMatch(/identity\.organization_closure_completed/);
    expect(CLOSURE).toMatch(/identity\.organization_closure_failed/);
  });
});

describe("migration", () => {
  it("is additive-only", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "organization_closure_requests"/,
    );
    expect(MIGRATION).not.toMatch(/DROP |TRUNCATE|DELETE FROM|RENAME/i);
  });
});
