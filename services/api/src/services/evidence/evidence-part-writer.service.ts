/**
 * THE canonical EvidencePart writer (evidence-lifecycle remediation, ET-UPL-01,
 * ET-INT-05, ET-UPL-02).
 *
 * Invariant A — original-byte immutability: once signing has begun, no path may
 * add, replace, remove or reorder original evidence bytes. Before this module
 * there were three `evidencePart.create` call sites with three different guard
 * sets; the resumable-upload bridge had none, so a same-team member could append
 * a part to another member's SIGNED record (the next report run then declared
 * it tampered). Every EvidencePart insert now goes through `writeEvidencePart`,
 * and every place that authorises FUTURE bytes for a record (an upload session,
 * a presigned part URL) asks `assertEvidenceAcceptsByteWrites` first.
 *
 * Serialisation: both functions take `pg_advisory_xact_lock(hashtext(evidenceId))`
 * — the same key the finalize transaction (evidence-complete.service.ts) holds
 * while it hashes, signs and claims SIGNED. A write therefore either commits
 * before finalize reads the parts (and is hashed and signed with them) or waits
 * and then observes SIGNED and is refused. There is no third outcome.
 *
 * Anti-enumeration: a record the principal may not write answers exactly like a
 * record that does not exist (404). A record the principal owns but that no
 * longer accepts bytes answers 409 EVIDENCE_NOT_WRITABLE.
 *
 * A repository guard (test/evidence-part-writer-authority.test.ts) asserts this
 * is the only production file that calls `evidencePart.create`.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

type Tx = Prisma.TransactionClient;
type AnyClient = PrismaClient | Tx;

/**
 * ET-ACQ-07 — THE upper bound on a record's parts: indexes 0..MAX-1. Indexes
 * are unique per record, so bounding the index bounds the count. The owner
 * parts route and direct capture both use it (the owner route had no bound:
 * any number of part rows and presigned URLs).
 *
 * UC-STR-001 — the value now lives in `@proovra/shared` (capture-limits.ts),
 * the ONE source the continuity manifest, the mobile client and (by value) the
 * native recorders also read, so a continuous session can never be allowed more
 * segments than its record can hold. Re-exported here for the part routes.
 */
export { MAX_EVIDENCE_PARTS } from "@proovra/shared";

/** Who is asking to add bytes to the record. */

export type EvidencePartWritePrincipal =
  /** The record's owner (web capture, mobile, extension, resumable upload). */
  | { kind: "OWNER"; userId: string }
  /**
   * An external-intake session. The contributor is not a User; the record's
   * owner of record is the link creator, and the caller has already proven the
   * session is bound to this record.
   */
  | { kind: "INTAKE_SESSION"; linkCreatorUserId: string; sessionId: string };

export type EvidencePartWriteRefusalCode =
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_NOT_WRITABLE"
  | "PART_INDEX_TAKEN"
  // ET-INT-09 — the caller's per-record part cap, checked under the record lock.
  | "PART_COUNT_EXCEEDED";

export class EvidencePartWriteRefused extends Error {
  readonly statusCode: number;
  readonly code: EvidencePartWriteRefusalCode;
  constructor(code: EvidencePartWriteRefusalCode) {
    super(
      code === "EVIDENCE_NOT_FOUND"
        ? "Evidence not found"
        : code === "PART_INDEX_TAKEN"
          ? "This part index is already in use"
          : code === "PART_COUNT_EXCEEDED"
            ? "This record has reached its file limit"
            : "This evidence record no longer accepts new files",
    );
    this.name = "EvidencePartWriteRefused";
    this.code = code;
    this.statusCode = code === "EVIDENCE_NOT_FOUND" ? 404 : 409;
  }
}

/** The statuses in which original bytes may still be added. */
const WRITABLE_STATUSES = new Set<string>([prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING]);

const isTx = (c: AnyClient): c is Tx => !("$transaction" in c) || typeof (c as PrismaClient).$transaction !== "function";

async function inTx<T>(client: AnyClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return isTx(client) ? fn(client) : (client as PrismaClient).$transaction(fn);
}

/**
 * Lock the record and prove it accepts new original bytes from `principal`.
 * MUST be called inside a transaction (it takes a transaction-scoped lock).
 */
export async function lockEvidenceForByteWrite(
  tx: Tx,
  evidenceId: string,
  principal: EvidencePartWritePrincipal,
): Promise<{ id: string; teamId: string | null; ownerUserId: string }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${evidenceId}))`;
  const ev = await tx.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, teamId: true, ownerUserId: true, status: true, deletedAt: true, lockedAt: true, lifecycleState: true },
  });
  if (!ev || ev.deletedAt) throw new EvidencePartWriteRefused("EVIDENCE_NOT_FOUND");
  const principalUserId = principal.kind === "OWNER" ? principal.userId : principal.linkCreatorUserId;
  // Anti-enumeration: a record the principal does not own is "not found".
  if (ev.ownerUserId !== principalUserId) throw new EvidencePartWriteRefused("EVIDENCE_NOT_FOUND");
  const lifecycle = (ev as { lifecycleState?: string | null }).lifecycleState ?? "ACTIVE";
  if (!WRITABLE_STATUSES.has(ev.status) || ev.lockedAt || lifecycle !== "ACTIVE") {
    throw new EvidencePartWriteRefused("EVIDENCE_NOT_WRITABLE");
  }
  return { id: ev.id, teamId: ev.teamId, ownerUserId: ev.ownerUserId };
}

/**
 * Prove the record still accepts bytes without writing anything (used before
 * issuing an upload session or a presigned PUT for a part).
 */
export async function assertEvidenceAcceptsByteWrites(
  client: AnyClient,
  evidenceId: string,
  principal: EvidencePartWritePrincipal,
): Promise<void> {
  await inTx(client, (tx) => lockEvidenceForByteWrite(tx, evidenceId, principal));
}

export type EvidencePartWriteInput = {
  evidenceId: string;
  principal: EvidencePartWritePrincipal;
  partIndex: number;
  data: Omit<Prisma.EvidencePartUncheckedCreateInput, "evidenceId" | "partIndex">;
  /**
   * What to do when the index is already occupied. "RETURN_EXISTING" keeps the
   * idempotent semantics the authenticated parts route has always had (a
   * repeated presign for the same index returns the same row); "REFUSE" is the
   * external-intake contract (PART_INDEX_TAKEN).
   */
  onExistingIndex: "RETURN_EXISTING" | "REFUSE";
  /**
   * ET-INT-09 — refuse a NEW part once the record holds this many. Counted
   * under the record lock, so two concurrent uploads cannot both slip under it
   * (the external-intake route counted before inserting, outside any lock).
   */
  maxPartCount?: number | null;
};

export type EvidencePartWriteResult = {
  part: prismaPkg.EvidencePart;
  created: boolean;
  evidence: { id: string; teamId: string | null; ownerUserId: string };
};

/** THE only EvidencePart insert in production code. */
export async function writeEvidencePart(
  input: EvidencePartWriteInput,
  client: AnyClient = defaultPrisma,
): Promise<EvidencePartWriteResult> {
  return inTx(client, async (tx) => {
    const evidence = await lockEvidenceForByteWrite(tx, input.evidenceId, input.principal);
    const existing = await tx.evidencePart.findFirst({ where: { evidenceId: input.evidenceId, partIndex: input.partIndex } });
    if (existing) {
      if (input.onExistingIndex === "REFUSE") throw new EvidencePartWriteRefused("PART_INDEX_TAKEN");
      return { part: existing, created: false, evidence };
    }
    if (typeof input.maxPartCount === "number" && input.maxPartCount > 0) {
      const held = await tx.evidencePart.count({ where: { evidenceId: input.evidenceId } });
      if (held >= input.maxPartCount) throw new EvidencePartWriteRefused("PART_COUNT_EXCEEDED");
    }
    const part = await tx.evidencePart.create({
      data: { ...input.data, evidenceId: input.evidenceId, partIndex: input.partIndex },
    });
    return { part, created: true, evidence };
  });
}
