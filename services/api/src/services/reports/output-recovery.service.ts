/**
 * ARTIFACT RECOVERY — the facts every output decision is made from, and the
 * one place a request to generate or recover an output is executed.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE MODULE
 * ---------------------------------------------------------------------------
 * The action a surface offers (Evidence Detail, Reports, Copilot, Operations,
 * the mobile app) and the operation the server performs when it is taken were
 * decided in different places, from different facts. A READY record offered
 * "Regenerate" that minted a new report; a report without its package offered
 * two verbs that both minted a new report; a request that failed terminally
 * kept a button whose every click was refused.
 *
 * Here the facts are gathered ONCE (in batch, for list pages), the decision is
 * `resolveEvidenceOutputActions` from `@proovra/shared`, and the POST route
 * and the Operations executor both call {@link requestOutputRecovery}, which
 * re-derives the decision from the same facts instead of trusting the
 * client's verb.
 */

import * as prismaPkg from "@prisma/client";
import {
  NEW_VERSION_ACTION,
  resolveEvidenceOutputActions,
  type EvidenceOutputActions,
  type EvidenceOutputFacts,
  type GenerationIntent,
  type GenerationRequestOutcome,
  type OutputActionUnavailableReason,
  type OutputOperation,
  type OutputRecordApplicability,
  type OutputRequestFact,
  type PersistedReportRequestState,
} from "@proovra/shared";

import { prisma } from "../../db.js";
import {
  resolveEvidenceOutputEligibility,
  type EvidenceOutputEligibility,
} from "../billing/evidence-output-eligibility.service.js";
import { resolveEvidenceRecordAccess } from "../evidence/evidence-record-access.service.js";
import { isEvidenceUnderAnyLegalHold } from "../governance/legal-hold.service.js";
import { resolveCommercialContext } from "../billing/commercial-context.service.js";
import { getWorkspaceUsage } from "../workspace-usage.service.js";
import {
  reenqueueReportGenerationRequest,
  requestReportGeneration,
} from "./report-generation-authority.service.js";

/**
 * THE ONE MAPPING from a persisted `EvidenceStatus` to the record axis.
 *
 * P1-3 CLOSURE (2026-09-10). Three call sites need it — this projection, the
 * Reports aggregator and the user-scoped Reports fallback — and a status
 * string compared inline at each of them is how a fourth status comes to be
 * classified two different ways. It is a pure function of the status, so it
 * takes the status and nothing else.
 *
 * A status this function does not recognise reads `NOT_FINALIZED`, which is
 * the conservative answer: it offers no action and promises nothing.
 */
export function resolveOutputRecordApplicability(
  status: prismaPkg.EvidenceStatus | string | null | undefined,
): OutputRecordApplicability {
  if (status === prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH) {
    return "INTEGRITY_FAILED";
  }
  if (
    status === prismaPkg.EvidenceStatus.SIGNED ||
    status === prismaPkg.EvidenceStatus.REPORTED
  ) {
    return "FINALIZED";
  }
  return "NOT_FINALIZED";
}

type RequestRow = {
  id: string;
  artifactType: string;
  state: string;
  terminalReasonCode: string | null;
  attemptCount: number;
  createdAtUtc: Date;
  completedAtUtc: Date | null;
  reportVersion: number | null;
};

type ArtifactRow = {
  version: number;
  generatedAtUtc: Date;
  sizeBytes: bigint | null;
};

/**
 * The storage a new report/package pair is expected to add. An ESTIMATE, and
 * labelled with what it is based on; never presented as an exact figure.
 */
export type NewVersionStorageEstimate = {
  estimatedBytes: string;
  /**
   * `PREVIOUS_PAIR`: the sizes of the latest report and package, which a new
   * pair closely matches (the package carries a copy of the original
   * evidence). `ORIGINAL_EVIDENCE`: the original's size plus the latest report,
   * used when the package size was not recorded.
   */
  basis: "PREVIOUS_PAIR" | "ORIGINAL_EVIDENCE";
  reportBytes: string | null;
  packageBytes: string | null;
  storageBytesUsed: string | null;
  storageBytesLimit: string | null;
  fitsStorage: boolean | null;
};

export type LoadedOutputFacts = {
  evidenceId: string;
  teamId: string | null;
  ownerUserId: string | null;
  facts: EvidenceOutputFacts;
  actions: EvidenceOutputActions;
  eligibility: EvidenceOutputEligibility | null;
  latestReport: ArtifactRow | null;
  /** The package paired with the latest report (same version). */
  packageAtLatest: (ArtifactRow & { packageType: string | null }) | null;
  /** The newest package of any version (history, legacy). */
  latestPackage: (ArtifactRow & { packageType: string | null }) | null;
  reportRequest: RequestRow | null;
  packageRequest: RequestRow | null;
  newVersionEstimate: NewVersionStorageEstimate | null;
};

const REQUEST_SELECT = {
  id: true,
  evidenceId: true,
  artifactType: true,
  state: true,
  terminalReasonCode: true,
  attemptCount: true,
  createdAtUtc: true,
  completedAtUtc: true,
  reportVersion: true,
} as const;

function toRequestFact(
  row: RequestRow | null,
  latestReport: ArtifactRow | null,
): OutputRequestFact {
  if (!row) return null;
  return {
    state: row.state as PersistedReportRequestState,
    terminalReasonCode: row.terminalReasonCode,
    afterLatestReport:
      latestReport != null && row.createdAtUtc > latestReport.generatedAtUtc,
  };
}

function readPackageBlocked(raw: unknown): boolean {
  return (
    raw != null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { blocked?: unknown }).blocked === true
  );
}

/**
 * Gather the facts for a set of records. Batch-safe: a fixed number of
 * queries per page plus one access, hold and eligibility resolution per
 * record.
 *
 * `callerUserId` decides `callerMayGenerate` through the CANONICAL record
 * access engine. With no caller, nothing is offered.
 */
export async function loadEvidenceOutputFacts(input: {
  evidenceIds: readonly string[];
  callerUserId?: string | null;
  /** Compute the storage estimate for a new version (single-record views). */
  includeNewVersionEstimate?: boolean;
}): Promise<Map<string, LoadedOutputFacts>> {
  const ids = [...new Set(input.evidenceIds)];
  const out = new Map<string, LoadedOutputFacts>();
  if (ids.length === 0) return out;

  const evidenceRows = await prisma.evidence.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      lifecycleState: true,
      teamId: true,
      ownerUserId: true,
      sizeBytes: true,
      verificationPackageMetadata: true,
    },
  });
  if (evidenceRows.length === 0) return out;
  const foundIds = evidenceRows.map((e) => e.id);

  const teamIds = [...new Set(evidenceRows.map((e) => e.teamId).filter((t): t is string => !!t))];
  const [reports, packagesAny, reportRequests, anyRequests, teams] = await Promise.all([
    prisma.report.findMany({
      where: { evidenceId: { in: foundIds } },
      orderBy: [{ evidenceId: "asc" }, { version: "desc" }],
      distinct: ["evidenceId"],
      select: { evidenceId: true, version: true, generatedAtUtc: true, sizeBytes: true },
    }),
    prisma.verificationPackage.findMany({
      where: { evidenceId: { in: foundIds } },
      orderBy: [{ evidenceId: "asc" }, { version: "desc" }],
      distinct: ["evidenceId"],
      select: { evidenceId: true, version: true, generatedAtUtc: true, sizeBytes: true, packageType: true },
    }),
    prisma.reportGenerationRequest.findMany({
      where: { evidenceId: { in: foundIds }, artifactType: "REPORT" },
      orderBy: [{ evidenceId: "asc" }, { createdAtUtc: "desc" }],
      distinct: ["evidenceId"],
      select: REQUEST_SELECT,
    }),
    prisma.reportGenerationRequest.findMany({
      where: { evidenceId: { in: foundIds } },
      orderBy: [{ evidenceId: "asc" }, { createdAtUtc: "desc" }],
      distinct: ["evidenceId"],
      select: REQUEST_SELECT,
    }),
    teamIds.length
      ? prisma.team.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, closedAtUtc: true, organizationId: true },
        })
      : Promise.resolve([] as Array<{ id: string; closedAtUtc: Date | null; organizationId: string | null }>),
  ]);

  const reportBy = new Map(reports.map((r) => [r.evidenceId, r]));
  const latestPackageBy = new Map(packagesAny.map((p) => [p.evidenceId, p]));
  const reportRequestBy = new Map(reportRequests.map((r) => [r.evidenceId, r]));
  const anyRequestBy = new Map(anyRequests.map((r) => [r.evidenceId, r]));
  const teamBy = new Map(teams.map((t) => [t.id, t]));

  // The package paired with each record's latest report.
  const pairs = reports.map((r) => ({ evidenceId: r.evidenceId, version: r.version }));
  const pairedPackages = pairs.length
    ? await prisma.verificationPackage.findMany({
        where: { OR: pairs },
        select: { evidenceId: true, version: true, generatedAtUtc: true, sizeBytes: true, packageType: true },
      })
    : [];
  const pairedBy = new Map(pairedPackages.map((p) => [p.evidenceId, p]));

  const orgIds = [...new Set(teams.map((t) => t.organizationId).filter((o): o is string => !!o))];
  const orgs = orgIds.length
    ? await prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, status: true },
      })
    : [];
  const orgBy = new Map(orgs.map((o) => [o.id, o]));

  await Promise.all(
    evidenceRows.map(async (ev) => {
      const latestReport = reportBy.get(ev.id) ?? null;
      const packageAtLatest = pairedBy.get(ev.id) ?? null;
      const latestPackage = latestPackageBy.get(ev.id) ?? null;
      const reportRequest = (reportRequestBy.get(ev.id) as RequestRow | undefined) ?? null;
      const packageRequest = (anyRequestBy.get(ev.id) as RequestRow | undefined) ?? null;
      const team = ev.teamId ? teamBy.get(ev.teamId) ?? null : null;
      const org = team?.organizationId ? orgBy.get(team.organizationId) ?? null : null;

      const [eligibility, legalHold, callerMayGenerate] = await Promise.all([
        ev.ownerUserId
          ? resolveEvidenceOutputEligibility({
              evidenceId: ev.id,
              ownerUserId: ev.ownerUserId,
              teamId: ev.teamId ?? null,
            }).catch(() => null)
          : Promise.resolve(null),
        isEvidenceUnderAnyLegalHold(ev.id).catch(() => true),
        input.callerUserId
          ? resolveEvidenceRecordAccess({
              userId: input.callerUserId,
              evidenceId: ev.id,
              permission: "evidence.generate_report",
            })
              .then((a) => a.allowed)
              .catch(() => false)
          : Promise.resolve(false),
      ]);

      let newVersionEstimate: NewVersionStorageEstimate | null = null;
      if (input.includeNewVersionEstimate && latestReport) {
        newVersionEstimate = await estimateNewVersionStorage({
          ownerUserId: ev.ownerUserId,
          teamId: ev.teamId,
          reportBytes: latestReport.sizeBytes,
          packageBytes: packageAtLatest?.sizeBytes ?? null,
          originalBytes: ev.sizeBytes ?? null,
        });
      }

      const facts: EvidenceOutputFacts = {
        record: resolveOutputRecordApplicability(ev.status),
        // An unresolvable commercial answer is not an entitlement: offer
        // nothing rather than a button the worker refuses.
        reportEligibility: eligibility?.reportEligibility ?? "NOT_INCLUDED",
        packageEligibility: eligibility?.packageEligibility ?? "NOT_INCLUDED",
        latestReportVersion: latestReport?.version ?? null,
        packageAtLatestReport: packageAtLatest !== null,
        latestPackageVersion: latestPackage?.version ?? null,
        packageBlockedByGovernance: readPackageBlocked(ev.verificationPackageMetadata),
        reportRequest: toRequestFact(reportRequest, latestReport),
        packageRequest: toRequestFact(packageRequest, latestReport),
        restrictions: {
          lifecycleState: ev.lifecycleState ? String(ev.lifecycleState) : null,
          legalHold,
          workspaceSuspended: org != null && org.status !== "ACTIVE",
          workspaceClosed: team?.closedAtUtc != null,
          workspaceResolved: Boolean(ev.teamId),
        },
        callerMayGenerate,
        newVersionFitsStorage: newVersionEstimate?.fitsStorage ?? null,
      };

      out.set(ev.id, {
        evidenceId: ev.id,
        teamId: ev.teamId ?? null,
        ownerUserId: ev.ownerUserId ?? null,
        facts,
        actions: resolveEvidenceOutputActions(facts),
        eligibility,
        latestReport,
        packageAtLatest,
        latestPackage,
        reportRequest,
        packageRequest,
        newVersionEstimate,
      });
    }),
  );
  return out;
}

async function estimateNewVersionStorage(input: {
  ownerUserId: string | null;
  teamId: string | null;
  reportBytes: bigint | null;
  packageBytes: bigint | null;
  originalBytes: bigint | null;
}): Promise<NewVersionStorageEstimate | null> {
  let estimated: bigint;
  let basis: NewVersionStorageEstimate["basis"];
  if (input.reportBytes != null && input.packageBytes != null) {
    estimated = input.reportBytes + input.packageBytes;
    basis = "PREVIOUS_PAIR";
  } else if (input.originalBytes != null) {
    estimated = input.originalBytes + (input.reportBytes ?? 0n);
    basis = "ORIGINAL_EVIDENCE";
  } else {
    // No recorded size to base an estimate on. Say so rather than invent one.
    return null;
  }
  let used: bigint | null = null;
  let limit: bigint | null = null;
  if (input.ownerUserId) {
    try {
      // The canonical commercial envelope, with an explicit subject: the
      // workspace that holds the record, or its personal owner.
      const ctx = await resolveCommercialContext(
        input.teamId
          ? { type: "WORKSPACE", teamId: input.teamId, requesterUserId: input.ownerUserId }
          : { type: "PERSONAL_ACCOUNT", userId: input.ownerUserId },
      );
      const usage = await getWorkspaceUsage(ctx.scope);
      used = usage.storageBytesUsed;
      limit = usage.storageBytesLimit;
    } catch {
      /* unknown allowance: the estimate stands, the fit is unknown */
    }
  }
  return {
    estimatedBytes: estimated.toString(),
    basis,
    reportBytes: input.reportBytes?.toString() ?? null,
    packageBytes: input.packageBytes?.toString() ?? null,
    storageBytesUsed: used?.toString() ?? null,
    storageBytesLimit: limit?.toString() ?? null,
    fitsStorage: used != null && limit != null ? used + estimated <= limit : null,
  };
}

// ===========================================================================
// EXECUTION
// ===========================================================================

export type OutputRecoveryResult =
  | {
      kind: "accepted";
      requestId: string | null;
      operation: OutputOperation;
      outcome: GenerationRequestOutcome;
      enqueued: boolean;
    }
  | {
      /** Nothing to do, or not possible now; `reason` says which. */
      kind: "declined";
      outcome: GenerationRequestOutcome;
      reason: OutputActionUnavailableReason | null;
    }
  | { kind: "idempotency_key_required" }
  | { kind: "not_found" };

/** Normalise a client's verb. `REGENERATE` is the legacy spelling of NEW_VERSION. */
export function normalizeGenerationIntent(raw: unknown): GenerationIntent | undefined {
  if (typeof raw !== "string") return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === "REGENERATE" || upper === "CREATE_NEW_VERSION") return "NEW_VERSION";
  return (["GENERATE", "RETRY", "RECOVER", "NEW_VERSION"] as const).includes(
    upper as "GENERATE",
  )
    ? (upper as GenerationIntent)
    : undefined;
}

/**
 * Execute a generation / recovery request for ONE record.
 *
 * The caller has already authorized the actor (the canonical record access
 * engine for customers; Operations capability for operators). This function
 * decides WHAT runs, from the same facts the projection shows:
 *
 *   * NEW_VERSION requires a caller idempotency key and the complete pair;
 *   * otherwise the missing or failed output is recovered — the package alone
 *     beside an existing report, the pair when there is no report — and a
 *     retryable request is re-enqueued as itself;
 *   * `operatorSupersede` starts a new request identity beside a TECHNICAL
 *     terminal and nothing else.
 */
export async function requestOutputRecovery(input: {
  evidenceId: string;
  actorUserId: string;
  intent?: GenerationIntent;
  clientRequestKey?: string | null;
  purpose: "operator_regenerate";
  regenerateReason: string;
  /** Operations only, after its own capability check and a recorded reason. */
  operatorSupersede?: boolean;
}): Promise<OutputRecoveryResult & { loaded?: LoadedOutputFacts }> {
  const loaded = (
    await loadEvidenceOutputFacts({
      evidenceIds: [input.evidenceId],
      callerUserId: input.actorUserId,
      includeNewVersionEstimate: input.intent === "NEW_VERSION",
    })
  ).get(input.evidenceId);
  if (!loaded) return { kind: "not_found" };
  const { actions } = loaded;
  const latestVersion = loaded.facts.latestReportVersion;
  const base = {
    evidenceId: input.evidenceId,
    purpose: input.purpose,
    regenerateReason: input.regenerateReason,
    requestedByUserId: input.actorUserId,
  } as const;

  const fromRequested = async (
    operation: OutputOperation,
    requested: Awaited<ReturnType<typeof requestReportGeneration>>,
  ): Promise<OutputRecoveryResult & { loaded: LoadedOutputFacts }> =>
    requested.requested
      ? {
          kind: "accepted",
          requestId: requested.requestId,
          operation,
          outcome: requested.outcome,
          enqueued: requested.enqueued,
          loaded,
        }
      : { kind: "declined", outcome: requested.outcome, reason: null, loaded };

  // ---- An explicit new version ------------------------------------------
  if (input.intent === "NEW_VERSION") {
    const key = input.clientRequestKey?.trim();
    if (!key) return { kind: "idempotency_key_required" };
    const prior = await prisma.reportGenerationRequest.findFirst({
      where: { evidenceId: input.evidenceId, clientRequestKey: key },
      select: { id: true },
    });
    if (!prior && actions.newVersion.action !== NEW_VERSION_ACTION) {
      return { kind: "declined", outcome: "NOT_RECOVERABLE", reason: actions.newVersion.reason, loaded };
    }
    return fromRequested(
      "NEW_VERSION",
      await requestReportGeneration({
        ...base,
        forceRegenerate: true,
        intent: "NEW_VERSION",
        clientRequestKey: key,
      }),
    );
  }

  // ---- Operator supersession of an exhausted technical failure -----------
  if (input.operatorSupersede) {
    const escalated = (d: { reason: OutputActionUnavailableReason | null }) =>
      d.reason === "ESCALATED_TO_OPERATOR";
    if (escalated(actions.verificationPackage) && latestVersion != null) {
      return fromRequested(
        "PACKAGE_RECOVERY",
        await requestReportGeneration({
          ...base,
          artifactType: "VERIFICATION_PACKAGE",
          reportVersion: latestVersion,
          forceRegenerate: false,
          intent: "RECOVER",
          supersedeTechnicalTerminal: true,
        }),
      );
    }
    if (escalated(actions.report)) {
      const existingReport = latestVersion != null;
      return fromRequested(
        existingReport ? "NEW_VERSION" : "FULL_GENERATION",
        await requestReportGeneration({
          ...base,
          forceRegenerate: existingReport,
          intent: existingReport ? "NEW_VERSION" : "GENERATE",
          supersedeTechnicalTerminal: true,
        }),
      );
    }
    return {
      kind: "declined",
      outcome: "NOT_RECOVERABLE",
      reason: actions.verificationPackage.reason ?? actions.report.reason,
      loaded,
    };
  }

  // ---- Recovery of what is missing or failed -----------------------------
  const pkg = actions.verificationPackage;
  const rep = actions.report;
  const chosen =
    input.intent === "RETRY" && rep.action === "RETRY"
      ? ({ output: "report", decision: rep } as const)
      : pkg.action !== "NONE"
        ? ({ output: "package", decision: pkg } as const)
        : rep.action !== "NONE"
          ? ({ output: "report", decision: rep } as const)
          : null;

  if (!chosen) {
    if (rep.reason === "IN_PROGRESS" || pkg.reason === "IN_PROGRESS") {
      return {
        kind: "accepted",
        requestId: loaded.packageRequest?.id ?? null,
        operation: pkg.reason === "IN_PROGRESS" ? "PACKAGE_RECOVERY" : "FULL_GENERATION",
        outcome: "ALREADY_ACTIVE",
        enqueued: false,
        loaded,
      };
    }
    const notRequired = rep.reason === "NOT_REQUIRED" && pkg.reason === "NOT_REQUIRED";
    return {
      kind: "declined",
      outcome: notRequired ? "NOTHING_TO_RECOVER" : "NOT_RECOVERABLE",
      reason: notRequired
        ? "NOT_REQUIRED"
        : ([pkg.reason, rep.reason].find((r) => r && r !== "NOT_REQUIRED" && r !== "FOLLOWS_REPORT") ??
          rep.reason ??
          pkg.reason),
      loaded,
    };
  }

  const retryRow =
    chosen.output === "report" ? loaded.reportRequest : loaded.packageRequest;
  if (chosen.decision.action === "RETRY" && retryRow?.state === "FAILED_RETRYABLE") {
    const retried = await reenqueueReportGenerationRequest(retryRow.id);
    return {
      kind: "accepted",
      requestId: retryRow.id,
      operation: chosen.decision.operation ?? "RETRY_REQUEST",
      outcome: retried.outcome,
      enqueued: retried.enqueued,
      loaded,
    };
  }

  if (chosen.output === "package") {
    return fromRequested(
      "PACKAGE_RECOVERY",
      await requestReportGeneration({
        ...base,
        artifactType: "VERIFICATION_PACKAGE",
        reportVersion: latestVersion,
        forceRegenerate: false,
        intent: input.intent ?? "RECOVER",
      }),
    );
  }
  return fromRequested(
    "FULL_GENERATION",
    await requestReportGeneration({
      ...base,
      artifactType: "REPORT",
      forceRegenerate: false,
      intent: input.intent ?? "GENERATE",
    }),
  );
}

/**
 * Lightweight pairing facts for DISPLAY-only surfaces (case boards) that do
 * not offer actions: is there a report, and is its package the one paired
 * with the LATEST report? Two queries for any number of records.
 */
export async function loadOutputPairing(
  evidenceIds: readonly string[],
): Promise<Map<string, { reportVersion: number | null; packagePaired: boolean; anyPackage: boolean }>> {
  const ids = [...new Set(evidenceIds)];
  const out = new Map<string, { reportVersion: number | null; packagePaired: boolean; anyPackage: boolean }>();
  if (ids.length === 0) return out;
  const [reports, packages] = await Promise.all([
    prisma.report.findMany({
      where: { evidenceId: { in: ids } },
      orderBy: [{ evidenceId: "asc" }, { version: "desc" }],
      distinct: ["evidenceId"],
      select: { evidenceId: true, version: true },
    }),
    prisma.verificationPackage.findMany({
      where: { evidenceId: { in: ids } },
      select: { evidenceId: true, version: true },
    }),
  ]);
  const latest = new Map(reports.map((r) => [r.evidenceId, r.version]));
  const versions = new Map<string, Set<number>>();
  for (const p of packages) {
    const set = versions.get(p.evidenceId) ?? new Set<number>();
    set.add(p.version);
    versions.set(p.evidenceId, set);
  }
  for (const id of ids) {
    const v = latest.get(id) ?? null;
    const set = versions.get(id);
    out.set(id, {
      reportVersion: v,
      packagePaired: v != null ? Boolean(set?.has(v)) : Boolean(set && set.size > 0),
      anyPackage: Boolean(set && set.size > 0),
    });
  }
  return out;
}
