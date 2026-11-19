/**
 * RG-04 / RG-05 — inventory (and, only on a LOCAL database, repair) of state
 * the fixed code no longer produces but older code left behind.
 *
 * DRY-RUN BY DEFAULT. Nothing is written unless --apply is passed, and
 * --apply is refused unless DATABASE_URL points at a loopback host. This
 * script is never to be executed against production in this remediation;
 * production use needs an owner decision (see the WS-AI handoff).
 *
 * Usage:
 *   pnpm --filter proovra-api exec tsx scripts/rg05-ai-repair-dry-run.ts \
 *     [--section=semantic|ledger|entities|all] [--teamId=<uuid>] [--apply]
 *
 * Sections:
 *   semantic  PRO-AI1C-01 / PRO-AI1-01: evidence_semantic_chunks rows (and
 *             how many carry a vector) in workspaces the semantic-egress gate
 *             now refuses. --apply deletes those derived chunk rows (they are
 *             re-derived from extracted text if the workspace later allows),
 *             but only where the refusal is the workspace's own (policy or
 *             plan) — never for an unreadable policy or a deployment that
 *             has no provider configured.
 *   ledger    PRO-AI1-06: ai_usage_events stuck in "reserved" for more than
 *             one hour (the refused-criteria leak). --apply releases each
 *             through the canonical ledger store (status failed + rollups
 *             given back), idempotently.
 *   entities  PRO-AI1-09: duplicate media_intelligence_entities rows (same
 *             record, kind and value hash). --apply keeps the oldest row of
 *             each group and deletes the rest.
 *
 * Output: one JSON object with counts per section and the affected ids
 * (bounded to 200 per section). Idempotent: a second --apply finds nothing.
 */
import { prisma } from "../src/db.js";
import { evaluateSemanticEgress } from "../src/services/ai/workspace-ai-policy.service.js";
import { buildPrismaLedgerStore } from "../src/services/ai/ai-usage-ledger.service.js";

type Section = "semantic" | "ledger" | "entities" | "all";

function args() {
  const out: { section: Section; teamId: string | null; apply: boolean } = {
    section: "all",
    teamId: null,
    apply: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--section=")) out.section = a.slice(10) as Section;
    else if (a.startsWith("--teamId=")) out.teamId = a.slice(9).trim() || null;
    else if (a === "--apply") out.apply = true;
  }
  return out;
}

function databaseIsLoopback(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

async function semantic(teamId: string | null, apply: boolean) {
  const teams = await prisma.$queryRaw<Array<{ team_id: string; chunks: bigint; embedded: bigint }>>`
    SELECT team_id::text AS team_id,
           count(*)::bigint AS chunks,
           count(embedding_vector)::bigint + count(embedding)::bigint AS embedded
      FROM evidence_semantic_chunks
     GROUP BY team_id`;
  const denied: Array<{ teamId: string; chunks: number; embedded: number; decision: string; workspaceRefusal: boolean }> = [];
  for (const t of teams) {
    if (teamId && t.team_id !== teamId) continue;
    const egress = await evaluateSemanticEgress({ teamId: t.team_id, dataClass: "DERIVED_CONTENT" });
    if (egress.allowed) continue;
    // Only a refusal that belongs to THIS workspace (its policy, its plan) makes
    // the rows removable. An unreadable policy or a deployment without a
    // provider says nothing about the workspace: reported, never deleted.
    const workspaceRefusal =
      !egress.unavailable && egress.decision !== "GLOBAL_DISABLED" && egress.decision !== "PROVIDER_NOT_CONFIGURED";
    denied.push({
      teamId: t.team_id,
      chunks: Number(t.chunks),
      embedded: Number(t.embedded),
      decision: egress.unavailable ? "POLICY_UNREADABLE" : egress.decision,
      workspaceRefusal,
    });
  }
  let deleted = 0;
  if (apply) {
    for (const d of denied) {
      if (!d.workspaceRefusal) continue;
      const r = await prisma.evidenceSemanticChunk.deleteMany({ where: { teamId: d.teamId } });
      deleted += r.count;
    }
  }
  return { workspacesDenied: denied.length, chunksInDeniedWorkspaces: denied.reduce((a, d) => a + d.chunks, 0), deleted, workspaces: denied.slice(0, 200) };
}

async function ledger(teamId: string | null, apply: boolean) {
  const stuck = await prisma.aiUsageEvent.findMany({
    where: {
      status: "reserved",
      reservedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
      ...(teamId ? { workspaceId: teamId } : {}),
    },
    select: { id: true, workspaceId: true, feature: true },
    take: 5000,
  });
  let released = 0;
  if (apply) {
    const store = buildPrismaLedgerStore();
    for (const e of stuck) {
      await store.markFailed(e.id);
      released += 1;
    }
  }
  return { stuckReserved: stuck.length, released, ids: stuck.slice(0, 200).map((e) => e.id) };
}

async function entities(teamId: string | null, apply: boolean) {
  const groups = await prisma.$queryRaw<Array<{ keep_id: string; drop_ids: string[] }>>`
    SELECT (array_agg(id ORDER BY created_at ASC, id ASC))[1]::text AS keep_id,
           (array_agg(id::text ORDER BY created_at ASC, id ASC))[2:] AS drop_ids
      FROM media_intelligence_entities
     WHERE (${teamId}::uuid IS NULL OR team_id = ${teamId}::uuid)
     GROUP BY record_id, kind, value_hash
    HAVING count(*) > 1`;
  const dropIds = groups.flatMap((g) => g.drop_ids);
  let deleted = 0;
  if (apply && dropIds.length > 0) {
    const r = await prisma.mediaIntelligenceEntity.deleteMany({ where: { id: { in: dropIds } } });
    deleted = r.count;
  }
  return { duplicateGroups: groups.length, duplicateRows: dropIds.length, deleted, sampleIds: dropIds.slice(0, 200) };
}

async function main() {
  const a = args();
  if (a.apply && !databaseIsLoopback()) {
    console.error("rg05-ai-repair: --apply is refused unless DATABASE_URL is a loopback database.");
    process.exit(2);
  }
  const out: Record<string, unknown> = { mode: a.apply ? "APPLY_LOCAL" : "DRY_RUN", teamId: a.teamId };
  if (a.section === "semantic" || a.section === "all") out.semantic = await semantic(a.teamId, a.apply);
  if (a.section === "ledger" || a.section === "all") out.ledger = await ledger(a.teamId, a.apply);
  if (a.section === "entities" || a.section === "all") out.entities = await entities(a.teamId, a.apply);
  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
