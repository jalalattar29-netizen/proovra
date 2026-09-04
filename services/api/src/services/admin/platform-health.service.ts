/**
 * PROOVRA Platform Admin — Platform Health & Service Status aggregation.
 *
 * READ-ONLY, PLATFORM-WIDE. This service CONNECTS existing mature health
 * services + reads a handful of operational Prisma tables to project a
 * single "is the platform healthy right now?" object. It does NOT
 * re-implement any health logic — every service-status row is derived
 * from an existing probe (runtime-readiness, signer-health,
 * queue-inventory, sso-health, observability registry, redaction
 * provider probes, webhook processingStatus rows, readiness posture).
 *
 * HONESTY CONTRACT (enforced by phase-admin-platform-health.test.ts):
 *   * A service is `healthy` ONLY when a real live signal proves it.
 *   * Providers with NO live probe in this build (OpenAI, Twilio,
 *     Resend, live Stripe/PayPal API, live TSA/OTS endpoints) are
 *     reported `unknown` or `not_connected` with an honest reason —
 *     NEVER a fabricated `healthy`.
 *   * A metric that cannot be measured is `null` + a reason, never a
 *     fabricated `0`.
 *   * Availability duration is NEVER fabricated — there is no such field.
 *   * NO secrets: no keys, tokens, connection strings, ARNs, bucket
 *     names beyond the operator-safe Object-Lock projection, or raw
 *     provider errors. Every string here is bounded + operator-safe.
 */

import { prisma } from "../../db.js";
import {
  runReadinessCheck,
  type ReadinessStatus,
  type SubsystemId,
} from "../../runtime/runtime-readiness.js";
import { probeSignerHealth } from "../operations/signer-health.service.js";
import { getQueueInventory } from "../operations/queue-inventory.service.js";
import { getWorkerFleetHealth } from "../operations/worker-liveness.service.js";
import { buildObservabilityHealth } from "../observability/registry.js";
import { computeReadinessPosture } from "../operations/readiness-posture.service.js";
import { probeAzureDocumentIntelligence } from "../redaction/providers/azure-document-intelligence-client.js";
import { probeDeepgram } from "../redaction/providers/deepgram-client.js";
import { probeRekognition } from "../redaction/providers/rekognition-client.js";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Honest service-status vocabulary.
 *   healthy       — a real live signal proves the service is up.
 *   degraded      — reachable but a real problem signal is present.
 *   critical      — a real signal proves the service is down / failing.
 *   unknown       — we could not measure it this cycle (probe error /
 *                   no live probe exists in this build). NOT "healthy".
 *   not_connected — the service is genuinely not wired / no credential
 *                   is bound. NOT "healthy".
 */
export type ServiceStatus =
  | "healthy"
  | "degraded"
  | "critical"
  /** Reported, but the reading is older than its freshness rule. */
  | "stale"
  /** Every instance shut down cleanly. Known, explained, and not running. */
  | "stopped"
  /** The source itself could not be read. Different from never having one. */
  | "unavailable"
  | "unknown"
  | "not_connected";

export type ServiceStatusRow = {
  key: string;
  label: string;
  status: ServiceStatus;
  lastCheckedAtUtc: string;
  lastSuccessAtUtc?: string | null;
  lastError?: string | null;
  latencyMs?: number | null;
  detail?: string | null;
};

/**
 * A live "Now" number is either a real measured value or `null` when
 * the signal is genuinely unreadable. Each carries an optional reason
 * so the UI can render an honest "Not measured" instead of a fake 0.
 */
export type NowMetric = {
  value: number | null;
  reason?: string | null;
};

export type PlatformNow = {
  generatedAtUtc: string;
  /** AuthenticatedSession rows seen in the last 5 minutes. */
  activeSessions: NowMetric;
  /** UploadSession rows in an in-progress status. */
  uploadsInProgress: NowMetric;
  /** BullMQ waiting + active + delayed across all known queues. */
  jobsPending: NowMetric;
  /** OperationalIncident rows OPEN or ACKNOWLEDGED. */
  openIncidents: NowMetric;
  /** AnalyticsEvent login_completed in the last 15 minutes. */
  recentLogins: NowMetric;
  /** AdminAuditLog rows in the last 15 minutes. */
  recentAuditEvents: NowMetric;
  /** Latest QueueTelemetrySnapshot sample age in seconds. */
  queueTelemetryAgeSeconds: NowMetric;
};

export type PlatformHealth = {
  generatedAtUtc: string;
  services: ServiceStatusRow[];
  now: PlatformNow;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_SESSION_WINDOW_MS = 5 * 60_000;
const RECENT_EVENT_WINDOW_MS = 15 * 60_000;
// ADM-013 — one authority. This was a local copy, and a second copy lived in
// evidence-health.service.ts while overview.service.ts used a THIRD, narrower
// predicate. See incident-open-statuses.ts.
import { UNRESOLVED_INCIDENT_STATUSES } from "../operations/incident-open-statuses.js";

const OPEN_INCIDENT_STATUSES = UNRESOLVED_INCIDENT_STATUSES;
const IN_PROGRESS_UPLOAD_STATUSES = ["CREATED", "UPLOADING", "PARTIAL"] as const;

/**
 * WHICH BUILD IS ACTUALLY RUNNING?
 *
 * "The fleet is live" cannot distinguish a live NEW deployment from a live
 * OLD one that never got replaced, which is exactly the question during a
 * rollout. The revision comes from the same variable Sentry and OTEL resolve
 * their release from, so an operator comparing the two cannot be told two
 * different stories.
 *
 * An instance that reported no revision reads "unknown" — deliberately a word
 * and not a blank, because a missing build identity is a fact worth seeing.
 * Distinct revisions are listed, so a half-finished rollout is visible rather
 * than averaged away.
 */
function describeFleetBuilds(
  instances: ReadonlyArray<{ buildRevision: string | null }>,
): string {
  if (instances.length === 0) return "";
  const revisions = [
    ...new Set(instances.map((i) => i.buildRevision ?? "unknown")),
  ];
  if (revisions.length === 1) {
    return `Build ${revisions[0]}.`;
  }
  return `Builds ${revisions.join(", ")} — the fleet is not on one revision.`;
}

/** Map a runtime-readiness ReadinessStatus onto our ServiceStatus vocabulary. */
function fromReadiness(status: ReadinessStatus): ServiceStatus {
  switch (status) {
    case "HEALTHY":
      return "healthy";
    case "DEGRADED":
      return "degraded";
    case "CRITICAL":
      return "critical";
    default:
      return "unknown";
  }
}

/** Run a count; return null (honest "not measured") on any failure. */
async function measured(run: () => Promise<number>): Promise<NowMetric> {
  try {
    return { value: await run() };
  } catch {
    return {
      value: null,
      reason: "Could not measure this signal on this cycle.",
    };
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function buildPlatformHealth(): Promise<PlatformHealth> {
  const nowIso = new Date().toISOString();

  // ---- Live probes (each isolated so one failure never sinks the page) ----
  const [
    readiness,
    signer,
    queueInventory,
    observability,
    posture,
  ] = await Promise.all([
    runReadinessCheck(prisma).catch(() => null),
    probeSignerHealth().catch(() => null),
    getQueueInventory().catch(() => null),
    Promise.resolve().then(() => {
      try {
        return buildObservabilityHealth();
      } catch {
        return null;
      }
    }),
    computeReadinessPosture(prisma).catch(() => null),
  ]);

  // SSO/SCIM is a PLATFORM view: buildSsoHealthSnapshot is per-team, so for
  // a platform status we honestly report whether any SsoConnection exists
  // at all rather than fabricating a team-scoped health.
  const ssoConnectionCount = await prisma.ssoConnection
    .count()
    .catch(() => null);

  const subsystemById = new Map<SubsystemId, ReadinessStatus>();
  const subsystemDetail = new Map<SubsystemId, string>();
  if (readiness) {
    for (const s of readiness.subsystems) {
      subsystemById.set(s.id, s.status);
      subsystemDetail.set(s.id, s.detail);
    }
  }

  const services: ServiceStatusRow[] = [];

  const pushSubsystem = (
    key: string,
    label: string,
    id: SubsystemId,
    fallbackDetail: string,
  ) => {
    const status = subsystemById.get(id);
    if (status === undefined) {
      services.push({
        key,
        label,
        status: "unknown",
        lastCheckedAtUtc: nowIso,
        lastError: readiness
          ? "Subsystem not present in the readiness report."
          : "Runtime readiness aggregator did not run this cycle.",
        detail: fallbackDetail,
      });
      return;
    }
    services.push({
      key,
      label,
      status: fromReadiness(status),
      lastCheckedAtUtc: readiness?.ranAtUtc ?? nowIso,
      detail: subsystemDetail.get(id) ?? fallbackDetail,
    });
  };

  // ---- API — if the readiness aggregator ran at all, the API is serving. ---
  services.push({
    key: "api",
    label: "API service",
    status: readiness ? "healthy" : "unknown",
    lastCheckedAtUtc: nowIso,
    detail: readiness
      ? "The API served this health request and ran the readiness aggregator."
      : "The readiness aggregator did not complete this cycle.",
  });

  // ---- Database / Redis / Storage / Object Lock / Workers / Queues ---------
  // All CONNECTED from the existing runtime-readiness live probes.
  pushSubsystem(
    "database",
    "Database (Postgres)",
    "database",
    "Live SELECT 1 probe via runtime-readiness.",
  );
  pushSubsystem(
    "redis",
    "Redis",
    "redis",
    "Live Redis ping via runtime-readiness.",
  );
  pushSubsystem(
    "storage",
    "Object storage (S3)",
    "multipart_storage",
    "Multipart storage reachability via runtime-readiness.",
  );
  pushSubsystem(
    "object_lock",
    "S3 Object Lock (WORM)",
    "s3_object_lock",
    "Object Lock configuration probe via runtime-readiness.",
  );
  /**
   * "BACKGROUND WORKERS" NOW MEANS THE WORKERS.
   *
   * This row used to be the readiness `workers` axis, which checks for a
   * recent `reviewer_reconcile_run` security event. That is an API-side
   * scheduled sweep, not the worker fleet. On a fixture with no cron secret
   * configured it read "Background workers — Degraded — Reconcile endpoint
   * cannot be authenticated", which is a true sentence about the wrong
   * subsystem: it says nothing at all about whether a worker is alive, and it
   * would have read exactly the same with a healthy fleet or with none.
   *
   * The row now comes from the same heartbeat projection the snapshot uses, so
   * this page and Observability cannot disagree. The reconcile sweep keeps its
   * own row below, under the name of the thing it actually measures.
   */
  const fleet = await getWorkerFleetHealth();
  services.push({
    key: "workers",
    label: "Background workers",
    status:
      fleet.state === "HEALTHY"
        ? "healthy"
        : fleet.state === "STALE"
          ? "stale"
          : fleet.state === "STOPPED"
            ? "stopped"
            : fleet.state === "UNAVAILABLE"
              ? "unavailable"
              : "unknown",
    // The last heartbeat, so a stale row shows how old the truth is rather
    // than the moment we happened to look.
    lastCheckedAtUtc: fleet.lastHeartbeatAtUtc ?? nowIso,
    detail:
      fleet.lastHeartbeatAtUtc === null
        ? fleet.reason
        : `${fleet.reason} Last heartbeat ${fleet.lastHeartbeatAgeSeconds}s ago; a worker is considered live for ${fleet.staleAfterSeconds}s after it reports. ${describeFleetBuilds(fleet.instances)}`,
    lastError: fleet.state === "UNAVAILABLE" ? fleet.reason : undefined,
  });

  pushSubsystem(
    "reviewer_reconcile",
    "Reviewer reconcile sweep",
    "workers",
    "Presence of a recent reviewer_reconcile_run security event. This is an API-side scheduled sweep, not worker liveness.",
  );
  pushSubsystem(
    "queues",
    "Job queues",
    "queues",
    "Queue reachability probe via runtime-readiness.",
  );

  // ---- KMS / Signing — live signer probe (KMS GetPublicKey or PEM check). --
  if (signer) {
    const signerStatus: ServiceStatus =
      signer.health === "healthy"
        ? "healthy"
        : signer.health === "unreachable" ||
            signer.health === "permission_denied" ||
            signer.health === "key_disabled" ||
            signer.health === "region_mismatch"
          ? "critical"
          : "degraded";
    services.push({
      key: "kms_signing",
      label: "KMS / Signing",
      status: signerStatus,
      lastCheckedAtUtc: signer.checkedAtUtc,
      lastError: signer.reason,
      detail: `Provider: ${signer.provider}. ${
        signer.recommendedAction ?? "Signer probe completed."
      }`,
    });
  } else {
    services.push({
      key: "kms_signing",
      label: "KMS / Signing",
      status: "unknown",
      lastCheckedAtUtc: nowIso,
      lastError: "Signer health probe did not complete this cycle.",
    });
  }

  // ---- TSA (RFC-3161) — NO live endpoint probe in this build. --------------
  services.push({
    key: "tsa",
    label: "Timestamp Authority (RFC-3161)",
    status: "unknown",
    lastCheckedAtUtc: nowIso,
    lastError:
      "No live TSA endpoint probe exists in this build. Preservation-failure counts are tracked per-evidence on the Evidence Operations console; this row does not claim live TSA reachability.",
  });

  // ---- OTS (OpenTimestamps) — NO live endpoint probe in this build. --------
  services.push({
    key: "ots",
    label: "OpenTimestamps calendar",
    status: "unknown",
    lastCheckedAtUtc: nowIso,
    lastError:
      "No live OpenTimestamps calendar probe exists in this build. Anchoring-failure counts are tracked per-evidence on the Evidence Operations console; this row does not claim live OTS reachability.",
  });

  // ---- SSO / SCIM — honest platform-level presence (per-team health lives
  //      on the org console). ------------------------------------------------
  services.push({
    key: "sso_scim",
    label: "SSO / SCIM",
    status:
      ssoConnectionCount == null
        ? "unknown"
        : ssoConnectionCount === 0
          ? "not_connected"
          : "healthy",
    lastCheckedAtUtc: nowIso,
    lastError:
      ssoConnectionCount == null
        ? "Could not read SSO connections this cycle."
        : null,
    detail:
      ssoConnectionCount == null
        ? null
        : ssoConnectionCount === 0
          ? "No SSO connections are configured on any workspace."
          : `${ssoConnectionCount} SSO connection(s) configured. Per-connection health is on each organization's console.`,
  });

  // ---- Redaction providers — live credential/env presence probes. ----------
  const azure = safeProbe(() => probeAzureDocumentIntelligence());
  const deepgram = safeProbe(() => probeDeepgram());
  const rekognition = safeProbe(() => probeRekognition());

  services.push(
    redactionRow(
      "redaction_azure",
      "Redaction · Azure Document Intelligence",
      azure?.state ?? null,
      azure?.reason ?? null,
      nowIso,
    ),
    redactionRow(
      "redaction_deepgram",
      "Redaction · Deepgram",
      deepgram?.state ?? null,
      deepgram?.reason ?? null,
      nowIso,
    ),
    redactionRow(
      "redaction_rekognition",
      "Redaction · AWS Rekognition",
      rekognition?.state ?? null,
      rekognition?.reason ?? null,
      nowIso,
    ),
  );

  // ---- Observability — live registry health. -------------------------------
  if (observability) {
    services.push({
      key: "observability",
      label: "Observability",
      status: !observability.enabled
        ? "not_connected"
        : observability.ready
          ? "healthy"
          : "degraded",
      lastCheckedAtUtc: nowIso,
      detail: !observability.enabled
        ? "Observability is not enabled (OBSERVABILITY_ENABLED is off)."
        : `Provider: ${observability.provider}. Ready: ${observability.ready}.`,
    });
  } else {
    services.push({
      key: "observability",
      label: "Observability",
      status: "unknown",
      lastCheckedAtUtc: nowIso,
      lastError: "Observability health could not be read this cycle.",
    });
  }

  // ---- Webhooks (Stripe / PayPal) — real processingStatus rows. ------------
  services.push(await buildWebhookRow("stripe", "Webhooks · Stripe", nowIso));
  services.push(await buildWebhookRow("paypal", "Webhooks · PayPal", nowIso));

  // ---- Backup / Restore — honest posture (never a fabricated positive). ----
  if (posture) {
    const b = posture.backup;
    // The launch gate is the honest signal: green only when backups are
    // independently verified AND a restore has been tested.
    const backupStatus: ServiceStatus = b.databaseBackupLaunchActionRequired
      ? "degraded"
      : "healthy";
    services.push({
      key: "backup_restore",
      label: "Backup / Restore",
      status: backupStatus,
      lastCheckedAtUtc: posture.generatedAtUtc,
      lastSuccessAtUtc: b.databaseBackupLastVerifiedAtUtc,
      detail: b.databaseBackupReason,
      lastError: b.databaseBackupLaunchActionRequired
        ? "Backups are not independently verified, or a restore has never been tested. This is an honest launch-action signal, not a live outage."
        : null,
    });
  } else {
    services.push({
      key: "backup_restore",
      label: "Backup / Restore",
      status: "unknown",
      lastCheckedAtUtc: nowIso,
      lastError: "Readiness posture could not be computed this cycle.",
    });
  }

  // ---- Third-party services with NO live probe — honest unknown. -----------
  // OpenAI / Twilio / Resend / live Stripe & PayPal API / live TSA & OTS are
  // NOT probed by any existing service, so we NEVER claim "healthy".
  for (const p of NOT_PROBED_PROVIDERS) {
    services.push({
      key: p.key,
      label: p.label,
      status: "unknown",
      lastCheckedAtUtc: nowIso,
      lastError: p.reason,
    });
  }

  // ---- Now panel — every number REAL or null-with-reason. ------------------
  const now = await buildNow(nowIso, queueInventory);

  return {
    generatedAtUtc: nowIso,
    services,
    now,
  };
}

// ---------------------------------------------------------------------------
// Providers with no live probe in this build — honest unknown, never healthy.
// ---------------------------------------------------------------------------

const NOT_PROBED_PROVIDERS: ReadonlyArray<{
  key: string;
  label: string;
  reason: string;
}> = [
  {
    key: "openai",
    label: "OpenAI",
    reason:
      "No live OpenAI health probe exists in this build. Status is not measured — this row does not claim reachability.",
  },
  {
    key: "twilio",
    label: "Twilio (SMS)",
    reason:
      "No live Twilio health probe exists in this build. Status is not measured.",
  },
  {
    key: "resend",
    label: "Resend (email)",
    reason:
      "No live Resend health probe exists in this build. Status is not measured.",
  },
  {
    key: "stripe_api",
    label: "Stripe API (live)",
    reason:
      "No live Stripe API reachability probe exists in this build. Webhook delivery health is reported separately from real processingStatus rows.",
  },
  {
    key: "paypal_api",
    label: "PayPal API (live)",
    reason:
      "No live PayPal API reachability probe exists in this build. Webhook delivery health is reported separately from real processingStatus rows.",
  },
];

// ---------------------------------------------------------------------------
// Redaction provider row mapping
// ---------------------------------------------------------------------------

function safeProbe<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

function redactionRow(
  key: string,
  label: string,
  state: string | null,
  reason: string | null,
  nowIso: string,
): ServiceStatusRow {
  // The provider probe vocabulary (RedactionDetectionProviderState) maps
  // onto our honest ServiceStatus: READY -> healthy (credentials bound),
  // NOT_CONFIGURED -> not_connected, RATE_LIMITED -> degraded,
  // ERROR -> critical, DISABLED_BY_POLICY -> not_connected.
  let status: ServiceStatus;
  switch (state) {
    case "READY":
      status = "healthy";
      break;
    case "RATE_LIMITED":
      status = "degraded";
      break;
    case "ERROR":
      status = "critical";
      break;
    case "NOT_CONFIGURED":
    case "DISABLED_BY_POLICY":
      status = "not_connected";
      break;
    default:
      status = "unknown";
  }
  return {
    key,
    label,
    status,
    lastCheckedAtUtc: nowIso,
    lastError: reason,
    detail:
      status === "healthy"
        ? "Credentials are bound (credential-presence probe; no cloud call is made)."
        : status === "not_connected"
          ? "Provider credentials are not bound for this platform."
          : null,
  };
}

// ---------------------------------------------------------------------------
// Webhook row — honest, from real processingStatus rows.
// ---------------------------------------------------------------------------

function isFailedProcessingStatus(status: string): boolean {
  const v = status.trim().toUpperCase();
  return (
    v === "FAILED" ||
    v === "ERROR" ||
    v === "ERRORED" ||
    v === "DEAD_LETTER" ||
    v === "REJECTED" ||
    v === "FAILED_PERMANENT"
  );
}

async function buildWebhookRow(
  provider: "stripe" | "paypal",
  label: string,
  nowIso: string,
): Promise<ServiceStatusRow> {
  const key = `webhook_${provider}`;
  try {
    const groups =
      provider === "stripe"
        ? await prisma.stripeWebhookEvent.groupBy({
            by: ["processingStatus"],
            _count: { processingStatus: true },
          })
        : await prisma.paypalWebhookEvent.groupBy({
            by: ["processingStatus"],
            _count: { processingStatus: true },
          });
    const last =
      provider === "stripe"
        ? await prisma.stripeWebhookEvent.findFirst({
            orderBy: [{ receivedAt: "desc" }],
            select: { receivedAt: true },
          })
        : await prisma.paypalWebhookEvent.findFirst({
            orderBy: [{ receivedAt: "desc" }],
            select: { receivedAt: true },
          });
    let total = 0;
    let failed = 0;
    for (const g of groups) {
      total += g._count.processingStatus;
      if (isFailedProcessingStatus(g.processingStatus)) {
        failed += g._count.processingStatus;
      }
    }
    // Zero rows ever received → genuinely not connected (honest), never
    // a fabricated "healthy".
    const status: ServiceStatus =
      total === 0 ? "not_connected" : failed > 0 ? "degraded" : "healthy";
    return {
      key,
      label,
      status,
      lastCheckedAtUtc: nowIso,
      lastSuccessAtUtc: last?.receivedAt?.toISOString() ?? null,
      detail:
        total === 0
          ? "No webhook events have ever been received from this provider."
          : `${total} event(s) received; ${failed} in a failed processing state.`,
    };
  } catch {
    return {
      key,
      label,
      status: "unknown",
      lastCheckedAtUtc: nowIso,
      lastError: "Could not read webhook processing status this cycle.",
    };
  }
}

// ---------------------------------------------------------------------------
// Now panel
// ---------------------------------------------------------------------------

async function buildNow(
  nowIso: string,
  queueInventory: Awaited<ReturnType<typeof getQueueInventory>> | null,
): Promise<PlatformNow> {
  const now = Date.now();
  const activeSince = new Date(now - ACTIVE_SESSION_WINDOW_MS);
  const recentSince = new Date(now - RECENT_EVENT_WINDOW_MS);

  const [
    activeSessions,
    uploadsInProgress,
    openIncidents,
    recentLogins,
    recentAuditEvents,
  ] = await Promise.all([
    measured(() =>
      prisma.authenticatedSession.count({
        where: {
          revokedAtUtc: null,
          OR: [
            { lastSeenAtUtc: { gte: activeSince } },
            { lastHeartbeatAtUtc: { gte: activeSince } },
          ],
        },
      }),
    ),
    measured(() =>
      prisma.uploadSession.count({
        where: { status: { in: [...IN_PROGRESS_UPLOAD_STATUSES] } },
      }),
    ),
    measured(() =>
      prisma.operationalIncident.count({
        where: { status: { in: [...OPEN_INCIDENT_STATUSES] } },
      }),
    ),
    measured(() =>
      prisma.analyticsEvent.count({
        where: { eventType: "login_completed", createdAt: { gte: recentSince } },
      }),
    ),
    measured(() =>
      prisma.adminAuditLog.count({
        where: { createdAt: { gte: recentSince } },
      }),
    ),
  ]);

  // jobsPending — reuse the queue inventory we already read (never re-hit
  // Redis here). Null-with-reason when the inventory was unreadable.
  let jobsPending: NowMetric;
  if (queueInventory) {
    let pending = 0;
    for (const q of queueInventory) {
      pending += q.counts.waiting + q.counts.active + q.counts.delayed;
    }
    jobsPending = { value: pending };
  } else {
    jobsPending = {
      value: null,
      reason: "Queue inventory was unreadable (worker/Redis not connected).",
    };
  }

  // queueTelemetryAgeSeconds — age of the latest persisted sample. Null
  // when no sample exists yet (honest "not measured").
  let queueTelemetryAgeSeconds: NowMetric;
  try {
    const latest = await prisma.queueTelemetrySnapshot.findFirst({
      orderBy: { sampledAtUtc: "desc" },
      select: { sampledAtUtc: true },
    });
    queueTelemetryAgeSeconds = latest
      ? { value: Math.floor((now - latest.sampledAtUtc.getTime()) / 1000) }
      : {
          value: null,
          reason: "No queue telemetry sample has been recorded yet.",
        };
  } catch {
    queueTelemetryAgeSeconds = {
      value: null,
      reason: "Could not read queue telemetry this cycle.",
    };
  }

  return {
    generatedAtUtc: nowIso,
    activeSessions,
    uploadsInProgress,
    jobsPending,
    openIncidents,
    recentLogins,
    recentAuditEvents,
    queueTelemetryAgeSeconds,
  };
}
