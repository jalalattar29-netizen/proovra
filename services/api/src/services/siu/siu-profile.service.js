/**
 * PROOVRA Insurance SIU — durable case profile service (Phase M3.1).
 *
 * Replaces the M3 in-process registry with a Prisma-backed projection.
 * Lazy-initializes the profile + checklist when a caller first
 * accesses a case that did not exist under M3.
 *
 * Hard rules:
 *   * Workspace-scoped — every read/write requires a `teamId` and
 *     verifies the case belongs to that team.
 *   * Bounded enums on every state — values are validated against
 *     `@proovra/shared` enums before they reach the DB.
 *   * Privacy-gated claimant fields are redacted from any read whose
 *     caller did NOT request explicit PII exposure (the SIU routes
 *     layer enforces capability + step-up before passing
 *     `exposePii: true`).
 *   * NEVER mutates evidence or report rows.
 *   * NEVER makes a SIU-finality determination of any kind.
 */
import { Prisma } from "@prisma/client";
import { SIU_PROFILE_SCHEMA_VERSION, buildEmptySiuChecklist, getSiuIntakeTemplate, } from "@proovra/shared";
import { prisma } from "../../db.js";
// Phase O1.5D — bounded siu.followup.request span. NEVER claimant
// PII or contact details in attributes.
import { PROOVRA_SPAN_NAMES, withProovraSpan, } from "../../observability/otel.js";
// ---------------------------------------------------------------------------
// Tenancy guards
// ---------------------------------------------------------------------------
async function requireCaseInTeam(input) {
    const c = await prisma.case.findFirst({
        where: { id: input.caseId, teamId: input.teamId },
        select: { id: true, teamId: true },
    });
    if (!c || !c.teamId)
        return null;
    return { caseId: c.id, teamId: c.teamId };
}
function projectProfile(row, opts) {
    const claimantName = opts.exposePii ? row.claimantName : redactIfPresent(row.claimantName);
    const claimantContact = opts.exposePii
        ? row.claimantContact
        : redactIfPresent(row.claimantContact);
    return {
        schemaVersion: SIU_PROFILE_SCHEMA_VERSION,
        caseId: row.caseId,
        teamId: row.teamId,
        createdAtUtc: row.createdAt.toISOString(),
        updatedAtUtc: row.updatedAt.toISOString(),
        claimType: row.claimType,
        investigationStatus: row.investigationStatus,
        claimNumber: row.claimNumber,
        policyReference: row.policyReference,
        incidentDate: row.incidentDate?.toISOString() ?? null,
        incidentLocation: extractIncidentLocationLabel(row.incidentLocationJson),
        lossDescription: row.lossDescription,
        assignedAdjusterUserId: row.assignedAdjusterUserId,
        assignedSIUReviewerUserId: row.assignedSiuReviewerUserId,
        claimantName,
        claimantContact,
        privacyGatedFieldsExposed: opts.exposePii,
        intakeTemplateId: row.intakeTemplateId,
        checklist: row.checklistItems
            .slice()
            .sort((a, b) => a.templateItemId.localeCompare(b.templateItemId))
            .map(projectChecklistItem),
        reviewIndicators: row.reviewIndicators
            .slice()
            .sort((a, b) => a.observedAtUtc.getTime() - b.observedAtUtc.getTime())
            .map(projectReviewIndicator),
        followUps: row.followUps
            .slice()
            .sort((a, b) => a.requestedAtUtc.getTime() - b.requestedAtUtc.getTime())
            .map(projectFollowUp),
    };
}
function projectChecklistItem(row) {
    return {
        itemId: row.templateItemId,
        label: row.label,
        required: row.required,
        status: row.status,
        mappedEvidenceIds: parseStringArrayJson(row.mappedEvidenceIdsJson),
        note: row.note,
    };
}
function projectReviewIndicator(row) {
    return {
        code: row.code,
        explanation: row.explanation,
        evidenceId: row.evidenceId,
        observedAtUtc: row.observedAtUtc.toISOString(),
        severity: row.severity,
    };
}
function projectFollowUp(row) {
    return {
        id: row.id,
        checklistItemId: row.checklistItemId,
        status: row.status,
        dueByUtc: row.dueByUtc?.toISOString() ?? null,
        requestedAtUtc: row.requestedAtUtc.toISOString(),
        note: row.privateNotes,
        intakeLinkId: row.intakeLinkId,
        receivedAtUtc: row.receivedAtUtc?.toISOString() ?? null,
        returnedEvidenceIds: parseStringArrayJson(row.returnedEvidenceIdsJson),
    };
}
function parseStringArrayJson(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((v) => typeof v === "string");
}
function extractIncidentLocationLabel(value) {
    if (!value || typeof value !== "object")
        return null;
    const obj = value;
    return typeof obj.label === "string" ? obj.label : null;
}
function redactIfPresent(s) {
    if (s == null)
        return null;
    return "[REDACTED]";
}
export async function loadSiuProfile(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const row = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        include: {
            checklistItems: true,
            followUps: true,
            reviewIndicators: true,
        },
    });
    if (!row)
        return null;
    return projectProfile(row, { exposePii: input.exposePii });
}
export async function upsertSiuProfile(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const existing = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        select: {
            id: true,
            intakeTemplateId: true,
        },
    });
    const intakeTemplateId = input.patch.intakeTemplateId ??
        existing?.intakeTemplateId ??
        inferTemplateFromClaimType(input.patch.claimType);
    const incidentLocationJson = input.patch.incidentLocation
        ? { label: input.patch.incidentLocation }
        : Prisma.JsonNull;
    const baseData = {
        claimType: input.patch.claimType,
        investigationStatus: input.patch.investigationStatus ?? undefined,
        claimNumber: input.patch.claimNumber ?? undefined,
        policyReference: input.patch.policyReference ?? undefined,
        incidentDate: input.patch.incidentDate
            ? new Date(input.patch.incidentDate)
            : undefined,
        incidentLocationJson: incidentLocationJson,
        lossDescription: input.patch.lossDescription ?? undefined,
        assignedAdjusterUserId: input.patch.assignedAdjusterUserId ?? undefined,
        assignedSiuReviewerUserId: input.patch.assignedSIUReviewerUserId ?? undefined,
        claimantName: input.patch.claimantName ?? undefined,
        claimantContact: input.patch.claimantContact ?? undefined,
        intakeTemplateId: intakeTemplateId ?? undefined,
        updatedByUserId: input.actorUserId ?? undefined,
    };
    if (existing) {
        await prisma.caseSiuProfile.update({
            where: { id: existing.id },
            data: baseData,
        });
    }
    else {
        // Create + materialize the checklist atomically.
        const templateChecklist = intakeTemplateId
            ? buildEmptySiuChecklist(getSiuIntakeTemplate(intakeTemplateId))
            : [];
        const templateItemsInput = intakeTemplateId
            ? getSiuIntakeTemplate(intakeTemplateId).items
            : [];
        await prisma.caseSiuProfile.create({
            data: {
                caseId: input.caseId,
                teamId: tenant.teamId,
                claimType: input.patch.claimType,
                investigationStatus: input.patch.investigationStatus ?? "intake",
                claimNumber: input.patch.claimNumber ?? null,
                policyReference: input.patch.policyReference ?? null,
                incidentDate: input.patch.incidentDate
                    ? new Date(input.patch.incidentDate)
                    : null,
                incidentLocationJson: incidentLocationJson === Prisma.JsonNull
                    ? Prisma.JsonNull
                    : incidentLocationJson,
                lossDescription: input.patch.lossDescription ?? null,
                assignedAdjusterUserId: input.patch.assignedAdjusterUserId ?? null,
                assignedSiuReviewerUserId: input.patch.assignedSIUReviewerUserId ?? null,
                claimantName: input.patch.claimantName ?? null,
                claimantContact: input.patch.claimantContact ?? null,
                piiVisibilityPolicy: "redacted_by_default",
                intakeTemplateId: intakeTemplateId ?? null,
                createdByUserId: input.actorUserId ?? null,
                updatedByUserId: input.actorUserId ?? null,
                checklistItems: {
                    create: templateChecklist.map((c, i) => ({
                        templateItemId: c.itemId,
                        label: c.label,
                        description: templateItemsInput[i]?.purpose ?? null,
                        required: c.required,
                        acceptedKindsJson: (templateItemsInput[i]?.acceptedKinds ?? []),
                        status: c.status,
                        mappedEvidenceIdsJson: [],
                        note: c.note,
                    })),
                },
            },
        });
    }
    return loadSiuProfile({
        caseId: input.caseId,
        teamId: input.teamId,
        exposePii: false,
    });
}
function inferTemplateFromClaimType(claimType) {
    switch (claimType) {
        case "auto":
            return "insurance-auto-claim";
        case "property":
            return "insurance-property-claim";
        case "injury":
        case "liability":
            return "insurance-injury-liability-claim";
        case "cyber":
            return "insurance-cyber-incident-claim";
        default:
            return null;
    }
}
// ---------------------------------------------------------------------------
// Checklist operations
// ---------------------------------------------------------------------------
export async function mapEvidenceToChecklistItem(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const profileRow = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        select: { id: true },
    });
    if (!profileRow)
        return null;
    const ev = await prisma.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { id: true },
    });
    if (!ev)
        return null;
    const item = await prisma.caseSiuChecklistItem.findUnique({
        where: {
            case_siu_checklist_profile_item_uniq: {
                siuProfileId: profileRow.id,
                templateItemId: input.itemId,
            },
        },
    });
    if (!item)
        return null;
    const mapped = parseStringArrayJson(item.mappedEvidenceIdsJson);
    if (!mapped.includes(input.evidenceId)) {
        const next = [...mapped, input.evidenceId];
        await prisma.caseSiuChecklistItem.update({
            where: { id: item.id },
            data: {
                mappedEvidenceIdsJson: next,
                status: "mapped",
            },
        });
    }
    return loadSiuProfile({
        caseId: input.caseId,
        teamId: input.teamId,
        exposePii: false,
    });
}
export async function setChecklistItemStatus(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const profileRow = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        select: { id: true },
    });
    if (!profileRow)
        return null;
    const item = await prisma.caseSiuChecklistItem.findUnique({
        where: {
            case_siu_checklist_profile_item_uniq: {
                siuProfileId: profileRow.id,
                templateItemId: input.itemId,
            },
        },
        select: { id: true, note: true },
    });
    if (!item)
        return null;
    await prisma.caseSiuChecklistItem.update({
        where: { id: item.id },
        data: {
            status: input.status,
            note: input.note ?? item.note,
            satisfiedAt: input.status === "satisfied" ? new Date() : undefined,
            satisfiedByUserId: input.status === "satisfied" ? input.actorUserId ?? null : undefined,
        },
    });
    return loadSiuProfile({
        caseId: input.caseId,
        teamId: input.teamId,
        exposePii: false,
    });
}
// ---------------------------------------------------------------------------
// Review indicators
// ---------------------------------------------------------------------------
export async function addReviewIndicator(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const profileRow = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        select: { id: true },
    });
    if (!profileRow)
        return null;
    await prisma.caseSiuReviewIndicator.create({
        data: {
            siuProfileId: profileRow.id,
            code: input.code,
            severity: input.severity,
            evidenceId: input.evidenceId ?? null,
            explanation: input.explanation.slice(0, 240),
            source: "reviewer",
            status: "open",
            createdByUserId: input.actorUserId ?? null,
        },
    });
    return loadSiuProfile({
        caseId: input.caseId,
        teamId: input.teamId,
        exposePii: false,
    });
}
// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------
export async function createFollowUpRequest(input) {
    return withProovraSpan(PROOVRA_SPAN_NAMES.SIU_FOLLOWUP_REQUEST, {
        "proovra.team_id": input.teamId,
        "proovra.case_id": input.caseId,
        "proovra.operation": "siu_followup_request",
    }, () => createFollowUpRequestInner(input));
}
async function createFollowUpRequestInner(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const profileRow = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        select: { id: true },
    });
    if (!profileRow)
        return null;
    const row = await prisma.caseSiuFollowUp.create({
        data: {
            siuProfileId: profileRow.id,
            checklistItemId: input.checklistItemId,
            intakeLinkId: input.intakeLinkId ?? null,
            status: input.intakeLinkId ? "sent" : "open",
            dueByUtc: input.dueByUtc ? new Date(input.dueByUtc) : null,
            requestedByUserId: input.actorUserId ?? null,
            privateNotes: input.note ? input.note.slice(0, 240) : null,
            returnedEvidenceIdsJson: [],
        },
    });
    return projectFollowUp(row);
}
export async function updateFollowUpStatus(input) {
    const tenant = await requireCaseInTeam(input);
    if (!tenant)
        return null;
    const profileRow = await prisma.caseSiuProfile.findUnique({
        where: { caseId: input.caseId },
        select: { id: true },
    });
    if (!profileRow)
        return null;
    const existing = await prisma.caseSiuFollowUp.findFirst({
        where: { id: input.followUpId, siuProfileId: profileRow.id },
    });
    if (!existing)
        return null;
    const existingIds = parseStringArrayJson(existing.returnedEvidenceIdsJson);
    const nextIds = input.receivedEvidenceId
        ? Array.from(new Set([...existingIds, input.receivedEvidenceId]))
        : existingIds;
    const now = new Date();
    const updated = await prisma.caseSiuFollowUp.update({
        where: { id: existing.id },
        data: {
            status: input.status,
            receivedAtUtc: input.status === "received" || input.status === "satisfied"
                ? existing.receivedAtUtc ?? now
                : existing.receivedAtUtc,
            satisfiedAtUtc: input.status === "satisfied" ? existing.satisfiedAtUtc ?? now : existing.satisfiedAtUtc,
            returnedEvidenceIdsJson: nextIds,
        },
    });
    return projectFollowUp(updated);
}
