/**
 * Workspace closure contracts (lifecycle Phase 7, 2026-07-17).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const ROUTES = read("../src/routes/teams.routes.ts");
const PREFLIGHT = read(
  "../src/services/identity/account-lifecycle-preflight.service.ts",
);
const CLOSURE = read("../src/services/workspace/workspace-closure.service.ts");
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
const MIGRATION = read(
  "../prisma/migrations/20270922000000_workspace_closure_requests/migration.sql",
);

describe("preflight", () => {
  it("carries the four stable blocker codes", () => {
    expect(PREFLIGHT).toMatch(/"PERSONAL_WORKSPACE_NOT_CLOSABLE"/);
    expect(PREFLIGHT).toMatch(/"DESTRUCTION_REVIEW_PENDING"/);
    expect(PREFLIGHT).toMatch(/evaluateWorkspaceClosurePreflight/);
  });

  it("the bootstrap personal workspace can never close on its own", () => {
    expect(PREFLIGHT).toMatch(
      /team\?\.isPersonal[\s\S]{0,200}PERSONAL_WORKSPACE_NOT_CLOSABLE/,
    );
  });

  it("active billing (team status OR subscription) blocks closure", () => {
    expect(PREFLIGHT).toMatch(/billingStatus === "ACTIVE"/);
    expect(PREFLIGHT).toMatch(/teamId,\s*status:\s*\{\s*in:\s*\["ACTIVE",\s*"TRIALING",\s*"PAST_DUE"\]/);
  });
});

describe("routes: owner-only + typed confirmation + step-up", () => {
  it("all three closure routes require the WORKSPACE owner (team.ownerUserId)", () => {
    expect(ROUTES).toMatch(/requireWorkspaceOwner/);
    expect(ROUTES).toMatch(/team\.ownerUserId === userId/);
    const closureStart = ROUTES.indexOf('"/v1/teams/:id/closure"');
    const block = ROUTES.slice(closureStart);
    expect(
      (block.match(/requireWorkspaceOwner\(/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("confirmation is a typed phrase validated SERVER-SIDE (never a boolean)", () => {
    expect(ROUTES).toMatch(
      /WORKSPACE_CLOSURE_CONFIRMATION_PHRASE = "close this workspace"/,
    );
    expect(ROUTES).toMatch(/"workspace_closure_request"/);
  });

  it("collaboration consequence is surfaced up front (membersLosingAccess)", () => {
    expect(ROUTES).toMatch(/membersLosingAccess/);
  });

  it("one open request per workspace; cancel is status-guarded", () => {
    const closureStart = ROUTES.indexOf('"/v1/teams/:id/closure"');
    const block = ROUTES.slice(closureStart);
    expect(block).toMatch(/closure_request_active/);
    expect(block).toMatch(/CANCELLABLE_WORKSPACE_CLOSURE_STATUSES/);
    expect(block).toMatch(/closure_not_cancellable/);
  });
});

describe("execution", () => {
  it("worker re-runs preflight, claims atomically, and rides the digest cron", () => {
    expect(CLOSURE).toMatch(
      /evaluateWorkspaceClosurePreflight\([\s\S]{0,600}status:\s*"BLOCKED"/,
    );
    expect(CLOSURE).toMatch(/if \(claimed\.count === 0\) continue;/);
    expect(SCHEDULER).toMatch(/processWorkspaceClosures\(now\)/);
  });

  it("revokes memberships + machine access; records a TeamActivity row", () => {
    // PHASE 3: closure revocation via the canonical mass helper.
    expect(CLOSURE).toMatch(/massRevokeWorkspaceMemberships/);
    expect(CLOSURE).toMatch(/apiCredential\.updateMany[\s\S]{0,300}"REVOKED"/);
    expect(CLOSURE).toMatch(/webhookEndpoint\.updateMany[\s\S]{0,200}"DISABLED"/);
    expect(CLOSURE).toMatch(/eventType:\s*"workspace_closed"/);
  });

  it("NEVER deletes the team, evidence, or memberships", () => {
    expect(CLOSURE).not.toMatch(/\.delete\(|deleteMany\(/);
  });

  it("every outcome lands on the requester's personal audit timeline", () => {
    expect(ROUTES).toMatch(/identity\.workspace_closure_requested/);
    expect(ROUTES).toMatch(/identity\.workspace_closure_cancelled/);
    expect(CLOSURE).toMatch(/identity\.workspace_closure_completed/);
    expect(CLOSURE).toMatch(/identity\.workspace_closure_failed/);
    expect(CLOSURE).toMatch(/identity\.workspace_closure_blocked/);
  });
});

describe("migration", () => {
  it("is additive-only", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "workspace_closure_requests"/,
    );
    expect(MIGRATION).not.toMatch(/DROP |TRUNCATE|DELETE FROM|RENAME/i);
  });
});
