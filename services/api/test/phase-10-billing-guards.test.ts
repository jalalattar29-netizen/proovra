/**
 * PROOVRA Phase 10 — Billing-guard source-contract test.
 *
 * Pins the canonical wiring between:
 *   - the five `assert*` helpers exported by
 *     services/api/src/services/collaboration-team/billing-guards.ts,
 *   - the BillingLimitError class shape (`.code` + `.httpStatus`),
 *   - the six error codes exported from `@proovra/shared`, and
 *   - the /v1/collaboration-teams* route handlers that MUST call those
 *     helpers before performing any mutation.
 *
 * Constitutional rules (Phase 10):
 *   - Billing controls capacity, not the definition of Team.
 *   - The mutation surface MUST gate every write on the canonical
 *     helpers — direct inline calls to `prisma.collaborationTeam.create`
 *     without a guard are a regression.
 *   - The shared error-code union is the canonical vocabulary; the
 *     handler must not invent new codes inline.
 *
 * Test style: source-contract (file-text assertions). No DB I/O.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// PHASE 12 POINT 4 PASS C — the ONE seat-limit policy under behavioral test.
import { computeOverSeatLimit } from "../src/services/billing.service.js";

const API_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const BILLING_GUARDS_PATH = resolve(
  API_ROOT,
  "src/services/collaboration-team/billing-guards.ts",
);
const ROUTES_PATH = resolve(
  API_ROOT,
  "src/routes/collaboration-teams.routes.ts",
);
const SERVICE_PATH = resolve(
  API_ROOT,
  "src/services/collaboration-team/collaboration-team.service.ts",
);
const SHARED_INDEX_PATH = resolve(
  REPO_ROOT,
  "packages/shared/src/index.ts",
);
const SHARED_CODES_PATH = resolve(
  REPO_ROOT,
  "packages/shared/src/collaboration-team-billing-codes.ts",
);

// ---------------------------------------------------------------------------
// Helper exports
// ---------------------------------------------------------------------------

describe("Phase 10 — collaboration-team billing-guards exports", () => {
  const src = readFileSync(BILLING_GUARDS_PATH, "utf8");

  it("exports assertCanCreateCollaborationTeam", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+assertCanCreateCollaborationTeam\b/,
    );
  });

  it("exports assertCollaborationTeamMemberLimit", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+assertCollaborationTeamMemberLimit\b/,
    );
  });

  // WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — the
  // invitation rails moved to the WORKSPACE, which is the subject they were
  // always about. The per-group gate enforced `maxPendingInvitesPerTeam` and
  // `maxInvitesPer24h` once PER GROUP, so a workspace with five groups could
  // hold five times the pending invitations its plan sells — and the
  // invitation that actually grants tenancy was gated by neither of them.
  //
  // Same numbers, same catalog, right subject. The export must be GONE (a
  // second answer to one question is the defect) and the successor present.
  it("the per-group invite gate is gone, and the workspace allowance replaces it", () => {
    expect(src).not.toMatch(
      /export\s+async\s+function\s+assertCanInviteCollaborationTeamMember\b/,
    );
    const seatsSrc = readFileSync(
      resolve(API_ROOT, "src/services/billing/workspace-seats.service.ts"),
      "utf8",
    );
    expect(seatsSrc).toMatch(
      /export\s+async\s+function\s+resolveWorkspaceInvitationAllowance\b/,
    );
    // It reads the SAME two catalog values, so the numbers cannot drift apart.
    expect(seatsSrc).toContain("maxPendingInvitesPerTeam");
    expect(seatsSrc).toContain("maxInvitesPer24h");
    // And the one invitation authority enforces it.
    const inviteSrc = readFileSync(
      resolve(API_ROOT, "src/services/identity/workspace-invitation.service.ts"),
      "utf8",
    );
    expect(inviteSrc).toContain("resolveWorkspaceInvitationAllowance(");
    expect(inviteSrc).toContain("WORKSPACE_INVITE_LIMIT_REACHED");
    expect(inviteSrc).toContain("WORKSPACE_INVITE_RATE_LIMIT_REACHED");
  });

  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. `assertCanCreateGuest` is DELETED;
  // the feature-eligibility surface is assertTeamsFeatureIncluded +
  // lowestPlanWithTeams.
  it("exports assertTeamsFeatureIncluded + lowestPlanWithTeams; assertCanCreateGuest is deleted", () => {
    expect(src).toMatch(/export\s+function\s+assertTeamsFeatureIncluded\b/);
    expect(src).toMatch(/export\s+function\s+lowestPlanWithTeams\b/);
    expect(src).not.toMatch(/assertCanCreateGuest/);
  });

  it("exports assertSubscriptionActiveOrGraceAllowed", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+assertSubscriptionActiveOrGraceAllowed\b/,
    );
  });

  it("declares the BillingLimitError class with .code + .httpStatus", () => {
    expect(src).toMatch(/export\s+class\s+BillingLimitError\b/);
    // The two structured fields the route handler relies on.
    expect(src).toMatch(/\bcode:\s*CollaborationTeamBillingErrorCode\b/);
    expect(src).toMatch(/\bhttpStatus:\s*402\s*\|\s*409\s*\|\s*429\b/);
  });
});

// ---------------------------------------------------------------------------
// Shared error-code vocabulary
// ---------------------------------------------------------------------------

describe("Phase 10 — shared error-code vocabulary is canonical + re-exported", () => {
  it("re-exports COLLABORATION_TEAM_BILLING_ERROR_CODES from @proovra/shared root", () => {
    const idx = readFileSync(SHARED_INDEX_PATH, "utf8");
    expect(idx).toMatch(/COLLABORATION_TEAM_BILLING_ERROR_CODES/);
    expect(idx).toMatch(/CollaborationTeamBillingErrorCode/);
  });

  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. SMS_INVITE_NOT_INCLUDED /
  // LINK_INVITE_NOT_INCLUDED / GUEST_LIMIT_REACHED are DELETED.
  it("the six canonical Teams billing codes are present; the three deleted codes are absent", () => {
    const codesSrc = readFileSync(SHARED_CODES_PATH, "utf8");
    const expected = [
      "TEAM_PLAN_REQUIRED",
      "TEAM_INVITES_NOT_INCLUDED",
      "TEAM_LIMIT_REACHED",
      "TEAM_MEMBER_LIMIT_REACHED",
      "TEAM_INVITE_LIMIT_REACHED",
      "SUBSCRIPTION_INACTIVE",
    ];
    for (const code of expected) {
      expect(codesSrc, `missing code ${code}`).toMatch(
        new RegExp(`["']${code}["']`),
      );
    }
    const deleted = [
      "SMS_INVITE_NOT_INCLUDED",
      "LINK_INVITE_NOT_INCLUDED",
      "GUEST_LIMIT_REACHED",
    ];
    for (const code of deleted) {
      expect(codesSrc, `deleted code ${code} must be absent`).not.toMatch(
        new RegExp(`["']${code}["']`),
      );
    }
    // Canonical HTTP-status mapping for the six live codes.
    expect(codesSrc).toMatch(/TEAM_PLAN_REQUIRED:\s*402/);
    expect(codesSrc).toMatch(/TEAM_INVITES_NOT_INCLUDED:\s*402/);
    expect(codesSrc).toMatch(/TEAM_LIMIT_REACHED:\s*409/);
    expect(codesSrc).toMatch(/TEAM_MEMBER_LIMIT_REACHED:\s*409/);
    expect(codesSrc).toMatch(/TEAM_INVITE_LIMIT_REACHED:\s*429/);
    expect(codesSrc).toMatch(/SUBSCRIPTION_INACTIVE:\s*402/);
  });
});

// ---------------------------------------------------------------------------
// /v1/collaboration-teams* handler wiring
// ---------------------------------------------------------------------------

describe("Phase 10 — /v1/collaboration-teams handlers call the canonical guards", () => {
  const routes = readFileSync(ROUTES_PATH, "utf8");

  it("the routes file imports the canonical billing-guard helpers", () => {
    expect(routes).toMatch(/from\s+["'].*billing-guards(\.js)?["']/);
    expect(routes).toMatch(/assertCanCreateCollaborationTeam/);
    expect(routes).toMatch(/assertCollaborationTeamMemberLimit/);
    expect(routes).toMatch(/BillingLimitError/);
    // WORKSPACE AND COLLABORATION RECONCILIATION — the group-invite channel
    // is retired, so the route layer no longer calls the invite gate. The
    // gate itself is NOT retired: it still guards the legacy writer, which
    // is asserted at its own level below.
  });

  it("POST /v1/collaboration-teams calls assertCanCreateCollaborationTeam", () => {
    // The handler block for POST /v1/collaboration-teams MUST call the
    // create-gate before doing any write. The route literal
    // `"/v1/collaboration-teams"` appears at BOTH the GET (list) and
    // POST (create) registrations, so we anchor on the POST registration
    // pattern (`app.post(...)` / `app.post<...>(...)`) to scope the
    // search to the create-team handler only.
    const postCreateMatch = routes.match(
      /app\.post(?:<[^>]*>)?\(\s*["']\/v1\/collaboration-teams["']\s*,([\s\S]*?)\n\s*\)\s*;/,
    );
    expect(
      postCreateMatch,
      "expected to locate the POST /v1/collaboration-teams handler block",
    ).not.toBeNull();
    const createBlock = postCreateMatch ? postCreateMatch[1] : "";
    expect(
      createBlock,
      "expected assertCanCreateCollaborationTeam call in POST /v1/collaboration-teams handler",
    ).toMatch(/assertCanCreateCollaborationTeam\s*\(/);
  });

  it("POST /v1/collaboration-teams/:teamId/members calls assertCollaborationTeamMemberLimit", () => {
    const membersSection = routes.split(
      '"/v1/collaboration-teams/:teamId/members"',
    )[1] ?? "";
    expect(
      membersSection,
      "expected assertCollaborationTeamMemberLimit in add-member handler",
    ).toMatch(/assertCollaborationTeamMemberLimit\s*\(/);
  });

  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. The /invites/sms and /invites/link
  // endpoints were DELETED then; email invite remained.
  //
  // WORKSPACE AND COLLABORATION RECONCILIATION — the group-invite channel
  // itself is now retired. People are invited to the WORKSPACE (one
  // invitation authority, one seat claim) and then ASSIGNED to a group, so a
  // second invitation system with its own commercial gate no longer exists.
  // The route stays registered and answers with a typed retirement rather
  // than a 404, and it reaches no writer at all.
  it("registers NO invites/sms or invites/link routes; the email-invite route is a typed retirement that writes nothing", () => {
    expect(routes).not.toContain("invites/sms");
    expect(routes).not.toContain("invites/link");
    const emailSection = routes.split(
      '"/v1/collaboration-teams/:teamId/invites/email"',
    )[1] ?? "";
    expect(
      emailSection,
      "expected the retired email-invite route to still be registered",
    ).not.toBe("");
    const handler = emailSection.slice(0, 2500);
    expect(handler).toContain("COLLABORATION_TEAM_INVITE_RETIRED");
    expect(handler).toMatch(/\.code\(410\)/);
    // It reaches no invite writer and no invite gate — there is nothing left
    // behind it to gate.
    expect(handler).not.toMatch(/createEmailInvite\s*\(/);
    expect(handler).not.toMatch(/assertCanInviteCollaborationTeamMember\s*\(/);
  });

  // CLOSURE — the writer itself is DELETED, which is stronger than gating it.
  // Retiring a route stops the traffic; deleting the writer stops the
  // possibility, so a new `CollaborationTeamInvite` row is not merely
  // unreached but unwritable.
  it("the legacy per-group invitation writer is gone, not merely gated", () => {
    const svc = readFileSync(SERVICE_PATH, "utf8");
    expect(svc).not.toMatch(/export async function createEmailInvite\b/);
    expect(svc).not.toContain("collaborationTeamInvite.create(");
    // The accept and revoke paths deliberately REMAIN: links already sent are
    // in people's mailboxes, and completing or withdrawing an obligation that
    // was validly issued is not a new write.
    expect(svc).toMatch(/export async function acceptInvite\b/);
    expect(svc).toMatch(/export async function revokeInvite\b/);
  });
  // Teams Entitlement Alignment 2026-07-14: SMS + shareable-link
  // invitation channels and external guests were removed from the product
  // (never published by Pricing/Billing); invitations are EMAIL-only;
  // FREE/PAYG include zero Teams. The capacity gate on ACCEPT now lives
  // inside the service `acceptInvite` (after the already-a-member
  // success short-circuit, before the membership write) — the route
  // handler delegates and translates BillingLimitError.
  it("accept: route delegates to acceptInvite; service acceptInvite calls assertCollaborationTeamMemberLimit", () => {
    const acceptSection = routes.split(
      '"/v1/collaboration-team-invites/:token/accept"',
    )[1] ?? "";
    expect(
      acceptSection,
      "expected the accept route to delegate to the service acceptInvite",
    ).toMatch(/acceptInvite\s*\(/);
    const svc = readFileSync(SERVICE_PATH, "utf8");
    const svcAccept =
      svc.split("export async function acceptInvite")[1] ?? "";
    expect(
      svcAccept,
      "expected assertCollaborationTeamMemberLimit inside service acceptInvite",
    ).toMatch(/assertCollaborationTeamMemberLimit\s*\(/);
  });
});

// ===========================================================================
// PHASE 12 POINT 4 PASS C — ONE seat-limit policy.
//
// The rule "is this workspace over its seat limit" existed twice with
// DIFFERENT behaviour:
//   * billing.service#refreshTeamSeatState counted ACTIVE members only (the
//     P5 domain remediation) and treated includedSeats:0 as unlimited;
//   * enterprise-provisioning#grantEnterprisePlanToOrg recomputed it inline
//     over ALL members with no zero-guard.
// A suspended or revoked member therefore inflated the count on the
// provisioning path and could mark a workspace over its seat limit when it was
// not — a false commercial restriction, applied silently and with no billing
// event. Both paths now share `computeOverSeatLimit`.
// ===========================================================================

describe("Phase 12 Point 4 — one seat-limit policy", () => {
  it("treats includedSeats: 0 as unlimited, never as zero seats allowed", () => {
    expect(
      computeOverSeatLimit({ activeMemberCount: 500, includedSeats: 0 }),
    ).toBe(false);
  });

  it("is over the limit only when ACTIVE members exceed the seats", () => {
    expect(
      computeOverSeatLimit({ activeMemberCount: 5, includedSeats: 5 }),
    ).toBe(false);
    expect(
      computeOverSeatLimit({ activeMemberCount: 6, includedSeats: 5 }),
    ).toBe(true);
  });

  it("the provisioning path counts ACTIVE members only", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/services/enterprise-provisioning.service.ts", import.meta.url),
      ),
      "utf8",
    );
    // The grant loop must scope its member count, not count every row.
    expect(src).toMatch(/members:\s*\{\s*where:\s*\{\s*status:\s*"ACTIVE"\s*\}\s*\}/);
  });

  it("neither module re-implements the comparison inline", () => {
    for (const rel of [
      "../src/services/enterprise-provisioning.service.ts",
      "../src/services/billing.service.ts",
    ]) {
      const src = readFileSync(
        fileURLToPath(new URL(rel, import.meta.url)),
        "utf8",
      );
      const body = src
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      // `_count.members > seats` style comparisons are the duplicated policy.
      expect(body, `${rel} re-implements the seat comparison`).not.toMatch(
        /_count\.members\s*>\s*\w*[Ss]eats/,
      );
    }
  });
});
