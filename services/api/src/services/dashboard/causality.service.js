/**
 * Phase 32.8C FINAL-2 — Operational Causality Engine.
 *
 * Builds deterministic causality links between real incidents,
 * workflows, correlations, and timeline events. Groups linked entities
 * into idempotent OperationalCausalityChain rows so the dashboard can
 * answer "Why is this workspace unhealthy?" — not just "What
 * happened?".
 *
 * Hard rules:
 *   - No fake causal explanations. Every link's `explanation` is
 *     constructed from real linked entity types + counts.
 *   - Generator failures NEVER block evidence / report / package /
 *     verify core flows.
 *   - Bounded operator-safe strings only. No raw payloads.
 *   - Chains are idempotent: keyed on (teamId, chainKey).
 */
import { prisma } from "../../db.js";
/**
 * Detect causality links + chains for one workspace. Reads real
 * incidents / workflows / correlations, builds deterministic links,
 * groups them into chains. Never throws.
 */
export async function detectCausalityForWorkspace(input) {
    let linksPersisted = 0;
    let chainsPersisted = 0;
    let failed = 0;
    let incidents = [];
    let workflows = [];
    let correlations = [];
    try {
        incidents = (await prisma.operationalIncident.findMany({
            where: {
                OR: [{ teamId: input.teamId }, { teamId: null }],
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
            },
            orderBy: { lastSeenAtUtc: "desc" },
            take: 200,
            select: {
                id: true,
                category: true,
                severity: true,
                status: true,
                fingerprint: true,
                lastSeenAtUtc: true,
                relatedEvidenceId: true,
            },
        }));
    }
    catch {
        return { linksPersisted: 0, chainsPersisted: 0, failed: 1 };
    }
    try {
        workflows = (await prisma.operationalWorkflow.findMany({
            where: {
                teamId: input.teamId,
                status: {
                    in: [
                        "OPEN",
                        "ASSIGNED",
                        "IN_PROGRESS",
                        "WAITING_ON_SYSTEM",
                        "WAITING_ON_REVIEWER",
                        "WAITING_ON_GOVERNANCE",
                        "MITIGATING",
                        "FAILED",
                    ],
                },
            },
            take: 200,
            select: {
                id: true,
                workflowType: true,
                status: true,
                severity: true,
                sourceIncidentId: true,
                sourceCorrelationId: true,
                evidenceId: true,
                caseId: true,
            },
        }));
    }
    catch {
        /* degrade — workflows may be unavailable but incidents are enough */
    }
    try {
        const cRows = await prisma.operationalCorrelation.findMany({
            where: {
                teamId: input.teamId,
                expiresAtUtc: { gt: new Date() },
            },
            take: 50,
            select: {
                id: true,
                correlationType: true,
                severity: true,
                linkedIncidentIds: true,
            },
        });
        correlations = cRows.map((r) => ({
            id: r.id,
            correlationType: r.correlationType,
            severity: r.severity,
            linkedIncidentIds: Array.isArray(r.linkedIncidentIds)
                ? r.linkedIncidentIds
                : [],
        }));
    }
    catch {
        /* degrade */
    }
    if (incidents.length === 0 && workflows.length === 0) {
        return { linksPersisted: 0, chainsPersisted: 0, failed: 0 };
    }
    // 1) Deterministic links between real entities ---------------------------
    const linkSeen = new Set();
    const links = [];
    // Rule A — incident generated → workflow created (direct)
    for (const wf of workflows) {
        if (!wf.sourceIncidentId)
            continue;
        const key = `wf:${wf.id}:from:${wf.sourceIncidentId}`;
        if (linkSeen.has(key))
            continue;
        linkSeen.add(key);
        links.push({
            sourceIncidentId: wf.sourceIncidentId,
            targetWorkflowId: wf.id,
            relationType: "CAUSED_BY",
            confidence: "DIRECT",
            reasonCode: "INCIDENT_TRIGGERED_WORKFLOW",
            explanation: `Workflow created from incident ${wf.sourceIncidentId.slice(0, 8)} (${wf.workflowType}).`,
        });
    }
    // Rule B — correlation grouped a set of incidents (PART_OF)
    for (const c of correlations) {
        for (const inc of c.linkedIncidentIds.slice(0, 20)) {
            const key = `corr:${c.id}:has:${inc}`;
            if (linkSeen.has(key))
                continue;
            linkSeen.add(key);
            links.push({
                sourceCorrelationId: c.id,
                targetIncidentId: inc,
                relationType: "PART_OF",
                confidence: "DIRECT",
                reasonCode: "CORRELATION_GROUPS_INCIDENT",
                explanation: `Incident is part of the ${c.correlationType} correlation grouping.`,
            });
        }
    }
    // Rule C — report-backlog incident → package-backlog incident (BLOCKED_BY)
    const reportIncidents = incidents.filter((i) => i.category === "REPORT");
    const packageIncidents = incidents.filter((i) => i.category === "PACKAGE");
    for (const r of reportIncidents) {
        for (const p of packageIncidents) {
            const key = `rpt-pkg:${r.id}:${p.id}`;
            if (linkSeen.has(key))
                continue;
            linkSeen.add(key);
            links.push({
                sourceIncidentId: r.id,
                targetIncidentId: p.id,
                relationType: "BLOCKED_BY",
                confidence: "INFERRED_HIGH",
                reasonCode: "REPORT_BACKLOG_BLOCKS_PACKAGE",
                explanation: "Report backlog blocks downstream verification package generation.",
            });
        }
    }
    // Rule D — governance incident → audit readiness incident (BLOCKED_BY)
    const governanceIncidents = incidents.filter((i) => i.category === "GOVERNANCE");
    const auditFingerprintIncidents = incidents.filter((i) => i.fingerprint.includes("unsigned_aged"));
    for (const g of governanceIncidents) {
        for (const a of auditFingerprintIncidents) {
            if (g.id === a.id)
                continue;
            const key = `gov-audit:${g.id}:${a.id}`;
            if (linkSeen.has(key))
                continue;
            linkSeen.add(key);
            links.push({
                sourceIncidentId: g.id,
                targetIncidentId: a.id,
                relationType: "BLOCKED_BY",
                confidence: "INFERRED_MEDIUM",
                reasonCode: "GOVERNANCE_BLOCKS_AUDIT",
                explanation: "Governance incident contributes to audit readiness pressure.",
            });
        }
    }
    // Rule E — telemetry stale → worker incidents (CAUSED_BY)
    const telemetryIncidents = incidents.filter((i) => i.fingerprint.includes("telemetry:"));
    const heartbeatStaleIncidents = incidents.filter((i) => i.fingerprint.includes("heartbeat_stale"));
    for (const t of telemetryIncidents) {
        for (const w of heartbeatStaleIncidents) {
            if (t.id === w.id)
                continue;
            const key = `tel-hb:${t.id}:${w.id}`;
            if (linkSeen.has(key))
                continue;
            linkSeen.add(key);
            links.push({
                sourceIncidentId: w.id,
                targetIncidentId: t.id,
                relationType: "CAUSED_BY",
                confidence: "INFERRED_HIGH",
                reasonCode: "WORKER_HEARTBEAT_CAUSES_TELEMETRY_STALE",
                explanation: "Worker heartbeat staleness explains stale queue telemetry samples.",
            });
        }
    }
    // Persist links — idempotent best-effort. Duplicates are tolerated;
    // we don't add a unique constraint because the source/target tuple is
    // sparse (any of 8 nullable columns can carry the edge). Per-call
    // dedup happens via `linkSeen` above.
    for (const l of links) {
        try {
            // Use a soft "exists" check to avoid duplicates on repeat detection.
            const exists = await prisma.operationalCausalityLink.findFirst({
                where: {
                    teamId: input.teamId,
                    sourceIncidentId: l.sourceIncidentId ?? null,
                    targetIncidentId: l.targetIncidentId ?? null,
                    sourceWorkflowId: l.sourceWorkflowId ?? null,
                    targetWorkflowId: l.targetWorkflowId ?? null,
                    sourceCorrelationId: l.sourceCorrelationId ?? null,
                    relationType: l.relationType,
                    reasonCode: l.reasonCode,
                },
                select: { id: true },
            });
            if (!exists) {
                await prisma.operationalCausalityLink.create({
                    data: {
                        teamId: input.teamId,
                        sourceIncidentId: l.sourceIncidentId ?? null,
                        targetIncidentId: l.targetIncidentId ?? null,
                        sourceWorkflowId: l.sourceWorkflowId ?? null,
                        targetWorkflowId: l.targetWorkflowId ?? null,
                        sourceCorrelationId: l.sourceCorrelationId ?? null,
                        relationType: l.relationType,
                        confidence: l.confidence,
                        reasonCode: l.reasonCode.slice(0, 80),
                        explanation: l.explanation.slice(0, 400),
                    },
                });
                linksPersisted += 1;
            }
        }
        catch {
            failed += 1;
        }
    }
    // 2) Group into chains ---------------------------------------------------
    const chains = buildChains({ teamId: input.teamId, incidents, workflows, correlations });
    for (const chain of chains) {
        try {
            await persistChain(input.teamId, chain);
            chainsPersisted += 1;
        }
        catch {
            failed += 1;
        }
    }
    return { linksPersisted, chainsPersisted, failed };
}
function buildChains(input) {
    const out = [];
    const reportIncs = input.incidents.filter((i) => i.category === "REPORT");
    const packageIncs = input.incidents.filter((i) => i.category === "PACKAGE");
    const workerIncs = input.incidents.filter((i) => i.category === "WORKER");
    const governanceIncs = input.incidents.filter((i) => i.category === "GOVERNANCE");
    // Chain 1: pipeline failure (report + package incidents + their workflows)
    if (reportIncs.length + packageIncs.length >= 2) {
        const allIncs = [...reportIncs, ...packageIncs];
        const wfs = input.workflows.filter((w) => (w.workflowType === "REPORT_RETRY" || w.workflowType === "PACKAGE_RETRY") &&
            w.sourceIncidentId !== null &&
            allIncs.some((i) => i.id === w.sourceIncidentId));
        const corrs = input.correlations.filter((c) => c.correlationType === "PIPELINE_DEGRADATION");
        out.push({
            chainKey: `pipeline_failure:${input.teamId}`,
            title: "Pipeline failure chain",
            summary: `Report + package pipelines degraded — ${reportIncs.length} report + ${packageIncs.length} package incidents.`,
            rootCauseType: "PIPELINE_FAILURE",
            severity: maxSeverity(allIncs.map((i) => i.severity)),
            linkedIncidentIds: allIncs.map((i) => i.id).slice(0, 50),
            linkedWorkflowIds: wfs.map((w) => w.id).slice(0, 50),
            linkedCorrelationIds: corrs.map((c) => c.id),
            linkedCaseIds: [],
            linkedEvidenceIds: dedupEvidence(allIncs, wfs),
        });
    }
    // Chain 2: reviewer bottleneck
    const reviewWorkflows = input.workflows.filter((w) => w.workflowType === "REVIEW_ESCALATION");
    if (reviewWorkflows.length >= 2) {
        const incs = input.incidents.filter((i) => reviewWorkflows.some((w) => w.sourceIncidentId === i.id));
        out.push({
            chainKey: `reviewer_bottleneck:${input.teamId}`,
            title: "Reviewer bottleneck chain",
            summary: `Multiple reviewer escalations open — ${reviewWorkflows.length} workflows active.`,
            rootCauseType: "REVIEWER_BOTTLENECK",
            severity: maxSeverity(reviewWorkflows.map((w) => w.severity)),
            linkedIncidentIds: incs.map((i) => i.id).slice(0, 50),
            linkedWorkflowIds: reviewWorkflows.map((w) => w.id).slice(0, 50),
            linkedCorrelationIds: [],
            linkedCaseIds: [],
            linkedEvidenceIds: dedupEvidence(incs, reviewWorkflows),
        });
    }
    // Chain 3: governance blocker
    if (governanceIncs.length >= 1 && packageIncs.length >= 1) {
        const wfs = input.workflows.filter((w) => w.workflowType === "GOVERNANCE_ESCALATION" ||
            w.workflowType === "EXPORT_BLOCKER_RESOLUTION" ||
            w.workflowType === "AUDIT_READINESS");
        const corrs = input.correlations.filter((c) => c.correlationType === "GOVERNANCE_ESCALATION" ||
            c.correlationType === "AUDIT_READINESS_GAP");
        out.push({
            chainKey: `governance_blocker:${input.teamId}`,
            title: "Governance blocker chain",
            summary: `Governance incidents are blocking the pipeline — ${governanceIncs.length} governance + ${packageIncs.length} package incidents.`,
            rootCauseType: "GOVERNANCE_BLOCKER",
            severity: maxSeverity([
                ...governanceIncs.map((i) => i.severity),
                ...packageIncs.map((i) => i.severity),
            ]),
            linkedIncidentIds: [...governanceIncs, ...packageIncs]
                .map((i) => i.id)
                .slice(0, 50),
            linkedWorkflowIds: wfs.map((w) => w.id).slice(0, 50),
            linkedCorrelationIds: corrs.map((c) => c.id),
            linkedCaseIds: [],
            linkedEvidenceIds: dedupEvidence([...governanceIncs, ...packageIncs], wfs),
        });
    }
    // Chain 4: telemetry/queue
    const telemetryIncs = input.incidents.filter((i) => i.fingerprint.includes("telemetry:") ||
        i.fingerprint.includes("heartbeat_stale") ||
        i.fingerprint.includes("retry_storms"));
    if (telemetryIncs.length >= 2 || workerIncs.length >= 3) {
        const allIncs = telemetryIncs.length >= 2 ? telemetryIncs : workerIncs;
        const wfs = input.workflows.filter((w) => w.workflowType === "TELEMETRY_RECOVERY" ||
            w.workflowType === "QUEUE_RECOVERY");
        const corrs = input.correlations.filter((c) => c.correlationType === "RETRY_STORM_CHAIN" ||
            c.correlationType === "INFRASTRUCTURE_PRESSURE" ||
            c.correlationType === "QUEUE_SATURATION_CHAIN");
        out.push({
            chainKey: `telemetry_queue:${input.teamId}`,
            title: "Telemetry/queue chain",
            summary: `Worker telemetry and queue subsystem under pressure — ${allIncs.length} incidents.`,
            rootCauseType: "TELEMETRY_QUEUE",
            severity: maxSeverity(allIncs.map((i) => i.severity)),
            linkedIncidentIds: allIncs.map((i) => i.id).slice(0, 50),
            linkedWorkflowIds: wfs.map((w) => w.id).slice(0, 50),
            linkedCorrelationIds: corrs.map((c) => c.id),
            linkedCaseIds: [],
            linkedEvidenceIds: dedupEvidence(allIncs, wfs),
        });
    }
    // Chain 5: integrity / audit
    const integrityIncs = input.incidents.filter((i) => i.category === "GOVERNANCE" && i.fingerprint.includes("unsigned_aged"));
    const integrityWfs = input.workflows.filter((w) => w.workflowType === "INTEGRITY_REVIEW" ||
        w.workflowType === "AUDIT_READINESS");
    if (integrityIncs.length >= 1 && integrityWfs.length >= 1) {
        out.push({
            chainKey: `integrity_audit:${input.teamId}`,
            title: "Integrity/audit chain",
            summary: `Integrity and audit-readiness signals firing — ${integrityIncs.length} integrity incidents, ${integrityWfs.length} workflows.`,
            rootCauseType: "INTEGRITY_AUDIT",
            severity: maxSeverity([
                ...integrityIncs.map((i) => i.severity),
                ...integrityWfs.map((w) => w.severity),
            ]),
            linkedIncidentIds: integrityIncs.map((i) => i.id).slice(0, 50),
            linkedWorkflowIds: integrityWfs.map((w) => w.id).slice(0, 50),
            linkedCorrelationIds: [],
            linkedCaseIds: [],
            linkedEvidenceIds: dedupEvidence(integrityIncs, integrityWfs),
        });
    }
    // Chain 6: coordination / case risk
    const coordIncs = input.incidents.filter((i) => i.fingerprint.includes("coordination:"));
    const coordWfs = input.workflows.filter((w) => w.workflowType === "COORDINATION_RESOLUTION" ||
        w.workflowType === "CASE_RISK_MITIGATION");
    if (coordIncs.length >= 1 && coordWfs.length >= 1) {
        out.push({
            chainKey: `coordination_case_risk:${input.teamId}`,
            title: "Coordination/case-risk chain",
            summary: `Unresolved coordination backlog is creating case-risk pressure.`,
            rootCauseType: "COORDINATION_CASE_RISK",
            severity: maxSeverity([
                ...coordIncs.map((i) => i.severity),
                ...coordWfs.map((w) => w.severity),
            ]),
            linkedIncidentIds: coordIncs.map((i) => i.id).slice(0, 50),
            linkedWorkflowIds: coordWfs.map((w) => w.id).slice(0, 50),
            linkedCorrelationIds: [],
            linkedCaseIds: coordWfs
                .map((w) => w.caseId)
                .filter((id) => !!id)
                .slice(0, 50),
            linkedEvidenceIds: dedupEvidence(coordIncs, coordWfs),
        });
    }
    return out;
}
function severityRank(s) {
    switch (s) {
        case "CRITICAL":
            return 3;
        case "HIGH":
            return 2;
        case "WARNING":
        case "MEDIUM":
            return 1;
        default:
            return 0;
    }
}
function maxSeverity(items) {
    let maxRank = 0;
    let result = "LOW";
    for (const s of items) {
        const rank = severityRank(s);
        if (rank > maxRank) {
            maxRank = rank;
            result =
                s === "CRITICAL"
                    ? "CRITICAL"
                    : s === "HIGH"
                        ? "HIGH"
                        : s === "WARNING" || s === "MEDIUM"
                            ? "MEDIUM"
                            : "LOW";
        }
    }
    return result;
}
function dedupEvidence(incidents, workflows) {
    const set = new Set();
    for (const i of incidents) {
        if (i.relatedEvidenceId)
            set.add(i.relatedEvidenceId);
    }
    for (const w of workflows) {
        if (w.evidenceId)
            set.add(w.evidenceId);
    }
    return Array.from(set).slice(0, 50);
}
async function persistChain(teamId, chain) {
    await prisma.operationalCausalityChain.upsert({
        where: {
            teamId_chainKey: {
                teamId,
                chainKey: chain.chainKey,
            },
        },
        create: {
            teamId,
            chainKey: chain.chainKey,
            title: chain.title.slice(0, 180),
            summary: chain.summary.slice(0, 400),
            rootCauseType: chain.rootCauseType,
            severity: chain.severity,
            status: "ACTIVE",
            linkedIncidentIds: chain.linkedIncidentIds,
            linkedWorkflowIds: chain.linkedWorkflowIds,
            linkedCorrelationIds: chain.linkedCorrelationIds,
            linkedCaseIds: chain.linkedCaseIds,
            linkedEvidenceIds: chain.linkedEvidenceIds,
        },
        update: {
            summary: chain.summary.slice(0, 400),
            severity: chain.severity,
            linkedIncidentIds: chain.linkedIncidentIds,
            linkedWorkflowIds: chain.linkedWorkflowIds,
            linkedCorrelationIds: chain.linkedCorrelationIds,
            linkedCaseIds: chain.linkedCaseIds,
            linkedEvidenceIds: chain.linkedEvidenceIds,
            lastSeenAtUtc: new Date(),
            status: "ACTIVE",
            resolvedAtUtc: null,
        },
    });
}
/**
 * Dashboard reader: ACTIVE causality chains for the workspace,
 * severity-sorted then most-recent.
 */
export async function listWorkspaceCausalityChains(input) {
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
    try {
        const rows = await prisma.operationalCausalityChain.findMany({
            where: {
                teamId: input.teamId,
                status: "ACTIVE",
            },
            orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
            take: limit,
        });
        return rows.map((r) => ({
            id: r.id,
            chainKey: r.chainKey,
            title: r.title,
            summary: r.summary,
            rootCauseType: r.rootCauseType,
            severity: r.severity,
            status: r.status,
            linkedIncidentIds: Array.isArray(r.linkedIncidentIds)
                ? r.linkedIncidentIds.slice(0, 50)
                : [],
            linkedWorkflowIds: Array.isArray(r.linkedWorkflowIds)
                ? r.linkedWorkflowIds.slice(0, 50)
                : [],
            linkedCorrelationIds: Array.isArray(r.linkedCorrelationIds)
                ? r.linkedCorrelationIds.slice(0, 50)
                : [],
            linkedCaseIds: Array.isArray(r.linkedCaseIds)
                ? r.linkedCaseIds.slice(0, 50)
                : [],
            linkedEvidenceIds: Array.isArray(r.linkedEvidenceIds)
                ? r.linkedEvidenceIds.slice(0, 50)
                : [],
            startAtUtc: r.startAtUtc.toISOString(),
            lastSeenAtUtc: r.lastSeenAtUtc.toISOString(),
        }));
    }
    catch {
        return [];
    }
}
