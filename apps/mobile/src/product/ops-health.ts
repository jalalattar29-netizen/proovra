/**
 * WORKSPACE HEALTH (T-11 / RC-12) — the native port of `/operations/health`
 * (`apps/web/app/(app)/operations/health/page.tsx`, abbreviated H).
 *
 * Two reads, polled every 30 s: `GET /v1/teams/{id}/operations/health` and
 * `…/operations/alerts`. PURE: paths, parsers, vocabulary, copy.
 *
 * The server orders alerts most severe first, counts over EVERY unresolved
 * condition, and says whether the capped list is the whole set (`complete`);
 * native re-sorts defensively and states the cap when the list is not complete.
 */
import type { ProovraStatusTone } from "@proovra/ui";
import { SEVERITY_VOCABULARY, categoryLabel, parseConditionMessage, severityOf, type ConditionMessageRef, type Severity } from "./ops-console";

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

/**
 * The server's states (workspace-operations.routes.ts): CRITICAL, DEGRADED
 * (high), ATTENTION (unresolved, none critical/high), HEALTHY (nothing
 * unresolved AND the discovery gate permits saying so), UNKNOWN (nothing
 * unresolved but discovery cannot vouch for it — `unknownReason` says why).
 * Anything else the server might send reads as UNKNOWN, never as healthy.
 */
export type HealthState = "HEALTHY" | "ATTENTION" | "DEGRADED" | "CRITICAL" | "UNKNOWN";

/** H:124-161 */
export const STATE_WORD: Readonly<Record<HealthState, string>> = {
  HEALTHY: "Healthy",
  ATTENTION: "Needs attention",
  DEGRADED: "Degraded",
  CRITICAL: "Critical",
  UNKNOWN: "Unknown",
};
export const STATE_TONE: Readonly<Record<HealthState, ProovraStatusTone>> = {
  HEALTHY: "verified",
  ATTENTION: "governance",
  DEGRADED: "pending",
  CRITICAL: "risk",
  UNKNOWN: "neutral",
};
/** Health's own severity tones (WARNING amber here, not Operations' purple). */
export function healthSeverityTone(s: Severity): ProovraStatusTone {
  return s === "CRITICAL" ? "risk" : s === "HIGH" || s === "WARNING" ? "pending" : "neutral";
}

/** The state's sentence, in English (`healthCopyFor(locale).reason` for the screen). */
export function stateReason(state: HealthState, unknownReason: string | null = null): string {
  return healthStateReason(HEALTH_STATE_EN, state, unknownReason);
}

export interface HealthPosture {
  readonly state: HealthState;
  /** Why the state is UNKNOWN (NEVER_RUN, STALE, FAILED, PARTIAL_SOURCES, …); null otherwise. */
  readonly unknownReason: string | null;
  readonly readiness: string | null;
  /** Unresolved conditions — OPEN, ACKNOWLEDGED or SUPPRESSED. Null when not sent. */
  readonly unresolved: number | null;
  /** OPEN only: unresolved and not yet acknowledged by anybody. Null when not sent. */
  readonly untriaged: number | null;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly lastActivityUtc: string | null;
  readonly evaluatedAtUtc: string;
}

export function parseHealth(v: unknown): HealthPosture {
  const d = obj(v);
  const s = d["state"];
  const open = obj(d["openIncidents"]);
  const by: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(open["bySeverity"]))) if (typeof n === "number") by[k] = n;
  const state: HealthState = s === "HEALTHY" || s === "ATTENTION" || s === "DEGRADED" || s === "CRITICAL" ? s : "UNKNOWN";
  return {
    state,
    unknownReason: state === "UNKNOWN" ? (str(d["unknownReason"]) ?? (s === "UNKNOWN" ? null : "UNRECOGNISED_STATE")) : null,
    readiness: str(d["readiness"]),
    // `openIncidents.total` and `unresolvedIncidents` are the SAME unresolved set.
    unresolved: num(d["unresolvedIncidents"]) ?? num(open["total"]),
    untriaged: num(d["untriagedIncidents"]),
    bySeverity: by,
    lastActivityUtc: str(d["lastIncidentActivityUtc"]),
    evaluatedAtUtc: str(d["evaluatedAtUtc"]) ?? "",
  };
}

/* ------------------------------------------------------------ localized state copy */

export interface HealthStateCopy {
  readonly word: Readonly<Record<HealthState, string>>;
  readonly critical: string;
  readonly degraded: string;
  readonly attention: string;
  readonly healthy: string;
  readonly unknown: Readonly<Record<string, string>> & { readonly default: string };
  readonly unresolvedLabel: string;
  readonly untriagedLabel: string;
  readonly bySeverityOpen: string;
  readonly lastActivity: string;
  readonly evaluated: string;
}

const HEALTH_STATE_EN: HealthStateCopy = {
  word: STATE_WORD,
  critical: "At least one critical condition is unresolved in this workspace.",
  degraded: "At least one high-severity condition is unresolved in this workspace.",
  attention: "Unresolved conditions are recorded in this workspace; none is critical or high severity.",
  healthy: "No unresolved conditions, and the latest complete check of this workspace found none.",
  unknown: {
    NEVER_RUN: "This workspace has not been checked for operational conditions yet, so its health cannot be stated.",
    RUNNING: "A check of this workspace is running. Its health will be stated when the check finishes.",
    STALE: "The last check of this workspace is too old to vouch for its health now.",
    FAILED: "The last check of this workspace failed, so its health cannot be stated.",
    STALLED: "The last check of this workspace stopped before finishing, so its health cannot be stated.",
    PARTIAL_SOURCES: "Some checks of this workspace did not complete, so its health cannot be stated.",
    TRUNCATED_SOURCE: "Some checks returned more than they could read, so this workspace's health cannot be stated.",
    INCIDENT_READ_INCOMPLETE: "The workspace's conditions could not be read completely, so its health cannot be stated.",
    default: "This workspace's health could not be confirmed. That is not the same as healthy.",
  },
  unresolvedLabel: "Unresolved conditions",
  untriagedLabel: "Not yet acknowledged",
  bySeverityOpen: "{severity} · {n} unresolved",
  lastActivity: "Last condition activity",
  evaluated: "Evaluated",
};

const HEALTH_STATE_DE: HealthStateCopy = {
  word: { HEALTHY: "Unauffällig", ATTENTION: "Beachtung nötig", DEGRADED: "Beeinträchtigt", CRITICAL: "Kritisch", UNKNOWN: "Unbekannt" },
  critical: "Mindestens ein kritischer Zustand ist in diesem Arbeitsbereich ungelöst.",
  degraded: "Mindestens ein Zustand mit hohem Schweregrad ist in diesem Arbeitsbereich ungelöst.",
  attention: "In diesem Arbeitsbereich sind ungelöste Zustände erfasst; keiner ist kritisch oder hoch.",
  healthy: "Keine ungelösten Zustände, und die letzte vollständige Prüfung dieses Arbeitsbereichs fand keine.",
  unknown: {
    NEVER_RUN: "Dieser Arbeitsbereich wurde noch nicht auf betriebliche Zustände geprüft, daher lässt sich sein Zustand nicht angeben.",
    RUNNING: "Eine Prüfung dieses Arbeitsbereichs läuft. Der Zustand wird angegeben, sobald sie abgeschlossen ist.",
    STALE: "Die letzte Prüfung dieses Arbeitsbereichs ist zu alt, um seinen Zustand jetzt zu belegen.",
    FAILED: "Die letzte Prüfung dieses Arbeitsbereichs ist fehlgeschlagen, daher lässt sich sein Zustand nicht angeben.",
    STALLED: "Die letzte Prüfung dieses Arbeitsbereichs wurde vor dem Abschluss beendet, daher lässt sich sein Zustand nicht angeben.",
    PARTIAL_SOURCES: "Einige Prüfungen dieses Arbeitsbereichs wurden nicht abgeschlossen, daher lässt sich sein Zustand nicht angeben.",
    TRUNCATED_SOURCE: "Einige Prüfungen lieferten mehr, als gelesen werden konnte, daher lässt sich der Zustand nicht angeben.",
    INCIDENT_READ_INCOMPLETE: "Die Zustände des Arbeitsbereichs konnten nicht vollständig gelesen werden, daher lässt sich sein Zustand nicht angeben.",
    default: "Der Zustand dieses Arbeitsbereichs konnte nicht bestätigt werden. Das ist nicht dasselbe wie unauffällig.",
  },
  unresolvedLabel: "Ungelöste Zustände",
  untriagedLabel: "Noch nicht bestätigt",
  bySeverityOpen: "{severity} · {n} ungelöst",
  lastActivity: "Letzte Aktivität eines Zustands",
  evaluated: "Ausgewertet",
};

const HEALTH_STATE_AR: HealthStateCopy = {
  word: { HEALTHY: "سليمة", ATTENTION: "تحتاج إلى انتباه", DEGRADED: "متدهورة", CRITICAL: "حرجة", UNKNOWN: "غير معروفة" },
  critical: "توجد حالة حرجة واحدة على الأقل غير محلولة في مساحة العمل هذه.",
  degraded: "توجد حالة واحدة على الأقل عالية الخطورة غير محلولة في مساحة العمل هذه.",
  attention: "توجد حالات غير محلولة في مساحة العمل هذه؛ ليست أيٌّ منها حرجة أو عالية الخطورة.",
  healthy: "لا توجد حالات غير محلولة، ولم يعثر آخر فحص مكتمل لمساحة العمل هذه على أي منها.",
  unknown: {
    NEVER_RUN: "لم تُفحص مساحة العمل هذه بعد بحثًا عن حالات تشغيلية، لذا لا يمكن تحديد سلامتها.",
    RUNNING: "يجري فحص مساحة العمل هذه. ستُحدَّد سلامتها عند انتهاء الفحص.",
    STALE: "آخر فحص لمساحة العمل هذه قديم جدًا ولا يكفي لتأكيد سلامتها الآن.",
    FAILED: "فشل آخر فحص لمساحة العمل هذه، لذا لا يمكن تحديد سلامتها.",
    STALLED: "توقف آخر فحص لمساحة العمل هذه قبل اكتماله، لذا لا يمكن تحديد سلامتها.",
    PARTIAL_SOURCES: "لم تكتمل بعض فحوص مساحة العمل هذه، لذا لا يمكن تحديد سلامتها.",
    TRUNCATED_SOURCE: "أعادت بعض الفحوص أكثر مما أمكن قراءته، لذا لا يمكن تحديد سلامة مساحة العمل هذه.",
    INCIDENT_READ_INCOMPLETE: "تعذّرت قراءة حالات مساحة العمل بالكامل، لذا لا يمكن تحديد سلامتها.",
    default: "تعذّر تأكيد سلامة مساحة العمل هذه. هذا لا يعني أنها سليمة.",
  },
  unresolvedLabel: "حالات غير محلولة",
  untriagedLabel: "لم تُؤكَّد بعد",
  bySeverityOpen: "{severity} · {n} غير محلولة",
  lastActivity: "آخر نشاط لحالة",
  evaluated: "وقت التقييم",
};

export function healthCopyFor(locale: string | null | undefined): HealthStateCopy {
  return locale === "de" ? HEALTH_STATE_DE : locale === "ar" ? HEALTH_STATE_AR : HEALTH_STATE_EN;
}

export function healthStateReason(c: HealthStateCopy, state: HealthState, unknownReason: string | null): string {
  switch (state) {
    case "CRITICAL":
      return c.critical;
    case "DEGRADED":
      return c.degraded;
    case "ATTENTION":
      return c.attention;
    case "HEALTHY":
      return c.healthy;
    default:
      return (unknownReason && c.unknown[unknownReason]) || c.unknown.default;
  }
}

export interface HealthAlert {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly safeSummary: string | null;
  /** The code the title/summary were rendered from; null from a legacy row or an older server. */
  readonly message: ConditionMessageRef | null;
  readonly category: string;
  readonly categoryLabel: string;
  readonly firstSeenAtUtc: string;
  readonly lastSeenAtUtc: string;
  readonly occurrenceCount: number;
}

export function parseAlerts(v: unknown): { items: HealthAlert[]; evaluatedAtUtc: string; capped: boolean; total: number | null } {
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
        title: str(o["title"]) ?? "",
        safeSummary: str(o["safeSummary"]),
        message: parseConditionMessage(o["message"]),
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
  // The server says whether the list is the whole unresolved set (`complete`);
  // an older server did not, and exactly ALERTS_CAP rows then means "maybe more".
  const capped = typeof d["complete"] === "boolean" ? d["complete"] === false : raw.length >= ALERTS_CAP;
  return { items, evaluatedAtUtc: str(d["evaluatedAtUtc"]) ?? "", capped, total: num(obj(d["counts"])["total"]) };
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
  capped: `Showing the first ${ALERTS_CAP} conditions, most severe first. Open the conditions queue to see and filter all of them.`,
  noActivity: "No activity recorded",
  footnote:
    "Platform runtime — process counters, queue depth, worker heartbeat and dependency probes — is not shown here. It is identical for every workspace on the instance and is administered by PROOVRA platform staff.",
} as const;

export const SEVERITY_ORDER: readonly Severity[] = ["CRITICAL", "HIGH", "WARNING", "INFO"];
