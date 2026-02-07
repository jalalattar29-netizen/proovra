import "./env.js";
import { prisma } from "./db.js";

async function run() {
  const now = new Date();
  const expired = await prisma.evidence.findMany({
    where: {
      deletedAt: null,
      retentionUntilUtc: { lte: now }
    },
    select: { id: true }
  });

  if (expired.length === 0) {
    console.log("No expired evidence found.");
    return;
  }

  for (const ev of expired) {
    const last = await prisma.custodyEvent.findFirst({
      where: { evidenceId: ev.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const nextSeq = (last?.sequence ?? 0) + 1;
    await prisma.$transaction([
      prisma.evidence.update({
        where: { id: ev.id },
        data: { deletedAt: now, deletedAtUtc: now }
      }),
      prisma.custodyEvent.create({
        data: {
          evidenceId: ev.id,
          eventType: "EVIDENCE_DELETED",
          atUtc: now,
          sequence: nextSeq,
          payload: { reason: "RETENTION_EXPIRED" }
        }
      })
    ]);
  }

  console.log(`Retention cleanup complete. Deleted ${expired.length} evidence.`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
