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
 * TEAM-SPEC R2 — the advanced review tools (Reviewer workspace, QC,
 * disagreements, metrics, coding schemas) and External Review. They are not
 * hub responsibilities of their own, so they are a quiet secondary row on
 * My reviews — each link rendered only where its route opens for this actor
 * (the same resolver as the tabs), never a link into a refusal.
 */
export function useMoreReviewTools(): ReadonlyArray<Extract<ReviewDestination, { kind: "link" }>> {
  const resolve = useReviewDestinationResolver();
  const items: Array<[string, string]> = [
    ["workspace.review_workspace", "Reviewer workspace"],
    ["workspace.review_qc", "Quality control"],
    ["workspace.review_disagreements", "Disagreements"],
    ["workspace.review_metrics", "Reviewer metrics"],
    ["workspace.coding_schemas", "Coding schemas"],
    ["workspace.review_external", "External review"],
  ];
  const out: Array<Extract<ReviewDestination, { kind: "link" }>> = [];
  for (const [id, label] of items) {
    const d = asLink(resolve(id, { label }));
    if (d) out.push(d);
  }
  return out;
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
  const moreTools = useMoreReviewTools();
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
      {active === "my-reviews" && moreTools.length > 0 ? (
        <nav
          aria-label="More review tools"
          data-review-hub-more-tools
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", marginTop: 8, fontSize: 13 }}
        >
          <span className="app-field-help" style={{ margin: 0 }}>More review tools:</span>
          {moreTools.map((d) => (
            <Link key={d.href} href={d.href} className="app-ghost-action" data-review-hub-more-tool={d.href}>
              {d.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {active === "monitoring" && monitoring.sla && monitoring.escalations ? (
        <nav
          className="app-tabs"
          aria-label="Monitoring"
          data-review-hub-subnav="monitoring"
          style={{ marginTop: 4 }}
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
