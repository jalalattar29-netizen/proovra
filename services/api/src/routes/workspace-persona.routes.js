/**
 * PHASE 38-CLOSURE — Workspace persona mutation routes.
 *
 *   GET   /v1/workspaces/:teamId/persona  — read the persona profile
 *   PATCH /v1/workspaces/:teamId/persona  — update the persona profile
 *
 * Hard contracts:
 *
 *   1. Tenant-scoped. The actor MUST be a member of `teamId`. Cross-tenant
 *      access is denied with 404 (anti-enumeration).
 *   2. Capability-gated. Update requires `TEAM_MANAGE`. Read requires
 *      `TEAM_VIEW`.
 *   3. NEVER grants permissions. The persona profile is presentation-only;
 *      the capability registry is the sole authority.
 *   4. Bounded enum validation. The persona vocabulary (7 codes) and
 *      density vocabulary (3 codes) are validated server-side; invalid
 *      values produce 400.
 *   5. Audit emission. Successful mutations append a `workspace.persona.updated`
 *      platform-audit-log row carrying before/after summary (no secrets).
 */
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { prisma } from "../db.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { readWorkspacePersonaProfile, } from "../services/platform-context/persona-profile.service.js";
import { OPERATIONAL_DENSITY_PREFERENCES, WORKSPACE_PERSONA_PROFILES, } from "../services/platform-context/types.js";
const PROFILE_ENUM = z.enum(WORKSPACE_PERSONA_PROFILES);
const DENSITY_ENUM = z.enum(OPERATIONAL_DENSITY_PREFERENCES);
const UpdatePersonaSchema = z.object({
    primaryProfile: PROFILE_ENUM.optional(),
    secondaryUseCases: z.array(PROFILE_ENUM).max(4).optional(),
    onboardingCompleted: z.boolean().optional(),
    preferredDashboardLayout: z.string().max(64).nullable().optional(),
    operationalDensityPreference: DENSITY_ENUM.optional(),
    featurePriorityOverrides: z.array(z.string().min(1).max(60)).max(24).optional(),
    onboardingState: z.record(z.string(), z.unknown()).optional(),
});
export async function workspacePersonaRoutes(app) {
    // ---------------------------------------------------------------------------
    // GET /v1/workspaces/:teamId/persona — read profile (TEAM_VIEW).
    // ---------------------------------------------------------------------------
    app.get("/v1/workspaces/:teamId/persona", { preHandler: [requireAuth] }, async (req, reply) => {
        const params = z.object({ teamId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) {
            return reply.code(400).send({
                error: { code: "invalid_params", reason: "team_id_required" },
            });
        }
        const grant = await authorizeOrFail(req, reply, {
            teamId: params.data.teamId,
            permission: "identity.org_policy.read",
            resourceKind: "workspace_persona_profile",
            resourceId: params.data.teamId,
            antiEnumeration: true,
        });
        if (!grant)
            return;
        // Resolve the role for the canonical envelope shape; the resolver
        // requires a Persona for the legacy fallback field.
        const profile = await readWorkspacePersonaProfile({
            teamId: params.data.teamId,
            resolvedRolePersona: "INDIVIDUAL",
        });
        return reply.send({ profile });
    });
    // ---------------------------------------------------------------------------
    // PATCH /v1/workspaces/:teamId/persona — update profile (TEAM_MANAGE).
    // ---------------------------------------------------------------------------
    app.patch("/v1/workspaces/:teamId/persona", { preHandler: [requireAuth] }, async (req, reply) => {
        const params = z.object({ teamId: z.string().uuid() }).safeParse(req.params);
        if (!params.success) {
            return reply.code(400).send({
                error: { code: "invalid_params", reason: "team_id_required" },
            });
        }
        const body = UpdatePersonaSchema.safeParse(req.body ?? {});
        if (!body.success) {
            return reply.code(400).send({
                error: {
                    code: "invalid_body",
                    // Bounded reason; we don't echo Zod messages verbatim because
                    // they can include schema internals.
                    reason: "persona_payload_rejected",
                },
            });
        }
        const grant = await authorizeOrFail(req, reply, {
            teamId: params.data.teamId,
            permission: "identity.org_policy.manage",
            resourceKind: "workspace_persona_profile",
            resourceId: params.data.teamId,
            antiEnumeration: true,
        });
        if (!grant)
            return;
        // Snapshot the prior profile for the audit log.
        const before = await readWorkspacePersonaProfile({
            teamId: params.data.teamId,
            resolvedRolePersona: "INDIVIDUAL",
        });
        const update = sanitiseUpdate(body.data);
        const after = await prisma.workspacePersonaProfile.upsert({
            where: { teamId: params.data.teamId },
            create: {
                teamId: params.data.teamId,
                primaryProfile: update.primaryProfile ?? "INDIVIDUAL",
                secondaryUseCases: (update.secondaryUseCases ?? []),
                onboardingCompleted: update.onboardingCompleted ?? false,
                preferredDashboardLayout: update.preferredDashboardLayout ?? null,
                operationalDensityPreference: update.operationalDensityPreference ?? "comfortable",
                featurePriorityOverrides: (update.featurePriorityOverrides ?? []),
                onboardingState: (update.onboardingState ?? {}),
            },
            update: {
                ...(update.primaryProfile !== undefined && {
                    primaryProfile: update.primaryProfile,
                }),
                ...(update.secondaryUseCases !== undefined && {
                    secondaryUseCases: update.secondaryUseCases,
                }),
                ...(update.onboardingCompleted !== undefined && {
                    onboardingCompleted: update.onboardingCompleted,
                }),
                ...(update.preferredDashboardLayout !== undefined && {
                    preferredDashboardLayout: update.preferredDashboardLayout,
                }),
                ...(update.operationalDensityPreference !== undefined && {
                    operationalDensityPreference: update.operationalDensityPreference,
                }),
                ...(update.featurePriorityOverrides !== undefined && {
                    featurePriorityOverrides: update.featurePriorityOverrides,
                }),
                ...(update.onboardingState !== undefined && {
                    onboardingState: update.onboardingState,
                }),
            },
            select: {
                primaryProfile: true,
                secondaryUseCases: true,
                onboardingCompleted: true,
                preferredDashboardLayout: true,
                operationalDensityPreference: true,
                featurePriorityOverrides: true,
            },
        });
        // Bounded audit summary — no secrets, no large payloads.
        await appendPlatformAuditLog({
            action: "workspace.persona.updated",
            userId: grant.actorUserId,
            category: "workspace",
            severity: "info",
            outcome: "success",
            resourceType: "workspace_persona_profile",
            resourceId: grant.teamId,
            metadata: {
                teamId: grant.teamId,
                before: {
                    primaryProfile: before.primaryProfile,
                    density: before.operationalDensityPreference,
                    onboardingCompleted: before.onboardingCompleted,
                },
                after: {
                    primaryProfile: after.primaryProfile,
                    density: after.operationalDensityPreference,
                    onboardingCompleted: after.onboardingCompleted,
                },
            },
        }).catch(() => undefined);
        // Re-read through the canonical resolver so the response shape
        // matches the platform-context envelope's `personaProfile` shape.
        const profile = await readWorkspacePersonaProfile({
            teamId: params.data.teamId,
            resolvedRolePersona: "INDIVIDUAL",
        });
        return reply.send({ profile });
    });
}
function sanitiseUpdate(input) {
    // Zod has validated everything above; cast to the bounded types.
    return input;
}
