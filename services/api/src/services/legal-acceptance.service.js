import { prisma } from "../db.js";
import { REQUIRED_LEGAL_VERSIONS, } from "../legal/legal-versioning.js";
function readUserAgent(req) {
    if (!req)
        return null;
    const ua = req.headers["user-agent"];
    return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}
export async function recordLegalAcceptances(params) {
    const db = params.db ?? prisma;
    if (!params.acceptances.length)
        return;
    await db.$transaction(params.acceptances.map((item) => db.userLegalAcceptance.upsert({
        where: {
            userId_policyKey: {
                userId: params.userId,
                policyKey: item.policyKey,
            },
        },
        update: {
            policyVersion: item.policyVersion,
            source: params.source ?? null,
            ipAddress: params.req?.ip ?? null,
            userAgent: readUserAgent(params.req),
            acceptedAt: new Date(),
        },
        create: {
            userId: params.userId,
            policyKey: item.policyKey,
            policyVersion: item.policyVersion,
            source: params.source ?? null,
            ipAddress: params.req?.ip ?? null,
            userAgent: readUserAgent(params.req),
        },
    })));
}
export async function getUserLegalAcceptanceStatus(params) {
    const db = params.db ?? prisma;
    const rows = await db.userLegalAcceptance.findMany({
        where: { userId: params.userId },
        select: {
            policyKey: true,
            policyVersion: true,
            acceptedAt: true,
        },
    });
    const acceptedVersions = Object.fromEntries(rows.map((row) => [row.policyKey, row.policyVersion]));
    const missingPolicies = Object.entries(REQUIRED_LEGAL_VERSIONS)
        .filter(([policyKey, requiredVersion]) => acceptedVersions[policyKey] !== requiredVersion)
        .map(([policyKey]) => policyKey);
    return {
        ok: missingPolicies.length === 0,
        requiresReacceptance: missingPolicies.length > 0,
        missingPolicies,
        acceptedVersions,
        requiredVersions: REQUIRED_LEGAL_VERSIONS,
    };
}
export async function assertUserHasRequiredLegalAcceptances(params) {
    const status = await getUserLegalAcceptanceStatus(params);
    if (!status.ok) {
        const error = new Error("LEGAL_REACCEPT_REQUIRED");
        error.code = "LEGAL_REACCEPT_REQUIRED";
        error.statusCode = 428;
        error.details = {
            missingPolicies: status.missingPolicies,
            acceptedVersions: status.acceptedVersions,
            requiredVersions: status.requiredVersions,
        };
        throw error;
    }
    return status;
}
