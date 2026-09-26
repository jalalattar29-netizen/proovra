/**
 * HISTORICAL PACKAGE RECOVERY — DISCOVERY (dry run) AND APPROVAL-GATED EXECUTION.
 *
 * Records produced before package-only recovery existed can carry a valid
 * report with no verification package at that report's version: the package
 * was never built, its build failed, or only an OLDER package exists. This
 * finds them, classifies each with the SAME decision every surface renders
 * (`resolveEvidenceOutputActions`, via `loadEvidenceOutputFacts`), checks the
 * stored report the worker would embed, and produces a reviewable plan.
 *
 * =============================================================================
 * THE DRY RUN WRITES NOTHING
 * =============================================================================
 * Discovery issues SELECTs and read-only object-store HEAD/GET calls. It opens
 * no transaction, writes no audit row and enqueues nothing; a test proves the
 * database is byte-identical before and after. It is bounded (`maxRecords`,
 * keyset pages of `pageSize`), deterministic (a re-run over unchanged data
 * produces the same `planHash`) and resumable (`afterEvidenceId`).
 *
 * =============================================================================
 * EXECUTION IS A SEPARATE, APPROVED STEP
 * =============================================================================
 * `executePackageRecoveryPlan` refuses unless ALL hold:
 *
 *   * the environment says so explicitly (`PACKAGE_RECOVERY_BACKFILL_EXECUTE`);
 *   * an approval names the plan's hash, who approved it and why;
 *   * a fresh discovery with the approved parameters yields THAT hash — an
 *     approval of yesterday's plan does not authorize today's;
 *   * each record's workspace has an operator named in the approval, and that
 *     operator passes the canonical record-access check for
 *     `evidence.generate_report` (no system authority is invented here).
 *
 * Each record is then requested through `requestOutputRecovery` — the one
 * executor the product and Operations use — which re-derives the decision and
 * builds ONLY the package, from the stored report after its hash is verified
 * (no re-render, no new report version, no new timestamp token), idempotently
 * per report version. Every attempt is audited. No evidence credit is used.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  resolveEvidenceOutputActions,
  type OutputActionUnavailableReason,
} from "@proovra/shared";

import { prisma } from "../../db.js";
import { runReadOnlyScan } from "../../lib/read-only-scan.js";
import { getObjectStream, headObject } from "../../storage.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";
import { getWorkspaceUsage } from "../workspace-usage.service.js";
import {
  loadEvidenceOutputFacts,
  requestOutputRecovery,
  type LoadedOutputFacts,
} from "./output-recovery.service.js";

export const PACKAGE_RECOVERY_PLAN_SCHEMA = "proovra.package-recovery-plan/v1";

/** How far the stored report is checked before a record counts as recoverable. */
export type ReportStorageCheck = "none" | "head" | "full";

export type PackageGapCategory =
  /** No verification package of any version. */
  | "MISSING"
  /** The last package attempt after the latest report failed or was blocked. */
  | "FAILED"
  /** A package exists, but for an OLDER report version than the latest. */
  | "MISMATCHED";

export type ReportStorageFinding =
  | "NOT_CHECKED"
  /** A recorded hash the worker will verify the bytes against. */
  | "VERIFIABLE_RECORDED_HASH"
  /** The store's own SHA-256 for the object the worker will verify against. */
  | "VERIFIABLE_STORE_CHECKSUM"
  /** Hashed in full here and matched the recorded or stored hash. */
  | "VERIFIED"
  | "REPORT_OBJECT_MISSING"
  | "REPORT_INTEGRITY_MISMATCH"
  /** Nothing can vouch for the bytes; the worker would refuse them. */
  | "REPORT_INTEGRITY_UNVERIFIABLE"
  | "REPORT_OBJECT_READ_FAILED";

export type CandidateDisposition =
  /** Package-only recovery would be requested. */
  | "RECOVER"
  /** A failed package request would be retried as itself. */
  | "RETRY"
  | "EXCLUDED";

export type PackageRecoveryCandidate = {
  evidenceId: string;
  workspaceId: string | null;
  reportVersion: number;
  olderPackageVersion: number | null;
  category: PackageGapCategory;
  disposition: CandidateDisposition;
  /** Why it is excluded (the shared decision's reason, or a storage finding). */
  exclusionReason: OutputActionUnavailableReason | ReportStorageFinding | "RECORD_NOT_FOUND" | null;
  reportStorage: ReportStorageFinding;
  lastPackageRequestState: string | null;
  /** An ESTIMATE of the package's size; null when nothing recorded supports one. */
  estimatedPackageBytes: string | null;
};

export type PackageRecoveryDryRunParameters = {
  workspaceId: string | null;
  maxRecords: number;
  pageSize: number;
  batchSize: number;
  afterEvidenceId: string | null;
  storageCheck: ReportStorageCheck;
};

export type PackageRecoveryPlan = {
  schema: typeof PACKAGE_RECOVERY_PLAN_SCHEMA;
  mode: "DRY_RUN";
  runId: string;
  generatedAtUtc: string;
  parameters: PackageRecoveryDryRunParameters;
  /** Bound to exactly the recoverable set; an approval names it. */
  planHash: string;
  /** More records exist beyond `maxRecords`; resume from `nextCursor`. */
  truncated: boolean;
  nextCursor: string | null;
  totals: {
    scanned: number;
    recover: number;
    retry: number;
    excluded: number;
    categories: Record<PackageGapCategory, number>;
    exclusions: Record<string, number>;
  };
  storageEstimate: {
    /** Always an estimate: the package includes a copy of the original evidence. */
    label: "ESTIMATE";
    estimatedBytes: string;
    recordsWithoutEstimate: number;
    basis: string;
  };
  workspaces: Array<{
    workspaceId: string | null;
    recover: number;
    retry: number;
    excluded: number;
    categories: Record<PackageGapCategory, number>;
    estimatedBytes: string;
    storageBytesUsed: string | null;
    storageBytesLimit: string | null;
    /** Would the estimate fit the allowance; null when the allowance is unknown. */
    fitsStorage: boolean | null;
  }>;
  batches: Array<{ index: number; evidenceIds: string[]; estimatedBytes: string }>;
  candidates: PackageRecoveryCandidate[];
  notes: string[];
};

const MAX_RECORDS_CEILING = 50_000;
const PAGE_SIZE_CEILING = 500;
const BATCH_SIZE_CEILING = 200;

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.trunc(v as number) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeDryRunParameters(
  input: Partial<PackageRecoveryDryRunParameters>,
): PackageRecoveryDryRunParameters {
  const storageCheck: ReportStorageCheck =
    input.storageCheck === "none" || input.storageCheck === "full" ? input.storageCheck : "head";
  return {
    workspaceId: input.workspaceId?.trim() || null,
    maxRecords: clampInt(input.maxRecords, 1_000, 1, MAX_RECORDS_CEILING),
    pageSize: clampInt(input.pageSize, 200, 1, PAGE_SIZE_CEILING),
    batchSize: clampInt(input.batchSize, 25, 1, BATCH_SIZE_CEILING),
    afterEvidenceId: input.afterEvidenceId?.trim() || null,
    storageCheck,
  };
}

// ===========================================================================
// DISCOVERY
// ===========================================================================

type GapRow = { evidence_id: string; team_id: string | null; report_version: number };

/**
 * One keyset page of records whose LATEST report has no package at its
 * version. Read-only; ordered by evidence id so pages are stable.
 */
async function selectGapPage(p: {
  workspaceId: string | null;
  after: string | null;
  limit: number;
}): Promise<GapRow[]> {
  return prisma.$queryRaw<GapRow[]>`
    SELECT e.id AS evidence_id, e.team_id AS team_id, lr.version AS report_version
    FROM evidence e
    JOIN LATERAL (
      SELECT r.version FROM reports r
      WHERE r.evidence_id = e.id
      ORDER BY r.version DESC
      LIMIT 1
    ) lr ON TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM verification_packages p
      WHERE p.evidence_id = e.id AND p.version = lr.version
    )
    AND (${p.workspaceId}::uuid IS NULL OR e.team_id = ${p.workspaceId}::uuid)
    AND (${p.after}::uuid IS NULL OR e.id > ${p.after}::uuid)
    ORDER BY e.id ASC
    LIMIT ${p.limit}
  `;
}

const isNotFound = (err: unknown): boolean => {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.Code === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
};

/**
 * What the worker would find when it reads this report — the same order of
 * checks as its `readVerifiedStoredReport`, without writing anything.
 */
async function checkStoredReport(
  report: { storageBucket: string; storageKey: string; sizeBytes: bigint | null; pdfSha256: string | null },
  mode: ReportStorageCheck,
): Promise<ReportStorageFinding> {
  if (mode === "none") return "NOT_CHECKED";
  let head: Awaited<ReturnType<typeof headObject>>;
  try {
    head = await headObject({ bucket: report.storageBucket, key: report.storageKey, withChecksum: true });
  } catch (err) {
    return isNotFound(err) ? "REPORT_OBJECT_MISSING" : "REPORT_OBJECT_READ_FAILED";
  }
  if (report.sizeBytes != null && head.sizeBytes != null && BigInt(head.sizeBytes) !== report.sizeBytes) {
    return "REPORT_INTEGRITY_MISMATCH";
  }
  const storeChecksum =
    head.checksumSha256 && !head.checksumSha256.includes("-")
      ? Buffer.from(head.checksumSha256, "base64").toString("hex")
      : null;
  if (!report.pdfSha256 && !storeChecksum) return "REPORT_INTEGRITY_UNVERIFIABLE";
  if (mode === "head") {
    return report.pdfSha256 ? "VERIFIABLE_RECORDED_HASH" : "VERIFIABLE_STORE_CHECKSUM";
  }
  // Full: hash the bytes exactly as the worker will.
  let sha256: string;
  try {
    const body = (await getObjectStream({
      bucket: report.storageBucket,
      key: report.storageKey,
    })) as unknown as AsyncIterable<Uint8Array>;
    const hash = createHash("sha256");
    for await (const chunk of body) hash.update(chunk);
    sha256 = hash.digest("hex");
  } catch (err) {
    return isNotFound(err) ? "REPORT_OBJECT_MISSING" : "REPORT_OBJECT_READ_FAILED";
  }
  const expected = report.pdfSha256?.toLowerCase() ?? storeChecksum;
  return expected === sha256 ? "VERIFIED" : "REPORT_INTEGRITY_MISMATCH";
}

const FAILED_STATES = new Set(["FAILED_RETRYABLE", "FAILED_TERMINAL", "BLOCKED_POLICY", "BLOCKED_STALE"]);

function classify(
  loaded: LoadedOutputFacts,
  reportVersion: number,
  storage: ReportStorageFinding,
): Omit<PackageRecoveryCandidate, "evidenceId" | "workspaceId" | "estimatedPackageBytes"> {
  // The SYSTEM view of the shared decision: what the record needs, with the
  // caller's permission set aside (execution re-checks it per operator).
  const actions = resolveEvidenceOutputActions({ ...loaded.facts, callerMayGenerate: true });
  const pkg = actions.verificationPackage;
  const older = loaded.latestPackage && loaded.latestPackage.version < reportVersion
    ? loaded.latestPackage.version
    : null;
  const lastState = loaded.packageRequest?.state ?? null;
  const attemptAfterReport = loaded.facts.packageRequest?.afterLatestReport === true;
  const category: PackageGapCategory =
    lastState && FAILED_STATES.has(lastState) && (attemptAfterReport || loaded.packageRequest?.reportVersion === reportVersion)
      ? "FAILED"
      : older != null
        ? "MISMATCHED"
        : "MISSING";

  const storageBlocks =
    storage === "REPORT_OBJECT_MISSING" ||
    storage === "REPORT_INTEGRITY_MISMATCH" ||
    storage === "REPORT_INTEGRITY_UNVERIFIABLE" ||
    storage === "REPORT_OBJECT_READ_FAILED";

  if (pkg.action === "RECOVER" || pkg.action === "RETRY") {
    if (storageBlocks) {
      return {
        reportVersion,
        olderPackageVersion: older,
        category,
        disposition: "EXCLUDED",
        exclusionReason: storage,
        reportStorage: storage,
        lastPackageRequestState: lastState,
      };
    }
    return {
      reportVersion,
      olderPackageVersion: older,
      category,
      disposition: pkg.action,
      exclusionReason: null,
      reportStorage: storage,
      lastPackageRequestState: lastState,
    };
  }
  return {
    reportVersion,
    olderPackageVersion: older,
    category,
    disposition: "EXCLUDED",
    exclusionReason: pkg.reason ?? actions.report.reason ?? null,
    reportStorage: storage,
    lastPackageRequestState: lastState,
  };
}

const emptyCategories = (): Record<PackageGapCategory, number> => ({ MISSING: 0, FAILED: 0, MISMATCHED: 0 });

/** The canonical, order-independent identity of what execution would do. */
export function computePlanHash(
  parameters: Pick<PackageRecoveryDryRunParameters, "workspaceId" | "afterEvidenceId" | "maxRecords">,
  candidates: ReadonlyArray<Pick<PackageRecoveryCandidate, "evidenceId" | "reportVersion" | "disposition">>,
): string {
  const actionable = candidates
    .filter((c) => c.disposition !== "EXCLUDED")
    .map((c) => `${c.evidenceId}:v${c.reportVersion}:${c.disposition}`)
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: PACKAGE_RECOVERY_PLAN_SCHEMA,
        workspaceId: parameters.workspaceId,
        afterEvidenceId: parameters.afterEvidenceId,
        maxRecords: parameters.maxRecords,
        actionable,
      }),
    )
    .digest("hex");
}

/**
 * THE DRY RUN. Read-only; see the file header.
 */
export async function discoverPackageRecoveryCandidates(
  input: Partial<PackageRecoveryDryRunParameters> = {},
): Promise<PackageRecoveryPlan> {
  // Nothing in the call tree may record even its own use (see read-only-scan).
  return runReadOnlyScan(() => discover(input));
}

async function discover(
  input: Partial<PackageRecoveryDryRunParameters>,
): Promise<PackageRecoveryPlan> {
  const parameters = normalizeDryRunParameters(input);
  const candidates: PackageRecoveryCandidate[] = [];
  let cursor = parameters.afterEvidenceId;
  let truncated = false;

  while (candidates.length < parameters.maxRecords) {
    const want = Math.min(parameters.pageSize, parameters.maxRecords - candidates.length);
    // One extra row tells us whether more exist beyond the bound.
    const page = await selectGapPage({ workspaceId: parameters.workspaceId, after: cursor, limit: want + 1 });
    const rows = page.slice(0, want);
    if (page.length > want && candidates.length + rows.length >= parameters.maxRecords) truncated = true;
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.evidence_id);
    const [loadedMap, reports, evidence] = await Promise.all([
      loadEvidenceOutputFacts({ evidenceIds: ids, callerUserId: null }),
      prisma.report.findMany({
        where: { OR: rows.map((r) => ({ evidenceId: r.evidence_id, version: r.report_version })) },
        select: {
          evidenceId: true,
          storageBucket: true,
          storageKey: true,
          sizeBytes: true,
          pdfSha256: true,
        },
      }),
      prisma.evidence.findMany({ where: { id: { in: ids } }, select: { id: true, sizeBytes: true } }),
    ]);
    const reportBy = new Map(reports.map((r) => [r.evidenceId, r]));
    const evidenceBy = new Map(evidence.map((e) => [e.id, e]));

    for (const row of rows) {
      const loaded = loadedMap.get(row.evidence_id);
      const report = reportBy.get(row.evidence_id);
      if (!loaded || !report) {
        candidates.push({
          evidenceId: row.evidence_id,
          workspaceId: row.team_id,
          reportVersion: row.report_version,
          olderPackageVersion: null,
          category: "MISSING",
          disposition: "EXCLUDED",
          exclusionReason: "RECORD_NOT_FOUND",
          reportStorage: "NOT_CHECKED",
          lastPackageRequestState: null,
          estimatedPackageBytes: null,
        });
        continue;
      }
      // The object store is consulted only for records that would otherwise
      // be recovered: an excluded record's report is not the question.
      const provisional = classify(loaded, row.report_version, "NOT_CHECKED");
      const storage =
        provisional.disposition === "EXCLUDED"
          ? "NOT_CHECKED"
          : await checkStoredReport(report, parameters.storageCheck);
      const c = storage === "NOT_CHECKED" ? provisional : classify(loaded, row.report_version, storage);
      // ESTIMATE: an older package of this record is the best guide; else the
      // original evidence plus the report it embeds.
      const olderBytes = c.olderPackageVersion != null ? loaded.latestPackage?.sizeBytes ?? null : null;
      const originalBytes = evidenceBy.get(row.evidence_id)?.sizeBytes ?? null;
      const estimate =
        olderBytes ?? (originalBytes != null ? originalBytes + (report.sizeBytes ?? 0n) : null);
      candidates.push({
        evidenceId: row.evidence_id,
        workspaceId: row.team_id,
        ...c,
        estimatedPackageBytes: c.disposition === "EXCLUDED" || estimate == null ? null : estimate.toString(),
      });
    }
    cursor = rows[rows.length - 1]!.evidence_id;
    if (rows.length < want) break;
  }

  return buildPlan(parameters, candidates, truncated ? cursor : null);
}

async function buildPlan(
  parameters: PackageRecoveryDryRunParameters,
  candidates: PackageRecoveryCandidate[],
  nextCursor: string | null,
): Promise<PackageRecoveryPlan> {
  const categories = emptyCategories();
  const exclusions: Record<string, number> = {};
  let recover = 0;
  let retry = 0;
  let excluded = 0;
  let estimated = 0n;
  let withoutEstimate = 0;
  const byWorkspace = new Map<string | null, PackageRecoveryPlan["workspaces"][number] & { _bytes: bigint; _owner?: string }>();

  for (const c of candidates) {
    categories[c.category] += 1;
    const ws =
      byWorkspace.get(c.workspaceId) ??
      {
        workspaceId: c.workspaceId,
        recover: 0,
        retry: 0,
        excluded: 0,
        categories: emptyCategories(),
        estimatedBytes: "0",
        storageBytesUsed: null,
        storageBytesLimit: null,
        fitsStorage: null,
        _bytes: 0n,
      };
    ws.categories[c.category] += 1;
    if (c.disposition === "EXCLUDED") {
      excluded += 1;
      ws.excluded += 1;
      const key = c.exclusionReason ?? "UNSPECIFIED";
      exclusions[key] = (exclusions[key] ?? 0) + 1;
    } else {
      if (c.disposition === "RECOVER") {
        recover += 1;
        ws.recover += 1;
      } else {
        retry += 1;
        ws.retry += 1;
      }
      if (c.estimatedPackageBytes != null) {
        const b = BigInt(c.estimatedPackageBytes);
        estimated += b;
        ws._bytes += b;
      } else {
        withoutEstimate += 1;
      }
    }
    byWorkspace.set(c.workspaceId, ws);
  }

  // The allowance, once per workspace with work in it. Read-only.
  const workspaces: PackageRecoveryPlan["workspaces"] = [];
  for (const ws of byWorkspace.values()) {
    const { _bytes, _owner, ...rest } = ws;
    void _owner;
    let used: bigint | null = null;
    let limit: bigint | null = null;
    if (ws.workspaceId && ws.recover + ws.retry > 0) {
      try {
        const team = await prisma.team.findUnique({
          where: { id: ws.workspaceId },
          select: { ownerUserId: true },
        });
        if (team?.ownerUserId) {
          const ctx = await resolveCommercialContext({
            type: "WORKSPACE",
            teamId: ws.workspaceId,
            requesterUserId: team.ownerUserId,
          });
          const usage = await getWorkspaceUsage(ctx.scope);
          used = usage.storageBytesUsed;
          limit = usage.storageBytesLimit;
        }
      } catch {
        /* unknown allowance: reported as unknown, never guessed */
      }
    }
    workspaces.push({
      ...rest,
      estimatedBytes: _bytes.toString(),
      storageBytesUsed: used?.toString() ?? null,
      storageBytesLimit: limit?.toString() ?? null,
      fitsStorage: used != null && limit != null ? used + _bytes <= limit : null,
    });
  }
  workspaces.sort((a, b) => String(a.workspaceId).localeCompare(String(b.workspaceId)));

  const actionable = candidates.filter((c) => c.disposition !== "EXCLUDED");
  const batches: PackageRecoveryPlan["batches"] = [];
  for (let i = 0; i < actionable.length; i += parameters.batchSize) {
    const slice = actionable.slice(i, i + parameters.batchSize);
    batches.push({
      index: batches.length,
      evidenceIds: slice.map((c) => c.evidenceId),
      estimatedBytes: slice
        .reduce((sum, c) => sum + (c.estimatedPackageBytes ? BigInt(c.estimatedPackageBytes) : 0n), 0n)
        .toString(),
    });
  }

  return {
    schema: PACKAGE_RECOVERY_PLAN_SCHEMA,
    mode: "DRY_RUN",
    runId: randomUUID(),
    generatedAtUtc: new Date().toISOString(),
    parameters,
    planHash: computePlanHash(parameters, candidates),
    truncated: nextCursor !== null,
    nextCursor,
    totals: { scanned: candidates.length, recover, retry, excluded, categories, exclusions },
    storageEstimate: {
      label: "ESTIMATE",
      estimatedBytes: estimated.toString(),
      recordsWithoutEstimate: withoutEstimate,
      basis:
        "Per record: the size of its older package when one exists, otherwise the original evidence plus the report it embeds (a package includes a copy of the original evidence). Manifest and signature files add a few kilobytes.",
    },
    workspaces,
    batches,
    candidates,
    notes: [
      "DRY RUN. Nothing was written, enqueued or audited; only SELECTs and read-only object-store reads ran.",
      "Recovery builds ONLY the verification package, from the stored report after its hash is verified: no re-render, no new report version, no new timestamp token, no evidence credit.",
      "Excluded records are not recovered by this plan. REPORT_OBJECT_MISSING, REPORT_INTEGRITY_MISMATCH and REPORT_INTEGRITY_UNVERIFIABLE need a person; ESCALATED_TO_OPERATOR needs an operator's recorded supersession.",
      "Execution requires a separate approval naming this plan's hash and an authorized operator per workspace, and re-discovers before acting.",
    ],
  };
}

// ===========================================================================
// REVIEWABLE REPORT
// ===========================================================================

function fmtBytes(raw: string | null): string {
  if (raw == null) return "unknown";
  let v = Number(raw);
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${Math.round(v)} bytes` : `${v.toFixed(1)} ${units[u]}`;
}

export function renderPackageRecoveryPlanMarkdown(plan: PackageRecoveryPlan): string {
  const lines: string[] = [];
  lines.push(`# Historical package recovery — dry run`);
  lines.push("");
  lines.push(`- Run: \`${plan.runId}\` at ${plan.generatedAtUtc}`);
  lines.push(`- Plan hash: \`${plan.planHash}\``);
  lines.push(
    `- Parameters: workspace=${plan.parameters.workspaceId ?? "all"}, maxRecords=${plan.parameters.maxRecords}, pageSize=${plan.parameters.pageSize}, batchSize=${plan.parameters.batchSize}, after=${plan.parameters.afterEvidenceId ?? "start"}, storageCheck=${plan.parameters.storageCheck}`,
  );
  lines.push(`- Truncated: ${plan.truncated ? `yes — resume after \`${plan.nextCursor}\`` : "no"}`);
  lines.push("");
  lines.push(`## Totals`);
  lines.push("");
  lines.push(`| Scanned | Recover | Retry | Excluded | Missing | Failed | Mismatched |`);
  lines.push(`|---:|---:|---:|---:|---:|---:|---:|`);
  const t = plan.totals;
  lines.push(
    `| ${t.scanned} | ${t.recover} | ${t.retry} | ${t.excluded} | ${t.categories.MISSING} | ${t.categories.FAILED} | ${t.categories.MISMATCHED} |`,
  );
  lines.push("");
  lines.push(`## Exclusions`);
  lines.push("");
  const ex = Object.entries(t.exclusions).sort((a, b) => b[1] - a[1]);
  if (ex.length === 0) lines.push("None.");
  else {
    lines.push(`| Reason | Records |`);
    lines.push(`|---|---:|`);
    for (const [k, v] of ex) lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push(`## Storage (estimate)`);
  lines.push("");
  lines.push(
    `Estimated additional storage: **about ${fmtBytes(plan.storageEstimate.estimatedBytes)}** (estimate; ${plan.storageEstimate.recordsWithoutEstimate} record(s) without a recorded size). ${plan.storageEstimate.basis}`,
  );
  lines.push("");
  lines.push(`## By workspace`);
  lines.push("");
  lines.push(`| Workspace | Recover | Retry | Excluded | Missing | Failed | Mismatched | Estimate | Used / limit | Fits |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---|---|`);
  for (const w of plan.workspaces) {
    lines.push(
      `| ${w.workspaceId ?? "(no workspace)"} | ${w.recover} | ${w.retry} | ${w.excluded} | ${w.categories.MISSING} | ${w.categories.FAILED} | ${w.categories.MISMATCHED} | ${fmtBytes(w.estimatedBytes)} | ${w.storageBytesUsed != null ? `${fmtBytes(w.storageBytesUsed)} / ${fmtBytes(w.storageBytesLimit)}` : "unknown"} | ${w.fitsStorage == null ? "unknown" : w.fitsStorage ? "yes" : "NO"} |`,
    );
  }
  lines.push("");
  lines.push(`## Batches`);
  lines.push("");
  lines.push(`${plan.batches.length} batch(es) of at most ${plan.parameters.batchSize}.`);
  for (const b of plan.batches) {
    lines.push(`- Batch ${b.index}: ${b.evidenceIds.length} record(s), about ${fmtBytes(b.estimatedBytes)}`);
  }
  lines.push("");
  lines.push(`## Notes`);
  lines.push("");
  for (const n of plan.notes) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n");
}

// ===========================================================================
// APPROVAL-GATED EXECUTION — NOT RUN AS PART OF THE DRY RUN
// ===========================================================================

export const PACKAGE_RECOVERY_EXECUTE_ENV = "PACKAGE_RECOVERY_BACKFILL_EXECUTE";
export const PACKAGE_RECOVERY_EXECUTE_ENV_VALUE = "I_HAVE_OWNER_APPROVAL";

export type PackageRecoveryApproval = {
  planHash: string;
  parameters: PackageRecoveryDryRunParameters;
  approvedBy: string;
  approvedAtUtc: string;
  /** Why, and where the decision is recorded (ticket, meeting, document). */
  reference: string;
  /** Workspace id → the operator who acts there (must hold evidence.generate_report). */
  operators: Record<string, string>;
  /** Milliseconds between batches. */
  pauseBetweenBatchesMs?: number;
};

export type PackageRecoveryExecutionRefusal =
  | "EXECUTION_NOT_ENABLED"
  | "APPROVAL_INCOMPLETE"
  | "PLAN_CHANGED";

export type PackageRecoveryExecutionResult =
  | { kind: "refused"; reason: PackageRecoveryExecutionRefusal; detail?: string }
  | {
      kind: "executed";
      runId: string;
      planHash: string;
      results: Array<{
        evidenceId: string;
        workspaceId: string | null;
        outcome: string;
        reason: string | null;
        requestId: string | null;
      }>;
    };

function approvalComplete(a: PackageRecoveryApproval | null | undefined): a is PackageRecoveryApproval {
  return Boolean(
    a &&
      typeof a.planHash === "string" &&
      /^[0-9a-f]{64}$/.test(a.planHash) &&
      a.parameters &&
      typeof a.approvedBy === "string" &&
      a.approvedBy.trim() &&
      typeof a.approvedAtUtc === "string" &&
      !Number.isNaN(Date.parse(a.approvedAtUtc)) &&
      typeof a.reference === "string" &&
      a.reference.trim() &&
      a.operators &&
      typeof a.operators === "object",
  );
}

export async function executePackageRecoveryPlan(
  approval: PackageRecoveryApproval | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<PackageRecoveryExecutionResult> {
  if (env[PACKAGE_RECOVERY_EXECUTE_ENV] !== PACKAGE_RECOVERY_EXECUTE_ENV_VALUE) {
    return { kind: "refused", reason: "EXECUTION_NOT_ENABLED" };
  }
  if (!approvalComplete(approval)) return { kind: "refused", reason: "APPROVAL_INCOMPLETE" };

  // Re-discover with the approved parameters; act only on the approved plan.
  const plan = await discoverPackageRecoveryCandidates(approval.parameters);
  if (plan.planHash !== approval.planHash) {
    return {
      kind: "refused",
      reason: "PLAN_CHANGED",
      detail: `approved ${approval.planHash}, current ${plan.planHash}`,
    };
  }

  const runId = randomUUID();
  const byId = new Map(plan.candidates.map((c) => [c.evidenceId, c]));
  const results: Extract<PackageRecoveryExecutionResult, { kind: "executed" }>["results"] = [];
  for (const batch of plan.batches) {
    for (const evidenceId of batch.evidenceIds) {
      const c = byId.get(evidenceId)!;
      const operator = c.workspaceId ? approval.operators[c.workspaceId] : undefined;
      if (!operator) {
        results.push({ evidenceId, workspaceId: c.workspaceId, outcome: "SKIPPED", reason: "NO_AUTHORIZED_OPERATOR", requestId: null });
        continue;
      }
      let outcome = "FAILED";
      let reason: string | null = null;
      let requestId: string | null = null;
      try {
        const r = await requestOutputRecovery({
          evidenceId,
          actorUserId: operator,
          intent: c.disposition === "RETRY" ? "RETRY" : "RECOVER",
          purpose: "operator_regenerate",
          regenerateReason: "historical_package_recovery_backfill",
        });
        if (r.kind === "accepted") {
          outcome = r.outcome;
          requestId = r.requestId;
        } else if (r.kind === "declined") {
          outcome = r.outcome;
          reason = r.reason;
        } else {
          outcome = r.kind === "not_found" ? "NOT_FOUND" : "REFUSED";
        }
      } catch {
        outcome = "FAILED";
      }
      results.push({ evidenceId, workspaceId: c.workspaceId, outcome, reason, requestId });
      await emitTenantAudit({
        action: "report.package_recovery_backfill.request",
        outcome: outcome === "ENQUEUED" || outcome === "ALREADY_ACTIVE" ? "success" : reason === "PERMISSION_DENIED" ? "denied" : "error",
        sourceApp: "API",
        actorUserId: operator,
        workspaceId: c.workspaceId,
        resourceType: "evidence",
        resourceId: evidenceId,
        metadata: {
          runId,
          planHash: plan.planHash,
          approvedBy: approval.approvedBy,
          approvalReference: approval.reference,
          reportVersion: c.reportVersion,
          disposition: c.disposition,
          outcome,
          reason,
          requestId,
        },
      }).catch(() => {
        /* the request stands; the audit sink's outage is its own incident */
      });
    }
    const pause = clampInt(approval.pauseBetweenBatchesMs, 1_000, 0, 60_000);
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
  }
  return { kind: "executed", runId, planHash: plan.planHash, results };
}
