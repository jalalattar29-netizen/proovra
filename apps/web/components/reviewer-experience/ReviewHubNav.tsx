"use client";

/**
 * TEAM-SPEC §3 — THE REVIEW HUB'S LOCAL TABS (one navigation level).
 *
 * Stage D (team remediation, T-065 / T-078 / T-079 / T-088 / T-092):
 *
 *   Inbox           /review                 one Inbox with views (`?view=`)
 *   Monitoring      /reviewer-ops/sla       deadlines, escalations, workload,
 *                                            quality and metrics as sections
 *   Review settings /review/settings        policy, reviewer criteria, schemas
 *
 * The separate Queues tab is gone (`/review/queues` redirects to the Inbox
 * view it named) and Monitoring has no second tab row: its sections are an
 * in-page segmented control. The tab row scrolls sideways on a phone, so
 * every tab stays reachable at 390 px.
 *
 * A tab is rendered ONLY when its destination resolves ALLOWED for this actor
 * in this workspace (`useReviewDestinationResolver`, the same two gates the
 * page itself applies) — never a tab that opens a refusal.
 *
 * The Inbox tab carries the current `?view=` (or a legacy `?queue=`), so
 * returning to the Inbox from Monitoring keeps the view the reviewer was
 * working.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useReviewDestinationResolver, type ReviewDestination } from "./reviewDestination";
import { INBOX_TITLE, inboxHref, isInboxView } from "../../lib/reviewer-workspace/inbox-views";
import "./review-surfaces.css";

export type ReviewHubTabId = "inbox" | "monitoring" | "settings";

type HubTab = {
  id: ReviewHubTabId;
  label: string;
  destination: Extract<ReviewDestination, { kind: "link" }>;
};

function asLink(d: ReviewDestination): Extract<ReviewDestination, { kind: "link" }> | null {
  return d && d.kind === "link" ? d : null;
}

export function useReviewHubTabs(): { tabs: ReadonlyArray<HubTab> } {
  const resolve = useReviewDestinationResolver();
  const searchParams = useSearchParams();
  const view = searchParams?.get("view") ?? searchParams?.get("queue") ?? null;

  const inbox = asLink(
    resolve("review.queue", { label: INBOX_TITLE, href: inboxHref(isInboxView(view) ? view : null) }),
  );
  const sla = asLink(resolve("review.sla", { label: "Monitoring" }));
  const escalations = asLink(
    resolve("review.escalations", { label: "Monitoring", href: "/reviewer-ops/sla?section=escalations" }),
  );
  const settings = asLink(resolve("review.settings", { label: "Review settings" }));

  const tabs: HubTab[] = [];
  if (inbox) tabs.push({ id: "inbox", label: INBOX_TITLE, destination: inbox });
  const monitoringEntry = sla ?? escalations;
  if (monitoringEntry) {
    tabs.push({ id: "monitoring", label: "Monitoring", destination: { ...monitoringEntry, label: "Monitoring" } });
  }
  if (settings) tabs.push({ id: "settings", label: "Review settings", destination: settings });
  return { tabs };
}

/**
 * The operational tools that are not hub tabs: External Review (an
 * operational task, T-079) and Challenged decisions (filed challenges, named
 * apart from the Inbox's Conflicts view, T-081). Quality control and metrics
 * are Monitoring sections, coding schemas are a Review settings section and
 * the reviewer workspace is the Review page's focus mode, so none of them is a
 * tool row any more. Each row renders only where its route opens.
 */
const REVIEW_TOOLS: ReadonlyArray<{ routeId: string; label: string; purpose: string; href?: string }> = [
  {
    routeId: "workspace.review_external",
    label: "External review",
    purpose: "Invite reviewers from outside the workspace and manage their access.",
  },
  {
    routeId: "workspace.review_disagreements",
    label: "Challenged decisions",
    purpose: "Decisions a reviewer has formally challenged. Reviews whose two reviews differ are in the Inbox's Conflicts view.",
  },
  {
    // T-066 — evidence requests are reviewed on the Requests page, not here.
    routeId: "workspace.evidence_requests",
    label: "Evidence requests awaiting review",
    purpose: "Responses to evidence requests are reviewed with the requests, not in this Inbox.",
  },
];

export type ReviewTool = Extract<ReviewDestination, { kind: "link" }> & { purpose: string };

export function useReviewTools(): ReadonlyArray<ReviewTool> {
  const resolve = useReviewDestinationResolver();
  const out: ReviewTool[] = [];
  for (const t of REVIEW_TOOLS) {
    const d = asLink(resolve(t.routeId, t.href ? { label: t.label, href: t.href } : { label: t.label }));
    if (d) out.push({ ...d, purpose: t.purpose });
  }
  return out;
}

/** The bottom "Review tools" panel on the Inbox; nothing when no tool opens. */
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

export function ReviewHubNav({ active }: { active: ReviewHubTabId }) {
  const { tabs } = useReviewHubTabs();
  // A single tab is not navigation: render nothing rather than a lone pill.
  if (tabs.length < 2) return null;
  return (
    <div className="review-hub-nav" data-review-hub-nav data-review-hub-active={active}>
      <nav className="app-tabs review-hub-tabs" aria-label="Review" data-review-hub-tabs-scroll>
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
    </div>
  );
}

export default ReviewHubNav;
