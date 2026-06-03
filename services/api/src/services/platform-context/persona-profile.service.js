/**
 * PHASE 38 — Workspace persona profile resolver.
 *
 * Reads (and defaults) the use-case persona profile for a workspace.
 * The resolver is READ-ONLY in the platform-context path; a separate
 * mutation route handles operator-driven profile updates (e.g. picking
 * a persona during onboarding).
 *
 * Hard contracts:
 *
 *   1. NEVER grants capabilities. The profile is presentation-only.
 *   2. NEVER fails the envelope. A missing row yields the canonical
 *      default profile; a degraded DB read yields a "default" source
 *      tag so consumers can render an honest staleness chip.
 *   3. Tenant-scoped: every read is keyed on `teamId`. No cross-tenant
 *      query is structurally possible.
 *   4. Bounded: the row is a single primary-key lookup. No findMany.
 *
 * Default profile selection rules:
 *
 *   - PERSONAL space + no stored row  → INDIVIDUAL
 *   - ORGANIZATION space + no stored row → INDIVIDUAL (until operator
 *     explicitly picks a different persona; mode is UX-only so a
 *     conservative default never blocks features).
 */
import { prisma as defaultPrisma } from "../../db.js";
import { OPERATIONAL_DENSITY_PREFERENCES, WORKSPACE_PERSONA_PROFILES, } from "./types.js";
const PROFILE_SET = new Set([
    ...WORKSPACE_PERSONA_PROFILES,
]);
const DENSITY_SET = new Set([
    ...OPERATIONAL_DENSITY_PREFERENCES,
]);
function coerceProfile(raw) {
    if (raw && PROFILE_SET.has(raw))
        return raw;
    return "INDIVIDUAL";
}
function coerceDensity(raw) {
    if (raw && DENSITY_SET.has(raw))
        return raw;
    return "comfortable";
}
function coerceProfileArray(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== "string")
            continue;
        if (PROFILE_SET.has(item))
            out.push(item);
        if (out.length >= 4)
            break;
    }
    return out;
}
function coerceStringArray(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (typeof item === "string" && item.length > 0 && item.length <= 60) {
            out.push(item);
        }
        if (out.length >= 24)
            break;
    }
    return out;
}
/**
 * Return the canonical default persona profile for a workspace. Used
 * when no DB row exists yet OR when the lookup fails — the envelope
 * is never blocked on this surface.
 */
export function defaultPersonaProfile(input) {
    return {
        teamId: input.teamId,
        primaryProfile: "INDIVIDUAL",
        secondaryUseCases: [],
        onboardingCompleted: false,
        preferredDashboardLayout: null,
        operationalDensityPreference: "comfortable",
        featurePriorityOverrides: [],
        resolvedRolePersona: input.resolvedRolePersona,
        source: "default",
    };
}
/**
 * Read the persona profile for `teamId`, falling back to the canonical
 * default if no row exists or the lookup fails. Always returns a
 * complete `PlatformContextPersonaProfile`.
 */
export async function readWorkspacePersonaProfile(input, client = defaultPrisma) {
    if (!input.teamId) {
        return defaultPersonaProfile(input);
    }
    try {
        const row = await client.workspacePersonaProfile.findUnique({
            where: { teamId: input.teamId },
        });
        if (!row) {
            return defaultPersonaProfile(input);
        }
        return {
            teamId: input.teamId,
            primaryProfile: coerceProfile(row.primaryProfile),
            secondaryUseCases: coerceProfileArray(row.secondaryUseCases),
            onboardingCompleted: row.onboardingCompleted === true,
            preferredDashboardLayout: row.preferredDashboardLayout ?? null,
            operationalDensityPreference: coerceDensity(row.operationalDensityPreference),
            featurePriorityOverrides: coerceStringArray(row.featurePriorityOverrides),
            resolvedRolePersona: input.resolvedRolePersona,
            source: "stored",
        };
    }
    catch {
        // Degraded — return default. The envelope MUST NOT fail on this
        // optional UX-layer surface.
        return defaultPersonaProfile(input);
    }
}
