/**
 * EVIDENCE OUTPUT RECOVERY — operator CLI over the CANONICAL report authority.
 *
 *   node dist/scripts/recover-evidence-outputs.js status  --email=<email> | --user-id=<uuid> | --evidence-id=<uuid> [--expect-complete]
 *   node dist/scripts/recover-evidence-outputs.js recover --email=<email> | --user-id=<uuid> | --evidence-id=<uuid> [--apply]
 *
 * WHY (evidence-output incident, 2026-10-05). A record finalized while its
 * account was FREE is SIGNED with no report: issuance was skipped as not
 * entitled and nothing was queued. When the account later becomes entitled
 * (here: an internal TEAM grant) the record is eligible — the detail page
 * offers Generate — but an operator needs ONE deterministic, replay-safe way to
 * issue it.
 *
 * This tool decides nothing itself:
 *   - eligibility comes from resolveEvidenceOutputEligibility (the projection
 *     every surface reads; internal-grant aware);
 *   - issuance goes through requestReportGeneration (purpose `first_issuance`,
 *     or `package_recovery` for a report version that has no package), which
 *     re-checks entitlement and the historical-first-issuance rule, writes ONE
 *     durable request row keyed REPORT:<id>:v<n> and enqueues it. A replay
 *     collapses onto that row: no second job, report or package.
 *   - the worker produces the report, commits it with the REPORTED transition
 *     in one transaction, then the package for that exact report version.
 * It never inserts report/package rows, never changes a status, never touches
 * the timestamp. `status` is read-only (a HEAD of each stored object proves it
 * exists); `recover` without --apply only prints what it would request.
 */
import { prisma } from "../db.js";
import { headObject } from "../storage.js";
import { resolveEvidenceOutputEligibility } from "../services/billing/evidence-output-eligibility.service.js";
import { requestReportGeneration } from "../services/reports/report-generation-authority.service.js";
import { resolveInternalGrantSubject } from "../services/billing/internal-plan-grant.service.js";

import { primaryPublishedPackageWhere, asPublishedPackage } from "@proovra/shared-runtime/reports";
const MACHINE_ID = "ops.recover-evidence-outputs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_LIFECYCLE = ["ACTIVE", "UNDER_REVIEW", "ON_HOLD", "RETENTION_LOCKED"] as const;

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

export type RecoveryTarget = { evidenceId?: string | null; email?: string | null; userId?: string | null };

async function targetEvidence(t: RecoveryTarget): Promise<Array<{ id: string; ownerUserId: string; teamId: string | null }>> {
  const evidenceId = t.evidenceId ?? null;
  if (evidenceId) {
    if (!UUID_RE.test(evidenceId)) throw new Error("--evidence-id is not a UUID");
    const ev = await prisma.evidence.findFirst({
      where: { id: evidenceId, deletedAt: null },
      select: { id: true, ownerUserId: true, teamId: true },
    });
    if (!ev) throw new Error("no live evidence record has this id");
    return [ev];
  }
  const { userId } = await resolveInternalGrantSubject({ email: t.email ?? null, userId: t.userId ?? null });
  return prisma.evidence.findMany({
    where: { ownerUserId: userId, deletedAt: null },
    select: { id: true, ownerUserId: true, teamId: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
}

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await headObject({ bucket, key });
    return true;
  } catch {
    return false;
  }
}

export async function evidenceOutputStatus(t: RecoveryTarget & { expectComplete?: boolean }): Promise<number> {
  const evidence = await targetEvidence(t);
  let incomplete = 0;
  for (const ev of evidence) {
    const row = await prisma.evidence.findUnique({
      where: { id: ev.id },
      select: {
        status: true,
        lifecycleState: true,
        latestReportVersion: true,
        verificationPackageVersion: true,
        tsaStatus: true,
        tsaValidatedAtUtc: true,
        tsaFailureCode: true,
        otsStatus: true,
      },
    });
    const eligibility = await resolveEvidenceOutputEligibility({
      evidenceId: ev.id,
      ownerUserId: ev.ownerUserId,
      teamId: ev.teamId,
    });
    const reports = await prisma.report.findMany({
      where: { evidenceId: ev.id },
      select: { version: true, storageBucket: true, storageKey: true, pdfSha256: true, generatedAtUtc: true },
      orderBy: { version: "asc" },
    });
    const packages = await prisma.verificationPackage.findMany({
      where: primaryPublishedPackageWhere({ evidenceId: ev.id }),
      select: { version: true, reportVersion: true, storageBucket: true, storageKey: true, packageSha256: true },
      orderBy: { version: "asc" },
    }).then((rows) => rows.map(asPublishedPackage));
    const requests = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId: ev.id },
      select: { state: true, purpose: true, artifactType: true, terminalReasonCode: true, createdAtUtc: true },
      orderBy: { createdAtUtc: "asc" },
    });
    const reportOut = await Promise.all(
      reports.map(async (r) => ({
        version: r.version,
        pdfSha256: r.pdfSha256,
        objectExists: await objectExists(r.storageBucket, r.storageKey),
      })),
    );
    const packageOut = await Promise.all(
      packages.map(async (p) => ({
        version: p.version,
        reportVersion: p.reportVersion,
        packageSha256: p.packageSha256,
        objectExists: await objectExists(p.storageBucket, p.storageKey),
      })),
    );
    const latestReport = reportOut[reportOut.length - 1];
    const pairedPackage = latestReport ? packageOut.find((p) => p.reportVersion === latestReport.version) : undefined;
    const complete =
      row?.status === "REPORTED" &&
      Boolean(latestReport?.objectExists) &&
      Boolean(pairedPackage?.objectExists);
    if (!complete) incomplete += 1;
    console.log(
      JSON.stringify(
        {
          evidenceId: ev.id,
          status: row?.status,
          lifecycleState: row?.lifecycleState,
          // TSA and OTS are independent of each other and of the outputs.
          tsa: { status: row?.tsaStatus ?? null, validated: Boolean(row?.tsaValidatedAtUtc), failureCode: row?.tsaFailureCode ?? null },
          ots: row?.otsStatus ?? null,
          eligibility: {
            plan: eligibility.plan,
            report: eligibility.reportEligibility,
            package: eligibility.packageEligibility,
            reason: eligibility.ineligibilityReason,
          },
          reports: reportOut,
          packages: packageOut,
          requests: requests.map((r) => ({
            state: r.state,
            purpose: r.purpose,
            artifactType: r.artifactType,
            terminalReasonCode: r.terminalReasonCode,
            createdAt: r.createdAtUtc.toISOString(),
          })),
          complete,
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify({ records: evidence.length, complete: evidence.length - incomplete, incomplete }));
  return t.expectComplete && incomplete > 0 ? 3 : 0;
}

export async function recoverEvidenceOutputs(t: RecoveryTarget & { apply?: boolean }): Promise<{
  code: number;
  summary: Record<string, number>;
}> {
  const apply = t.apply === true;
  const evidence = await targetEvidence(t);
  const summary = { scanned: 0, requested: 0, deduplicated: 0, wouldRequest: 0, notEntitled: 0, notApplicable: 0, refused: 0 };
  for (const ev of evidence) {
    summary.scanned += 1;
    const row = await prisma.evidence.findUnique({
      where: { id: ev.id },
      select: { status: true, lifecycleState: true },
    });
    const reports = await prisma.report.findMany({ where: { evidenceId: ev.id }, select: { version: true }, orderBy: { version: "desc" } });
    const latest = reports[0]?.version ?? null;
    const paired = latest == null ? true : (await prisma.verificationPackage.count({ where: primaryPublishedPackageWhere({ evidenceId: ev.id, reportVersion: latest }) })) > 0;

    let purpose: "first_issuance" | "package_recovery" | null = null;
    if (row?.status === "SIGNED" && latest == null) purpose = "first_issuance";
    else if (row?.status === "REPORTED" && latest != null && !paired) purpose = "package_recovery";
    if (!purpose || !LIVE_LIFECYCLE.includes(String(row?.lifecycleState) as (typeof LIVE_LIFECYCLE)[number])) {
      summary.notApplicable += 1;
      console.log(`[recover] ${ev.id} nothing to recover (status=${row?.status} lifecycle=${row?.lifecycleState})`);
      continue;
    }

    const eligibility = await resolveEvidenceOutputEligibility({ evidenceId: ev.id, ownerUserId: ev.ownerUserId, teamId: ev.teamId });
    const needed = purpose === "first_issuance" ? eligibility.reportEligibility : eligibility.packageEligibility;
    if (needed !== "ELIGIBLE") {
      summary.notEntitled += 1;
      console.log(`[recover] ${ev.id} NOT ENTITLED (${needed}, plan=${eligibility.plan}, reason=${eligibility.ineligibilityReason ?? "-"}) — nothing requested`);
      continue;
    }
    if (!apply) {
      summary.wouldRequest += 1;
      console.log(`[recover] ${ev.id} (dry-run) would request ${purpose}`);
      continue;
    }
    const res = await requestReportGeneration({
      evidenceId: ev.id,
      purpose,
      ...(purpose === "package_recovery" ? { artifactType: "VERIFICATION_PACKAGE" as const, reportVersion: latest } : {}),
      requestedByMachineId: MACHINE_ID,
    });
    if (!res.requested) {
      summary.refused += 1;
      console.log(`[recover] ${ev.id} REFUSED by the report authority: ${res.reason}`);
      continue;
    }
    if (res.deduplicated) summary.deduplicated += 1;
    else summary.requested += 1;
    console.log(
      `[recover] ${ev.id} ${purpose} request=${res.requestId} deduplicated=${res.deduplicated} enqueued=${res.enqueued}${res.reason ? ` reason=${res.reason}` : ""}`,
    );
  }
  console.log(`[recover] summary ${JSON.stringify({ mode: apply ? "APPLY" : "DRY-RUN", ...summary })}`);
  return { code: summary.refused > 0 ? 3 : 0, summary };
}

const invokedDirectly = /recover-evidence-outputs\.(ts|js)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  const command = process.argv[2];
  const target: RecoveryTarget = { evidenceId: arg("evidence-id"), email: arg("email"), userId: arg("user-id") };
  (command === "status"
    ? evidenceOutputStatus({ ...target, expectComplete: flag("expect-complete") })
    : command === "recover"
      ? recoverEvidenceOutputs({ ...target, apply: flag("apply") }).then((r) => r.code)
      : Promise.reject(new Error("command must be status or recover")))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("recover-evidence-outputs failed:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

