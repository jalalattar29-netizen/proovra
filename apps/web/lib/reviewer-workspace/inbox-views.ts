/**
 * Stage D (team remediation, T-065 / T-092 / T-081) — THE INBOX VIEWS.
 *
 * `/review` is the one review Inbox. A view is a queue slice the reviewer-ops
 * queue route serves (`GET /v1/reviewer-ops/queue?queue=<VIEW>`), selected by
 * `?view=` in the URL. The URL and the highlighted view always agree: the
 * page reads the view from the URL, and choosing a view writes the URL.
 *
 * One label per view, everywhere (T-092): "Assigned to me" is the view the
 * product called "My reviews", "Assigned (mine)" and "Open my queue";
 * "Inbox" is the page. The adjudication slice is "Conflicts", named apart from
 * filed challenges ("Challenged decisions", T-081).
 */

import { REVIEWER_OPS_QUEUE_TYPES, type ReviewerOpsQueueType } from "@proovra/shared";

/** The handoff slices the queue route derives from the current decision round. */
export const HANDOFF_VIEWS = ["AWAITING_SECOND_REVIEW", "AWAITING_ADJUDICATION"] as const;

export type InboxView = ReviewerOpsQueueType | (typeof HANDOFF_VIEWS)[number];

export const INBOX_VIEWS: ReadonlyArray<InboxView> = [...REVIEWER_OPS_QUEUE_TYPES, ...HANDOFF_VIEWS];

export const DEFAULT_INBOX_VIEW: InboxView = "MY_REVIEWS";

/** The page's name. */
export const INBOX_TITLE = "Inbox";

/** THE label map (T-092): exactly one label per view. */
export const INBOX_VIEW_LABELS: Readonly<Record<InboxView, string>> = {
  MY_REVIEWS: "Assigned to me",
  UNASSIGNED: "Unassigned",
  OVERDUE: "Overdue",
  DUE_SOON: "Due soon",
  ESCALATED: "Escalated",
  AWAITING_SECOND_REVIEW: "Awaiting second review",
  AWAITING_ADJUDICATION: "Conflicts",
  HIGH_PRIORITY: "High priority",
  LEGAL_HOLD: "Legal hold",
  WORKFLOW_BLOCKED: "Paused",
  INTEGRITY_RISK: "Integrity risk",
  EXTERNAL_INTAKE: "External intake",
  COMPLETED_RECENTLY: "Completed recently",
};

/** The views shown as tabs (scrollable on a phone); the rest sit under "More views". */
export const PRIMARY_INBOX_VIEWS: ReadonlyArray<InboxView> = [
  "MY_REVIEWS",
  "UNASSIGNED",
  "OVERDUE",
  "DUE_SOON",
  "ESCALATED",
  "AWAITING_SECOND_REVIEW",
  "AWAITING_ADJUDICATION",
];

export const MORE_INBOX_VIEWS: ReadonlyArray<InboxView> = INBOX_VIEWS.filter(
  (v) => !PRIMARY_INBOX_VIEWS.includes(v),
);

/** What a confirmed-empty view says (never shown for a failed load, T-067). */
export const INBOX_EMPTY_COPY: Readonly<Record<InboxView, string>> = {
  MY_REVIEWS: "No reviews are assigned to you.",
  UNASSIGNED: "No reviews are waiting for an owner.",
  OVERDUE: "No reviews are overdue.",
  DUE_SOON: "No reviews are due soon.",
  ESCALATED: "No reviews have an active escalation.",
  HIGH_PRIORITY: "No reviews are high priority or urgent.",
  LEGAL_HOLD: "No reviews are under an active legal hold.",
  WORKFLOW_BLOCKED: "No reviews are paused.",
  INTEGRITY_RISK: "No reviews carry an integrity escalation.",
  EXTERNAL_INTAKE: "No external-intake reviews are waiting.",
  COMPLETED_RECENTLY: "No reviews were completed in the last 7 days.",
  AWAITING_SECOND_REVIEW: "No reviews are waiting for an independent second reviewer.",
  AWAITING_ADJUDICATION: "No conflicting reviews are waiting for adjudication.",
};

export function isInboxView(value: string | null | undefined): value is InboxView {
  return typeof value === "string" && (INBOX_VIEWS as ReadonlyArray<string>).includes(value);
}

type ParamSource = { get(name: string): string | null } | null | undefined;

/**
 * The view a URL asks for: `?view=` (canonical), else the legacy `?queue=`
 * that `/review/queues` links and saved bookmarks carry; else the default.
 */
export function inboxViewFromParams(params: ParamSource): InboxView {
  const view = params?.get("view") ?? null;
  if (isInboxView(view)) return view;
  const queue = params?.get("queue") ?? null;
  if (isInboxView(queue)) return queue;
  return DEFAULT_INBOX_VIEW;
}

/** The Inbox URL for a view. */
export function inboxHref(view: InboxView | null | undefined): string {
  return view && view !== DEFAULT_INBOX_VIEW ? `/review?view=${encodeURIComponent(view)}` : "/review";
}

/**
 * Where a retired `/review/queues?queue=X` link lands: the same view in the
 * Inbox (T-065). An unknown or missing queue lands on the default view.
 */
export function reviewQueuesRedirectTarget(params: Record<string, string | string[] | undefined>): string {
  const raw = params.view ?? params.queue;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return inboxHref(isInboxView(value ?? null) ? (value as InboxView) : null);
}

/**
 * T-074 — the Review page URL opened from an Inbox view: it carries the view,
 * so Back returns to it and Next item moves within it.
 */
export function reviewHrefFromInbox(workflowId: string, view: InboxView, opts: { focus?: boolean } = {}): string {
  const q = new URLSearchParams();
  q.set("from", "inbox");
  q.set("view", view);
  if (opts.focus) q.set("mode", "focus");
  return `/reviewer-ops/${encodeURIComponent(workflowId)}?${q.toString()}`;
}

/**
 * T-074 — the Back target of the Review page: the Inbox view it was opened
 * from, else the default Inbox.
 */
export function reviewBackTarget(params: ParamSource): { href: string; label: string } {
  const view = params?.get("view") ?? null;
  if (isInboxView(view)) {
    return { href: inboxHref(view), label: `Inbox · ${INBOX_VIEW_LABELS[view]}` };
  }
  return { href: "/review", label: INBOX_TITLE };
}
