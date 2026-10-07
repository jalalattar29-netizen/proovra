/**
 * The internal-grant Production rollout tool (src/scripts/internal-grant-rollout.ts):
 * it may only READ, it stops on anything outside the release, and its
 * before/after comparison accepts exactly one grant + one applied event.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROLLOUT_MIGRATIONS,
  READ_ONLY_SQL,
  compareSnapshots,
  evaluateMigrationState,
  fingerprint,
  isReadOnlyStatement,
  type SubjectSnapshot,
} from "../src/scripts/internal-grant-rollout.js";

const MIGRATIONS_DIR = resolve(__dirname, "..", "prisma", "migrations");
const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const before9 = onDisk.filter((m) => !ROLLOUT_MIGRATIONS.includes(m));
const rows = (names: string[]) => names.map((migration_name) => ({ migration_name, finished: true, rolled_back: false }));

describe("internal-grant rollout — read-only by construction", () => {
  it("every statement it can send is a plain SELECT (or SET TRANSACTION READ ONLY)", () => {
    for (const [name, sql] of Object.entries(READ_ONLY_SQL)) {
      expect(isReadOnlyStatement(sql), name).toBe(true);
    }
    expect(READ_ONLY_SQL.readOnly).toBe("SET TRANSACTION READ ONLY");
  });

  it("refuses anything that could write", () => {
    for (const sql of [
      `UPDATE "evidence" SET x = 1`,
      `SELECT 1; DELETE FROM users`,
      `INSERT INTO plan_grants VALUES (1)`,
      `WITH d AS (DELETE FROM users RETURNING 1) SELECT * FROM d`,
      `SELECT pg_advisory_lock(1) FROM users FOR UPDATE`,
      `CREATE INDEX x ON users (id)`,
      `SET TRANSACTION READ WRITE`,
    ]) {
      expect(isReadOnlyStatement(sql), sql).toBe(false);
    }
  });

  it("the backfill count is the exact WHERE of 20281001000700", () => {
    const sql = READ_ONLY_SQL.backfillCandidates;
    for (const clause of [
      `p."default_retention_days" > 0`,
      `e."retention_until_utc" IS NULL`,
      `e."deleted_at" IS NULL`,
      `'PROOVRA_MOBILE_APP'`,
      `'DIRECT_WEB_CAPTURE_EXTENSION'`,
      `'DIRECT_SCREEN_CAPTURE_ANDROID'`,
      `'DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS'`,
      `'DIRECT_SCREEN_CAPTURE_IOS'`,
    ]) {
      expect(sql).toContain(clause);
    }
  });
});

describe("internal-grant rollout — migration state", () => {
  it("the release is nine CONSECUTIVE timestamped migrations, and every later one belongs to a NAMED later release", () => {
    // `email_password_auth` is a historical, un-timestamped directory that
    // sorts last by name; it is not part of this release (readiness treats it
    // as unrelated-pending if a database has never applied it).
    const timestamped = onDisk.filter((m) => /^\d{14}_/.test(m));
    const end = timestamped.indexOf(ROLLOUT_MIGRATIONS[ROLLOUT_MIGRATIONS.length - 1]!);
    expect(end).toBeGreaterThan(0);
    expect(timestamped.slice(end - ROLLOUT_MIGRATIONS.length + 1, end + 1)).toEqual([...ROLLOUT_MIGRATIONS]);
    // A migration added after this release must be named here by its release,
    // so nothing can slip in between unclassified.
    const LATER_RELEASES = [
      // Updated-report / recovery closure (RGA-05 pairing FK, durable progress).
      "20281003000000_verification_package_report_pair_fk",
      "20281004000000_report_request_progress_stage",
      // Report & verification-package truth closure (disclosure profiles).
      "20281005000000_verification_package_disclosure_profile",
      // Per-profile package rows (reserved ids) and signing-key purpose.
      "20281006000000_verification_package_profile_rows",
      "20281006000100_signing_key_purpose",
    ];
    expect(timestamped.slice(end + 1)).toEqual(LATER_RELEASES);
  });

  it("pre: READY when exactly this release is pending", () => {
    const checks = evaluateMigrationState(onDisk, rows(before9), "pre");
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("pre: STOPS on an unrelated pending migration, a failed row, or an already-applied release", () => {
    const missingOne = before9.filter((m) => m !== before9[before9.length - 5]);
    const unrelated = evaluateMigrationState(onDisk, rows(missingOne), "pre");
    expect(unrelated.find((c) => c.name === "no pending migration outside this release")?.ok).toBe(false);

    const failed = evaluateMigrationState(
      onDisk,
      [...rows(before9), { migration_name: ROLLOUT_MIGRATIONS[0], finished: false, rolled_back: false }],
      "pre",
    );
    expect(failed.find((c) => c.name === "no failed or in-progress migration rows")?.ok).toBe(false);

    const done = evaluateMigrationState(onDisk, rows(onDisk), "pre");
    expect(done.find((c) => c.name.startsWith("this release is still pending"))?.ok).toBe(false);
  });

  it("post: every release migration recorded exactly once and nothing pending", () => {
    expect(evaluateMigrationState(onDisk, rows(onDisk), "post").filter((c) => !c.ok)).toEqual([]);
    const twice = evaluateMigrationState(onDisk, rows([...onDisk, ROLLOUT_MIGRATIONS[8]]), "post");
    expect(twice.find((c) => c.name === `${ROLLOUT_MIGRATIONS[8]} recorded exactly once`)?.ok).toBe(false);
    const partial = evaluateMigrationState(onDisk, rows(onDisk.slice(0, -1)), "post");
    expect(partial.find((c) => c.name === "nothing pending")?.ok).toBe(false);
  });
});

describe("internal-grant rollout — activation proof", () => {
  it("a fingerprint is order-insensitive and changes with any column", () => {
    const a = [{ id: "1", plan: "FREE", at: new Date(0) }, { id: "2", plan: "PRO", at: new Date(1) }];
    expect(fingerprint(a)).toEqual(fingerprint([...a].reverse()));
    expect(fingerprint(a).sha256).not.toBe(fingerprint([a[0], { ...a[1], plan: "TEAM" }]).sha256);
    expect(fingerprint([]).count).toBe(0);
  });

  const fp = { count: 1, sha256: "a".repeat(64) };
  const base: SubjectSnapshot = {
    takenAtUtc: "2026-10-05T10:00:00.000Z",
    userId: "u",
    personalTeamId: "t",
    providerPlan: "FREE",
    activeEntitlements: 1,
    effective: { plan: "FREE", source: "PERSONAL_ENTITLEMENT" },
    activeGrant: null,
    subjectGrants: 0,
    subjectAppliedEvents: 0,
    globalPlanGrants: 0,
    globalAppliedEvents: 0,
    fingerprints: { subscriptions: fp, payments: fp, evidence: fp },
  };
  const KEY = "owner-test:someone@example.test:team:2026-10";
  const granted: SubjectSnapshot = {
    ...base,
    takenAtUtc: "2026-10-05T10:05:00.000Z",
    effective: { plan: "TEAM", source: "INTERNAL_GRANT" },
    activeGrant: {
      id: "g",
      plan: "TEAM",
      source: "INTERNAL_TEST",
      grantedAtUtc: "2026-10-05T10:01:00.000Z",
      expiresAtUtc: "2027-01-03T10:01:00.000Z",
      idempotencyKey: KEY,
    },
    subjectGrants: 1,
    subjectAppliedEvents: 1,
    globalPlanGrants: 1,
    globalAppliedEvents: 1,
  };

  it("PASS: exactly one grant, one event, TEAM / INTERNAL_GRANT, 90 days, key matches, nothing else changed", () => {
    const checks = compareSnapshots(base, granted, "grant-applied", { idempotencyKey: KEY, expiryDays: 90 });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("FAIL: a changed payment, a changed provider plan, a second event, a wrong expiry or key", () => {
    const failing = (after: SubjectSnapshot, opts = { idempotencyKey: KEY }) =>
      compareSnapshots(base, after, "grant-applied", opts).filter((c) => !c.ok).map((c) => c.name);
    expect(failing({ ...granted, fingerprints: { ...granted.fingerprints, payments: { count: 2, sha256: "b".repeat(64) } } })).toContain(
      "payments unchanged (count + content SHA-256)",
    );
    expect(failing({ ...granted, providerPlan: "TEAM" })).toContain("provider plan unchanged");
    expect(failing({ ...granted, subjectAppliedEvents: 2, globalAppliedEvents: 2 })).toContain("subject applied events +1");
    expect(
      failing({ ...granted, activeGrant: { ...granted.activeGrant!, expiresAtUtc: "2026-11-04T10:01:00.000Z" } }),
    ).toContain("expiry = activation + 90 days (± 10 minutes of operator latency)");
    expect(failing(granted, { idempotencyKey: "another-key-123" })).toContain("grant idempotency key");
  });

  it("the idempotent replay must change NOTHING", () => {
    expect(compareSnapshots(granted, { ...granted, takenAtUtc: "later" }, "none").filter((c) => !c.ok)).toEqual([]);
    const dup = compareSnapshots(granted, { ...granted, subjectGrants: 2, globalPlanGrants: 2 }, "none");
    expect(dup.filter((c) => !c.ok).map((c) => c.name)).toEqual(["subject grants +0", "all grants +0"]);
  });
});
