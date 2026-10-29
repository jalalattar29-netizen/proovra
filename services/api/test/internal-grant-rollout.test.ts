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
      // OTS truth: attestation / chain-check columns, EXPAND only.
      "20281012000000_evidence_ots_truth_columns",
      // Operations condition message code + params, EXPAND only.
      "20281013000000_operational_incident_message_code",
      // FREE outputs, canonical verification identity, retention archive — EXPAND only.
      "20281014000000_free_outputs_canonical_verification_retention_archive",
      // Capture attempt idempotency (AUD-026) — EXPAND only.
      "20281015120000_capture_session_client_attempt",
      // Verification disclosure policy (2026-10-18) — EXPAND + deterministic in-migration backfill
      // (PUBLISHED -> CONTENT_PREVIEW; hidden OWNER_SHARE links revoked).
      "20281018000000_verification_disclosure_policy",
      // SEALED IDENTITY SET ONCE (2026-10-20, AUD-43) — one BEFORE UPDATE trigger
      // refusing to change or clear a sealed evidence column. EXPAND only.
      "20281020000000_evidence_sealed_identity_set_once",
      // INDEPENDENT FORWARD AUDIT CLOSURE (2026-10-21) — the capture facts a signed
      // fingerprint commits to are set once (F-01 / F-25). EXPAND only.
      "20281021000000_evidence_sealed_capture_facts_set_once",
      // F-05 / F-06 — the issuance custody cut-off and the renewed claim lease. EXPAND only.
      "20281021000100_output_lease_renewal_and_issued_custody_cutoff",
      // Review decision rounds: Reopen and request-more-information start a new
      // round. EXPAND + BACKFILL + a guarded swap of the unique key.
      "20281023000100_review_decision_rounds",
      // Reviewer operations become a term an Enterprise contract can EXCLUDE
      // (owner matrix 2026-10-24): one nullable boolean on enterprise_contracts,
      // NULL = the catalog answer (included). EXPAND only.
      "20281024000000_enterprise_contract_reviewer_operations",
      // Members audit ACC-01/ACC-10: a Collaboration Team's reach into a Case.
      // One new empty table; EXPAND only.
      "20281025000000_case_collaboration_team_access",
      // Members audit LIFE-17: one custody enum value. EXPAND only.
      "20281026000000_custody_evidence_ownership_transferred",
      // Members audit DOM-12 / DOM-06: history refusal triggers and the owner
      // FK delete rule (CASCADE → RESTRICT). EXPAND only.
      "20281026000100_members_history_append_only_owner_restrict",
      // Members audit DOM-11: partial unique keys over ACTIVE rows. EXPAND only.
      "20281026000200_live_status_unique_keys",
      // Members audit, unassigned-member rule: one nullable Enterprise contract term. EXPAND only.
      "20281026000300_enterprise_contract_assignment_placement",
      // Members audit SEC-08: creator-scoped share grants get a 30-day ceiling and end with their creator. BACKFILL.
      "20281026000400_share_grant_lifetimes",
      // Members audit DOM-09: tier grants carried into the canonical engine. BACKFILL; apply with the API image.
      "20281026000500_delegated_admin_convergence",
      // Members audit DOM-08: CHECK constraints (NOT VALID) over the Collaboration Team vocabulary. EXPAND only.
      "20281026000600_collaboration_vocabulary_checks",
      // Members audit DOM-13: SSO and SCIM belong to the Organization. BACKFILL with guarded key swaps; apply with the API image.
      "20281026000700_organization_scoped_identity",
      // Members re-audit defect 6: a restricted case stays restricted when its last named member leaves. EXPAND + BACKFILL.
      "20281026000800_case_restriction_flag",
      // Members re-audit defects 8 and 12: legal holds and Organization SCIM groups no longer cascade with a workspace. EXPAND (FK delete rule).
      "20281026000900_holds_and_groups_outlive_workspace",
      // Members re-audit N-2: live tier grants of holders SUSPENDED at the DOM-09 convergence are carried forward (inert until reinstatement). BACKFILL.
      "20281026001000_delegated_admin_suspended_holders",
      // Members re-audit N-1: grants the precise delegated-only floor permissions to carried tier holders. BACKFILL.
      "20281026001100_delegated_admin_floor",
      // Members re-audit N-4: archived duplicate SCIM groups record their survivor so a directory still addressing them keeps deprovisioning. EXPAND + BACKFILL.
      "20281026001200_scim_group_merged_into",
      // Members re-audit D-12: SCIM tokens, identity mappings, SSO callback attempts and SSO connections no longer cascade with a workspace. EXPAND (FK delete rule).
      "20281026001300_identity_rows_outlive_workspace",
      // Members re-audit N-8: normalises deterministic legacy vocabulary variants and validates the DOM-08 checks that have no violators. BACKFILL.
      "20281026001400_collaboration_vocabulary_normalise",
      // Collaboration Team archive and step-up assurance: passkey factor, step-up ladder columns, Organization assurance policy, session assurance, archive provenance. EXPAND.
      "20281028000000_team_archive_step_up_assurance",
      // Combined screen recording: run kind, derived asset kind and the derived size ceiling for ONE DERIVED MP4 of a legacy segmented recording. EXPAND.
      "20281029000000_screen_recording_combined_derivative",
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
