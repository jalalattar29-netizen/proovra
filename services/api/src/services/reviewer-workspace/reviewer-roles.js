/**
 * PROOVRA Phase 2A — Reviewer role resolver.
 *
 * Resolves a member's bounded ReviewerRole + capabilities from the
 * existing PROOVRA RBAC role + bounded function flags. Phase 2A
 * derives the reviewer role from the existing TeamMember.role plus
 * a single optional flag stored on the team's role-flags JSON; the
 * default mapping is:
 *
 *   PROOVRA role  → default ReviewerRole
 *   OWNER         → REVIEW_ADMIN
 *   ADMIN         → SUPERVISOR
 *   MEMBER        → REVIEWER
 *   VIEWER        → no reviewer role; cannot mutate
 *
 * A workspace admin can elevate a MEMBER to SENIOR_REVIEWER or
 * QC_REVIEWER via a future admin surface; the bounded mapping
 * defined here is the deterministic default until that surface
 * lands. This resolver NEVER consults the database — it operates
 * over a small (role, flags) input.
 */
import { REVIEWER_ROLES, REVIEWER_ROLE_CAPABILITIES, reviewerCapabilitiesForRole, } from "@proovra/shared";
const DEFAULT_BY_WORKSPACE_ROLE = {
    OWNER: "REVIEW_ADMIN",
    ADMIN: "SUPERVISOR",
    MEMBER: "REVIEWER",
    VIEWER: null,
};
export function resolveReviewerRole(input) {
    // Platform admins always get REVIEW_ADMIN for diagnostic + support
    // workflows. They do not bypass workspace anchoring; the route
    // layer still enforces teamId filtering.
    if (input.isPlatformAdmin === true) {
        return {
            role: "REVIEW_ADMIN",
            capabilities: REVIEWER_ROLE_CAPABILITIES.REVIEW_ADMIN,
        };
    }
    const wsRole = input.workspaceRole;
    if (!wsRole)
        return { role: null, capabilities: [] };
    // Honour an explicit override when it is a known reviewer role and
    // the workspace role is at least MEMBER. A VIEWER never gets
    // elevated by an override.
    if (wsRole !== "VIEWER" && input.reviewerRoleOverride) {
        const override = input.reviewerRoleOverride;
        if (REVIEWER_ROLES.includes(override)) {
            return {
                role: override,
                capabilities: REVIEWER_ROLE_CAPABILITIES[override],
            };
        }
    }
    const role = DEFAULT_BY_WORKSPACE_ROLE[wsRole];
    if (!role)
        return { role: null, capabilities: [] };
    return { role, capabilities: REVIEWER_ROLE_CAPABILITIES[role] };
}
export function callerHasCapability(resolution, capability) {
    return resolution.capabilities.includes(capability);
}
export { reviewerCapabilitiesForRole };
