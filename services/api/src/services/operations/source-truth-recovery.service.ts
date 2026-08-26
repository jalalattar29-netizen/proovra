/**
 * AUTO-RESOLVE FROM SOURCE TRUTH — the one sweep for probe-recovered sources.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS FILLS
 * ---------------------------------------------------------------------------
 * A source declared `SOURCE_TRUTH` promises two things: nobody may close its
 * conditions by hand, and the condition closes ITSELF when the source recovers.
 * The first half is enforced at the resolve path. The second half was, until
 * now, implemented once per source: the evidence-integrity service has its own
 * sweep, and the aggregate sources close through re-observation in discovery.
 *
 * Two sources have neither. `storage.immutable_drift` is written by a Worker
 * reconciler that opens conditions and never closed them, and
 * `search.indexing_failure` is new. Without a sweep, promising automatic
 * recovery while offering no Resolve control would produce the worst possible
 * combination — a permanently unclosable row — which is precisely the failure
 * mode the fail-closed rule is accused of and must not actually cause.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS, AND WHAT IT REFUSES TO BE
 * ---------------------------------------------------------------------------
 * It resolves ONLY on positive proof. The probe must say RECOVERED. UNKNOWN
 * leaves the condition exactly as it was, because "we could not check" is not
 * "it is fine" — and that is the whole reason this is a sweep over probes
 * rather than a sweep over absence-from-a-scan.
 *
 * It writes nothing but `OperationalIncident` and its own event and SLA
 * satellites. No evidence row, no proof, no hash, no custody entry, no storage
 * object. The probes it calls are reads.
 *
 * The transition itself is delegated to the SHARED authority
 * (`decideObservationTransition`), so a suppressed-but-recovered condition and
 * an acknowledged-but-recovered one are decided by the same rule the Worker
 * and the API already share, rather than by a third opinion written here.
 */

import * as prismaPkg from "@prisma/client";
import {
  decideObservationTransition,
  lifecycleForSourceId,
  type IncidentTransitionStatus,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { workspaceIncidentWhereWith } from "../observability/incident-scope.js";

import { buildProbeContext, probeSource } from "./operations-source-probes.js";

type PrismaClient = prismaPkg.PrismaClient;

/**
 * A generous ceiling on one sweep.
 *
 * Bounded because an unbounded probe-per-row sweep over an Enterprise
 * workspace is a load generator, and because a sweep that cannot finish is
 * worse than one that finishes a page at a time: rows not reached this run are
 * reached on the next, oldest first, and nothing is lost.
 */
const SWEEP_LIMIT = 200;

export type SourceTruthRecoverySweep = {
  /** How many conditions were examined. */
  readonly examined: number;
  /** How many the source proved recovered, and which therefore resolved. */
  readonly resolved: number;
  /** True when the bound was reached, so this pass did not see everything. */
  readonly truncated: boolean;
};

/**
 * Sweep the OPEN, ACKNOWLEDGED and SUPPRESSED conditions of one source.
 *
 * SUPPRESSED is included deliberately. Domain truth outranks a suppression:
 * a silenced condition whose source has genuinely recovered IS over, and
 * leaving it silenced-but-live would make the next real recurrence read as a
 * continuation of something that ended.
 */
export async function sweepSourceTruthRecoveries(
  input: {
    teamId: string;
    sourceId: string;
    now?: Date;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<SourceTruthRecoverySweep> {
  const lifecycle = lifecycleForSourceId(input.sourceId);
  // A sweep for a source that does not promise probe recovery would be a
  // second, undeclared recovery policy. Refused by returning nothing rather
  // than by throwing: the caller is discovery, and a misconfiguration here
  // must not take a whole workspace's sweep down.
  if (
    !lifecycle ||
    lifecycle.resolutionAuthority !== "SOURCE_TRUTH" ||
    lifecycle.recoveryPolicy !== "PROBE_AUTO_RESOLVE" ||
    lifecycle.activityProbeKey === "NONE"
  ) {
    return { examined: 0, resolved: 0, truncated: false };
  }

  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? SWEEP_LIMIT, SWEEP_LIMIT));

  const open = await client.operationalIncident.findMany({
    where: workspaceIncidentWhereWith(input.teamId, {
      // DECLARED ID OR LEGACY SHAPE.
      //
      // A row written before `source_id` existed carries NULL there, and the
      // migration's backfill claims it by fingerprint prefix. Matching on the
      // id alone would make this sweep silently skip exactly the rows that
      // have been open longest — on a database where the backfill has not run
      // yet, that is every one of them.
      OR: [
        { sourceId: input.sourceId },
        ...lifecycle.legacyFingerprints
          .filter((f) => f.kind === "PREFIX")
          .map((f) => ({
            sourceId: null,
            fingerprint: { startsWith: `${(f as { prefix: string }).prefix}:` },
          })),
      ],
      status: {
        in: [
          prismaPkg.IncidentStatus.OPEN,
          prismaPkg.IncidentStatus.ACKNOWLEDGED,
          prismaPkg.IncidentStatus.SUPPRESSED,
        ],
      },
    }),
    select: { id: true, status: true, fingerprint: true },
    // Oldest first: a condition nobody has cleared for longest is the one an
    // operator most needs closed if it is genuinely over.
    orderBy: [{ firstSeenAtUtc: "asc" }, { id: "asc" }],
    take: limit + 1,
  });
  const truncated = open.length > limit;
  const rows = truncated ? open.slice(0, limit) : open;
  if (rows.length === 0) {
    return { examined: 0, resolved: 0, truncated: false };
  }

  let resolved = 0;
  for (const row of rows) {
    const ctx = await buildProbeContext({
      teamId: input.teamId,
      fingerprint: row.fingerprint,
      client,
      now,
    });
    const observation = await probeSource(lifecycle.activityProbeKey, ctx);
    // ONLY a proven recovery closes anything. ACTIVE leaves it open,
    // UNKNOWN leaves it open, and NOT_APPLICABLE leaves it open too — a
    // subject that vanished is what the source's `notApplicableDisposition`
    // governs at the RESOLVE path, where a person is asking; it is not a
    // licence for a background sweep to close rows nobody looked at.
    if (observation.activity !== "RECOVERED") continue;

    const decision = decideObservationTransition({
      currentStatus: row.status as IncidentTransitionStatus,
      observation: "SOURCE_RECOVERED",
    });
    if (decision !== "AUTO_RESOLVE_SOURCE_RECOVERY") continue;

    await client.operationalIncident.update({
      where: { id: row.id },
      data: {
        status: prismaPkg.IncidentStatus.RESOLVED,
        resolvedAtUtc: now,
        // No human resolver is invented for a domain-truth resolution, and
        // `acknowledgedAtUtc` / `acknowledgedByUserId` are left alone: who
        // took this on is part of what happened to it.
        resolvedByUserId: null,
        resolutionNote: `Resolved from source truth: ${lifecycle.displayLabel} is no longer reported by its source.`,
      },
    });
    await client.operationalIncidentEvent
      .create({
        data: {
          incidentId: row.id,
          eventType: "resolved_by_domain_truth",
          safeMessage:
            "The condition's own source now reports recovery. Resolved from positive domain evidence, not from absence in a scan.",
          metadataJson: {
            sourceId: input.sourceId,
            previousStatus: row.status,
          } as prismaPkg.Prisma.InputJsonValue,
        },
      })
      .catch(() => null);

    await import("./incident-sla-cycle.service.js")
      .then((cycles) =>
        cycles.closeSlaCycle({ incidentId: row.id, reason: "RESOLVED" }, client),
      )
      .catch(() => null);

    resolved += 1;
  }

  return { examined: rows.length, resolved, truncated };
}
