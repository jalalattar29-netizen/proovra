/**
 * WHERE A BOUNDED REVIEW SWEEP RESUMES (WORKFLOW-012).
 *
 * A sweep that reads the first N rows by id reads the same N every tick, so row
 * N+1 is never reached and nothing reports it. These sweeps use the worker's
 * `worker_sweep_cursors` table as the trash-grace reconciler does: a keyset on
 * id that advances each tick and wraps when a page comes back short.
 */
import type { PrismaClient } from "@prisma/client";

export async function readSweepCursor(client: PrismaClient, key: string): Promise<string | null> {
  const row = await client.workerSweepCursor.findUnique({ where: { key }, select: { cursorId: true } });
  return row?.cursorId ?? null;
}

/** Records the page just read. A short page means the sweep reached the end. */
export async function advanceSweepCursor(
  client: PrismaClient,
  key: string,
  previous: string | null,
  page: { lastId: string | null; pageSize: number; limit: number },
): Promise<{ wrapped: boolean; cursorId: string | null }> {
  const wrapped = page.pageSize < page.limit;
  const cursorId = wrapped ? null : page.lastId;
  if (cursorId !== previous) {
    await client.workerSweepCursor.upsert({
      where: { key },
      create: { key, cursorId },
      update: { cursorId },
    });
  }
  return { wrapped, cursorId };
}

/** Id-ordered keyset for a Prisma findMany: `where` narrows, this resumes. */
export function afterCursor(cursorId: string | null): { id?: { gt: string } } {
  return cursorId ? { id: { gt: cursorId } } : {};
}
