/**
 * OUTPUT RECONCILIATION DRY RUN — READ-ONLY (2026-09-29).
 *
 * Classifies every FINALIZED, usable, not-deleted record by what the
 * evidence output lifecycle would do for it, and prints the batched repair
 * plan the worker's first-issuance reconciliation would carry out once its
 * rollout flags are enabled. It WRITES NOTHING: no row, no request, no queue
 * job, no S3 object. It reads the same inputs the worker does and asks the
 * same issuance decision (`resolveOutputIssuanceEntitlement`, through the
 * API's eligibility service), so the plan it prints is the plan that runs.
 *
 *   pnpm --filter proovra-api ops:output-reconciliation-dry-run -- \
 *     [--batch=200] [--limit=100000] [--json] [--samples=5]
 *
 * Groups (mutually exclusive, first match wins):
 *
 *   BUSY                         a request is QUEUED / PROCESSING / FAILED_RETRYABLE — left alone
 *   OPERATOR_TERMINAL            the latest request is FAILED_TERMINAL / BLOCKED_* — never auto-retried
 *   UNRESOLVED                   the entitlement could not be read — nothing is issued
 *   NOT_ISSUED_PLAN              no report; the plan does not include reports (Free) — correct, no action
 *   FIRST_ISSUE_NOT_CONFIRMED    no report; entitled only by trial/grace — waits for a confirmed payment
 *   FIRST_ISSUE_RECENT           no report; confirmed paid; signed within 7 days — scheduled without a flag
 *   FIRST_ISSUE_HISTORICAL       no report; confirmed paid; older — needs OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED
 *   PACKAGE_NOT_INCLUDED         latest report has no package; the plan excludes packages — correct, no action
 *   PACKAGE_RECOVERY             latest report vN has no package vN — needs OUTPUT_PACKAGE_RECOVERY_ENABLED
 *                                (sub-count: an OLDER package exists, e.g. report v7 / package v2)
 *   COMPLETE                     latest report and its package at the same version
 *
 * Legacy facts (informational; never repaired, shown as "not recorded"):
 * reports without s3_version_id, packages without package_sha256 / format.
 *
 * Records are identified by the first 8 characters of their id only.
 */
import { prisma } from "../db.js";
import { resolveEvidenceOutputEligibilityByRecord } from "../services/billing/evidence-output-eligibility.service.js";

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SIGNED_AGE_MS = 15 * 60 * 1000;
const OPERATOR = new Set(["FAILED_TERMINAL", "BLOCKED_POLICY", "BLOCKED_STALE"]);

type Group =
  | "BUSY"
  | "OPERATOR_TERMINAL"
  | "UNRESOLVED"
  | "NOT_ISSUED_PLAN"
  | "FIRST_ISSUE_NOT_CONFIRMED"
  | "FIRST_ISSUE_RECENT"
  | "FIRST_ISSUE_HISTORICAL"
  | "PACKAGE_NOT_INCLUDED"
  | "PACKAGE_RECOVERY"
  | "COMPLETE"
  | "TOO_YOUNG";

type Row = {
  id: string;
  owner_user_id: string;
  team_id: string | null;
  status: string;
  signed_at_utc: Date | null;
  latest_report: number | null;
  latest_package: number | null;
  package_at_latest: boolean;
  latest_request_state: string | null;
  any_live_request: boolean;
};

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function page(cursor: string | null, take: number): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT e.id,
           e.owner_user_id,
           e.team_id,
           e.status::text AS status,
           e.signed_at_utc,
           (SELECT max(r.version) FROM reports r WHERE r.evidence_id = e.id) AS latest_report,
           (SELECT max(vp.version) FROM verification_packages vp WHERE vp.evidence_id = e.id) AS latest_package,
           EXISTS (
             SELECT 1 FROM verification_packages vp
              WHERE vp.evidence_id = e.id
                AND vp.version = (SELECT max(r.version) FROM reports r WHERE r.evidence_id = e.id)
           ) AS package_at_latest,
           (SELECT q.state FROM report_generation_requests q
             WHERE q.evidence_id = e.id ORDER BY q.created_at_utc DESC LIMIT 1) AS latest_request_state,
           EXISTS (
             SELECT 1 FROM report_generation_requests q
              WHERE q.evidence_id = e.id
                AND q.state IN ('QUEUED','PROCESSING','FAILED_RETRYABLE')
           ) AS any_live_request
      FROM evidence e
     WHERE e.status IN ('SIGNED','REPORTED')
       AND e.deleted_at IS NULL
       AND e.lifecycle_state IN ('ACTIVE','UNDER_REVIEW','ON_HOLD','RETENTION_LOCKED')
       AND (${cursor}::uuid IS NULL OR e.id > ${cursor}::uuid)
     ORDER BY e.id
     LIMIT ${take}
  `;
}

async function main(): Promise<void> {
  const batch = Math.min(Math.max(1, Number(arg("batch") ?? 200)), 1000);
  const limit = Math.max(1, Number(arg("limit") ?? 100_000));
  const samplesPer = Math.max(0, Number(arg("samples") ?? 5));
  const asJson = process.argv.includes("--json");
  const now = Date.now();

  const counts = new Map<Group, number>();
  const samples = new Map<Group, string[]>();
  let olderPackageExists = 0;
  let scanned = 0;
  let cursor: string | null = null;

  const bump = (g: Group, id: string) => {
    counts.set(g, (counts.get(g) ?? 0) + 1);
    const s = samples.get(g) ?? [];
    if (s.length < samplesPer) s.push(id.slice(0, 8));
    samples.set(g, s);
  };

  while (scanned < limit) {
    const rows = await page(cursor, Math.min(batch, limit - scanned));
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;

    const eligibility = await resolveEvidenceOutputEligibilityByRecord(
      rows.map((r) => ({ id: r.id, ownerUserId: r.owner_user_id, teamId: r.team_id })),
    );

    for (const r of rows) {
      if (r.any_live_request) {
        bump("BUSY", r.id);
        continue;
      }
      const complete = r.latest_report != null && r.package_at_latest;
      if (complete) {
        bump("COMPLETE", r.id);
        continue;
      }
      if (r.latest_request_state && OPERATOR.has(r.latest_request_state)) {
        bump("OPERATOR_TERMINAL", r.id);
        continue;
      }
      const issuance = eligibility.get(r.id)?.issuance;
      if (!issuance || issuance.decision === "UNRESOLVED") {
        bump("UNRESOLVED", r.id);
        continue;
      }
      if (r.latest_report == null) {
        const signedAt = r.signed_at_utc ? r.signed_at_utc.getTime() : null;
        if (signedAt != null && now - signedAt < MIN_SIGNED_AGE_MS) {
          bump("TOO_YOUNG", r.id);
        } else if (issuance.decision !== "ENTITLED" || !issuance.reportsIncluded) {
          bump("NOT_ISSUED_PLAN", r.id);
        } else if (!issuance.mayIssueHistoricalFirstOutputs) {
          bump("FIRST_ISSUE_NOT_CONFIRMED", r.id);
        } else if (signedAt != null && now - signedAt <= RECENT_WINDOW_MS) {
          bump("FIRST_ISSUE_RECENT", r.id);
        } else {
          bump("FIRST_ISSUE_HISTORICAL", r.id);
        }
        continue;
      }
      if (issuance.decision !== "ENTITLED" || !issuance.verificationPackageIncluded) {
        bump("PACKAGE_NOT_INCLUDED", r.id);
        continue;
      }
      bump("PACKAGE_RECOVERY", r.id);
      if (r.latest_package != null && r.latest_package < r.latest_report) olderPackageExists++;
    }
  }

  const [legacy] = await prisma.$queryRaw<
    Array<{ reports_no_version: bigint; packages_unsealed: bigint; packages_no_digest: bigint }>
  >`
    SELECT (SELECT count(*) FROM reports WHERE s3_version_id IS NULL) AS reports_no_version,
           (SELECT count(*) FROM verification_packages WHERE package_format_version IS NULL) AS packages_unsealed,
           (SELECT count(*) FROM verification_packages WHERE package_sha256 IS NULL) AS packages_no_digest
  `;

  const plan = (group: Group, flagName: string | null) => {
    const n = counts.get(group) ?? 0;
    return { group, records: n, batches: Math.ceil(n / batch), flag: flagName };
  };
  const out = {
    mode: "DRY_RUN_READ_ONLY",
    scanned,
    batchSize: batch,
    groups: Object.fromEntries([...counts.entries()].sort()),
    packageRecoveryWithOlderPackage: olderPackageExists,
    samples: Object.fromEntries([...samples.entries()].sort()),
    repairPlan: [
      plan("FIRST_ISSUE_RECENT", null),
      plan("PACKAGE_RECOVERY", "OUTPUT_PACKAGE_RECOVERY_ENABLED"),
      plan("FIRST_ISSUE_HISTORICAL", "OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED"),
    ],
    noAction: ["NOT_ISSUED_PLAN", "FIRST_ISSUE_NOT_CONFIRMED", "PACKAGE_NOT_INCLUDED", "COMPLETE", "BUSY", "TOO_YOUNG"],
    operatorReview: ["OPERATOR_TERMINAL", "UNRESOLVED"],
    legacy: {
      reportsWithoutS3VersionId: Number(legacy.reports_no_version),
      packagesWithoutFormatVersion: Number(legacy.packages_unsealed),
      packagesWithoutDigest: Number(legacy.packages_no_digest),
    },
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    console.log(`output-reconciliation dry run — READ-ONLY — ${scanned} finalized record(s) scanned`);
    for (const [g, n] of Object.entries(out.groups)) {
      console.log(`  ${g.padEnd(28)} ${String(n).padStart(7)}   e.g. ${(out.samples[g] ?? []).join(", ")}`);
    }
    console.log(`  (package recovery where an OLDER package exists: ${olderPackageExists})`);
    console.log("repair plan (in rollout order):");
    for (const p of out.repairPlan) {
      console.log(`  ${p.group.padEnd(24)} ${p.records} record(s) in ${p.batches} batch(es)  flag: ${p.flag ?? "none (automatic)"}`);
    }
    console.log(
      `legacy (not repaired): ${out.legacy.reportsWithoutS3VersionId} report(s) without a pinned S3 version, ` +
        `${out.legacy.packagesWithoutFormatVersion} unsealed package(s)`,
    );
  }
}

main()
  .catch((err) => {
    console.error("output-reconciliation dry run failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
