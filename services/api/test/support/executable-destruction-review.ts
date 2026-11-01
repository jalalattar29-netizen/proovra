/**
 * FIXTURE: a destruction review that two people decided and a person asked to
 * execute, written directly.
 *
 * The executor reads its approval from the governance store (GOV-001), so a suite
 * proving what the executor does to storage needs a real row rather than a
 * boolean. How that row is earned through the routes is proven by
 * gov-002-gov-003-destruction-review.integration.test.ts.
 */
import type { PrismaClient } from "@prisma/client";

export async function seedExecutableReview(
  prisma: PrismaClient,
  evidenceId: string,
): Promise<string> {
  const record = await prisma.evidence.findUniqueOrThrow({
    where: { id: evidenceId },
    select: { teamId: true, ownerUserId: true },
  });
  if (!record.teamId) throw new Error("a Personal record needs no destruction review");
  // A sweep may already have opened the record's one active review.
  const open = await prisma.destructionReview.findFirst({
    where: { evidenceId, status: { in: ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"] } },
    select: { id: true },
  });
  if (open) {
    await prisma.destructionReview.update({
      where: { id: open.id },
      data: {
        status: "APPROVED",
        decidedByUserId: record.ownerUserId,
        decidedAtUtc: new Date(),
        executionRequestedAtUtc: new Date(),
        executionRequestedByUserId: record.ownerUserId,
      },
    });
    return open.id;
  }
  const review = await prisma.destructionReview.create({
    data: {
      teamId: record.teamId,
      evidenceId,
      status: "APPROVED",
      reason: "manual_review",
      decidedByUserId: record.ownerUserId,
      decidedAtUtc: new Date(),
      executionRequestedAtUtc: new Date(),
      executionRequestedByUserId: record.ownerUserId,
    },
    select: { id: true },
  });
  return review.id;
}
