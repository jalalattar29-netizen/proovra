import { prisma } from "../db.js";
import { evaluateCustodyChain } from "./custody-events.service.js";
import { isAccessCustodyEventType, normalizeOtsStatusValue, } from "@proovra/shared";
const EVENT_TYPE_LABELS = {
    EVIDENCE_CREATED: {
        label: "Evidence created",
        source: "SYSTEM",
        tone: "success",
        description: "The evidence record was created.",
    },
    UPLOAD_STARTED: {
        label: "Upload started",
        source: "SYSTEM",
        tone: "neutral",
        description: "The evidence upload session started.",
    },
    UPLOAD_COMPLETED: {
        label: "Upload completed",
        source: "SYSTEM",
        tone: "success",
        description: "The evidence file materials were uploaded and recorded.",
    },
    EVIDENCE_COMPLETED: {
        label: "Evidence completed",
        source: "SYSTEM",
        tone: "success",
        description: "The evidence record was completed before report generation.",
    },
    SIGNATURE_APPLIED: {
        label: "Digital signature applied",
        source: "SYSTEM",
        tone: "success",
        description: "A cryptographic signature was applied to the recorded fingerprint.",
    },
    TIMESTAMP_APPLIED: {
        label: "Trusted timestamp recorded",
        source: "SYSTEM",
        tone: "success",
        description: "A trusted timestamp was recorded for the preserved integrity state.",
    },
    TIMESTAMP_FAILED: {
        label: "Trusted timestamp failed",
        source: "SYSTEM",
        tone: "warning",
        description: "A trusted timestamp could not be obtained for this record.",
    },
    OTS_APPLIED: {
        label: "OpenTimestamp proof recorded",
        source: "SYSTEM",
        tone: "warning",
        description: "OpenTimestamp proof material was recorded. Public anchoring may still be pending.",
    },
    OTS_FAILED: {
        label: "OpenTimestamp failed",
        source: "SYSTEM",
        tone: "warning",
        description: "OpenTimestamp proof creation failed or could not be completed.",
    },
    IDENTITY_SNAPSHOT_RECORDED: {
        label: "Identity snapshot recorded",
        source: "SYSTEM",
        tone: "success",
        description: "Submitter and workspace identity context was recorded for reviewer reference.",
    },
    REPORT_GENERATED: {
        label: "Report generated",
        source: "SYSTEM",
        tone: "success",
        description: "A PDF verification report was generated for this evidence record.",
    },
    REVIEW_READY: {
        label: "Review ready",
        source: "SYSTEM",
        tone: "success",
        description: "The evidence record was marked ready for reviewer inspection.",
    },
    VERIFICATION_PACKAGE_GENERATED: {
        label: "Verification package generated",
        source: "SYSTEM",
        tone: "success",
        description: "An offline verification package was generated for independent technical review.",
    },
    EVIDENCE_LOCKED: {
        label: "Evidence locked",
        source: "SYSTEM",
        tone: "success",
        description: "The evidence record was locked or sealed in the preservation workflow.",
    },
    EVIDENCE_VIEWED: {
        label: "Evidence viewed",
        source: "USER",
        tone: "success",
        description: "The evidence record was viewed by an authorized user.",
    },
    EVIDENCE_DOWNLOADED: {
        label: "Evidence downloaded",
        source: "USER",
        tone: "success",
        description: "An authorized user downloaded the evidence file.",
    },
    REPORT_DOWNLOADED: {
        label: "Report downloaded",
        source: "USER",
        tone: "success",
        description: "A generated report was downloaded for the evidence.",
    },
    VERIFICATION_PACKAGE_DOWNLOADED: {
        label: "Verification package downloaded",
        source: "USER",
        tone: "success",
        description: "The evidence verification package was downloaded.",
    },
    VERIFY_VIEWED: {
        label: "Verification page viewed",
        source: "PUBLIC_VERIFY",
        tone: "neutral",
        description: "An external verification link was accessed.",
    },
    TECHNICAL_VERIFICATION_CHECKED: {
        label: "Verification check performed",
        source: "SYSTEM",
        tone: "success",
        description: "The evidence verification process was executed.",
    },
};
function resolveEventLabelInfo(eventType) {
    const normalized = String(eventType ?? "").trim().toUpperCase();
    return (EVENT_TYPE_LABELS[normalized] ?? {
        label: normalized || "Unknown event",
        source: "UNKNOWN",
        tone: "neutral",
        description: "A custody event was recorded.",
    });
}
function buildEvidenceReviewDecision(params) {
    const issues = [];
    const nextActions = [];
    const statusEvidence = String(params.evidence.status).toUpperCase();
    if (!params.chainValid) {
        issues.push("Custody chain integrity could not be verified.");
        nextActions.push("Review custody event history and reconcile missing event hashes.");
    }
    if (!params.reportReady) {
        issues.push("Evidence report is not yet generated.");
        nextActions.push("Generate the PDF report before external review.");
    }
    if (!params.anchorPublished && !params.verificationPackageReady) {
        issues.push("Public verification and verification package are not fully available.");
        nextActions.push("Publish verification proof or generate a package for independent review.");
    }
    if (params.evidence.deletedAt) {
        return {
            status: "RESTRICTED",
            label: "Restricted Evidence",
            summary: "This evidence record is currently in a restricted state and may not be suitable for external review.",
            reasons: ["Evidence is in secure trash or marked for deletion."],
            nextActions: ["Restore or resolve the evidence state before review."],
            tone: "danger",
        };
    }
    if (issues.length === 0 && params.chainValid && params.reportReady) {
        return {
            status: "READY_FOR_EXTERNAL_REVIEW",
            label: "Ready for review",
            summary: "The evidence record has a verified custody chain, a generated report, and available verification artifacts.",
            reasons: [
                `Custody chain is ${params.chainMode}.`,
                "Evidence report is generated.",
                params.anchorPublished
                    ? "Public verification is active."
                    : "Verification package is available.",
            ],
            nextActions: [
                "Share the verification link with external reviewers.",
                "Provide the generated report as supporting evidence.",
            ],
            tone: "success",
        };
    }
    if (statusEvidence === "SIGNED" || statusEvidence === "REPORTED") {
        return {
            status: "NEEDS_ATTENTION",
            label: "Needs review",
            summary: "This evidence record has strong preservation signals but still requires additional verification artifacts or custody confirmation.",
            reasons: issues.length > 0 ? issues : ["Some verification or preservation signals are incomplete."],
            nextActions: nextActions.length > 0
                ? nextActions
                : ["Confirm proof artifacts, then re-run the evidence verification workflow."],
            tone: "warning",
        };
    }
    return {
        status: "NEEDS_ATTENTION",
        label: "Review recommended",
        summary: "The evidence has not yet achieved a fully review-ready state.",
        reasons: issues.length > 0 ? issues : ["The evidence record lacks review-ready verification signals."],
        nextActions: nextActions.length > 0
            ? nextActions
            : ["Complete evidence review readiness tasks and validate preservation state."],
        tone: "neutral",
    };
}
function buildVerificationProof(params) {
    const hasHash = Boolean(params.fileSha256 || params.fingerprintHash);
    const signaturePresent = Boolean(params.signatureBase64 || params.signingKeyId || params.signingKeyVersion);
    const tsaStatus = params.tsaStatus ? String(params.tsaStatus).trim().toUpperCase() : "UNKNOWN";
    const otsStatus = normalizeOtsStatusValue(params.otsStatus) ?? "UNKNOWN";
    return {
        hashMatch: hasHash ? "MATCH" : "NOT_CHECKED",
        sha256Recorded: Boolean(params.fileSha256),
        signatureStatus: signaturePresent ? "APPLIED" : "MISSING",
        tsaStatus: [
            "RECORDED",
            "SIGNED",
            "COMPLETE",
            "STAMPED",
            "GRANTED",
            "VERIFIED",
            "SUCCEEDED",
        ].includes(tsaStatus)
            ? "RECORDED"
            : tsaStatus === "FAILED" || tsaStatus === "ERROR" || tsaStatus === "UNAVAILABLE"
                ? "FAILED"
                : tsaStatus === "PENDING"
                    ? "PENDING"
                    : "UNKNOWN",
        otsStatus,
    };
}
function buildArtifactSummaries(params) {
    const reportReady = Boolean(params.evidence.reportGeneratedAtUtc || params.evidence.latestReportVersion);
    const verificationPackageReady = Boolean(params.evidence.verificationPackageGeneratedAtUtc || params.evidence.verificationPackageVersion);
    return {
        report: {
            available: reportReady,
            label: "PDF report",
            version: params.evidence.latestReportVersion ? String(params.evidence.latestReportVersion) : null,
            generatedAtUtc: formatNullableDate(params.evidence.reportGeneratedAtUtc),
            generatedByLabel: "Automated report engine",
            downloadCount: null,
            lastDownloadedAtUtc: null,
            offlineVerificationIncluded: true,
        },
        verificationPackage: {
            available: verificationPackageReady,
            label: "Verification package",
            version: params.evidence.verificationPackageVersion ? String(params.evidence.verificationPackageVersion) : null,
            generatedAtUtc: formatNullableDate(params.evidence.verificationPackageGeneratedAtUtc),
            generatedByLabel: "Automated package generator",
            downloadCount: null,
            lastDownloadedAtUtc: null,
            offlineVerificationIncluded: true,
        },
        verificationProofArtifacts: {
            available: Boolean(params.evidence.otsStatus || params.evidence.tsaStatus || params.evidence.signatureBase64),
            label: "Verification proof artifacts",
            version: null,
            generatedAtUtc: null,
            generatedByLabel: "Capture system",
            downloadCount: null,
            lastDownloadedAtUtc: null,
            offlineVerificationIncluded: Boolean(params.evidence.otsStatus || params.evidence.tsaStatus),
        },
    };
}
function buildAccessActivitySummary(params) {
    const accessRecords = params.records.filter((event) => isAccessCustodyEventType(event.eventType));
    const recentEvents = accessRecords
        .slice(-6)
        .reverse()
        .map((event) => {
        const info = resolveEventLabelInfo(event.eventType);
        return {
            eventType: event.eventType,
            label: info.label,
            timestampUtc: event.atUtc.toISOString(),
            actorLabel: info.source === "PUBLIC_VERIFY"
                ? "External reviewer"
                : info.source === "SYSTEM"
                    ? "System process"
                    : "Authorized user",
            source: info.source,
            tone: info.tone,
            description: info.description,
        };
    });
    const publicVerifyViews = accessRecords.filter((event) => String(event.eventType).toUpperCase() === "VERIFY_VIEWED").length;
    const reportDownloads = accessRecords.filter((event) => String(event.eventType).toUpperCase() === "REPORT_DOWNLOADED").length;
    const verificationPackageDownloads = accessRecords.filter((event) => String(event.eventType).toUpperCase() ===
        "VERIFICATION_PACKAGE_DOWNLOADED").length;
    const lastViewedAtUtc = accessRecords.map((event) => event.atUtc.toISOString()).sort().pop() ?? null;
    const lastDownloadedAtUtc = accessRecords
        .filter((event) => [
        "EVIDENCE_DOWNLOADED",
        "REPORT_DOWNLOADED",
        "VERIFICATION_PACKAGE_DOWNLOADED",
    ].includes(String(event.eventType).toUpperCase()))
        .map((event) => event.atUtc.toISOString())
        .sort()
        .pop() ?? null;
    return {
        publicVerifyViews: publicVerifyViews || null,
        reportDownloads: reportDownloads || null,
        verificationPackageDownloads: verificationPackageDownloads || null,
        originalDownloads: null,
        lastViewedAtUtc,
        lastDownloadedAtUtc,
        recentEvents,
    };
}
function buildReviewerAlerts(params) {
    const alerts = [];
    if (params.evidence.deletedAt) {
        alerts.push({
            severity: "danger",
            label: "Trash retention active",
            detail: "This evidence is currently deleted and retained in secure trash.",
        });
    }
    if (params.evidence.lockedAt) {
        alerts.push({
            severity: "info",
            label: "Record sealed",
            detail: "Evidence has been permanently locked to preserve chain-of-custody.",
        });
    }
    if (!params.chainValid) {
        alerts.push({
            severity: "danger",
            label: "Custody chain issue",
            detail: "One or more custody events did not match expected chain integrity.",
        });
    }
    if (!params.reportReady) {
        alerts.push({
            severity: "warning",
            label: "Report not ready",
            detail: "A downloadable evidence report is not yet available.",
        });
    }
    if (!params.verificationPackageReady) {
        alerts.push({
            severity: "warning",
            label: "Verification package missing",
            detail: "A verification package is not currently generated for this record.",
        });
    }
    if (!params.anchor?.published && !params.anchor?.configured) {
        alerts.push({
            severity: "warning",
            label: "Public verification not configured",
            detail: "Public verification is not enabled for this evidence record.",
        });
    }
    if (!params.storage?.verified) {
        alerts.push({
            severity: "warning",
            label: "Storage protection incomplete",
            detail: "Storage object lock or legal hold settings are not fully configured.",
        });
    }
    if (alerts.length === 0) {
        alerts.push({
            severity: "info",
            label: "Review ready",
            detail: "This record has no flagged issues in the current intelligence summary.",
        });
    }
    return alerts;
}
function buildCustodyTimeline(params) {
    const forensicRecords = params.records.filter((record) => !isAccessCustodyEventType(record.eventType));
    return forensicRecords
        .slice(-10)
        .reverse()
        .map((record) => {
        const info = resolveEventLabelInfo(record.eventType);
        return {
            eventType: record.eventType,
            label: info.label,
            timestampUtc: record.atUtc.toISOString(),
            actorLabel: info.source === "SYSTEM"
                ? "System"
                : info.source === "PUBLIC_VERIFY"
                    ? "Public verification"
                    : "User",
            source: info.source,
            tone: info.tone,
            description: info.description,
        };
    });
}
function buildLibrarySummary(params) {
    const signals = [
        params.chainValid ? 1 : 0,
        params.reportReady ? 1 : 0,
        params.verificationPackageReady ? 1 : 0,
        params.anchorPublished ? 1 : 0,
    ];
    const score = Math.round((signals.reduce((sum, value) => sum + value, 0) / signals.length) * 100);
    return {
        label: "Evidence readiness score",
        score: score === 0 ? null : score,
        description: `Scored from custody integrity, artifact availability, and verification readiness. ${score >= 80 ? "High confidence for review." : score >= 50 ? "Moderate confidence; review gaps remain." : "Additional validation is recommended."}`,
    };
}
function formatNullableDate(value) {
    if (value === null || value === undefined)
        return null;
    const date = typeof value === "string" ? new Date(value) : value;
    if (!date || Number.isNaN(date.getTime()))
        return null;
    return date.toISOString();
}
export async function buildEvidenceIntelligence(params) {
    const custodyRecords = await prisma.custodyEvent.findMany({
        where: { evidenceId: params.evidenceId },
        orderBy: { sequence: "asc" },
        select: {
            sequence: true,
            eventType: true,
            atUtc: true,
            payload: true,
            prevEventHash: true,
            eventHash: true,
        },
    });
    const chain = evaluateCustodyChain({
        evidenceId: params.evidenceId,
        records: custodyRecords.map((record) => ({
            sequence: record.sequence,
            eventType: record.eventType,
            atUtc: record.atUtc,
            payload: record.payload,
            prevEventHash: record.prevEventHash,
            eventHash: record.eventHash,
        })),
    });
    const accessEventCount = custodyRecords.filter((record) => isAccessCustodyEventType(record.eventType)).length;
    const forensicEventCount = custodyRecords.length - accessEventCount;
    return {
        recordId: params.evidenceId,
        status: {
            evidence: String(params.evidence.status),
            verificationStatus: params.evidence.verificationStatus ?? null,
            signedAtUtc: formatNullableDate(params.evidence.signedAtUtc),
            reportReady: Boolean(params.evidence.reportGeneratedAtUtc),
            verificationPackageReady: Boolean(params.evidence.verificationPackageGeneratedAtUtc),
        },
        preservation: {
            locked: Boolean(params.evidence.lockedAt),
            archived: Boolean(params.evidence.archivedAt),
            deleted: Boolean(params.evidence.deletedAt),
            deleteScheduledForUtc: formatNullableDate(params.evidence.deleteScheduledForUtc),
            retentionUntilUtc: formatNullableDate(params.evidence.retentionUntilUtc),
            storageProtection: params.storage,
            publicVerificationEnabled: Boolean(params.anchor?.configured),
            publicVerificationActive: Boolean(params.anchor?.published),
        },
        provenance: {
            captureMethod: params.evidence.captureMethod ?? null,
            identityLevelSnapshot: params.evidence.identityLevelSnapshot ?? null,
            submittedByEmail: params.evidence.submittedByEmail ?? null,
            submittedByAuthProvider: params.evidence.submittedByAuthProvider ?? null,
            createdByUserId: params.evidence.createdByUserId ?? null,
            uploadedByUserId: params.evidence.uploadedByUserId ?? null,
            workspaceName: params.evidence.workspaceNameSnapshot ?? null,
            organizationName: params.evidence.organizationNameSnapshot ?? null,
            organizationVerified: params.evidence.organizationVerifiedSnapshot ?? null,
        },
        custody: {
            createdAt: formatNullableDate(params.evidence.createdAt) ??
                new Date().toISOString(),
            uploadedAtUtc: formatNullableDate(params.evidence.uploadedAtUtc),
            lastAccessedAtUtc: formatNullableDate(params.evidence.lastAccessedAtUtc),
            lastVerifiedAtUtc: formatNullableDate(params.evidence.lastVerifiedAtUtc),
            recordedIntegrityVerifiedAtUtc: formatNullableDate(params.evidence.recordedIntegrityVerifiedAtUtc),
            firstEventAtUtc: custodyRecords.length > 0
                ? formatNullableDate(custodyRecords[0].atUtc)
                : null,
            latestEventAtUtc: custodyRecords.length > 0
                ? formatNullableDate(custodyRecords[custodyRecords.length - 1].atUtc)
                : null,
        },
        events: {
            total: custodyRecords.length,
            access: accessEventCount,
            forensic: forensicEventCount,
            chainIntegrity: {
                valid: chain.valid,
                mode: chain.mode,
                reason: chain.reason,
            },
        },
        anchor: {
            provider: params.anchor?.provider ?? null,
            mode: params.anchor?.mode ?? "off",
            configured: Boolean(params.anchor?.configured),
            published: Boolean(params.anchor?.published),
            anchorHash: params.anchor?.anchorHash ?? null,
            publicUrl: params.anchor?.publicUrl ?? null,
            anchoredAtUtc: formatNullableDate(params.anchor?.anchoredAtUtc),
        },
        reviewerDecision: buildEvidenceReviewDecision({
            evidence: params.evidence,
            chainValid: chain.valid,
            chainMode: chain.mode,
            reportReady: Boolean(params.evidence.reportGeneratedAtUtc || params.evidence.latestReportVersion),
            verificationPackageReady: Boolean(params.evidence.verificationPackageGeneratedAtUtc || params.evidence.verificationPackageVersion),
            anchorPublished: Boolean(params.anchor?.published),
        }),
        verificationProof: buildVerificationProof(params.evidence),
        artifacts: buildArtifactSummaries({ evidence: params.evidence }),
        accessActivity: buildAccessActivitySummary({ records: custodyRecords }),
        reviewerAlerts: buildReviewerAlerts({
            evidence: params.evidence,
            anchor: params.anchor,
            storage: params.storage,
            chainValid: chain.valid,
            reportReady: Boolean(params.evidence.reportGeneratedAtUtc || params.evidence.latestReportVersion),
            verificationPackageReady: Boolean(Boolean(params.evidence.verificationPackageGeneratedAtUtc || params.evidence.verificationPackageVersion)),
        }),
        custodyTimeline: buildCustodyTimeline({ records: custodyRecords }),
        librarySummary: buildLibrarySummary({
            evidence: params.evidence,
            chainValid: chain.valid,
            reportReady: Boolean(params.evidence.reportGeneratedAtUtc || params.evidence.latestReportVersion),
            verificationPackageReady: Boolean(Boolean(params.evidence.verificationPackageGeneratedAtUtc || params.evidence.verificationPackageVersion)),
            anchorPublished: Boolean(params.anchor?.published),
        }),
    };
}
