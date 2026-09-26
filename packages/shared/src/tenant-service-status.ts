/**
 * TENANT SERVICE STATUS — the one client-side reading of `GET /v1/runtime/status`.
 *
 * The route answers in terms of what a user can DO:
 *
 *   { status, capabilities: { uploads, artifactGeneration, downloads, search,
 *     reviewAutomation }, checkedAt }
 *
 * Web and mobile both parse and word it through this module, so the same
 * response cannot mean different things on two clients.
 *
 * What it deliberately never says: that a record is incomplete, corrupt or
 * stale. A platform capability being slow is a statement about an ACTION
 * (generating, uploading, downloading, searching), never about evidence
 * already recorded. Record-specific processing and integrity have their own
 * authorities (the output lifecycle and the integrity projection).
 *
 * Pure: no fetch, no React.
 */

export const TENANT_SERVICE_CAPABILITIES = [
  "uploads",
  "artifactGeneration",
  "downloads",
  "search",
  "reviewAutomation",
] as const;
export type TenantServiceCapability = (typeof TENANT_SERVICE_CAPABILITIES)[number];

/** The capabilities every user depends on. `reviewAutomation` is reviewer-only. */
export const CORE_TENANT_SERVICE_CAPABILITIES: ReadonlyArray<TenantServiceCapability> = [
  "uploads",
  "artifactGeneration",
  "downloads",
  "search",
];

export type TenantServiceCapabilityStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";

export type TenantServiceStatus = {
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  capabilities: Record<TenantServiceCapability, TenantServiceCapabilityStatus>;
  checkedAt: string | null;
};

const CAPABILITY_STATUSES: ReadonlyArray<TenantServiceCapabilityStatus> = [
  "HEALTHY",
  "DEGRADED",
  "UNAVAILABLE",
  "UNKNOWN",
];

function readCapability(v: unknown): TenantServiceCapabilityStatus {
  return typeof v === "string" && (CAPABILITY_STATUSES as readonly string[]).includes(v)
    ? (v as TenantServiceCapabilityStatus)
    : "UNKNOWN";
}

/**
 * Parse a response. Anything unrecognised is UNKNOWN — never HEALTHY.
 *
 * A server that predates capabilities answers only `status`: HEALTHY then
 * means every capability is healthy; anything else is not attributable to a
 * capability and reads UNKNOWN, so no client invents which action is broken.
 */
export function parseTenantServiceStatus(payload: unknown): TenantServiceStatus {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const raw = d.status;
  const status: TenantServiceStatus["status"] =
    raw === "HEALTHY" || raw === "DEGRADED" || raw === "UNAVAILABLE" ? raw : "UNAVAILABLE";
  const caps =
    d.capabilities && typeof d.capabilities === "object"
      ? (d.capabilities as Record<string, unknown>)
      : null;
  const capabilities = Object.fromEntries(
    TENANT_SERVICE_CAPABILITIES.map((c) => [
      c,
      caps ? readCapability(caps[c]) : status === "HEALTHY" ? "HEALTHY" : "UNKNOWN",
    ]),
  ) as TenantServiceStatus["capabilities"];
  return {
    status,
    capabilities,
    checkedAt: typeof d.checkedAt === "string" ? d.checkedAt : null,
  };
}

/** The user-facing sentence for one capability in one state. Null when healthy. */
export function tenantServiceMessage(
  capability: TenantServiceCapability,
  status: TenantServiceCapabilityStatus,
): string | null {
  if (status === "HEALTHY") return null;
  const copy: Record<TenantServiceCapability, Record<Exclude<TenantServiceCapabilityStatus, "HEALTHY">, string>> = {
    artifactGeneration: {
      DEGRADED:
        "Report and package generation is delayed. Requests are queued and will complete automatically.",
      UNAVAILABLE: "Report and package generation is temporarily unavailable. Try again later.",
      UNKNOWN: "Report and package generation status can't be confirmed right now.",
    },
    uploads: {
      DEGRADED: "Uploads may be slower than usual.",
      UNAVAILABLE: "Uploads are temporarily unavailable. Try again later.",
      UNKNOWN: "Upload service status can't be confirmed right now.",
    },
    downloads: {
      DEGRADED: "Downloads may be slower than usual.",
      UNAVAILABLE: "Downloads are temporarily unavailable. Try again later.",
      UNKNOWN: "Download service status can't be confirmed right now.",
    },
    search: {
      DEGRADED: "Search results may be delayed.",
      UNAVAILABLE: "Search is temporarily unavailable.",
      UNKNOWN: "Search status can't be confirmed right now.",
    },
    reviewAutomation: {
      DEGRADED: "Review SLA tracking and escalations may be delayed.",
      UNAVAILABLE: "Review SLA tracking and escalations are temporarily paused.",
      UNKNOWN: "Review SLA tracking status can't be confirmed right now.",
    },
  };
  return copy[capability][status];
}

export type TenantServiceNotice = {
  capability: TenantServiceCapability;
  status: Exclude<TenantServiceCapabilityStatus, "HEALTHY">;
  message: string;
};

/**
 * CONTEXTUAL: the notices for the capabilities THIS action depends on.
 *
 * Only confirmed impact (DEGRADED / UNAVAILABLE). "Could not measure" is not
 * placed beside an action — the global indicator says it once — because an
 * unverified warning next to a working button is exactly the false alarm this
 * contract removes.
 */
export function contextualServiceNotices(
  status: TenantServiceStatus | null,
  requires: ReadonlyArray<TenantServiceCapability>,
): TenantServiceNotice[] {
  if (!status) return [];
  const out: TenantServiceNotice[] = [];
  for (const capability of requires) {
    const s = status.capabilities[capability];
    if (s !== "DEGRADED" && s !== "UNAVAILABLE") continue;
    out.push({ capability, status: s, message: tenantServiceMessage(capability, s)! });
  }
  return out;
}

export type TenantServiceSummary =
  | { level: "OK" }
  | {
      /** ISSUE: a confirmed impact. UNKNOWN: nothing confirmed, something unmeasured. */
      level: "ISSUE" | "UNKNOWN";
      label: string;
      notices: TenantServiceNotice[];
    };

/**
 * GLOBAL: what the header indicator shows. Core capabilities only, so reviewer
 * automation never alarms a user who does no reviewing. `null` status (the read
 * itself failed) is UNKNOWN, never OK.
 */
export function summarizeTenantServiceStatus(
  status: TenantServiceStatus | null,
): TenantServiceSummary {
  if (!status) {
    return {
      level: "UNKNOWN",
      label: "Status unavailable",
      notices: [],
    };
  }
  const notices: TenantServiceNotice[] = [];
  let unknown = false;
  for (const capability of CORE_TENANT_SERVICE_CAPABILITIES) {
    const s = status.capabilities[capability];
    if (s === "HEALTHY") continue;
    if (s === "UNKNOWN") unknown = true;
    notices.push({ capability, status: s, message: tenantServiceMessage(capability, s)! });
  }
  if (notices.some((n) => n.status !== "UNKNOWN")) {
    return { level: "ISSUE", label: "Service issue", notices };
  }
  if (unknown) return { level: "UNKNOWN", label: "Status unavailable", notices };
  return { level: "OK" };
}
