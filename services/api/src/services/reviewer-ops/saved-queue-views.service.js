/**
 * Phase 25.5 — Reviewer-ops saved queue views.
 *
 * Reuses the Phase 24 `SavedSearchView` table via the new `scope`
 * discriminator column. No parallel table is created.
 *
 * Hard rules:
 *   - `scope` is always `"REVIEWER_OPS"` on read + write — the service
 *     never touches `"SEARCH"` rows.
 *   - The route layer validates `queryJson` against
 *     `ReviewerOpsSavedViewFilterSchema` before storage; the service
 *     re-validates on read in case rows predate the schema.
 *   - Visibility honours the Phase 24 PRIVATE / TEAM model.
 *   - Anti-cross-team: every query filters on `teamId`.
 */
import { REVIEWER_OPS_SAVED_VIEW_SCOPE, ReviewerOpsSavedViewFilterSchema, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
function projectView(row) {
    // The route layer validates queryJson before insert; here we
    // re-validate defensively. Invalid rows (legacy / hand-edited) get
    // a minimal shape with just the teamId so the UI can show them but
    // not blow up.
    const parsed = ReviewerOpsSavedViewFilterSchema.safeParse(row.queryJson);
    const filter = parsed.success
        ? parsed.data
        : { teamId: row.teamId };
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        pinned: row.pinned,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastUsedAtUtc: row.lastUsedAtUtc?.toISOString() ?? null,
        filter,
    };
}
// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------
export async function listReviewerOpsSavedViews(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await client.savedSearchView.findMany({
        where: {
            teamId: input.teamId,
            scope: REVIEWER_OPS_SAVED_VIEW_SCOPE,
            OR: [
                { createdByUserId: input.userId },
                { visibility: "TEAM" },
            ],
        },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        take: limit,
    });
    return rows.map(projectView);
}
export async function createReviewerOpsSavedView(input, client = defaultPrisma) {
    // Anti-cross-team: filter.teamId must match input.teamId.
    if (input.filter.teamId !== input.teamId)
        return null;
    try {
        const row = await client.savedSearchView.create({
            data: {
                teamId: input.teamId,
                createdByUserId: input.actorUserId,
                name: input.name.slice(0, 120),
                description: input.description?.slice(0, 400) ?? null,
                visibility: input.visibility,
                pinned: input.pinned ?? false,
                scope: REVIEWER_OPS_SAVED_VIEW_SCOPE,
                queryJson: input.filter,
            },
        });
        bump("reviewer_saved_view_created_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "reviewer_saved_view_created",
            severity: "INFO",
            details: {
                savedViewId: row.id,
                actorUserId: input.actorUserId,
                visibility: input.visibility,
            },
        });
        return projectView(row);
    }
    catch {
        // Likely a duplicate (uk on team+user+name). Surface null so the
        // route can 409.
        return null;
    }
}
// -----------------------------------------------------------------------------
// Delete
// -----------------------------------------------------------------------------
export async function deleteReviewerOpsSavedView(input, client = defaultPrisma) {
    const row = await client.savedSearchView.findFirst({
        where: {
            id: input.id,
            teamId: input.teamId,
            scope: REVIEWER_OPS_SAVED_VIEW_SCOPE,
        },
    });
    if (!row)
        return false;
    // PRIVATE views are deletable only by the creator.
    if (row.visibility === "PRIVATE" &&
        row.createdByUserId !== input.actorUserId) {
        return false;
    }
    await client.savedSearchView.delete({ where: { id: row.id } });
    bump("reviewer_saved_view_deleted_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_saved_view_deleted",
        severity: "INFO",
        details: {
            savedViewId: row.id,
            actorUserId: input.actorUserId,
        },
    });
    return true;
}
