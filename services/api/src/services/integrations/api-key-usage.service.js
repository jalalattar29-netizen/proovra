/**
 * Phase 10.5 — API credential usage log.
 *
 * Records per-call audit trail for service-account API key usage:
 *   - which credential, in which workspace
 *   - which route + method + action
 *   - success / failure + safe failure reason
 *   - request id correlation
 *
 * NEVER stores:
 *   - raw API key
 *   - Authorization header value
 *   - request body
 *   - private evidence data
 *
 * Best-effort: failures here MUST NOT break the caller. All writes go
 * through `safeRecordApiCredentialUsage`, which swallows errors.
 */
import { prisma as defaultPrisma } from "../../db.js";
const ROUTE_MAX = 256;
const METHOD_MAX = 16;
const ACTION_MAX = 96;
const FAILURE_REASON_MAX = 96;
const REQUEST_ID_MAX = 64;
function clip(value, max) {
    if (!value)
        return null;
    const t = value.trim();
    if (!t)
        return null;
    return t.length > max ? t.slice(0, max) : t;
}
export async function recordApiCredentialUsage(input, client = defaultPrisma) {
    const routePath = clip(input.routePath, ROUTE_MAX) ?? "/unknown";
    const method = clip(input.method, METHOD_MAX) ?? "GET";
    const action = clip(input.action, ACTION_MAX) ?? "unknown";
    const failureReason = input.success
        ? null
        : clip(input.failureReason ?? null, FAILURE_REASON_MAX);
    const requestId = clip(input.requestId ?? null, REQUEST_ID_MAX);
    return client.apiCredentialUsageLog.create({
        data: {
            apiCredentialId: input.apiCredentialId,
            teamId: input.teamId,
            routePath,
            method: method.toUpperCase(),
            action,
            statusCode: Math.max(0, Math.min(999, Math.floor(input.statusCode))),
            success: input.success,
            failureReason,
            requestId,
        },
    });
}
/**
 * Fire-and-forget wrapper. Use this from middleware / route hooks
 * where an audit-log failure must NEVER bubble up to the caller.
 */
export function safeRecordApiCredentialUsage(input, client = defaultPrisma) {
    recordApiCredentialUsage(input, client).catch(() => null);
}
export async function listApiCredentialUsage(input, client = defaultPrisma) {
    return client.apiCredentialUsageLog.findMany({
        where: {
            apiCredentialId: input.apiCredentialId,
            teamId: input.teamId,
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export function projectApiCredentialUsage(log) {
    return {
        id: log.id,
        routePath: log.routePath,
        method: log.method,
        action: log.action,
        statusCode: log.statusCode,
        success: log.success,
        failureReason: log.failureReason,
        requestId: log.requestId,
        createdAt: log.createdAt.toISOString(),
        // Deliberately NOT projected: teamId (caller already knows it),
        // apiCredentialId (caller already knows it).
    };
}
