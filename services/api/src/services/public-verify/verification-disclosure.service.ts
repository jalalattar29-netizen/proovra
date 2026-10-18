/**
 * THE VERIFICATION DISCLOSURE AUTHORITY (2026-10-18) — the ONLY writer of a
 * record's disclosure policy (evidence.verification_disclosure_mode,
 * evidence.show_recorded_location).
 *
 *   - authorized by the route (evidence.publish_verify) — never here;
 *   - CONCURRENCY: a compare-and-swap on verification_disclosure_version under
 *     the record's advisory lock; a stale version is a conflict, never a lost
 *     update;
 *   - IDEMPOTENT: asking for the policy the record already has changes
 *     nothing, writes nothing and appends nothing;
 *   - AUDITED: every change appends a VERIFICATION_DISCLOSURE_CHANGED custody
 *     event in the same transaction (administrative, never forensic) and the
 *     route emits a tenant audit row;
 *   - it never touches ACCESS: a withdrawn, suspended or retained page stays
 *     so (verification_access_state and the lifecycle are not written), and a
 *     destroyed record's policy cannot be changed at all.
 */
import {
  parseVerificationDisclosurePolicy,
  type VerificationDisclosureMode,
  type VerificationDisclosurePolicy,
} from "@proovra/shared";

import { prisma } from "../../db.js";
import { appendCustodyEventTx } from "../custody-events.service.js";

export type DisclosureChangeResult =
  | { outcome: "NOT_FOUND" }
  | { outcome: "RECORD_NOT_CHANGEABLE" }
  | { outcome: "CONFLICT"; current: VerificationDisclosurePolicy & { version: number } }
  | {
      outcome: "UNCHANGED" | "CHANGED";
      teamId: string | null;
      previous: VerificationDisclosurePolicy;
      current: VerificationDisclosurePolicy & { version: number };
    };

export class DisclosurePolicyInvalid extends Error {
  readonly code = "DISCLOSURE_LOCATION_REQUIRES_CONTENT_PREVIEW";
  constructor() {
    super("Recorded location can be shown only with content preview.");
  }
}

/** Does moving from `a` to `b` disclose MORE (and so need a fresh step-up)? */
export function disclosureWidens(a: VerificationDisclosurePolicy, b: VerificationDisclosurePolicy): boolean {
  return (a.mode === "VERIFICATION_ONLY" && b.mode === "CONTENT_PREVIEW") || (!a.showRecordedLocation && b.showRecordedLocation);
}

export async function readVerificationDisclosure(
  evidenceId: string,
): Promise<(VerificationDisclosurePolicy & { version: number; changedAtUtc: Date | null }) | null> {
  const row = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      verificationDisclosureMode: true,
      showRecordedLocation: true,
      verificationDisclosureVersion: true,
      verificationDisclosureChangedAtUtc: true,
    },
  });
  if (!row) return null;
  return {
    ...parseVerificationDisclosurePolicy(row),
    version: row.verificationDisclosureVersion,
    changedAtUtc: row.verificationDisclosureChangedAtUtc ?? null,
  };
}

export async function changeVerificationDisclosure(input: {
  evidenceId: string;
  actorUserId: string;
  mode: VerificationDisclosureMode;
  showRecordedLocation: boolean;
  /** The version the caller saw; a stale one is a CONFLICT. */
  expectedVersion: number;
  ip?: string | null;
}): Promise<DisclosureChangeResult> {
  if (input.showRecordedLocation && input.mode !== "CONTENT_PREVIEW") throw new DisclosurePolicyInvalid();
  const requested: VerificationDisclosurePolicy = { mode: input.mode, showRecordedLocation: input.showRecordedLocation };

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.evidenceId}))`;
    const row = await tx.evidence.findUnique({
      where: { id: input.evidenceId },
      select: {
        teamId: true,
        lifecycleState: true,
        destroyedAtUtc: true,
        verificationDisclosureMode: true,
        showRecordedLocation: true,
        verificationDisclosureVersion: true,
      },
    });
    if (!row) return { outcome: "NOT_FOUND" } as const;
    if (row.destroyedAtUtc || row.lifecycleState === "DESTROYED" || row.lifecycleState === "PENDING_DESTRUCTION") {
      return { outcome: "RECORD_NOT_CHANGEABLE" } as const;
    }
    const previous = parseVerificationDisclosurePolicy(row);
    const current = { ...previous, version: row.verificationDisclosureVersion };
    const same = previous.mode === requested.mode && previous.showRecordedLocation === requested.showRecordedLocation;
    // Idempotent: the policy is already what was asked (a retried click, or a
    // second tab that made the same choice) — whatever version the caller saw.
    if (same) return { outcome: "UNCHANGED", teamId: row.teamId, previous, current } as const;
    if (row.verificationDisclosureVersion !== input.expectedVersion) return { outcome: "CONFLICT", current } as const;

    const now = new Date();
    const swapped = await tx.evidence.updateMany({
      where: { id: input.evidenceId, verificationDisclosureVersion: input.expectedVersion },
      data: {
        verificationDisclosureMode: requested.mode,
        showRecordedLocation: requested.showRecordedLocation,
        verificationDisclosureVersion: input.expectedVersion + 1,
        verificationDisclosureChangedAtUtc: now,
        verificationDisclosureChangedByUserId: input.actorUserId,
      },
    });
    if (swapped.count !== 1) return { outcome: "CONFLICT", current } as const;
    await appendCustodyEventTx(tx, {
      evidenceId: input.evidenceId,
      eventType: "VERIFICATION_DISCLOSURE_CHANGED",
      atUtc: now,
      payload: {
        fromMode: previous.mode,
        toMode: requested.mode,
        fromShowRecordedLocation: previous.showRecordedLocation,
        toShowRecordedLocation: requested.showRecordedLocation,
        changedByUserId: input.actorUserId,
      },
      ip: input.ip ?? null,
    });
    return {
      outcome: "CHANGED",
      teamId: row.teamId,
      previous,
      current: { ...requested, version: input.expectedVersion + 1 },
    } as const;
  });
}
