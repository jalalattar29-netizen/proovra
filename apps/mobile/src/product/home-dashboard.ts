/**
 * HOME DASHBOARD — pure projections for the native Home overview.
 *
 * Ports the canonical web Home
 * (`apps/web/components/home-experience/SelfServeHomeDashboard.tsx` over
 * `useHomeData.ts` + `home-view-model.ts`).
 *
 * Native Home read TWO sources (`/v1/dashboard/trust-summary`, `/v1/evidence`)
 * where the web reads seven, so it was not under-styled — it was data-starved,
 * and no amount of layout work could have filled it.
 *
 * The canonical reads, and what each one answers:
 *   /v1/dashboard/command-center?teamId=  pipeline, matters, attention items
 *   /v1/dashboard/trust-summary?teamId=   real integrity/verification posture
 *   /v1/billing/overview                  storage against the plan
 *   /v1/reports?teamId=                   reports and packages produced
 *   /v1/workflow/intake-links?teamId=     active intake links
 *   /v1/me/inbox                          submissions and items awaiting review
 *   /v1/evidence?scope=active             the most recent captures
 *
 * The web renders four tabs (Overview / Operations / Analytics / Activity).
 * This ports the OVERVIEW tab — the executive summary, the five KPIs, the
 * priority queue and recent work. The other three are analytics surfaces whose
 * native disposition is recorded in the ledger, not silently dropped.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

/* ----------------------------------------------------------------- helpers */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/** Thousands separators, matching the web's KPI formatting. */
export function formatKpiNumber(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

/** A percentage, or the honest em dash when the denominator is zero. */
export function formatPercent(part: number | null, whole: number | null): string {
  if (part === null || whole === null || whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/* --------------------------------------------------------------- the inputs */

export interface HomeSources {
  commandCenter?: unknown;
  trustSummary?: unknown;
  billingOverview?: unknown;
  reports?: unknown;
  intakeLinks?: unknown;
  inbox?: unknown;
  recentEvidence?: unknown;
}

/* ------------------------------------------------------------------- KPIs */

export type HomeKpiKey = "evidence" | "matters" | "trust" | "deliverables" | "intake";

export interface HomeKpi {
  key: HomeKpiKey;
  label: string;
  /** Pre-formatted display value ("334", "92%", "12 / 3"). */
  value: string;
  /** One line: what the number means, never a restatement of the label. */
  subtitle: string;
  tone: ProovraStatusTone;
  /** Where tapping the card goes. */
  href: string;
}

/**
 * The five canonical KPIs, with the web's labels and hrefs verbatim.
 *
 * An absent source yields "—" rather than 0. A zero and an unknown are
 * different facts, and showing "0 evidence" to someone whose dashboard failed
 * to load is a lie the surface can avoid telling.
 */
export function buildHomeKpis(s: HomeSources): HomeKpi[] {
  const cc = obj(s.commandCenter);
  const trust = obj(s.trustSummary);

  const totalEvidence = int(obj(cc.evidence).total) ?? int(trust.totalEvidence);
  const caseCount = int(obj(cc.cases).active) ?? int(cc.activeCases);

  const verified = int(trust.endToEndReady) ?? int(trust.verifiedCount);
  const trustTotal = int(trust.totalEvidence) ?? totalEvidence;

  const reportsReady = int(obj(s.reports).readyCount) ?? (rows(obj(s.reports).items).length || null);
  const packagesReady = int(obj(s.reports).packagesReady);

  const intakeActive = rows(obj(s.intakeLinks).items).length || int(obj(s.intakeLinks).activeCount);
  const submissions = int(obj(s.inbox).submissionCount) ?? null;

  return [
    {
      key: "evidence",
      label: "Total evidence",
      value: formatKpiNumber(totalEvidence),
      subtitle: totalEvidence === null ? "Not available" : "Records in this workspace",
      tone: "neutral",
      href: "/evidence",
    },
    {
      key: "matters",
      label: "Active matters",
      value: formatKpiNumber(caseCount),
      subtitle: caseCount === null ? "Not available" : caseCount === 0 ? "No open matters" : "Open cases",
      tone: "neutral",
      href: "/cases",
    },
    {
      key: "trust",
      label: "End-to-end ready",
      value: formatPercent(verified, trustTotal),
      subtitle:
        verified === null || trustTotal === null
          ? "Not available"
          : `${formatKpiNumber(verified)} of ${formatKpiNumber(trustTotal)} fully verified`,
      // Honest tone: only a real, complete posture reads as verified.
      tone:
        verified === null || trustTotal === null || trustTotal === 0
          ? "neutral"
          : verified === trustTotal
            ? "verified"
            : verified / trustTotal >= 0.9
              ? "pending"
              : "risk",
      href: "/evidence",
    },
    {
      key: "deliverables",
      label: "Reports & packages",
      value:
        reportsReady === null && packagesReady === null
          ? "—"
          : `${formatKpiNumber(reportsReady ?? 0)} / ${formatKpiNumber(packagesReady ?? 0)}`,
      subtitle: reportsReady === null ? "Not available" : "Ready to download",
      tone: "neutral",
      href: "/evidence",
    },
    {
      key: "intake",
      label: "Intake & submissions",
      value:
        intakeActive === null && submissions === null
          ? "—"
          : `${formatKpiNumber(intakeActive ?? 0)}${submissions ? ` · ${submissions}` : ""}`,
      subtitle:
        intakeActive === null
          ? "Not available"
          : intakeActive === 0
            ? "No active intake links"
            : "Active links",
      tone: "neutral",
      href: "/intake-links",
    },
  ];
}

/* ------------------------------------------------------- executive summary */

export interface HomeSummary {
  /** One state word: what the workspace is doing. */
  state: string;
  /** One sentence. Never marketing, never a claim the data cannot support. */
  sentence: string;
  tone: ProovraStatusTone;
}

/**
 * The one-state, one-sentence band the web opens Home with.
 *
 * Deliberately conservative: when the dashboard could not be read, it says so
 * rather than reporting a calm, healthy-looking workspace built from absent
 * numbers.
 */
export function buildHomeSummary(s: HomeSources, priorities: HomePriority[]): HomeSummary {
  if (!s.commandCenter && !s.trustSummary) {
    return {
      state: "Unavailable",
      sentence: "Your workspace summary could not be loaded. Pull to refresh to try again.",
      tone: "neutral",
    };
  }
  const risks = priorities.filter((p) => p.tone === "risk").length;
  if (risks > 0) {
    return {
      state: "Needs attention",
      sentence: `${risks} item${risks === 1 ? "" : "s"} need${risks === 1 ? "s" : ""} you now.`,
      tone: "risk",
    };
  }
  if (priorities.length > 0) {
    return {
      state: "In progress",
      sentence: `${priorities.length} item${priorities.length === 1 ? "" : "s"} in your queue.`,
      tone: "pending",
    };
  }
  return { state: "All clear", sentence: "Nothing is waiting on you.", tone: "verified" };
}

/* ------------------------------------------------------------- priorities */

export interface HomePriority {
  id: string;
  label: string;
  detail: string | null;
  tone: ProovraStatusTone;
  /** Where acting on this item goes, when the surface exists natively. */
  href: string | null;
}

/** Severity order, so the most urgent item is never below a routine one. */
const TONE_RANK: Record<string, number> = { risk: 0, governance: 1, pending: 2, info: 3, neutral: 4, verified: 5 };

/**
 * The "what needs you now" queue, from the inbox envelope and the command
 * centre's attention items. The web ranks by severity; so does this, because a
 * queue ordered by arrival buries the thing that matters.
 */
export function buildHomePriorities(s: HomeSources): HomePriority[] {
  const out: HomePriority[] = [];

  for (const raw of rows(obj(s.inbox).items)) {
    const i = obj(raw);
    const kind = str(i.kind) ?? str(i.itemType) ?? "item";
    const severity = (str(i.severity) ?? "").toLowerCase();
    out.push({
      id: str(i.itemKey) ?? str(i.id) ?? `${kind}-${out.length}`,
      label: str(i.title) ?? str(i.label) ?? humanize(kind),
      detail: str(i.subtitle) ?? str(i.detail),
      tone:
        severity === "critical" || severity === "high"
          ? "risk"
          : severity === "medium"
            ? "pending"
            : "info",
      href: str(i.href),
    });
  }

  for (const raw of rows(obj(s.commandCenter).attention)) {
    const a = obj(raw);
    out.push({
      id: str(a.id) ?? `attention-${out.length}`,
      label: str(a.label) ?? str(a.title) ?? "Needs attention",
      detail: str(a.detail),
      tone: (str(a.tone) as ProovraStatusTone) ?? "pending",
      href: str(a.href),
    });
  }

  out.sort((a, b) => (TONE_RANK[a.tone] ?? 9) - (TONE_RANK[b.tone] ?? 9));
  return out;
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ------------------------------------------------------------- storage */

export interface HomeStorage {
  usedLabel: string;
  limitLabel: string;
  /** 0–1, or null when the plan has no stated limit. */
  fraction: number | null;
  tone: ProovraStatusTone;
}

export function buildHomeStorage(s: HomeSources): HomeStorage | null {
  const o = obj(obj(s.billingOverview).storage);
  const used = str(o.usedLabel);
  const limit = str(o.limitLabel);
  if (!used) return null;
  const usedBytes = int(o.usedBytes);
  const limitBytes = int(o.limitBytes);
  const fraction = usedBytes !== null && limitBytes !== null && limitBytes > 0 ? usedBytes / limitBytes : null;
  return {
    usedLabel: used,
    limitLabel: limit ?? "—",
    fraction,
    tone: fraction === null ? "neutral" : fraction >= 0.9 ? "risk" : fraction >= 0.75 ? "pending" : "neutral",
  };
}
