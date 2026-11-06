/**
 * PRO-078 (UI-07) — a refused upload gives its record slot back at once.
 *
 * On FREE, POST /v1/evidence reserves one of the three lifetime record slots
 * and the first file is then offered to POST /v1/evidence/:id/parts. When
 * that file was refused (415 FILE_VALIDATION_BLOCKED: an executable, a
 * double extension, a dangerous declared type), the empty record stayed
 * reserved: invisible in the library, counted by the meter and the admission
 * gate for 24 hours, until the reservation sweep released it. Two refused
 * .exe files on a FREE account at 1 of 3 turned the next valid PDF into
 * FREE_LIMIT_REACHED.
 *
 * The release goes through the reservation authority
 * (`releaseEvidenceReservationTx`, reason UPLOAD_REFUSED), so it is the same
 * soft delete plus EVIDENCE_DELETED custody event a discarded draft gets, under
 * the evidence lock, and only while the record is unsealed AND still empty: no
 * part, no single-object upload, no live session. A refused second file never
 * discards the record its first file is in.
 */
import { releaseEvidenceReservationTx } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../db.js";

export async function releaseRefusedUploadReservation(
  input: { evidenceId: string; now?: Date },
  client: typeof defaultPrisma = defaultPrisma,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return client.$transaction((tx) =>
    releaseEvidenceReservationTx(tx as never, { evidenceId: input.evidenceId, reason: "UPLOAD_REFUSED", now }),
  );
}
