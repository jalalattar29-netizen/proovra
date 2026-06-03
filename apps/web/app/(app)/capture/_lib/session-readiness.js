import { getChecklistStepById, getItemQualityStatus } from "./file-utils";
function createItemIssue(params) {
    return {
        code: params.code,
        severity: params.severity,
        label: params.label,
        detail: params.detail,
        itemId: params.item.id,
        checklistStepId: params.checklistStepId ?? undefined,
    };
}
/** Phase 30.12 — humanised blocker label + detail (bounded). */
function resumableBlockerToIssue(b) {
    switch (b.kind) {
        case "upload_in_progress":
            return {
                code: "resumable_upload_in_progress",
                severity: "blocker",
                label: "Large file upload still in progress",
                detail: "A resumable upload is still uploading parts to storage. Review & Sign will become available when the upload completes and the server confirms verification.",
            };
        case "server_verification_pending":
            return {
                code: "resumable_server_verification_pending",
                severity: "blocker",
                label: "Server verification pending",
                detail: "The server is verifying the uploaded file. This usually takes a few seconds.",
            };
        case "hash_mismatch":
            return {
                code: "resumable_hash_mismatch",
                severity: "blocker",
                label: "Hash mismatch detected",
                detail: "The server-computed hash of the uploaded file does not match the expected value. The upload must be retried.",
            };
        case "session_expired":
            return {
                code: "resumable_session_expired",
                severity: "blocker",
                label: "Upload session expired",
                detail: "The upload session expired before all parts were uploaded. Re-stage the file and retry.",
            };
        case "session_aborted":
            return {
                code: "resumable_session_aborted",
                severity: "blocker",
                label: "Upload session aborted",
                detail: "An upload session was aborted. Discard or replace the affected file to continue.",
            };
        case "needs_recovery":
            return {
                code: "resumable_needs_recovery",
                severity: "blocker",
                label: "Recovery required before finalization",
                detail: "A previous upload requires operator action before this evidence can be finalized.",
            };
        case "failed_retryable":
            return {
                code: "resumable_failed_retryable",
                severity: "blocker",
                label: "Finalization blocked by upload session",
                detail: "A resumable upload reported a transient failure. Retry it from the operations panel.",
            };
    }
}
export function buildSessionReadiness({ items, selectedPlan, planMode, useLocation, resumableBlockers, }) {
    const requiredSteps = selectedPlan?.steps.filter((step) => step.required) ?? [];
    const mappedStepIds = new Set(items.map((item) => item.checklistStepId).filter(Boolean));
    const missingRequiredSteps = requiredSteps.filter((step) => !mappedStepIds.has(step.id));
    const mappedItems = items.filter((item) => Boolean(item.checklistStepId));
    const unmappedItems = items.filter((item) => !item.checklistStepId);
    const blockers = [];
    const warnings = [];
    if (items.length === 0) {
        blockers.push({
            code: "capture_empty_session",
            severity: "blocker",
            label: "Add at least one material to finish.",
            detail: "Capture requires at least one staged material before Review & Sign can start.",
        });
    }
    if (planMode === "CHECKLIST_REQUIRED") {
        missingRequiredSteps.forEach((step) => {
            blockers.push({
                code: "capture_required_step_missing",
                severity: "blocker",
                label: "Cannot finish yet",
                detail: `${step.title} has not been mapped to a staged material.`,
                checklistStepId: step.id,
            });
        });
    }
    const locationRequiredButMissing = selectedPlan?.locationRequirement === "required" && !useLocation;
    if (locationRequiredButMissing) {
        blockers.push({
            code: "capture_required_location_missing",
            severity: "blocker",
            label: "Location metadata is required by the selected plan.",
            detail: "Enable location and grant browser permission before finishing this evidence session.",
        });
    }
    unmappedItems.forEach((item) => {
        warnings.push(createItemIssue({
            code: "capture_item_unmapped",
            severity: "warning",
            label: "Needs mapping",
            detail: "This material is not mapped to a collection requirement.",
            item,
        }));
    });
    const itemQualityIssues = items.flatMap((item) => {
        const step = getChecklistStepById(selectedPlan, item.checklistStepId);
        const status = getItemQualityStatus({ item, step });
        if (status.tone === "success")
            return [];
        const severity = "warning";
        return [
            createItemIssue({
                code: `capture_item_${status.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
                severity,
                label: status.label,
                detail: status.detail,
                item,
                checklistStepId: item.checklistStepId,
            }),
        ];
    });
    warnings.push(...itemQualityIssues);
    if (selectedPlan?.locationRequirement === "recommended" && !useLocation) {
        warnings.push({
            code: "capture_recommended_location_missing",
            severity: "warning",
            label: "Recommended location not included",
            detail: "The selected plan recommends location metadata, but it is not included for this session.",
        });
    }
    // Phase 30.12 — fold resumable upload blockers into the
    // readiness verdict. Each upload session that isn't COMPLETED +
    // VERIFIED contributes a precise blocker reason. The backend
    // finalize gate remains the ultimate authority — this is just
    // UI hygiene so the user sees why Review & Sign is disabled
    // rather than a generic "not ready" message.
    if (resumableBlockers && resumableBlockers.length > 0) {
        for (const b of resumableBlockers) {
            blockers.push(resumableBlockerToIssue(b));
        }
    }
    const requiredCompleted = requiredSteps.length - missingRequiredSteps.length;
    const canFinalize = blockers.length === 0;
    const warningCount = warnings.length;
    const blockerCount = blockers.length;
    let status = "collecting";
    if (items.length === 0) {
        status = "empty";
    }
    else if (blockerCount > 0) {
        status = "blocked";
    }
    else if (warningCount > 0) {
        status = "warning";
    }
    else if (canFinalize) {
        status = "ready";
    }
    return {
        canFinalize,
        status,
        blockers,
        warnings,
        missingRequiredSteps,
        unmappedItems,
        mappedItems,
        itemQualityIssues,
        locationRequiredButMissing,
        aiRecommendedReview: warningCount > 0,
        summary: {
            totalItems: items.length,
            requiredTotal: requiredSteps.length,
            requiredCompleted,
            unmappedCount: unmappedItems.length,
            warningCount,
            blockerCount,
        },
    };
}
