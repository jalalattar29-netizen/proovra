/**
 * AUDIT D-03 (product decision 2026-11-15) — THE FIRST ISSUANCE OF AN ENTITLED
 * FREE RECORD IS NOT CUSTOMER STORAGE.
 *
 * The decision: Free offers up to three complete evidence records within a
 * combined 250 MiB of UPLOADED material. The originals are counted once, by the
 * existing storage authority (`Evidence.sizeBytes`). The standard first-issued
 * report and package variants that complete an entitled Free record are
 * excluded from the customer-facing allowance, whichever job produced them (the
 * completion's request, a retry, an operator supersession of a failed first
 * issuance, the first-issuance reconciler, a package-only recovery or the
 * historical package backfill for that version, or the server-verified
 * recovery of a proven-missing first-issued file). Additional versions and paid
 * outputs keep their existing entitlement and quota rules.
 *
 * Before this, a FULL_FORENSIC package (which embeds the originals) counted a
 * second copy of every original, so one ~100 MiB video as record 1 left too
 * little room for records 2 and 3 of the promise.
 *
 * THE DEFINITION — durable facts only, nothing new is stored:
 *
 *   entitled Free record   the record's stored earned fact (ET-COM-04) is
 *                          `outputEarnedPlan = FREE`, `outputEarnedBasis =
 *                          FREE_ALLOWANCE` — written once in the completion
 *                          transaction that settled it into one of the three
 *                          Free slots, or by the bounded historical backfill
 *                          (three-decisions-backfill.ts) for legacy records. It
 *                          never changes with the plan, so an upgrade or a
 *                          downgrade neither adds nor removes the exclusion; a
 *                          credit-funded record (its fact is the ledger row) and
 *                          a record earned on a paid plan are not covered.
 *   first issuance         the record's FIRST committed report version (the
 *                          lowest `Report.version` — the F-02 "no earlier report
 *                          version" rule, `firstIssuanceExemptFromStorageLimit`)
 *                          and, transitively, every version that RECOVERED a
 *                          proven-missing file of a first-issued version: a
 *                          report committed by a request whose purpose is the
 *                          server-only `missing_output_recovery` (AUD-011,
 *                          minted by the API only after a live HEAD of the
 *                          recorded version answered NOT_FOUND; no route takes a
 *                          purpose from a caller) whose `previousReportVersion`
 *                          — written by the worker from its own reservation —
 *                          is itself first issuance. Plus every PUBLISHED
 *                          package row of those versions, any disclosure profile
 *                          (FULL_FORENSIC, EXTERNAL_DISCLOSURE, legacy).
 *                          RESERVED / FAILED package rows store nothing and
 *                          count nowhere; publication orphans have no row and
 *                          count nowhere. A customer's updated report (purpose
 *                          `updated_report`, free-text reason) is never first
 *                          issuance, whatever its reason or key says.
 *
 * WHAT IT CHANGES: only the CUSTOMER-FACING figure. Both hosts' usage
 * measures (API `getWorkspaceUsage`, worker `getWorkspaceUsage`) subtract this
 * from the stored-bytes sum, so the API admission gates (part presign,
 * completion under the capacity lock), the worker artifact gates, the Billing
 * meter and every client meter that reads them answer from ONE figure. The
 * actual stored bytes stay observable beside it (`actualStorageBytes` on both
 * usage measures, the internal workspace console and the worker refusal
 * telemetry). No row is written, no artifact moves: immutable reports and
 * packages stay exactly where they are, and records that already have
 * first-issued outputs are excluded by the same rule the moment this is read.
 *
 * Shared by the API and worker calculators so the two cannot disagree.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { publishedPackageWhere } from "../reports/verification-package-artifacts.js";

/** The stored earned fact of a record settled into a Free allowance slot. */
export const FREE_ALLOWANCE_EARNED_EVIDENCE_WHERE = {
  outputEarnedPlan: "FREE",
  outputEarnedBasis: "FREE_ALLOWANCE",
} as const satisfies Prisma.EvidenceWhereInput;

/** Is this stored earned fact a Free allowance slot? */
export function isFreeAllowanceEarnedFact(row: {
  outputEarnedPlan?: string | null;
  outputEarnedBasis?: string | null;
} | null | undefined): boolean {
  return row?.outputEarnedPlan === "FREE" && row?.outputEarnedBasis === "FREE_ALLOWANCE";
}

/**
 * The server-only request purpose of an AUD-011 missing-file recovery. Equal
 * to the `REPORT_GENERATION_PURPOSES` member of the same name.
 */
export const MISSING_OUTPUT_RECOVERY_PURPOSE = "missing_output_recovery" as const;
/**
 * The idempotency-key prefix the missing-file recovery mints
 * (`recover-missing:<evidenceId>:v<N>`). Reserved: a caller-supplied key may
 * not start with it, so no customer request can occupy a recovery's identity.
 */
export const MISSING_OUTPUT_RECOVERY_KEY_PREFIX = "recover-missing:" as const;

/** Request stages at which the request's report version is COMMITTED. */
const REPORT_COMMITTED_STAGES = ["REPORT_COMMITTED", "PACKAGE_PUBLISHED"];
/** States of a request still running (its reserved version not yet committed). */
const LIVE_REQUEST_STATES = ["QUEUED", "PROCESSING", "FAILED_RETRYABLE"];

/**
 * THE RULE (pure). Which of a record's report versions are its first issuance:
 * the lowest version, and every version issued by a missing-file recovery
 * (`recoveryVersions`) whose `previousReportVersion` is already first issuance.
 */
export function firstIssuanceReportVersions(
  reports: ReadonlyArray<{ version: number; previousReportVersion: number | null }>,
  recoveryVersions: ReadonlySet<number>,
): Set<number> {
  const sorted = [...reports].sort((a, b) => a.version - b.version);
  const first = new Set<number>();
  if (sorted.length === 0) return first;
  first.add(sorted[0]!.version);
  for (const r of sorted.slice(1)) {
    if (
      recoveryVersions.has(r.version) &&
      r.previousReportVersion != null &&
      first.has(r.previousReportVersion)
    ) {
      first.add(r.version);
    }
  }
  return first;
}

type ReportReader = Pick<PrismaClient, "report" | "reportGenerationRequest">;

/** Committed missing-file recovery versions per record. */
async function committedRecoveryVersions(
  client: Pick<PrismaClient, "reportGenerationRequest">,
  evidenceIds: string[],
): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  if (evidenceIds.length === 0) return out;
  const rows = await client.reportGenerationRequest.findMany({
    where: {
      evidenceId: { in: evidenceIds },
      purpose: MISSING_OUTPUT_RECOVERY_PURPOSE,
      stage: { in: REPORT_COMMITTED_STAGES },
      reportVersion: { not: null },
    },
    select: { evidenceId: true, reportVersion: true },
  });
  for (const r of rows) {
    if (r.reportVersion == null) continue;
    const set = out.get(r.evidenceId) ?? new Set<number>();
    set.add(r.reportVersion);
    out.set(r.evidenceId, set);
  }
  return out;
}

type ReportRow = { evidenceId: string; version: number; previousReportVersion: number | null; sizeBytes: bigint | null };

async function readFirstIssuance(
  client: ReportReader,
  evidenceIds: string[],
): Promise<Map<string, { versions: Set<number>; reports: ReportRow[] }>> {
  const out = new Map<string, { versions: Set<number>; reports: ReportRow[] }>();
  if (evidenceIds.length === 0) return out;
  const reports = await client.report.findMany({
    where: { evidenceId: { in: evidenceIds } },
    select: { evidenceId: true, version: true, previousReportVersion: true, sizeBytes: true },
  });
  const byRecord = new Map<string, ReportRow[]>();
  for (const r of reports) {
    const list = byRecord.get(r.evidenceId) ?? [];
    list.push(r);
    byRecord.set(r.evidenceId, list);
  }
  // Recovery requests matter only for a record with more than one version.
  const recoveries = await committedRecoveryVersions(
    client,
    [...byRecord.entries()].filter(([, list]) => list.length > 1).map(([id]) => id),
  );
  for (const [id, list] of byRecord) {
    out.set(id, { versions: firstIssuanceReportVersions(list, recoveries.get(id) ?? new Set()), reports: list });
  }
  return out;
}

/**
 * The first-issuance report versions of each record given (callers pass
 * entitled Free records only). Used by the API's output offer so the offered
 * recovery and the worker's gate agree.
 */
export async function firstIssuanceVersionsByRecord(
  client: ReportReader,
  evidenceIds: string[],
): Promise<Map<string, Set<number>>> {
  const read = await readFirstIssuance(client, evidenceIds);
  return new Map([...read.entries()].map(([id, v]) => [id, v.versions]));
}

/**
 * For the worker's artifact gates: is THIS version of THIS record the
 * first issuance of an entitled Free record — its first report, or a
 * missing-file recovery of it (committed, or the live request reserving it)?
 * Such an artifact is not customer storage, so the allowance never refuses it.
 */
export async function isAllowanceExcludedFirstIssuance(
  client: Pick<PrismaClient, "evidence" | "report" | "reportGenerationRequest">,
  input: { evidenceId: string; version: number },
): Promise<boolean> {
  const earned = await client.evidence.findUnique({
    where: { id: input.evidenceId },
    select: { outputEarnedPlan: true, outputEarnedBasis: true },
  });
  if (!isFreeAllowanceEarnedFact(earned)) return false;
  const reports = await client.report.findMany({
    where: { evidenceId: input.evidenceId },
    select: { version: true, previousReportVersion: true },
  });
  const earlier = reports.filter((r) => r.version < input.version);
  if (earlier.length === 0) return true; // the first report version
  const own = reports.find((r) => r.version === input.version);
  const candidate = own ?? {
    version: input.version,
    // The report about to be committed follows the latest earlier version
    // (the worker's reservation writes exactly that as previousReportVersion).
    previousReportVersion: Math.max(...earlier.map((r) => r.version)),
  };
  const requests = await client.reportGenerationRequest.findMany({
    where: {
      evidenceId: input.evidenceId,
      purpose: MISSING_OUTPUT_RECOVERY_PURPOSE,
      reportVersion: { not: null },
      OR: [
        { stage: { in: REPORT_COMMITTED_STAGES } },
        { reportVersion: input.version, state: { in: LIVE_REQUEST_STATES } },
      ],
    },
    select: { reportVersion: true },
  });
  const recoveryVersions = new Set(requests.map((r) => r.reportVersion).filter((v): v is number => v != null));
  return firstIssuanceReportVersions([...earlier, candidate], recoveryVersions).has(input.version);
}

export type FirstIssuanceAllowanceExclusion = {
  /** Entitled Free records in the measured population. */
  records: number;
  /** Bytes of their first-issuance report versions. */
  reportBytes: bigint;
  /** Bytes of every published package row of those versions. */
  packageBytes: bigint;
  /** reportBytes + packageBytes: what the customer-facing figure leaves out. */
  totalBytes: bigint;
};

const NOTHING_EXCLUDED: FirstIssuanceAllowanceExclusion = {
  records: 0,
  reportBytes: 0n,
  packageBytes: 0n,
  totalBytes: 0n,
};

function toBytes(value: unknown): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.max(0, Math.trunc(value)));
  return 0n;
}

/**
 * Measure the first-issued outputs of the entitled Free records in a usage
 * population. `evidenceWhere` is the caller's own population AND lifecycle
 * filter — exactly the one its report and package sums use — so nothing is
 * subtracted that was not added.
 */
export async function measureFirstIssuanceAllowanceExclusion(
  // AUD-0017 — any client with the delegates, so a transaction passes its own.
  client: Pick<PrismaClient, "evidence" | "report" | "verificationPackage" | "reportGenerationRequest">,
  evidenceWhere: Prisma.EvidenceWhereInput,
): Promise<FirstIssuanceAllowanceExclusion> {
  const records = await client.evidence.findMany({
    where: { AND: [evidenceWhere, FREE_ALLOWANCE_EARNED_EVIDENCE_WHERE] },
    select: { id: true },
  });
  if (records.length === 0) return NOTHING_EXCLUDED;

  const first = await readFirstIssuance(client, records.map((r) => r.id));
  if (first.size === 0) return { ...NOTHING_EXCLUDED, records: records.length };
  let reportBytes = 0n;
  for (const { versions, reports } of first.values()) {
    for (const r of reports) if (versions.has(r.version)) reportBytes += toBytes(r.sizeBytes);
  }

  // Every published package row of those versions, whichever job issued it.
  const packages = await client.verificationPackage.findMany({
    where: publishedPackageWhere({ evidenceId: { in: [...first.keys()] } }),
    select: { evidenceId: true, version: true, sizeBytes: true },
  });
  const packageBytes = packages
    .filter((p) => first.get(p.evidenceId)?.versions.has(p.version) === true)
    .reduce((sum, p) => sum + toBytes(p.sizeBytes), 0n);

  return {
    records: records.length,
    reportBytes,
    packageBytes,
    totalBytes: reportBytes + packageBytes,
  };
}
