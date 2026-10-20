/**
 * AUD-43 (2026-10-20) — a record's sealed identity columns are set once
 * (trigger evidence_sealed_identity_set_once). A test that simulates a TAMPERED
 * or LEGACY row writes outside every application path: the triggers are
 * bypassed for that one transaction only (session_replication_role = replica),
 * exactly as an attacker with direct database access would have to.
 */
type Tx = {
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
  evidence: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> };
};
type TxClient = { $transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

export async function tamperSealedEvidence(prisma: unknown, id: string, data: Record<string, unknown>): Promise<void> {
  await (prisma as TxClient).$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.evidence.update({ where: { id }, data });
  });
}
