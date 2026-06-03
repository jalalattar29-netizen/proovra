/**
 * Phase 16 — Operator-facing semantic embedding backfill.
 *
 * Usage:
 *   pnpm --filter @proovra/api exec tsx scripts/backfill-semantic-embeddings.ts \
 *     --teamId=<workspace-uuid> [--batchSize=50] [--maxBatches=10] [--dryRun] \
 *     [--cursor=<chunk-uuid>] [--repeat=3]
 *
 * Hard rules:
 *   - --teamId is REQUIRED. The driver refuses to scan across workspaces.
 *   - --dryRun simulates the selection + budget check but does NOT call
 *     the provider and does NOT write any vector. Use this to size a
 *     workspace before flipping SEMANTIC_EMBEDDINGS_PROVIDER=openai.
 *   - --repeat lets the operator loop the driver `n` times without
 *     reinvoking; useful when a large workspace exceeds maxBatches
 *     in one pass. The driver uses the `nextCursorChunkId` from each
 *     run to resume.
 *   - The script honours the workspace daily cap + monthly EUR
 *     budget via the same `canEmbedMore` gate the live indexing path
 *     uses; hitting the cap exits cleanly with the bounded reason.
 */
import { prisma } from "../src/db.js";
import { runSemanticBackfill } from "../src/services/search/semantic-backfill.service.js";
function parseArgs() {
    const args = process.argv.slice(2);
    const out = {
        teamId: null,
        dryRun: false,
        repeat: 1,
    };
    for (const a of args) {
        if (a.startsWith("--teamId="))
            out.teamId = a.slice("--teamId=".length).trim();
        else if (a.startsWith("--batchSize=")) {
            const n = Number.parseInt(a.slice("--batchSize=".length), 10);
            if (Number.isFinite(n))
                out.batchSize = n;
        }
        else if (a.startsWith("--maxBatches=")) {
            const n = Number.parseInt(a.slice("--maxBatches=".length), 10);
            if (Number.isFinite(n))
                out.maxBatches = n;
        }
        else if (a.startsWith("--cursor=")) {
            out.cursor = a.slice("--cursor=".length).trim() || null;
        }
        else if (a === "--dryRun" || a === "--dry-run") {
            out.dryRun = true;
        }
        else if (a.startsWith("--repeat=")) {
            const n = Number.parseInt(a.slice("--repeat=".length), 10);
            if (Number.isFinite(n) && n >= 1)
                out.repeat = Math.min(n, 1000);
        }
    }
    return out;
}
async function main() {
    const args = parseArgs();
    if (!args.teamId) {
        // eslint-disable-next-line no-console
        console.error("backfill-semantic-embeddings: --teamId=<workspace-uuid> is required");
        process.exitCode = 2;
        return;
    }
    let cursor = args.cursor ?? null;
    for (let i = 0; i < args.repeat; i += 1) {
        const result = await runSemanticBackfill({
            workspaceId: args.teamId,
            batchSize: args.batchSize,
            maxBatches: args.maxBatches,
            cursorChunkId: cursor,
            dryRun: args.dryRun,
        }, prisma);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
            kind: "semantic.backfill.tick",
            tick: i + 1,
            of: args.repeat,
            teamId: args.teamId,
            ...result,
        }));
        if (result.skippedReason && result.skippedReason !== "DRY_RUN_COMPLETED") {
            break;
        }
        if (result.processed === 0)
            break;
        cursor = result.nextCursorChunkId ?? cursor;
    }
}
main()
    .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
        kind: "semantic.backfill.fatal",
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    }));
    process.exitCode = 1;
})
    .finally(async () => {
    try {
        await prisma.$disconnect();
    }
    catch {
        /* best-effort */
    }
});
