const INTEGRITY_CRITICAL_SIGNAL_KEYS = new Set([
    "core_integrity",
    "signature",
    "trusted_timestamp",
    "immutable_storage",
]);
function toEpoch(value) {
    if (!value)
        return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
}
function getSignal(decision, key) {
    return decision?.signals.find((signal) => signal.key === key) ?? null;
}
function signalChanged(snapshot, live, key) {
    const before = getSignal(snapshot, key);
    const after = getSignal(live, key);
    if (!before && !after)
        return false;
    if (!before || !after)
        return true;
    return (before.status !== after.status ||
        before.summary !== after.summary ||
        before.detail !== after.detail ||
        before.tone !== after.tone);
}
function pushReason(reasons, reason) {
    if (reasons.some((entry) => entry.code === reason.code)) {
        return;
    }
    reasons.push(reason);
}
export function buildTrustDecisionConsistency(input) {
    if (!input.snapshotTrustDecision) {
        return {
            source: input.source,
            consistentWithSnapshot: null,
            tone: "neutral",
            accessOnly: false,
            integrityCritical: false,
            reasons: [],
        };
    }
    const reasons = [];
    const accessEventsAfterSnapshot = input.accessEventsAfterSnapshot ?? 0;
    if (accessEventsAfterSnapshot > 0) {
        pushReason(reasons, {
            code: "ACCESS_ACTIVITY_CHANGED",
            label: "Access activity changed after the report snapshot",
            detail: "Later viewing, download, or verification activity was recorded after the fixed report or package snapshot. This is an activity difference, not by itself an integrity failure.",
            tone: "info",
            integrityCritical: false,
        });
    }
    if (signalChanged(input.snapshotTrustDecision, input.liveTrustDecision, "public_anchoring") ||
        input.snapshotTrustDecision.publicationState !==
            input.liveTrustDecision.publicationState) {
        pushReason(reasons, {
            code: "PUBLICATION_STATUS_CHANGED",
            label: "OpenTimestamps or public anchoring status changed after the snapshot",
            detail: "The later live state no longer matches the snapshot for OpenTimestamps, external publication, or public-anchoring status. This affects publication posture and reviewer interpretation.",
            tone: "warning",
            integrityCritical: false,
        });
    }
    const snapshotGeneratedAt = toEpoch(input.snapshotGeneratedAtUtc);
    const latestReportGeneratedAt = toEpoch(input.latestReportGeneratedAtUtc);
    const latestPackageGeneratedAt = toEpoch(input.latestVerificationPackageGeneratedAtUtc);
    const hasLaterArtifact = snapshotGeneratedAt != null &&
        ((latestReportGeneratedAt != null &&
            latestReportGeneratedAt > snapshotGeneratedAt) ||
            (latestPackageGeneratedAt != null &&
                latestPackageGeneratedAt > snapshotGeneratedAt));
    if (hasLaterArtifact) {
        pushReason(reasons, {
            code: "ARTIFACT_VERSION_CHANGED",
            label: "Report or verification-package version changed after the snapshot",
            detail: "A newer report or verification package was generated after the fixed snapshot that supplied this trust decision. Review the later artifact version before relying on snapshot-era summaries alone.",
            tone: "warning",
            integrityCritical: false,
        });
    }
    else if (input.latestReportVersion != null &&
        input.latestVerificationPackageVersion != null &&
        input.latestVerificationPackageVersion > input.latestReportVersion) {
        pushReason(reasons, {
            code: "ARTIFACT_VERSION_CHANGED",
            label: "Report and verification-package versions are no longer aligned",
            detail: "The report snapshot and verification package no longer reflect the same artifact-generation point. Review the current artifact versions together before drawing reviewer conclusions.",
            tone: "warning",
            integrityCritical: false,
        });
    }
    const forensicEventsAtSnapshot = input.forensicEventsAtSnapshot ?? 0;
    const currentForensicEvents = input.currentForensicEvents ?? forensicEventsAtSnapshot;
    if (currentForensicEvents > forensicEventsAtSnapshot) {
        pushReason(reasons, {
            code: "FORENSIC_CUSTODY_CHANGED",
            label: "Forensic custody events changed after the snapshot",
            detail: "The current forensic custody chain contains additional integrity-relevant lifecycle events beyond those present at the fixed report or package snapshot.",
            tone: "warning",
            integrityCritical: true,
        });
    }
    const integritySignalsChanged = Array.from(INTEGRITY_CRITICAL_SIGNAL_KEYS).some((key) => signalChanged(input.snapshotTrustDecision, input.liveTrustDecision, key));
    if (integritySignalsChanged) {
        pushReason(reasons, {
            code: "CORE_INTEGRITY_SIGNALS_CHANGED",
            label: "Core integrity, signature, timestamp, or storage signals changed",
            detail: "The live technical verification state no longer matches the fixed snapshot for one or more integrity-critical signals such as core digest consistency, signature materials, trusted timestamping, or immutable-storage controls.",
            tone: "danger",
            integrityCritical: true,
        });
    }
    const snapshotMatchesLive = JSON.stringify(input.snapshotTrustDecision) === JSON.stringify(input.liveTrustDecision);
    if (!snapshotMatchesLive && reasons.length === 0) {
        pushReason(reasons, {
            code: "UNKNOWN_DIFFERENCE",
            label: "A live verification difference was detected",
            detail: "The live verification state differs from the fixed snapshot, but the current response did not isolate a narrower reason. Review the current technical materials directly.",
            tone: "warning",
            integrityCritical: false,
        });
    }
    const integrityCritical = reasons.some((reason) => reason.integrityCritical);
    const accessOnly = reasons.length > 0 &&
        reasons.every((reason) => reason.code === "ACCESS_ACTIVITY_CHANGED");
    const tone = integrityCritical
        ? "danger"
        : accessOnly
            ? "info"
            : reasons.length > 0
                ? "warning"
                : "neutral";
    return {
        source: input.source,
        consistentWithSnapshot: reasons.length === 0,
        tone,
        accessOnly,
        integrityCritical,
        reasons,
    };
}
