/**
 * THE DEAD-LETTER READER — one classification of a sink's retained entries for
 * the worker's queue-health sample and the API's Operations inventory
 * (2026-10-13). See `@proovra/shared` dead-letter.ts for the contract.
 *
 * Bounded: one page of entries (newest first), two indexed queries. An entry
 * that names a record is RESOLVED when that record produced its output after
 * the entry (a SUCCEEDED request), otherwise it takes the lifecycle state of
 * the record's newest report/package incident seen at or after it; an entry
 * that names no record (a media-intelligence run) is UNRESOLVED until its
 * incident says otherwise — it is never silently dropped.
 */
import type { PrismaClient } from "@prisma/client";
import {
  deadLetterResolutionFromIncident,
  summarizeDeadLetterEntries,
  type DeadLetterResolution,
  type DeadLetterSummary,
} from "@proovra/shared";

/** The slice of a BullMQ queue this reader needs. */
export type DeadLetterQueueLike = {
  getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
  getJobs: (types: string[], start?: number, end?: number, asc?: boolean) => Promise<
    Array<{ id?: string | null; timestamp?: number; data?: unknown } | undefined>
  >;
};

export const DEAD_LETTER_PAGE = 500;
/** An incident seen this long before the entry was still about it (clock skew between writers). */
const INCIDENT_SKEW_MS = 10 * 60 * 1000;

export async function readDeadLetterSummary(
  prisma: PrismaClient,
  queue: DeadLetterQueueLike,
  nowMs: number = Date.now(),
): Promise<DeadLetterSummary> {
  const counts = await queue.getJobCounts("waiting", "delayed", "paused", "failed");
  const retained = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  const jobs = (await queue.getJobs(["waiting", "delayed", "paused", "failed"], 0, DEAD_LETTER_PAGE - 1, false)).filter(
    (j): j is NonNullable<typeof j> => Boolean(j),
  );
  const entries = jobs.map((j) => {
    const data = (j.data ?? {}) as { evidenceId?: unknown };
    return {
      addedAtMs: typeof j.timestamp === "number" && Number.isFinite(j.timestamp) ? j.timestamp : nowMs,
      evidenceId: typeof data.evidenceId === "string" && data.evidenceId.length === 36 ? data.evidenceId : null,
    };
  });
  const evidenceIds = [...new Set(entries.map((e) => e.evidenceId).filter((x): x is string => x !== null))];
  const oldest = entries.reduce((m, e) => Math.min(m, e.addedAtMs), nowMs);

  const [succeeded, incidents] = evidenceIds.length
    ? await Promise.all([
        prisma.reportGenerationRequest.findMany({
          where: { evidenceId: { in: evidenceIds }, state: "SUCCEEDED", completedAtUtc: { gte: new Date(oldest) } },
          select: { evidenceId: true, completedAtUtc: true },
        }),
        prisma.operationalIncident.findMany({
          where: {
            relatedEvidenceId: { in: evidenceIds },
            category: { in: ["REPORT", "PACKAGE"] },
            lastSeenAtUtc: { gte: new Date(oldest - INCIDENT_SKEW_MS) },
          },
          select: { relatedEvidenceId: true, status: true, lastSeenAtUtc: true },
          orderBy: { lastSeenAtUtc: "desc" },
        }),
      ])
    : [[], []];

  const resolutionOf = (e: (typeof entries)[number]): DeadLetterResolution => {
    if (!e.evidenceId) return "UNRESOLVED";
    const recovered = succeeded.some(
      (r) => r.evidenceId === e.evidenceId && r.completedAtUtc !== null && r.completedAtUtc.getTime() >= e.addedAtMs,
    );
    if (recovered) return "RESOLVED";
    const incident = incidents.find(
      (i) => i.relatedEvidenceId === e.evidenceId && i.lastSeenAtUtc.getTime() >= e.addedAtMs - INCIDENT_SKEW_MS,
    );
    return deadLetterResolutionFromIncident(incident?.status ?? null);
  };

  return summarizeDeadLetterEntries(
    entries.map((e) => ({ addedAtMs: e.addedAtMs, resolution: resolutionOf(e) })),
    { nowMs, retained },
  );
}
