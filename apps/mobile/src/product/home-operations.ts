/**
 * HOME — the Operations, Analytics and Activity views.
 *
 * Ports the three tabs `SelfServeHomeDashboard` puts beside Overview:
 * workspace health, records-by-type, the evidence activity series, and the
 * activity feed.
 *
 * ===========================================================================
 * EVERY NUMBER IS THE SERVER'S, OR IT IS ABSENT
 * ===========================================================================
 * Records-by-type reads `GET /v1/dashboard/records-by-type`, which counts
 * EVERY active row in scope. The web has a second path that classifies a
 * sampled list client-side and marks the result `sampled`; Native does not
 * carry that path. A donut drawn from whatever happened to be on the first
 * page would be a picture of the page, not of the workspace.
 *
 * The activity series is the one place a sample is unavoidable — it is
 * bucketed from evidence timestamps — so the sample is REPORTED. A chart that
 * silently covers only part of the window is worse than one that says so.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

// ---------------------------------------------------------------------------
// Records by type
// ---------------------------------------------------------------------------

export const RECORDS_BY_TYPE_PATH = "/v1/dashboard/records-by-type";

/**
 * The canonical seven, in the canonical order.
 *
 * A category the server sends that is not one of these is DROPPED, exactly as
 * the web drops it: a client cannot fabricate a slice for a category the
 * product has no vocabulary for.
 */
export const HOME_EVIDENCE_CATEGORY_ORDER: readonly string[] = [
  "Images",
  "Documents",
  "Videos",
  "Audio",
  "Archives",
  "Folders",
  "Other Files",
];

export interface TypeSlice {
  key: string;
  label: string;
  count: number;
  percent: number;
}

export interface TypeDistribution {
  slices: TypeSlice[];
  total: number;
  /** True only when the counts do not cover every record in scope. */
  sampled: boolean;
}

export function parseRecordsByType(payload: unknown): TypeDistribution {
  const d = obj(payload);
  const byCategory = obj(d.byCategory);

  const counted = HOME_EVIDENCE_CATEGORY_ORDER.map((label) => {
    const raw = byCategory[label];
    return [label, typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0] as const;
  });

  const total =
    int(d.total) ?? counted.reduce((sum, [, count]) => sum + count, 0);

  return {
    slices: counted
      .filter(([, count]) => count > 0)
      .map(([label, count]) => ({
        key: label.toUpperCase().replace(/\s+/g, "_"),
        label,
        count,
        // Whole percents, as the web rounds them. They can sum to 99 or 101,
        // which is why the COUNT is what the row states and the percent only
        // sizes the bar.
        percent: total > 0 ? Math.round((count / total) * 100) : 0,
      })),
    total,
    // The aggregate endpoint covers every active row; nothing here is a sample.
    sampled: false,
  };
}

// ---------------------------------------------------------------------------
// Workspace health
// ---------------------------------------------------------------------------

export type HealthTone = "ok" | "warn" | "danger" | "neutral";

export interface HealthMetric {
  key: string;
  label: string;
  value: string;
  tone: HealthTone;
}

export interface HealthInputs {
  commandCenter?: unknown;
  trustSummary?: unknown;
  reports?: unknown;
  inbox?: unknown;
  activeCases?: number | null;
  storageLabel?: string | null;
  storagePercent?: number | null;
}

function pipeline(cc: unknown): Record<string, unknown> {
  return obj(obj(obj(obj(cc).sections).pipelineDetail).data);
}

/**
 * The eight rows, with the web's labels verbatim.
 *
 * Two of those labels are load-bearing and were corrected upstream for
 * honesty, so they are copied rather than paraphrased:
 *
 *   "Records with a report" — NOT "records complete". The metric counts
 *   evidence at status REPORTED, and "complete" reads as deliverable-complete,
 *   which it is not.
 *
 *   "Records with delivery issues" is kept separate from "Records flagged for
 *   review". The second counts verificationStatus flags only; folding a
 *   delivery failure into it would imply a content-integrity problem where
 *   there is none.
 */
export function buildWorkspaceHealth(inputs: HealthInputs): HealthMetric[] {
  const p = pipeline(inputs.commandCenter);
  const trust = obj(inputs.trustSummary);
  const reportsData = obj(inputs.reports);

  const reported = int(obj(p.evidence).reported) ?? 0;
  const signed = int(obj(p.evidence).signed) ?? 0;
  const needReport = int(obj(p.reports).missingFromSigned) ?? 0;

  const reportRows = rows(reportsData.items ?? reportsData.reports);
  const countStatus = (...wanted: string[]) =>
    reportRows.filter((r) => {
      const st = (str(obj(r).status) ?? "").toUpperCase();
      return wanted.includes(st);
    }).length;
  const reportsReady = countStatus("READY", "COMPLETED");
  const reportsFailed = countStatus("FAILED");

  const submissionsWaiting = rows(obj(inputs.inbox).items).filter((i) => {
    const kind = (str(obj(i).type) ?? str(obj(i).kind) ?? "").toUpperCase();
    return kind.includes("SUBMISSION") || kind.includes("INTAKE");
  }).length;

  // DOMAIN STATE, not one person's notification feed. The web records what
  // happened when this read the caller's inbox: a workspace's "integrity
  // issues" tile counted whatever was visible to one person at that moment
  // and fell when they archived something.
  const integrityIssues = int(trust.needingAttention) ?? 0;
  const operationalIssues =
    (int(trust.signedWithoutReport) ?? 0) +
    (int(trust.reportedWithoutPackage) ?? 0) +
    reportsFailed;

  // Warn, not neutral, when finalised evidence exists and no report is ready —
  // the failure is then visible to someone who only scans tones.
  const reportsReadyTone: HealthTone =
    reportsReady > 0 ? "ok" : signed > 0 ? "warn" : "neutral";

  const storagePercent = inputs.storagePercent;
  const storageTone: HealthTone =
    storagePercent === null || storagePercent === undefined
      ? "neutral"
      : storagePercent >= 90
        ? "danger"
        : storagePercent >= 75
          ? "warn"
          : "ok";

  return [
    { key: "complete", label: "Records with a report", value: String(reported), tone: reported > 0 ? "ok" : "neutral" },
    { key: "need_report", label: "Need a report", value: String(needReport), tone: needReport > 0 ? "warn" : "ok" },
    {
      key: "active_cases",
      label: "Active matters",
      // An unknown count is "—", never 0: a workspace whose cases could not be
      // read has not been told it has none.
      value: inputs.activeCases === null || inputs.activeCases === undefined ? "—" : String(inputs.activeCases),
      tone: "neutral",
    },
    { key: "submissions", label: "Submissions waiting", value: String(submissionsWaiting), tone: submissionsWaiting > 0 ? "warn" : "ok" },
    { key: "reports_ready", label: "Reports ready", value: String(reportsReady), tone: reportsReadyTone },
    { key: "operational", label: "Records with delivery issues", value: String(operationalIssues), tone: operationalIssues > 0 ? "danger" : "ok" },
    { key: "integrity", label: "Records flagged for review", value: String(integrityIssues), tone: integrityIssues > 0 ? "danger" : "ok" },
    { key: "storage", label: "Storage used", value: inputs.storageLabel ?? "—", tone: storageTone },
  ];
}

/** The single word the health card leads with. */
export function workspaceHealthOverall(
  metrics: ReadonlyArray<HealthMetric>,
): "healthy" | "needs_attention" | "action_required" {
  if (metrics.some((m) => m.tone === "danger")) return "action_required";
  if (metrics.some((m) => m.tone === "warn")) return "needs_attention";
  return "healthy";
}

export function healthToneBadge(tone: HealthTone): ProovraStatusTone {
  switch (tone) {
    case "ok":
      return "verified";
    case "warn":
      return "pending";
    case "danger":
      return "risk";
    case "neutral":
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// The evidence activity series
// ---------------------------------------------------------------------------

export interface ActivityBucket {
  label: string;
  count: number;
}

export interface ActivitySeries {
  buckets: ActivityBucket[];
  total: number;
  /**
   * True when the records the series was built from do not cover the window.
   *
   * REPORTED, never hidden: a chart that silently covers part of a window is
   * worse than one that says it is a sample.
   */
  sampled: boolean;
}

const DAY_MS = 86_400_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Fourteen daily buckets, oldest first, from evidence timestamps.
 *
 * The bucket is the LOCAL day, because the reader is reading their own days.
 */
export function buildActivitySeries(input: {
  createdAtIsoList: ReadonlyArray<string | null>;
  hasMore: boolean;
  nowMs?: number;
  days?: number;
}): ActivitySeries {
  const days = input.days ?? 14;
  const now = input.nowMs ?? Date.now();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const firstDay = startOfToday.getTime() - (days - 1) * DAY_MS;

  const counts = new Array<number>(days).fill(0);
  let total = 0;

  for (const iso of input.createdAtIsoList) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    const index = Math.round((d.getTime() - firstDay) / DAY_MS);
    if (index < 0 || index >= days) continue;
    counts[index] += 1;
    total += 1;
  }

  return {
    buckets: counts.map((count, i) => ({
      label: DAY_NAMES[new Date(firstDay + i * DAY_MS).getDay()],
      count,
    })),
    total,
    sampled: input.hasMore,
  };
}

export const ACTIVITY_SAMPLE_NOTE =
  "This covers the most recent records only, so earlier days may be undercounted.";

// ---------------------------------------------------------------------------
// The activity feed
// ---------------------------------------------------------------------------

export type ActivityGroupId = "today" | "yesterday" | "earlier";

export interface ActivityEvent {
  id: string;
  title: string;
  detail: string | null;
  atIso: string;
}

export interface ActivityGroup {
  id: ActivityGroupId;
  label: string;
  events: ActivityEvent[];
}

const GROUP_LABEL: Readonly<Record<ActivityGroupId, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

export function groupForTimestamp(atMs: number, nowMs: number): ActivityGroupId {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (atMs >= today) return "today";
  if (atMs >= today - DAY_MS) return "yesterday";
  return "earlier";
}

/**
 * The feed, from sources the Home screen already loads.
 *
 * Nothing is fetched for this and nothing is invented: an event exists only
 * because a record, a report or an intake link carries the timestamp it is
 * built from. An event with no timestamp is dropped rather than placed in
 * "Earlier", which would be a claim about when it happened.
 */
export function buildActivityGroups(input: {
  recentEvidence?: unknown;
  reports?: unknown;
  intakeLinks?: unknown;
  nowMs?: number;
  limit?: number;
}): ActivityGroup[] {
  const now = input.nowMs ?? Date.now();
  const events: ActivityEvent[] = [];

  for (const raw of rows(obj(input.recentEvidence).items)) {
    const e = obj(raw);
    const id = str(e.id);
    const at = str(e.createdAt);
    if (!id || !at) continue;
    events.push({
      id: `evidence:${id}`,
      title: str(e.title) ?? str(e.originalFileName) ?? "Evidence recorded",
      detail: str(e.status),
      atIso: at,
    });
  }

  for (const raw of rows(obj(input.reports).items ?? obj(input.reports).reports)) {
    const r = obj(raw);
    const id = str(r.id);
    const at = str(r.createdAt) ?? str(r.completedAt);
    if (!id || !at) continue;
    events.push({
      id: `report:${id}`,
      title: "Report",
      detail: str(r.status),
      atIso: at,
    });
  }

  for (const raw of rows(obj(input.intakeLinks).links)) {
    const l = obj(raw);
    const id = str(l.id);
    const at = str(l.createdAt);
    if (!id || !at) continue;
    events.push({
      id: `intake:${id}`,
      // The recipient's own label when there is one, never a raw id.
      title: str(l.recipientLabel) ?? str(l.workflowTemplateSlug) ?? "Intake link",
      detail: str(l.status),
      atIso: at,
    });
  }

  const limit = input.limit ?? 30;
  const ordered = events
    .map((e) => ({ e, t: Date.parse(e.atIso) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit);

  const groups: Record<ActivityGroupId, ActivityEvent[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const { e, t } of ordered) groups[groupForTimestamp(t, now)].push(e);

  return (["today", "yesterday", "earlier"] as ActivityGroupId[])
    .map((id) => ({ id, label: GROUP_LABEL[id], events: groups[id] }))
    .filter((g) => g.events.length > 0);
}
