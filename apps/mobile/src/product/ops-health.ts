/**
 * WORKSPACE HEALTH (T-11 / RC-12) — the native port of `/operations/health`
 * (`apps/web/app/(app)/operations/health/page.tsx`, abbreviated H).
 *
 * Two reads, polled every 30 s: `GET /v1/teams/{id}/operations/health` and
 * `…/operations/alerts`. PURE: paths, parsers, vocabulary, copy.
 *
 * DIFFERENCES FROM THE WEB, BOTH DELIBERATE (T-11 spec §10):
 *   - The API orders alerts `severity: "asc"` over the enum
 *     INFO < WARNING < HIGH < CRITICAL, so the web table lists the LEAST severe
 *     first. Native sorts most severe first — the order the page is read in.
 *   - The API caps the list at 100 (`take: 100`) and the web never says so.
 *     Native states it when exactly 100 rows arrive.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import { SEVERITY_VOCABULARY, categoryLabel, severityOf, type Severity } from "./ops-console";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const HEALTH_POLL_MS = 30_000;
export const ALERTS_CAP = 100;
export function buildWorkspaceHealthPath(workspaceId: string): string {
  return `/v1/teams/${encodeURIComponent(workspaceId)}/operations/health`;
}
export function buildWorkspaceAlertsPath(workspaceId: string): string {
  return `/v1/teams/${encodeURIComponent(workspaceId)}/operations/alerts`;
}

export type HealthState = "HEALTHY" | "DEGRADED" | "CRITICAL" | "STALE" | "UNKNOWN";

/** H:124-161 */
export const STATE_WORD: Readonly<Record<HealthState, string>> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  CRITICAL: "Critical",
  STALE: "Stale",
  UNKNOWN: "Unknown",
};
export const STATE_TONE: Readonly<Record<HealthState, ProovraStatusTone>> = {
  HEALTHY: "verified",
  DEGRADED: "pending",
  CRITICAL: "risk",
  STALE: "pending",
  UNKNOWN: "neutral",
};
/** Health's own severity tones (WARNING amber here, not Operations' purple — spec §11). */
export function healthSeverityTone(s: Severity): ProovraStatusTone {
  return s === "CRITICAL" ? "risk" : s === "HIGH" || s === "WARNING" ? "pending" : "neutral";
}

export function stateReason(state: HealthState): string {
  if (state === "CRITICAL") return "At least one critical condition is open in this workspace.";
  if (state === "DEGRADED") return "At least one high-severity condition is open in this workspace.";
  return "No critical or high-severity conditions are open in this workspace.";
}

export interface HealthPosture {
  readonly state: HealthState;
  readonly openTotal: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly unresolved: number;
  readonly lastActivityUtc: string | null;
  readonly evaluatedAtUtc: string;
}

export function parseHealth(v: unknown): HealthPosture {
  const d = obj(v);
  const s = d["state"];
  const open = obj(d["openIncidents"]);
  const by: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(open["bySeverity"]))) if (typeof n === "number") by[k] = n;
  return {
    state: s === "HEALTHY" || s === "DEGRADED" || s === "CRITICAL" || s === "STALE" ? s : "UNKNOWN",
    openTotal: num(open["total"]) ?? 0,
    bySeverity: by,
    unresolved: num(d["unresolvedIncidents"]) ?? 0,
    lastActivityUtc: str(d["lastIncidentActivityUtc"]),
    evaluatedAtUtc: str(d["evaluatedAtUtc"]) ?? "",
  };
}

export interface HealthAlert {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly safeSummary: string | null;
  readonly category: string;
  readonly categoryLabel: string;
  readonly firstSeenAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly occurrenceCount: number;
}

export function parseAlerts(v: unknown): { items: HealthAlert[]; evaluatedAtUtc: string; capped: boolean } {
  const d = obj(v);
  const raw = Array.isArray(d["items"]) ? (d["items"] as unknown[]) : [];
  const items = raw
    .map((x): HealthAlert | null => {
      const o = obj(x);
      const id = str(o["id"]);
      if (!id) return null;
      const category = str(o["category"]) ?? "";
      return {
        id,
        severity: severityOf(o["severity"]),
        title: str(o["title"]) ?? "Operational condition",
        safeSummary: str(o["safeSummary"]),
        category,
        categoryLabel: categoryLabel(category),
        firstSeenAtUtc: str(o["firstSeenAtUtc"]) ?? "",
        lastSeenAtUtc: str(o["lastSeenAtUtc"]) ?? "",
        occurrenceCount: num(o["occurrenceCount"]) ?? 1,
      };
    })
    .filter((x): x is HealthAlert => x !== null)
    // Most severe first; within a severity, most recent first.
    .sort(
      (a, b) =>
        SEVERITY_VOCABULARY[b.severity].rank - SEVERITY_VOCABULARY[a.severity].rank ||
        b.lastSeenAtUtc.localeCompare(a.lastSeenAtUtc),
    );
  return { items, evaluatedAtUtc: str(d["evaluatedAtUtc"]) ?? "", capped: raw.length >= ALERTS_CAP };
}

export const HEALTH_COPY = {
  title: "Workspace health",
  subtitle: (name: string) =>
    `Unresolved operational conditions recorded against ${name}. Every figure below is a record in this workspace — none of it is platform runtime.`,
  noWorkspace: "No workspace is currently selected. Workspace health describes one workspace at a time.",
  /**
   * The route gate (routeRegistry.ts:1164-1172, WORKSPACE_HEALTH_VIEW) in the
   * canonical denial vocabulary (packages/shared denial-vocabulary.ts
   * PERMISSION_REQUIRED). The web prints its resolver reason instead —
   * "Missing required capability: WORKSPACE_HEALTH_VIEW" — a capability key.
   */
  deniedTitle: "Permission required",
  deniedBody: "Your current role does not include this capability. An admin can grant access.",
  scope: "Scope: Workspace",
  postureTitle: "Current posture",
  evaluating: "Evaluating…",
  postureUnavailable: (message: string, at: string) =>
    `${message} Attempted ${at}. This is not a statement that the workspace is healthy — the evaluation did not complete.`,
  postureFallback: "Workspace health could not be evaluated.",
  listTitle: "Unresolved conditions",
  openQueue: "Open the conditions queue",
  listLoading: "Loading…",
  listUnavailable: (message: string, at: string) =>
    `${message} Attempted ${at}. The list below is not empty because there is nothing to show; it is empty because it could not be read.`,
  listFallback: "Workspace conditions could not be listed.",
  listEmpty: (at: string) => `No unresolved conditions are recorded against this workspace as of ${at}.`,
  capped: `Showing the first ${ALERTS_CAP} conditions. Open the conditions queue to see and filter all of them.`,
  noActivity: "No activity recorded",
  footnote:
    "Platform runtime — process counters, queue depth, worker heartbeat and dependency probes — is not shown here. It is identical for every workspace on the instance and is administered by PROOVRA platform staff.",
} as const;

export const SEVERITY_ORDER: readonly Severity[] = ["CRITICAL", "HIGH", "WARNING", "INFO"];
