/**
 * EVIDENCE OUTPUT RECOVERY — operator CLI over the CANONICAL report authority.
 *
 *   node dist/scripts/recover-evidence-outputs.js status  --email=<email> | --user-id=<uuid> | --evidence-id=<uuid> [--expect-complete]
 *   node dist/scripts/recover-evidence-outputs.js recover --email=<email> | --user-id=<uuid> | --evidence-id=<uuid> [--apply] [--regenerate]
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
 *
 * ONE ASSESSMENT (2026-10-13). `status`, the dry run and `--apply` all read
 * assessEvidenceOutputRecovery, and `recover` performs only the operation it
 * names. Package recovery is chosen only for a latest report whose object
 * exists and can be vouched for; a missing or unverifiable report is
 * REPORT_REGENERATION_REQUIRED (executed only with --regenerate, as a new
 * verified version), altered bytes are REFUSED_INTEGRITY_FAILURE, a live
 * request is re-driven as itself, and an exhausted TECHNICAL terminal is
 * superseded once through the writer's bounded, audited supersession.
 */
import { prisma } from "../db.js";
import { probeStoredObject } from "../storage.js";
import { resolveEvidenceOutputEligibility } from "../services/billing/evidence-output-eligibility.service.js";
import {
  reenqueueReportGenerationRequest,
  requestReportGeneration,
} from "../services/reports/report-generation-authority.service.js";
import {
  assessEvidenceOutputRecovery,
  type AssessmentIo,
} from "../services/reports/output-recovery-assessment.js";
import { resolveInternalGrantSubject } from "../services/billing/internal-plan-grant.service.js";

import { primaryPublishedPackageWhere, asPublishedPackage } from "@proovra/shared-runtime/reports";
const MACHINE_ID = "ops.recover-evidence-outputs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--name=value` or `--name value` (the runbooks use both). */
function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3).trim();
  const at = argv.indexOf(`--${name}`);
  const next = at >= 0 ? argv[at + 1] : undefined;
  return next && !next.startsWith("--") ? next.trim() : null;
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

/**
 * AUD-011 — the RECORDED version, classified: PRESENT, NOT_FOUND, or a store
 * that did not answer (TRANSIENT) or refused us (ACCESS_DENIED). A transport
 * or permission failure used to print `objectExists: false`.
 */
async function objectState(bucket: string, key: string, versionId: string | null) {
  const probe = await probeStoredObject({ bucket, key, versionId });
  return probe.state;
}

export async function evidenceOutputStatus(
  t: RecoveryTarget & { expectComplete?: boolean; io?: AssessmentIo },
): Promise<number> {
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
      select: { version: true, storageBucket: true, storageKey: true, s3VersionId: true, pdfSha256: true, generatedAtUtc: true },
      orderBy: { version: "asc" },
    });
    const packages = await prisma.verificationPackage.findMany({
      where: primaryPublishedPackageWhere({ evidenceId: ev.id }),
      select: { version: true, reportVersion: true, storageBucket: true, storageKey: true, s3VersionId: true, packageSha256: true },
      orderBy: { version: "asc" },
    }).then((rows) => rows.map(asPublishedPackage));
    const requests = await prisma.reportGenerationRequest.findMany({
      where: { evidenceId: ev.id },
      select: { state: true, purpose: true, artifactType: true, terminalReasonCode: true, createdAtUtc: true },
      orderBy: { createdAtUtc: "asc" },
    });
    const reportOut = await Promise.all(
      reports.map(async (r) => {
        const object = await objectState(r.storageBucket, r.storageKey, r.s3VersionId);
        return { version: r.version, pdfSha256: r.pdfSha256, objectExists: object === "PRESENT", object };
      }),
    );
    const packageOut = await Promise.all(
      packages.map(async (p) => {
        const object = await objectState(p.storageBucket, p.storageKey, p.s3VersionId ?? null);
        return { version: p.version, reportVersion: p.reportVersion, packageSha256: p.packageSha256, objectExists: object === "PRESENT", object };
      }),
    );
    const assessed = await assessEvidenceOutputRecovery(ev, t.io);
    const complete = assessed.complete;
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
          assessment: assessed.assessment,
          assessmentReason: assessed.reason,
          latestReportFinding: assessed.latestReport?.finding ?? null,
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

export async function recoverEvidenceOutputs(
  t: RecoveryTarget & { apply?: boolean; regenerate?: boolean; io?: AssessmentIo },
): Promise<{
  code: number;
  summary: Record<string, number>;
  results: Array<{ evidenceId: string; assessment: string; reason: string; action: string; requestId?: string; deduplicated?: boolean; enqueued?: boolean }>;
}> {
  const apply = t.apply === true;
  const evidence = await targetEvidence(t);
  const summary = {
    scanned: 0,
    complete: 0,
    requested: 0,
    deduplicated: 0,
    reenqueued: 0,
    wouldRequest: 0,
    activeRequest: 0,
    notEntitled: 0,
    notApplicable: 0,
    operatorAction: 0,
    refused: 0,
  };
  const results: Array<{ evidenceId: string; assessment: string; reason: string; action: string; requestId?: string; deduplicated?: boolean; enqueued?: boolean }> = [];
  const say = (r: (typeof results)[number]) => {
    results.push(r);
    console.log(`[recover] ${JSON.stringify({ mode: apply ? "APPLY" : "DRY-RUN", ...r })}`);
  };

  for (const ev of evidence) {
    summary.scanned += 1;
    const a = await assessEvidenceOutputRecovery(ev, t.io);
    const head = { evidenceId: ev.id, assessment: a.assessment, reason: a.reason };
    switch (a.assessment) {
      case "COMPLETE":
        summary.complete += 1;
        say({ ...head, action: "none" });
        continue;
      case "NOT_ENTITLED":
        summary.notEntitled += 1;
        say({ ...head, action: "none" });
        continue;
      case "NOT_APPLICABLE":
        summary.notApplicable += 1;
        say({ ...head, action: "none" });
        continue;
      case "STORAGE_UNAVAILABLE":
        // AUD-011 — nothing is known to be missing; nothing is requested.
        summary.operatorAction += 1;
        say({ ...head, action: a.reason.endsWith("ACCESS_DENIED") ? "check_storage_credentials_and_configuration" : "retry_status_storage_unavailable" });
        continue;
      case "REFUSED_INTEGRITY_FAILURE":
        summary.refused += 1;
        say({ ...head, action: "operator_review_required" });
        continue;
      case "REPORT_REGENERATION_REQUIRED":
        if (!t.regenerate) {
          summary.operatorAction += 1;
          say({ ...head, action: "rerun_with_--regenerate_to_issue_a_new_verified_report_version" });
          continue;
        }
        break;
      case "ACTIVE_REQUEST":
        if (a.request?.state !== "FAILED_RETRYABLE" && !(await liveRetryable(ev.id))) {
          summary.activeRequest += 1;
          say({ ...head, action: "none_in_flight", requestId: a.activeRequestId ?? undefined });
          continue;
        }
        break;
      default:
        break;
    }

    if (!apply) {
      summary.wouldRequest += 1;
      say({ ...head, action: plannedAction(a.assessment) });
      continue;
    }

    if (a.assessment === "ACTIVE_REQUEST") {
      // A retryable request is re-driven AS ITSELF — no new identity.
      const retryable = await liveRetryable(ev.id);
      const out = retryable ? await reenqueueReportGenerationRequest(retryable) : { enqueued: false, outcome: "ALREADY_ACTIVE" };
      if (out.enqueued) summary.reenqueued += 1;
      else summary.activeRequest += 1;
      say({ ...head, action: "reenqueue_retryable", requestId: retryable ?? undefined, enqueued: out.enqueued });
      continue;
    }

    const res =
      a.assessment === "FIRST_ISSUANCE_REQUIRED"
        ? await requestReportGeneration({ evidenceId: ev.id, purpose: "first_issuance", requestedByMachineId: MACHINE_ID })
        : a.assessment === "REPORT_REGENERATION_REQUIRED"
          ? await requestReportGeneration({
              evidenceId: ev.id,
              purpose: "operator_regenerate",
              forceRegenerate: true,
              intent: "NEW_VERSION",
              // One regeneration per unusable report version, however often
              // the command runs.
              clientRequestKey: `ops-regenerate:${ev.id}:v${a.latestReportVersion}`,
              regenerateReason: `operator recovery: ${a.reason}`,
              requestedByMachineId: MACHINE_ID,
            })
          : await requestReportGeneration({
              evidenceId: ev.id,
              purpose: "package_recovery",
              artifactType: "VERIFICATION_PACKAGE" as const,
              reportVersion: a.latestReportVersion,
              // A package for an existing report is not a regeneration. Stated,
              // not derived, so this command and the Operations recovery
              // (requestOutputRecovery) share ONE key — `VERIFICATION_PACKAGE:<id>:v<N>` —
              // and collapse onto one request (2026-10-13). Derived, it was
              // `…:v<N>:force`: a second identity for the same package.
              forceRegenerate: false,
              requestedByMachineId: MACHINE_ID,
              ...(a.assessment === "TERMINAL_FAILURE_REQUIRES_SUPERSESSION"
                ? {
                    supersedeTechnicalTerminal: true,
                    regenerateReason: `operator recovery after technical terminal ${a.reason}`.slice(0, 120),
                  }
                : {}),
            });
    if (!res.requested) {
      summary.refused += 1;
      say({ ...head, action: `refused_by_authority:${res.reason}` });
      continue;
    }
    if (res.deduplicated) summary.deduplicated += 1;
    else summary.requested += 1;
    say({
      ...head,
      action: plannedAction(a.assessment),
      requestId: res.requestId,
      deduplicated: res.deduplicated,
      enqueued: res.enqueued,
    });
  }
  console.log(`[recover] summary ${JSON.stringify({ mode: apply ? "APPLY" : "DRY-RUN", ...summary })}`);
  return { code: summary.refused > 0 ? 3 : 0, summary, results };
}

/** The retryable request of this record, if any (re-driven as itself). */
async function liveRetryable(evidenceId: string): Promise<string | null> {
  const row = await prisma.reportGenerationRequest.findFirst({
    where: { evidenceId, state: "FAILED_RETRYABLE" },
    orderBy: { createdAtUtc: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

function plannedAction(kind: string): string {
  switch (kind) {
    case "FIRST_ISSUANCE_REQUIRED":
      return "request_first_issuance";
    case "PACKAGE_RECOVERY_REQUIRED":
      return "request_package_recovery";
    case "TERMINAL_FAILURE_REQUIRES_SUPERSESSION":
      return "supersede_technical_terminal_with_package_recovery";
    case "REPORT_REGENERATION_REQUIRED":
      return "request_new_verified_report_version";
    case "ACTIVE_REQUEST":
      return "reenqueue_retryable";
    default:
      return "none";
  }
}

const invokedDirectly = /recover-evidence-outputs\.(ts|js)$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  const command = process.argv[2];
  const target: RecoveryTarget = { evidenceId: arg("evidence-id"), email: arg("email"), userId: arg("user-id") };
  (command === "status"
    ? evidenceOutputStatus({ ...target, expectComplete: flag("expect-complete") })
    : command === "recover"
      ? recoverEvidenceOutputs({ ...target, apply: flag("apply"), regenerate: flag("regenerate") }).then((r) => r.code)
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

