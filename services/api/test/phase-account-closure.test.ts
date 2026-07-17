/**
 * Personal account closure contracts (lifecycle Phase 5, 2026-07-17).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const PREFLIGHT = read(
  "../src/services/identity/account-lifecycle-preflight.service.ts",
);
const CLOSURE = read("../src/services/identity/account-closure.service.ts");
const ROUTES = read("../src/routes/account-closure.routes.ts");
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
const MIGRATION = read(
  "../prisma/migrations/20270920000000_account_closure_requests/migration.sql",
);

describe("preflight blockers", () => {
  it("carries the four stable blocker codes", () => {
    expect(PREFLIGHT).toMatch(/"ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED"/);
    expect(PREFLIGHT).toMatch(/"WORKSPACE_MEMBERS_ACTIVE"/);
    expect(PREFLIGHT).toMatch(/"LEGAL_HOLD_ACTIVE"/);
    expect(PREFLIGHT).toMatch(/"BILLING_SUBSCRIPTION_ACTIVE"/);
  });

  it("solo implicit personal orgs never block (only orgs with OTHER members)", () => {
    expect(PREFLIGHT).toMatch(/userId:\s*\{\s*not:\s*userId\s*\}/);
  });

  it("closure is universal — no plan/entitlement query gates it", () => {
    // code path, not prose: no plan/entitlement read anywhere.
    expect(PREFLIGHT).not.toMatch(/getPlanCapabilities\(|prisma\.entitlement\b/);
    expect(ROUTES).not.toMatch(/getPlanCapabilities\(|prisma\.entitlement\b/);
  });
});

describe("routes: typed confirmation + step-up + user binding", () => {
  it("confirmation is a typed phrase validated SERVER-SIDE (never a boolean)", () => {
    expect(ROUTES).toMatch(/CLOSURE_CONFIRMATION_PHRASE = "close my account"/);
    expect(ROUTES).toMatch(/confirmation_mismatch/);
    // code shape: no `confirmed` boolean field is read anywhere.
    expect(ROUTES).not.toMatch(/confirmed\s*[:=]/);
  });

  it("request is step-up gated with a dedicated action", () => {
    expect(ROUTES).toMatch(/"account_closure_request"/);
  });

  it("one open request per user (409 closure_request_active)", () => {
    expect(ROUTES).toMatch(/closure_request_active/);
    expect(ROUTES).toMatch(/ACTIVE_CLOSURE_STATUSES/);
  });

  it("blocked requests surface stable codes and persist an audit row", () => {
    expect(ROUTES).toMatch(/status:\s*"BLOCKED"/);
    expect(ROUTES).toMatch(/identity\.account_closure_blocked/);
    expect(ROUTES).toMatch(/code:\s*"closure_blocked"/);
  });

  it("cancel is strictly user-bound and status-guarded", () => {
    expect(ROUTES).toMatch(/CANCELLABLE_CLOSURE_STATUSES/);
    expect(ROUTES).toMatch(/closure_not_cancellable/);
    expect(ROUTES).toMatch(/id:\s*params\.id,\s*\n?\s*userId/);
  });
});

describe("worker: cooling-off + execution safety", () => {
  it("cooling-off window is 7 days and the row schedules via coolingOffEndsAtUtc", () => {
    expect(CLOSURE).toMatch(/COOLING_OFF_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
    expect(ROUTES).toMatch(/coolingOffEndsAtUtc/);
  });

  it("re-runs preflight at execution time — a new blocker moves the row to BLOCKED", () => {
    expect(CLOSURE).toMatch(
      /evaluateAccountClosurePreflight\(req\.userId\)[\s\S]{0,400}status:\s*"BLOCKED"/,
    );
  });

  it("claims atomically (guarded updateMany, skip when count === 0)", () => {
    expect(CLOSURE).toMatch(/if \(claimed\.count === 0\) continue;/);
  });

  it("piggybacks the existing digest cron (no parallel job system)", () => {
    expect(SCHEDULER).toMatch(/processAccountClosures\(now\)/);
  });
});

describe("execution: anonymize + revoke, never destroy evidence", () => {
  it("revokes every session through the canonical revocation service", () => {
    expect(CLOSURE).toMatch(
      /revokeAllSessionsForUser\(\{\s*userId,\s*reason:\s*"ACCOUNT_CLOSED"\s*\}\)/,
    );
  });

  it("revokes login methods: identity links REVOKED, password nulled, subject scrambled", () => {
    expect(CLOSURE).toMatch(/status:\s*"REVOKED",\s*revokedAtUtc/);
    expect(CLOSURE).toMatch(/passwordHash:\s*null/);
    expect(CLOSURE).toMatch(/providerUserId:\s*`closed:\$\{userId\}`/);
  });

  it("anonymizes PII (email, names, avatar, bio, country)", () => {
    for (const field of [
      "email",
      "displayName",
      "firstName",
      "lastName",
      "avatarUrl",
      "bio",
      "country",
    ]) {
      expect(CLOSURE).toMatch(new RegExp(`${field}:\\s*null`));
    }
  });

  it("cancels outstanding data exports and nulls their payloads", () => {
    expect(CLOSURE).toMatch(
      /status:\s*"CANCELLED",\s*packageJson:\s*null,\s*packageSha256:\s*null/,
    );
  });

  it("archives solo implicit orgs; NEVER deletes evidence, teams, or orgs", () => {
    expect(CLOSURE).toMatch(/status:\s*"ARCHIVED"/);
    // code shape: no destructive delete against evidence/team/org models.
    expect(CLOSURE).not.toMatch(/evidence\.delete|team\.delete|organization\.delete\b/);
    expect(CLOSURE).not.toMatch(/deleteMany\(\{\s*where:\s*\{\s*teamId/);
  });

  it("emits lifecycle audit events for every outcome", () => {
    expect(ROUTES).toMatch(/identity\.account_closure_requested/);
    expect(ROUTES).toMatch(/identity\.account_closure_cancelled/);
    expect(CLOSURE).toMatch(/identity\.account_closure_completed/);
    expect(CLOSURE).toMatch(/identity\.account_closure_failed/);
    expect(CLOSURE).toMatch(/identity\.account_closure_blocked/);
  });
});

describe("migration", () => {
  it("is additive-only", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "account_closure_requests"/,
    );
    expect(MIGRATION).not.toMatch(/DROP |TRUNCATE|DELETE FROM|RENAME/i);
  });
});
