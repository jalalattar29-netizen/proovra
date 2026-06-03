/**
 * Phase 16 — Semantic embedding cost + rate-limit gate.
 *
 * Reuses the new `semantic_usage_daily` table (workspace-day rollup)
 * to enforce two bounded caps BEFORE issuing an outbound embedding
 * call:
 *
 *   1. SEMANTIC_MAX_CHUNKS_PER_WORKSPACE_PER_DAY  (default 5000)
 *      — daily cap on chunks embedded for one workspace. Prevents a
 *        single workspace from monopolising the queue's budget on a
 *        runaway document.
 *   2. SEMANTIC_MONTHLY_BUDGET_EUR                (default 100)
 *      — month-to-date EUR ceiling per workspace. Sums the last 31
 *        days of `eur_spent_micros` for the workspace.
 *
 * Cost model (Phase 16 — defaults targeting text-embedding-3-small):
 *
 *   USD per token   = SEMANTIC_USD_PER_TOKEN          (default 0.00000002)
 *   EUR / USD       = SEMANTIC_EUR_PER_USD            (default 0.92)
 *   token estimate  = chars / 4 (pessimistic)
 *
 * Hard rules satisfied:
 *   - NEVER logs raw chunk text or embedding bytes. Only counts +
 *     workspace ids + bounded reason codes.
 *   - Per-workspace strict isolation — every query is anchored on
 *     `workspace_id` so a workspace cannot be charged for another's
 *     traffic.
 *   - Failure to read the budget table → returns `{ allowed: true }`
 *     so a transient DB outage cannot wedge the embedding pipeline.
 *     The Bytes-column legacy ranker still works without budgets.
 */
import { prisma as defaultPrisma } from "../../db.js";
// -----------------------------------------------------------------------------
// Env-driven configuration. Conservative defaults — operators can tune.
// -----------------------------------------------------------------------------
export const SEMANTIC_DEFAULT_MAX_CHUNKS_PER_DAY = 5_000;
export const SEMANTIC_DEFAULT_MONTHLY_BUDGET_EUR = 100;
export const SEMANTIC_DEFAULT_USD_PER_TOKEN = 0.000_000_02;
export const SEMANTIC_DEFAULT_EUR_PER_USD = 0.92;
function readEnvNumber(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
        return fallback;
    return parsed;
}
export function getDailyChunkCap() {
    return Math.floor(readEnvNumber("SEMANTIC_MAX_CHUNKS_PER_WORKSPACE_PER_DAY", SEMANTIC_DEFAULT_MAX_CHUNKS_PER_DAY));
}
export function getMonthlyBudgetEur() {
    return readEnvNumber("SEMANTIC_MONTHLY_BUDGET_EUR", SEMANTIC_DEFAULT_MONTHLY_BUDGET_EUR);
}
export function getUsdPerToken() {
    return readEnvNumber("SEMANTIC_USD_PER_TOKEN", SEMANTIC_DEFAULT_USD_PER_TOKEN);
}
export function getEurPerUsd() {
    return readEnvNumber("SEMANTIC_EUR_PER_USD", SEMANTIC_DEFAULT_EUR_PER_USD);
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
/** Pessimistic token estimate: chars / 4. Floor at 1 so empty
 *  fragments still count as ≥1 token (avoids divide-by-zero). */
export function estimateTokensFromChars(chars) {
    if (!Number.isFinite(chars) || chars <= 0)
        return 1;
    return Math.max(1, Math.ceil(chars / 4));
}
/** Tokens → EUR (returns the float EUR, not micros). */
export function estimateEurFromTokens(tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0)
        return 0;
    return tokens * getUsdPerToken() * getEurPerUsd();
}
/** EUR (float) → integer micros for safe DB persistence. */
export function eurToMicros(eur) {
    if (!Number.isFinite(eur) || eur <= 0)
        return 0n;
    return BigInt(Math.round(eur * 1_000_000));
}
/** Integer micros → float EUR for the UI surface. */
export function microsToEur(micros) {
    const n = typeof micros === "bigint" ? Number(micros) : micros;
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    return n / 1_000_000;
}
/** UTC date (YYYY-MM-DD at 00:00 UTC) for the rollup key. */
export function dateUtcKey(at = new Date()) {
    const utc = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    return utc;
}
/** First UTC instant of the current month. */
export function firstOfMonthUtc(at = new Date()) {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
/**
 * Phase 16 — gate consulted BEFORE issuing an outbound embedding
 * call. The caller passes `additionalChunks` so the gate can answer
 * "would this push us over the cap?".
 *
 * NEVER throws. A DB read failure → `allowed: true` so a transient
 * outage cannot wedge the pipeline.
 */
export async function canEmbedMore(client, args) {
    const additional = Math.max(0, Math.floor(args.additionalChunks ?? 0));
    if (!args.workspaceId) {
        return { allowed: true, remaining: 0, reason: null };
    }
    const dailyCap = getDailyChunkCap();
    const monthlyCap = getMonthlyBudgetEur();
    if (dailyCap <= 0 && monthlyCap <= 0) {
        return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, reason: null };
    }
    try {
        const today = dateUtcKey();
        const monthStart = firstOfMonthUtc();
        const [todayRow, monthRows] = await Promise.all([
            client.semanticUsageDaily.findUnique({
                where: { workspaceId_dateUtc: { workspaceId: args.workspaceId, dateUtc: today } },
                select: { chunksEmbedded: true, eurSpentMicros: true },
            }),
            client.semanticUsageDaily.findMany({
                where: {
                    workspaceId: args.workspaceId,
                    dateUtc: { gte: monthStart },
                },
                select: { chunksEmbedded: true, eurSpentMicros: true },
            }),
        ]);
        const todayChunks = todayRow?.chunksEmbedded ?? 0;
        const monthEurMicros = monthRows.reduce((acc, r) => acc + (r.eurSpentMicros ?? 0n), 0n);
        const monthEur = microsToEur(monthEurMicros);
        if (dailyCap > 0 && todayChunks + additional > dailyCap) {
            return {
                allowed: false,
                remaining: Math.max(0, dailyCap - todayChunks),
                reason: "DAILY_CAP",
            };
        }
        if (monthlyCap > 0 && monthEur >= monthlyCap) {
            return {
                allowed: false,
                remaining: 0,
                reason: "MONTHLY_BUDGET",
            };
        }
        const remaining = dailyCap > 0 ? Math.max(0, dailyCap - todayChunks) : Number.MAX_SAFE_INTEGER;
        return { allowed: true, remaining, reason: null };
    }
    catch {
        // Read failure — fail-open. The pipeline continues; the budget
        // counter will be a low estimate until the DB recovers. Better
        // than wedging the embedding queue.
        return { allowed: true, remaining: dailyCap, reason: null };
    }
}
/**
 * Phase 16 — recorded after every successful provider call (live
 * indexing path, mi-embed worker, backfill script). Atomically
 * increments the per-workspace-day counter.
 *
 * NEVER throws. A failed write surfaces as a structured warn line
 * and the counter is lost for the call (the daily cap then runs
 * slightly under-counted; the safety net is the monthly EUR cap).
 */
export async function recordSemanticChunkEmbedded(client, args) {
    if (!args.workspaceId)
        return;
    const tokens = Math.max(0, Math.floor(args.tokens ?? 0));
    const eurMicros = eurToMicros(args.eur ?? estimateEurFromTokens(tokens));
    const today = dateUtcKey();
    try {
        await client.semanticUsageDaily.upsert({
            where: {
                workspaceId_dateUtc: {
                    workspaceId: args.workspaceId,
                    dateUtc: today,
                },
            },
            update: {
                chunksEmbedded: { increment: 1 },
                tokensConsumed: { increment: BigInt(tokens) },
                eurSpentMicros: { increment: eurMicros },
            },
            create: {
                workspaceId: args.workspaceId,
                dateUtc: today,
                chunksEmbedded: 1,
                tokensConsumed: BigInt(tokens),
                eurSpentMicros: eurMicros,
            },
        });
    }
    catch {
        // Bounded log, no PII.
        try {
            // eslint-disable-next-line no-console
            console.warn(JSON.stringify({
                kind: "semantic.usage.record_failed",
                workspaceId: args.workspaceId.slice(0, 64),
                chunkId: args.chunkId?.slice(0, 64) ?? null,
                evidenceId: args.evidenceId?.slice(0, 64) ?? null,
            }));
        }
        catch {
            /* logging best-effort */
        }
    }
}
/**
 * Phase 16 — UI summary surface. Reads today + month-to-date
 * counters for the workspace. Bounded.
 */
export async function getSemanticUsageSummary(client, workspaceId) {
    const dailyCap = getDailyChunkCap();
    const monthlyBudgetEur = getMonthlyBudgetEur();
    if (!workspaceId) {
        return {
            today: { chunks: 0, eur: 0 },
            monthToDate: { chunks: 0, eur: 0 },
            dailyCap,
            monthlyBudgetEur,
        };
    }
    try {
        const today = dateUtcKey();
        const monthStart = firstOfMonthUtc();
        const [todayRow, monthRows] = await Promise.all([
            client.semanticUsageDaily.findUnique({
                where: { workspaceId_dateUtc: { workspaceId, dateUtc: today } },
                select: { chunksEmbedded: true, eurSpentMicros: true },
            }),
            client.semanticUsageDaily.findMany({
                where: { workspaceId, dateUtc: { gte: monthStart } },
                select: { chunksEmbedded: true, eurSpentMicros: true },
            }),
        ]);
        const monthChunks = monthRows.reduce((acc, r) => acc + (r.chunksEmbedded ?? 0), 0);
        const monthMicros = monthRows.reduce((acc, r) => acc + (r.eurSpentMicros ?? 0n), 0n);
        return {
            today: {
                chunks: todayRow?.chunksEmbedded ?? 0,
                eur: microsToEur(todayRow?.eurSpentMicros ?? 0n),
            },
            monthToDate: { chunks: monthChunks, eur: microsToEur(monthMicros) },
            dailyCap,
            monthlyBudgetEur,
        };
    }
    catch {
        return {
            today: { chunks: 0, eur: 0 },
            monthToDate: { chunks: 0, eur: 0 },
            dailyCap,
            monthlyBudgetEur,
        };
    }
}
export { defaultPrisma };
