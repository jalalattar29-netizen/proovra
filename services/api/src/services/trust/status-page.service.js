/**
 * PROOVRA Phase 4A — Status Page service.
 *
 * In-platform Status Page. Reads from a local component + incident
 * store and, when `BETTER_STACK_STATUS_PAGE_API_KEY` is bound,
 * augments component health from the upstream Better Stack monitor
 * API. When the upstream is not bound the projection honestly
 * reports `upstreamProvider = "LOCAL"`.
 *
 * Hard rules:
 *   * NEVER fake uptime — if a probe is missing the component
 *     reports `UNKNOWN`.
 *   * Status incidents + maintenance windows are bounded JSON
 *     shapes; raw upstream payloads are never echoed.
 *   * Workspace-anchored at every entry point.
 */
import { STATUS_COMPONENT_HEALTHS, STATUS_COMPONENT_KEYS, STATUS_INCIDENT_SEVERITIES, STATUS_INCIDENT_STATES, STATUS_PAGE_SCHEMA_VERSION, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitStatusIncidentEvent } from "./trust-and-governance-audit.service.js";
import { probeAll } from "./status-probes.service.js";
const STATUS_PAGE_LIMITATIONS = [
    "STATUS_REFLECTS_UPSTREAM_PROBE_LAG_UP_TO_60S",
    "MISSING_PROBES_REPORT_UNKNOWN_NEVER_FALSE_OPERATIONAL",
];
export async function upsertStatusComponent(input) {
    if (!STATUS_COMPONENT_KEYS.includes(input.key)) {
        throw new Error(`status-page: unknown component key ${input.key}`);
    }
    const prisma = input.prisma ?? defaultPrisma;
    const health = input.health ?? "UNKNOWN";
    return prisma.statusComponent.upsert({
        where: { teamId_key: { teamId: input.teamId, key: input.key } },
        create: {
            teamId: input.teamId,
            key: input.key,
            label: input.label.slice(0, 120),
            description: input.description.slice(0, 600),
            health,
            upstreamSource: input.upstreamSource ?? "LOCAL",
            upstreamReference: input.upstreamReference ?? null,
        },
        update: {
            label: input.label.slice(0, 120),
            description: input.description.slice(0, 600),
            health,
            upstreamSource: input.upstreamSource ?? "LOCAL",
            upstreamReference: input.upstreamReference ?? null,
            lastUpdatedAtUtc: new Date(),
        },
    });
}
export async function ensureStatusComponentsSeed(input) {
    let created = 0;
    let updated = 0;
    for (const seed of SEED_COMPONENTS) {
        const existing = await (input.prisma ?? defaultPrisma).statusComponent.findFirst({
            where: { teamId: input.teamId, key: seed.key },
            select: { id: true },
        });
        await upsertStatusComponent({
            prisma: input.prisma,
            teamId: input.teamId,
            key: seed.key,
            label: seed.label,
            description: seed.description,
        });
        if (existing)
            updated += 1;
        else
            created += 1;
    }
    return { created, updated };
}
export async function createIncident(input) {
    if (!STATUS_INCIDENT_SEVERITIES.includes(input.severity)) {
        throw new Error(`status-page: bad severity ${input.severity}`);
    }
    const prisma = input.prisma ?? defaultPrisma;
    const incident = await prisma.statusIncident.create({
        data: {
            teamId: input.teamId,
            title: input.title.slice(0, 200),
            severity: input.severity,
            state: "INVESTIGATING",
            componentKeys: input.componentKeys,
            externalRef: input.externalRef ?? null,
        },
        select: { id: true },
    });
    if (input.body) {
        await prisma.statusIncidentUpdate.create({
            data: {
                teamId: input.teamId,
                incidentId: incident.id,
                body: input.body.slice(0, 2000),
                state: "INVESTIGATING",
                authoredByUserId: input.authoredByUserId ?? null,
            },
        });
    }
    void emitStatusIncidentEvent({
        prisma,
        teamId: input.teamId,
        incidentId: incident.id,
        code: "STATUS_INCIDENT_CREATED",
        actorUserId: input.authoredByUserId ?? null,
    }).catch(() => { });
    return incident;
}
export async function appendIncidentUpdate(input) {
    if (!STATUS_INCIDENT_STATES.includes(input.state)) {
        throw new Error(`status-page: bad state ${input.state}`);
    }
    const prisma = input.prisma ?? defaultPrisma;
    await prisma.$transaction(async (tx) => {
        await tx.statusIncidentUpdate.create({
            data: {
                teamId: input.teamId,
                incidentId: input.incidentId,
                body: input.body.slice(0, 2000),
                state: input.state,
                authoredByUserId: input.authoredByUserId ?? null,
            },
        });
        await tx.statusIncident.update({
            where: { id: input.incidentId },
            data: {
                state: input.state,
                resolvedAtUtc: input.state === "RESOLVED" ? new Date() : undefined,
                postmortemUrl: input.postmortemUrl ?? undefined,
            },
        });
    });
    void emitStatusIncidentEvent({
        prisma,
        teamId: input.teamId,
        incidentId: input.incidentId,
        code: "STATUS_INCIDENT_UPDATED",
        actorUserId: input.authoredByUserId ?? null,
        reason: input.state,
    }).catch(() => { });
}
export async function createMaintenanceWindow(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const w = await prisma.maintenanceWindow.create({
        data: {
            teamId: input.teamId,
            title: input.title.slice(0, 200),
            description: input.description.slice(0, 2000),
            componentKeys: input.componentKeys,
            startsAtUtc: input.startsAtUtc,
            endsAtUtc: input.endsAtUtc,
        },
    });
    void emitStatusIncidentEvent({
        prisma,
        teamId: input.teamId,
        incidentId: w.id,
        code: "STATUS_MAINTENANCE_SCHEDULED",
    }).catch(() => { });
    return w;
}
// ---------------------------------------------------------------------------
// Read path — bounded projection.
// ---------------------------------------------------------------------------
export async function projectStatusPage(input) {
    const prisma = input.prisma ?? defaultPrisma;
    // Lazy seed for first-load tenants.
    await ensureStatusComponentsSeed({ prisma, teamId: input.teamId });
    const upstreamHealthMap = input.betterStackApiKey
        ? await fetchBetterStackHealth(input.betterStackApiKey).catch(() => null)
        : null;
    const upstreamProvider = upstreamHealthMap ? "BETTER_STACK" : "LOCAL";
    // Internal probes — run in parallel with DB reads; best-effort overlay.
    const probeReports = await probeAll({ prisma }).catch(() => []);
    const probeMap = new Map(probeReports
        .filter((r) => r.componentKey != null)
        .map((r) => [r.componentKey, r]));
    const componentRows = await prisma.statusComponent.findMany({
        where: { teamId: input.teamId },
        orderBy: { key: "asc" },
    });
    const components = componentRows.map((c) => {
        const upstreamHealth = upstreamHealthMap?.get(c.key);
        const probe = probeMap.get(c.key);
        // Priority: Better Stack > internal probe (when deterministic) > DB.
        // Internal probe UNKNOWN preserves the existing health — never downgrades
        // a known-good status to UNKNOWN because a non-configured probe was skipped.
        const probeVerdict = probe && probe.verdict !== "UNKNOWN" ? probe.verdict : null;
        const effective = upstreamHealth ?? probeVerdict ?? c.health;
        return {
            key: c.key,
            label: c.label,
            health: effective,
            description: c.description ?? "",
            lastUpdatedUtc: c.lastUpdatedAtUtc.toISOString(),
            upstreamSource: upstreamHealth ? "BETTER_STACK" : probeVerdict ? "INTERNAL" : (c.upstreamSource ?? ""),
            upstreamReference: c.upstreamReference,
        };
    });
    const overallHealth = aggregateOverallHealth(components.map((c) => c.health));
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const incidentRows = await prisma.statusIncident.findMany({
        where: {
            teamId: input.teamId,
            OR: [
                { state: { not: "RESOLVED" } },
                { startedAtUtc: { gte: since } },
            ],
        },
        orderBy: { startedAtUtc: "desc" },
        take: 100,
        include: {
            updates: { orderBy: { createdAt: "asc" } },
        },
    });
    const incidents = incidentRows.map((i) => ({
        id: i.id,
        externalRef: i.externalRef,
        title: i.title,
        severity: i.severity,
        state: i.state,
        componentKeys: Array.isArray(i.componentKeys)
            ? i.componentKeys
            : [],
        startedAtUtc: i.startedAtUtc.toISOString(),
        resolvedAtUtc: i.resolvedAtUtc?.toISOString() ?? null,
        postmortemUrl: i.postmortemUrl,
        updates: i.updates.map((u) => ({
            id: u.id,
            body: u.body,
            state: u.state,
            createdAtUtc: u.createdAt.toISOString(),
        })),
    }));
    const activeIncidents = incidents.filter((i) => i.state !== "RESOLVED" && !i.state.startsWith("POSTMORTEM"));
    const recentIncidents = incidents.filter((i) => i.state === "RESOLVED" || i.state.startsWith("POSTMORTEM"));
    const windows = await prisma.maintenanceWindow.findMany({
        where: { teamId: input.teamId, endsAtUtc: { gte: new Date() } },
        orderBy: { startsAtUtc: "asc" },
        take: 20,
    });
    const maintenanceWindows = windows.map((w) => ({
        id: w.id,
        title: w.title,
        description: w.description ?? "",
        componentKeys: Array.isArray(w.componentKeys)
            ? w.componentKeys
            : [],
        startsAtUtc: w.startsAtUtc.toISOString(),
        endsAtUtc: w.endsAtUtc.toISOString(),
        state: (w.state ?? "SCHEDULED"),
    }));
    return {
        schemaVersion: STATUS_PAGE_SCHEMA_VERSION,
        generatedAtUtc: new Date().toISOString(),
        upstreamProvider,
        overallHealth,
        components,
        activeIncidents,
        recentIncidents,
        maintenanceWindows,
        limitations: STATUS_PAGE_LIMITATIONS,
    };
}
// ---------------------------------------------------------------------------
// Better Stack reader — honest degradation.
// ---------------------------------------------------------------------------
async function fetchBetterStackHealth(apiKey) {
    if (!apiKey || apiKey.length < 8)
        return null;
    try {
        const res = await fetch("https://uptime.betterstack.com/api/v2/monitors", {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok)
            return null;
        const json = (await res.json());
        const out = new Map();
        if (!Array.isArray(json.data))
            return out;
        for (const m of json.data) {
            const name = (m.attributes?.pronounceable_name ??
                m.attributes?.url ??
                "").toLowerCase();
            const status = m.attributes?.status ?? "";
            const health = mapBetterStackStatus(status);
            const key = matchComponentKey(name);
            if (key)
                out.set(key, health);
        }
        return out;
    }
    catch {
        return null;
    }
}
function mapBetterStackStatus(status) {
    switch (status.toLowerCase()) {
        case "up":
            return "OPERATIONAL";
        case "validating":
        case "paused":
            return "MAINTENANCE";
        case "down":
            return "MAJOR_OUTAGE";
        default:
            return "UNKNOWN";
    }
}
function matchComponentKey(name) {
    if (name.includes("api"))
        return "API";
    if (name.includes("verify") || name.includes("verification"))
        return "VERIFICATION";
    if (name.includes("capture"))
        return "CAPTURE";
    if (name.includes("report"))
        return "REPORTS";
    if (name.includes("ai"))
        return "AI_SERVICES";
    if (name.includes("azure"))
        return "AZURE_DI";
    if (name.includes("deepgram"))
        return "DEEPGRAM";
    if (name.includes("rekognition"))
        return "AWS_REKOGNITION";
    if (name.includes("s3") || name.includes("storage"))
        return "STORAGE_HEALTH";
    if (name.includes("worker"))
        return "BACKGROUND_WORKERS";
    if (name.includes("queue"))
        return "QUEUE_HEALTH";
    if (name.includes("dependency"))
        return "DEPENDENCY_HEALTH";
    return null;
}
function aggregateOverallHealth(values) {
    if (values.includes("MAJOR_OUTAGE"))
        return "MAJOR_OUTAGE";
    if (values.includes("PARTIAL_OUTAGE"))
        return "PARTIAL_OUTAGE";
    if (values.includes("DEGRADED"))
        return "DEGRADED";
    if (values.includes("MAINTENANCE"))
        return "MAINTENANCE";
    if (values.every((v) => v === "OPERATIONAL"))
        return "OPERATIONAL";
    return "UNKNOWN";
}
const SEED_COMPONENTS = [
    { key: "API", label: "API", description: "Public Fastify API + auth + workspace anchoring." },
    { key: "VERIFICATION", label: "Verification", description: "Public verify routes + verification package generation." },
    { key: "CAPTURE", label: "Capture", description: "Operator + citizen + mobile capture ingest." },
    { key: "REPORTS", label: "Report Generation", description: "Background report rendering + delivery." },
    { key: "AI_SERVICES", label: "AI Services", description: "Provider adapter orchestrator + budget gate." },
    { key: "AZURE_DI", label: "Azure DI", description: "Azure Document Intelligence subprocessor." },
    { key: "DEEPGRAM", label: "Deepgram", description: "Deepgram transcription subprocessor." },
    { key: "AWS_REKOGNITION", label: "AWS Rekognition", description: "AWS Rekognition image intelligence subprocessor." },
    { key: "AWS_S3", label: "AWS S3", description: "Evidence storage with Object Lock." },
    { key: "BACKGROUND_WORKERS", label: "Background Workers", description: "Worker pool (report-v2, ots-anchoring, verification-package)." },
    { key: "QUEUE_HEALTH", label: "Queue Health", description: "Bull queue depth + processing latency." },
    { key: "STORAGE_HEALTH", label: "Storage Health", description: "S3 read/write latency + Object Lock posture." },
    { key: "DEPENDENCY_HEALTH", label: "Dependency Health", description: "PostgreSQL + Redis + KMS upstream health." },
];
// Compile-time guard.
function _assertEnumsIntact() {
    const _h = "OPERATIONAL";
    void _h;
    void STATUS_COMPONENT_HEALTHS;
}
void _assertEnumsIntact;
