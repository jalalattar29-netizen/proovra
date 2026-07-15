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

  it("exports assertCanInviteCollaborationTeamMember", () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+assertCanInviteCollaborationTeamMember\b/,
    );
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
    expect(routes).toMatch(/assertCanInviteCollaborationTeamMember/);
    expect(routes).toMatch(/BillingLimitError/);
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
  // endpoints are DELETED (email invite + revoke + accept remain).
  it("registers NO invites/sms or invites/link routes; email-invite handler passes 'EMAIL' to the invite gate", () => {
    expect(routes).not.toContain("invites/sms");
    expect(routes).not.toContain("invites/link");
    const emailSection = routes.split(
      '"/v1/collaboration-teams/:teamId/invites/email"',
    )[1] ?? "";
    expect(
      emailSection,
      "expected assertCanInviteCollaborationTeamMember(... 'EMAIL' ...) in email-invite handler",
    ).toMatch(
      /assertCanInviteCollaborationTeamMember\s*\([\s\S]{0,200}["']EMAIL["']/,
    );
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
