"use client";
/**
 * PHASE 38 — Use-case persona hook.
 *
 * Returns the canonical persona profile for the active workspace.
 * Falls back to a sensible default when the envelope hasn't loaded yet
 * or when the persona section is absent.
 *
 * Hard rule consumers MUST follow:
 *
 *   - This hook NEVER replaces a capability check. Pages keep gating on
 *     `ctx.can(CAPABILITY_KEY)` regardless of persona.
 *   - This hook ONLY informs UX ordering, defaults, terminology, and
 *     emphasis. Persona reordering on the sidebar/dashboard MUST NOT
 *     add or remove entries — only reorder existing ones.
 */
import { usePlatformContext } from "./PlatformContextProvider";
const DEFAULT_PROFILE = {
    teamId: null,
    primaryProfile: "INDIVIDUAL",
    secondaryUseCases: [],
    onboardingCompleted: false,
    preferredDashboardLayout: null,
    operationalDensityPreference: "comfortable",
    featurePriorityOverrides: [],
    resolvedRolePersona: "INDIVIDUAL",
    source: "default",
};
export function usePersonaProfile() {
    const { envelope } = usePlatformContext();
    return envelope?.personaProfile ?? DEFAULT_PROFILE;
}
export function usePrimaryPersona() {
    return usePersonaProfile().primaryProfile;
}
/**
 * Convenience predicate for surfaces that emphasise team-style operator
 * personas. Useful when a surface wants to render compact-mode by
 * default for legal/insurance/enterprise teams.
 */
export function useIsOperatorPersona() {
    const profile = usePersonaProfile().primaryProfile;
    return (profile === "LAWYER" ||
        profile === "INSURANCE" ||
        profile === "ENTERPRISE_COMPLIANCE" ||
        profile === "ADMIN_OPERATOR");
}
