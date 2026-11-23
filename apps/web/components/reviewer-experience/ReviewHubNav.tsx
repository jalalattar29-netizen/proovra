"use client";

/**
 * TEAM-SPEC §3 — THE REVIEW HUB'S LOCAL TABS.
 *
 * One sidebar entry ("Review" → /review) leads into a hub whose pages keep
 * their URLs, so deep links survive:
 *
 *   My reviews      /review
 *   Queues          /review/queues
 *   Monitoring      /reviewer-ops/sla   (sub-view: Escalations /reviewer-ops/escalations)
 *   Review settings /review/settings
 *
 * A tab is rendered ONLY when its destination resolves ALLOWED for this actor
 * in this workspace (`useReviewDestinationResolver`, the same two gates the
 * page itself applies). Team vs Enterprise therefore reads as "the tab exists
 * and works" or "the tab does not exist" — never a tab that opens a refusal.
 *
 * `?queue=` is carried into the Queues tab, so returning to Queues from the
 * inspector or Monitoring keeps the slice the reviewer was working.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useReviewDestinationResolver, type ReviewDestination } from "./reviewDestination";
import "./review-surfaces.css";

export type ReviewHubTabId = "my-reviews" | "queues" | "monitoring" | "settings";
export type ReviewHubMonitoringView = "sla" | "escalations";

type HubTab = {
  id: ReviewHubTabId;
  label: string;
  destination: Extract<ReviewDestination, { kind: "link" }>;
};

/** Keep only the params a tab understands (never leak unrelated state). */
function withQueueParam(href: string, queue: string | null): string {
  if (!queue || !/^[A-Z_]{1,40}$/.test(queue)) return href;
  return `${href}?queue=${encodeURIComponent(queue)}`;
}

function asLink(d: ReviewDestination): Extract<ReviewDestination, { kind: "link" }> | null {
  return d && d.kind === "link" ? d : null;
}

export function useReviewHubTabs(): {
  tabs: ReadonlyArray<HubTab>;
  monitoring: { sla: HubTab["destination"] | null; escalations: HubTab["destination"] | null };
} {
  const resolve = useReviewDestinationResolver();
  const searchParams = useSearchParams();
  const queue = searchParams?.get("queue") ?? null;

  const mine = asLink(resolve("review.queue", { label: "My reviews" }));
  const queues = asLink(
    resolve("workspace.review_queues", {
      label: "Queues",
      href: withQueueParam("/review/queues", queue),
    }),
  );
  const sla = asLink(resolve("review.sla", { label: "SLA" }));
  const escalations = asLink(resolve("review.escalations", { label: "Escalations" }));
  const settings = asLink(resolve("review.settings", { label: "Review settings" }));

  const tabs: HubTab[] = [];
  if (mine) tabs.push({ id: "my-reviews", label: "My reviews", destination: mine });
  if (queues) tabs.push({ id: "queues", label: "Queues", destination: queues });
  const monitoringEntry = sla ?? escalations;
  if (monitoringEntry) {
    tabs.push({
      id: "monitoring",
      label: "Monitoring",
      destination: { ...monitoringEntry, label: "Monitoring" },
    });
  }
  if (settings) tabs.push({ id: "settings", label: "Review settings", destination: settings });
  return { tabs, monitoring: { sla, escalations } };
}

/**
 * TEAM-SPEC R2 / TEAM-UI-SPEC §3 — the advanced review tools (Reviewer
 * workspace, QC, disagreements, metrics, coding schemas) and External Review.
 * They are not hub responsibilities of their own, so they are NOT a row under
 * the hub tabs: My reviews lists them at the bottom in a "Review tools" panel
 * (`ReviewToolsPanel`), each row rendered only where its route opens for this
 * actor (the same resolver as the tabs), never a link into a refusal.
 */
const REVIEW_TOOLS: ReadonlyArray<{ routeId: string; label: string; purpose: string }> = [
  { routeId: "workspace.review_workspace", label: "Reviewer workspace", purpose: "Receive, review, code and decide evidence workflows." },
  { routeId: "workspace.review_qc", label: "Quality control", purpose: "Sample-based checks of closed reviews." },
  { routeId: "workspace.review_disagreements", label: "Disagreements", purpose: "Reviews where reviewers reached different outcomes." },
  { routeId: "workspace.review_metrics", label: "Reviewer metrics", purpose: "Reviewer activity over the last seven days." },
  { routeId: "workspace.coding_schemas", label: "Coding schemas", purpose: "Structured templates reviewers code against." },
  { routeId: "workspace.review_external", label: "External review", purpose: "Invitations and access for reviewers outside the workspace." },
];

export type ReviewTool = Extract<ReviewDestination, { kind: "link" }> & { purpose: string };

export function useReviewTools(): ReadonlyArray<ReviewTool> {
  const resolve = useReviewDestinationResolver();
  const out: ReviewTool[] = [];
  for (const t of REVIEW_TOOLS) {
    const d = asLink(resolve(t.routeId, { label: t.label }));
    if (d) out.push({ ...d, purpose: t.purpose });
  }
  return out;
}

/** The bottom "Review tools" panel on My reviews; nothing when no tool opens. */
export function ReviewToolsPanel() {
  const tools = useReviewTools();
  if (tools.length === 0) return null;
  return (
    <section className="app-panel review-tools-panel" data-review-tools-panel aria-labelledby="review-tools-title">
      <div className="app-panel__head">
        <h2 className="app-panel__title" id="review-tools-title">
          Review tools
        </h2>
      </div>
      <ul className="app-panel__body review-tools">
        {tools.map((t) => (
          <li key={t.href} className="review-tools__row" data-review-tool={t.href}>
            <Link href={t.href} className="review-rows__ref" data-review-tool-link={t.href}>
              {t.label}
            </Link>
            <p className="app-field-help">{t.purpose}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReviewHubNav({
  active,
  monitoringView,
}: {
  active: ReviewHubTabId;
  /** Which Monitoring sub-view is open (only read when active = monitoring). */
  monitoringView?: ReviewHubMonitoringView;
}) {
  const { tabs, monitoring } = useReviewHubTabs();
  // A single tab is not navigation: render nothing rather than a lone pill.
  if (tabs.length < 2 && !(active === "monitoring" && monitoring.sla && monitoring.escalations)) {
    return null;
  }
  return (
    <div className="review-hub-nav" data-review-hub-nav data-review-hub-active={active}>
      {tabs.length >= 2 ? (
        <nav className="app-tabs" aria-label="Review">
          {tabs.map((tab) => {
            const isActive = tab.id === active;
            return (
              <Link
                key={tab.id}
                href={tab.destination.href}
                className={isActive ? "app-tab is-active" : "app-tab"}
                aria-current={isActive ? "page" : undefined}
                data-review-hub-tab={tab.id}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
      {active === "monitoring" && monitoring.sla && monitoring.escalations ? (
        <nav
          className="app-tabs"
          aria-label="Monitoring"
          data-review-hub-subnav="monitoring"
        >
          {(
            [
              ["sla", monitoring.sla, "SLA"],
              ["escalations", monitoring.escalations, "Escalations"],
            ] as const
          ).map(([id, dest, label]) => {
            const isActive = (monitoringView ?? "sla") === id;
            return (
              <Link
                key={id}
                href={dest.href}
                className={isActive ? "app-tab is-active" : "app-tab"}
                aria-current={isActive ? "page" : undefined}
                data-review-hub-subtab={id}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}

export default ReviewHubNav;
