/**
 * CANONICAL NATIVE INTAKE LINKS (Master Program §9, Workstream F) — pure.
 *
 * GET /v1/workflow/intake-links?teamId → { items[] } (member-accessible;
 * feature-flag guarded). IMPORTANT truthful constraint: the intake token is a
 * server-side SECRET — the raw link URL is returned only once at creation and is
 * NEVER exposed in listings (links are delivered server-side via /send). So the
 * native surface is view + revoke; it does not (and cannot) show/copy an existing
 * link's URL, and it never fabricates one. Creation stays web-managed (it needs
 * the public web origin + template catalog + the one-time URL).
 *
 * These pure parsers read the enriched list projection defensively (item.link.*
 * with a flat fallback) and map status → tone; the RN screen is a thin shell.
 */

import { listEnvelope } from "./envelope";
import type { ProovraStatusTone } from "@proovra/ui";
import { humanizeEnum } from "./domain-display";
import { DELIVERY_VOCABULARY, deliveryStateOf, providerErrorCodeLabel } from "./intake-delivery";

export interface IntakeLinkItem {
  id: string;
  templateName: string;
  recipientLabel: string | null;
  status: string;
  usedCount: number;
  maxUses: number | null;
  expiresAtUtc: string | null;
  archived: boolean;
  /** The full list projection the Details section reads (link + delivery + activity). */
  detail: IntakeLinkDetail;
}

/** One enriched list item: GET /v1/workflow/intake-links → items[] ({ link, delivery, activity }). */
export interface IntakeLinkDetail {
  templateSlug: string | null;
  intakeMode: string;
  customerId: string | null;
  recipientName: string | null;
  /** The server decides raw-vs-masked; this is whichever it sent for this caller. */
  recipientEmail: string | null;
  recipientPhone: string | null;
  rawStatus: string;
  createdAt: string | null;
  /** link.updatedAt — the web's activity-sort fallback (filters.ts activitySortKey). */
  updatedAt: string | null;
  /** True when the server sent the masked previews rather than the raw contact. */
  recipientContactIsMasked: boolean;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  archivedAtUtc: string | null;
  delivery: {
    latestStatus: string | null;
    latestChannel: string | null;
    latestAtUtc: string | null;
    latestSentAtUtc: string | null;
    latestErrorCode: string | null;
    attemptCount: number;
    channelsAttempted: string[];
  };
  activity: {
    firstOpenedAtUtc: string | null;
    firstStartedAtUtc: string | null;
    firstSubmittedAtUtc: string | null;
    lastOpenedAtUtc: string | null;
    lastStartedAtUtc: string | null;
    lastSubmittedAtUtc: string | null;
    sessionsCreated: number;
    sessionsOpened: number;
    sessionsStarted: number;
    sessionsSubmitted: number;
    evidenceCount: number;
  };
}

const STATUS_TONE: Record<string, ProovraStatusTone> = {
  ACTIVE: "info",
  OPEN: "info",
  SENT: "info",
  OPENED: "info",
  VIEWED: "info",
  IN_PROGRESS: "pending",
  SUBMITTED: "verified",
  FULFILLED: "verified",
  COMPLETED: "verified",
  EXPIRED: "neutral",
  REVOKED: "risk",
  ARCHIVED: "neutral",
};

export function intakeStatusDisplay(status: string | null | undefined): { label: string; tone: ProovraStatusTone } {
  const key = (status ?? "").toUpperCase();
  return { label: key ? humanizeEnum(key) : "Unknown", tone: STATUS_TONE[key] ?? "neutral" };
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse GET /v1/workflow/intake-links → { items } into view rows (defensive). */
export function parseIntakeLinks(data: unknown): IntakeLinkItem[] {
  const items = Array.isArray(o(data)["items"]) ? (o(data)["items"] as unknown[]) : [];
  const out: IntakeLinkItem[] = [];
  for (const raw of items) {
    const item = o(raw);
    // Enriched projection nests the row under `link`; fall back to flat fields.
    const link = "link" in item ? o(item["link"]) : item;
    const id = s(link["id"]);
    if (!id) continue;
    const delivery = o(item["delivery"]);
    const activity = o(item["activity"]);
    const revealed = link["recipientContactRevealAuthorized"] === true;
    const detail: IntakeLinkDetail = {
      templateSlug: s(link["workflowTemplateSlug"]),
      intakeMode: s(link["intakeMode"]) ?? "EXTERNAL_ONE_TIME",
      customerId: s(link["customerId"]),
      recipientName: s(link["recipientLabel"]),
      recipientEmail: (revealed ? s(link["recipientEmail"]) : null) ?? s(link["recipientEmailPreview"]),
      recipientPhone: (revealed ? s(link["recipientPhone"]) : null) ?? s(link["recipientPhonePreview"]),
      rawStatus: s(link["status"]) ?? "",
      createdAt: s(link["createdAt"]),
      updatedAt: s(link["updatedAt"]),
      recipientContactIsMasked: !revealed,
      revokedAtUtc: s(link["revokedAtUtc"]),
      revokedReason: s(link["revokedReason"]),
      archivedAtUtc: s(link["archivedAtUtc"]),
      delivery: {
        latestStatus: s(delivery["latestStatus"]),
        latestChannel: s(delivery["latestChannel"]),
        latestAtUtc: s(delivery["latestAtUtc"]),
        latestSentAtUtc: s(delivery["latestSentAtUtc"]),
        latestErrorCode: s(delivery["latestErrorCode"]),
        attemptCount: n(delivery["attemptCount"]) ?? 0,
        channelsAttempted: Array.isArray(delivery["channelsAttempted"])
          ? (delivery["channelsAttempted"] as unknown[]).filter((c): c is string => typeof c === "string")
          : [],
      },
      activity: {
        firstOpenedAtUtc: s(activity["firstOpenedAtUtc"]),
        firstStartedAtUtc: s(activity["firstStartedAtUtc"]),
        firstSubmittedAtUtc: s(activity["firstSubmittedAtUtc"]),
        lastOpenedAtUtc: s(activity["lastOpenedAtUtc"]),
        lastStartedAtUtc: s(activity["lastStartedAtUtc"]),
        lastSubmittedAtUtc: s(activity["lastSubmittedAtUtc"]),
        sessionsCreated: n(activity["sessionsCreated"]) ?? 0,
        sessionsOpened: n(activity["sessionsOpened"]) ?? 0,
        sessionsStarted: n(activity["sessionsStarted"]) ?? 0,
        sessionsSubmitted: n(activity["sessionsSubmitted"]) ?? 0,
        evidenceCount: n(activity["evidenceCount"]) ?? 0,
      },
    };
    out.push({
      id,
      templateName: s(link["workflowTemplateName"]) ?? s(link["workflowTemplateSlug"]) ?? "Intake link",
      recipientLabel: s(link["recipientLabel"]) ?? s(link["customerId"]),
      // THE OPERATIONAL STATE, derived exactly as the web derives it. This read
      // `item.lifecycle.state`, a key the server never sends (it sends
      // `computedLifecycle`), so every row fell back to the raw DB status and an
      // archived, used-up or time-expired link still read "Active".
      status: getLinkOperationalState({
        status: s(link["status"]) ?? "",
        expiresAtUtc: s(link["expiresAtUtc"]),
        revokedAtUtc: detail.revokedAtUtc,
        archivedAtUtc: detail.archivedAtUtc,
        maxUses: n(link["maxUses"]) ?? 0,
        usedCount: n(link["usedCount"]) ?? 0,
      }),
      usedCount: n(link["usedCount"]) ?? 0,
      maxUses: n(link["maxUses"]),
      expiresAtUtc: s(link["expiresAtUtc"]),
      archived: !!link["archivedAtUtc"],
      detail,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Submissions, archive, send, and the one audited disclosure
// ---------------------------------------------------------------------------

export function buildIntakeSubmissionsPath(linkId: string): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/submissions`;
}

export function buildIntakeArchivePath(linkId: string, archived: boolean): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/${archived ? "unarchive" : "archive"}`;
}

export function buildIntakeSendPath(linkId: string): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/send`;
}

export function buildIntakeRevealPath(linkId: string): string {
  return `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/recipient-contact`;
}

export interface IntakeSubmission {
  id: string;
  status: string;
  submitterName: string | null;
  /** Already MASKED by the server. Never the raw address. */
  submitterEmailPreview: string | null;
  submitterPhonePreview: string | null;
  pseudonym: string | null;
  openedAtIso: string | null;
  submittedAtIso: string | null;
  abandonedAtIso: string | null;
  /** The record the submission produced (intake-link-lifecycle.service.ts), when it has one. */
  evidenceId: string | null;
}

/** The web drawer's counts line (SubmissionsDrawer.tsx:125). */
export function submissionsSummaryLine(subs: IntakeSubmission[]): string {
  const up = (s: string) => s.toUpperCase();
  const submitted = subs.filter((s) => up(s.status) === "SUBMITTED").length;
  const inProgress = subs.filter((s) => ["OPENED", "UPLOAD_STARTED", "UPLOAD_COMPLETED"].includes(up(s.status))).length;
  const withEvidence = subs.filter((s) => Boolean(s.evidenceId)).length;
  return `${subs.length} total · ${submitted} submitted · ${inProgress} in progress · ${withEvidence} evidence record${withEvidence === 1 ? "" : "s"}`;
}

/** The web canOpenEvidence: a record exists and the session is not terminal. */
export function canOpenSubmissionEvidence(s: IntakeSubmission): boolean {
  if (!s.evidenceId) return false;
  const st = s.status.toUpperCase();
  return st !== "ABANDONED" && st !== "REVOKED" && st !== "EXPIRED";
}

function io(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function is(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * `GET /v1/workflow/intake-links/:id/submissions` sends
 * `{ link, sessions, totals }` - `loadIntakeLinkSubmissions` in
 * services/api/src/services/intake-link-lifecycle.service.ts:705, and the web
 * drawer reads `payload.sessions` (SubmissionsDrawer.tsx:92).
 *
 * This read `submissions`, a key the route has never sent, then fell through
 * to the bare payload and reported an empty list - so the drawer showed "no
 * submissions" for every link that had them. The per-session field names below
 * were right all along; only the envelope was guessed.
 *
 * `submissions` is NOT kept as a compatibility key. A compatibility key is a
 * shape the server once sent; this one was invented by the client, so keeping
 * it would only preserve the defect in a form no test could see.
 */
export function parseIntakeSubmissions(payload: unknown): IntakeSubmission[] {
  return listEnvelope(payload, ["sessions"])
    .map((entry) => {
      const s = io(entry);
      const id = is(s["id"]);
      if (!id) return null;
      return {
        id,
        status: is(s["status"]) ?? "OPENED",
        submitterName: is(s["submitterDisplayName"]),
        // The projection masks these itself, for everybody. Nothing here
        // un-masks them and nothing here asks for the raw form.
        submitterEmailPreview: is(s["submitterEmailPreview"]),
        submitterPhonePreview: is(s["submitterPhonePreview"]),
        pseudonym: is(s["pseudonym"]),
        openedAtIso: is(s["openedAtUtc"]),
        submittedAtIso: is(s["submittedAtUtc"]),
        abandonedAtIso: is(s["abandonedAtUtc"]),
        evidenceId: is(s["evidenceId"]),
      };
    })
    .filter((s): s is IntakeSubmission => s !== null);
}

/** The two channels that remain. A request naming a retired one is refused. */
export const INTAKE_SEND_CHANNELS = ["SMS", "EMAIL"] as const;
export type IntakeSendChannel = (typeof INTAKE_SEND_CHANNELS)[number];

/**
 * Resending needs the RAW TOKEN, which the API never persists.
 *
 * So a resend is possible only for a link whose token this client still holds
 * — in practice, one created in this session. After a relaunch it is gone, and
 * offering a Send control then would produce a request that cannot be formed.
 * The surface offers it exactly when it can be honoured.
 */
export function canResendIntakeLink(rawToken: string | null | undefined): boolean {
  return typeof rawToken === "string" && rawToken.length >= 8;
}

export function buildIntakeSendBody(input: {
  channel: IntakeSendChannel;
  rawToken: string;
  intakeUrl: string;
  idempotencyKey?: string;
}) {
  const body: Record<string, unknown> = {
    channel: input.channel,
    rawToken: input.rawToken,
    intakeUrl: input.intakeUrl,
  };
  // The nonce is why tapping Resend twice does not become two provider calls.
  if (input.idempotencyKey) body.idempotencyKey = input.idempotencyKey;
  return body;
}

export interface RevealedContact {
  email: string | null;
  phone: string | null;
}

export function parseRevealedContact(payload: unknown): RevealedContact {
  const c = io(io(payload)["recipientContact"]);
  return { email: is(c["recipientEmail"]), phone: is(c["recipientPhone"]) };
}

/**
 * The words shown before a reveal happens.
 *
 * This is the ONLY place a raw recipient address leaves the API. Every
 * projection ships the masked form for everybody; asking here is an act with a
 * consequence, it requires a capability, and the disclosure is recorded at
 * WARNING severity. A user should know that before they tap, not discover it
 * in an audit log afterwards.
 */
export const INTAKE_REVEAL_CONSEQUENCE =
  "Revealing the recipient's contact details is recorded against your account, with the reason. " +
  "Everywhere else in the product this address stays masked.";

// ---------------------------------------------------------------------------
// T-14 — the link DETAILS (web DetailsDrawer + rowModel + state-model + vocabulary)
// ---------------------------------------------------------------------------

export type LinkOperationalState = "ACTIVE" | "ARCHIVED" | "REVOKED" | "EXPIRED";

/** getLinkOperationalState (apps/web/lib/intake-links/state-model.ts), verbatim. */
export function getLinkOperationalState(
  link: { status: string; expiresAtUtc: string | null; revokedAtUtc: string | null; archivedAtUtc: string | null; maxUses: number; usedCount: number },
  now: number = Date.now(),
): LinkOperationalState {
  if (link.archivedAtUtc) return "ARCHIVED";
  if (link.status === "REVOKED" || link.revokedAtUtc) return "REVOKED";
  if (link.status === "EXPIRED") return "EXPIRED";
  if (link.expiresAtUtc) {
    const t = Date.parse(link.expiresAtUtc);
    if (Number.isFinite(t) && t <= now) return "EXPIRED";
  }
  if (link.maxUses > 0 && link.usedCount >= link.maxUses) return "EXPIRED";
  return "ACTIVE";
}

export type LatestSessionState = "NO_ACTIVITY" | "OPENED" | "UPLOAD_STARTED" | "SUBMITTED";
export function getLatestSessionState(a: IntakeLinkDetail["activity"]): LatestSessionState {
  if (a.sessionsSubmitted > 0) return "SUBMITTED";
  if (a.sessionsStarted > 0) return "UPLOAD_STARTED";
  if (a.sessionsOpened > 0) return "OPENED";
  return "NO_ACTIVITY";
}

type Vocab = { label: string; tone: ProovraStatusTone; explanation: string };
export const LINK_STATE_VOCABULARY: Record<LinkOperationalState, Vocab> = {
  ACTIVE: { label: "Active", tone: "verified", explanation: "This link can still accept submissions." },
  ARCHIVED: { label: "Archived", tone: "neutral", explanation: "Hidden from the default view. Archiving does not change public access." },
  REVOKED: { label: "Link disabled", tone: "risk", explanation: "This link can no longer accept submissions." },
  EXPIRED: { label: "Expired", tone: "info", explanation: "The expiry time passed, or every allowed submission has been used." },
};
export const SESSION_STATE_VOCABULARY: Record<LatestSessionState, Vocab> = {
  NO_ACTIVITY: { label: "Not opened", tone: "risk", explanation: "Nobody has opened this link yet." },
  OPENED: { label: "Opened", tone: "pending", explanation: "The link was opened but no upload has started." },
  UPLOAD_STARTED: { label: "Upload started", tone: "pending", explanation: "An upload is in progress and has not been submitted." },
  SUBMITTED: { label: "Submitted", tone: "info", explanation: "At least one contributor completed a submission." },
};

/** "Manual" when no delivery record exists; otherwise the delivery vocabulary the history already uses. */
export function deliveryPresentation(d: IntakeLinkDetail["delivery"]): Vocab {
  if (d.attemptCount === 0 && d.latestChannel == null) {
    return {
      label: "Manual",
      tone: "governance",
      explanation: "Shared manually — this link was created to copy and send yourself, so no message was dispatched.",
    };
  }
  return DELIVERY_VOCABULARY[deliveryStateOf(d.latestStatus ?? "")];
}

const CHANNEL_LABEL: Record<string, string> = { EMAIL: "Email", SMS: "SMS", WHATSAPP: "WhatsApp", MANUAL: "Copy link" };
export function intakeChannelLabel(channel: string | null): string {
  return CHANNEL_LABEL[String(channel ?? "MANUAL").toUpperCase()] ?? "Copy link";
}
const MODE_LABEL: Record<string, string> = {
  EXTERNAL_ONE_TIME: "One-time link",
  EXTERNAL_REUSABLE: "Reusable link",
  EXTERNAL_ANONYMOUS: "Anonymous link",
  EXTERNAL_PSEUDONYMOUS: "Display-name link",
};
export function intakeModeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? "One-time link";
}

/** canRevokeLink: anything not archived and not already disabled. */
export function canDisableLink(item: IntakeLinkItem): boolean {
  return !item.detail.archivedAtUtc && !(item.detail.rawStatus === "REVOKED" || item.detail.revokedAtUtc);
}

export function deliveryAttemptLine(d: IntakeLinkDetail["delivery"]): string {
  const channels = d.channelsAttempted.length;
  return `${d.attemptCount} attempt${d.attemptCount === 1 ? "" : "s"} across ${channels} channel${channels === 1 ? "" : "s"}.`;
}
export function deliveryErrorLine(d: IntakeLinkDetail["delivery"]): string | null {
  return d.latestErrorCode ? providerErrorCodeLabel(d.latestErrorCode) : null;
}
export function submissionsLine(a: IntakeLinkDetail["activity"]): string {
  const inProgress = Math.max(0, a.sessionsStarted - a.sessionsSubmitted);
  return `${a.sessionsSubmitted} submitted · ${inProgress} in progress · ${a.evidenceCount} evidence record${a.evidenceCount === 1 ? "" : "s"} produced.`;
}

export const DISABLE_LINK_COPY = {
  actionLabel: "Disable link",
  title: "Disable this intake link?",
  description:
    "Anyone holding this link will be refused immediately. This cannot be undone — the link cannot be re-enabled. Submissions already received are kept.",
  confirmLabel: "Disable link",
  note: "Disabling refuses everyone holding the link. It cannot be undone.",
  access:
    "The secure link is shown once, immediately after creation, and is never stored or shown again. Contributors submit files without accessing this workspace.",
} as const;

/** rowModel.latestActivityIso: the newest thing that happened to this link. */
export function latestActivityIso(d: IntakeLinkDetail): string | null {
  return d.activity.lastSubmittedAtUtc ?? d.activity.lastStartedAtUtc ?? d.activity.lastOpenedAtUtc ?? d.delivery.latestAtUtc ?? d.createdAt;
}

/** The list row's Delivery cell: "Delivered via Email", or "Manual" for a copy-link share. */
export function deliveryCell(d: IntakeLinkDetail): string {
  const v = deliveryPresentation(d.delivery);
  return d.delivery.attemptCount === 0 && d.delivery.latestChannel == null ? v.label : `${v.label} via ${intakeChannelLabel(d.delivery.latestChannel)}`;
}


// ---------------------------------------------------------------------------
// The list console (web intake-links page.tsx + _lib/filters.ts +
// lib/intake-links/state-model.ts + vocabulary.ts). The search TERM is a
// server parameter (contact details are matched against stored values, never
// shipped to the device); tabs, channel, lifecycle, delivery, sort and paging
// run over the returned rows, as on the web — the list route has no such
// query parameters (workflow-intake-links.routes.ts ListQuery).
// ---------------------------------------------------------------------------

export type IntakeTab = "all" | "active" | "submitted" | "opened" | "failed_delivery" | "archived" | "revoked_or_expired";

/** state-model.ts matchesIntakeTab, verbatim: "all" includes archived rows; every other tab excludes them. */
export function matchesIntakeTab(item: IntakeLinkItem, tab: IntakeTab): boolean {
  if (tab === "all") return true;
  const link = item.status as LinkOperationalState;
  if (tab === "archived") return link === "ARCHIVED";
  if (link === "ARCHIVED") return false;
  const sess = getLatestSessionState(item.detail.activity);
  switch (tab) {
    case "active":
      return link === "ACTIVE";
    case "submitted":
      return sess === "SUBMITTED";
    case "opened":
      return sess === "OPENED" || sess === "UPLOAD_STARTED";
    case "failed_delivery":
      return deliveryStateOf(item.detail.delivery.latestStatus ?? "") === "FAILED";
    case "revoked_or_expired":
      return link === "REVOKED" || link === "EXPIRED";
  }
  return false;
}

export type IntakeKpiKey = "total" | "active" | "submitted" | "opened" | "failedDelivery" | "archived" | "revokedOrExpired";

/** vocabulary.ts KPI_VOCABULARY in KPI_ORDER (web tone → native tone: indigo→governance, orange→pending, blue→info, green→verified, red→risk, slate→neutral). */
export const INTAKE_KPIS: ReadonlyArray<{ key: IntakeKpiKey; tab: IntakeTab; label: string; tone: ProovraStatusTone; explanation: string }> = [
  { key: "total", tab: "all", label: "Total links", tone: "governance", explanation: "Every intake link in this workspace, including archived ones." },
  { key: "active", tab: "active", label: "Active", tone: "pending", explanation: "Links that can still accept a submission right now." },
  { key: "submitted", tab: "submitted", label: "Submitted", tone: "info", explanation: "Links where at least one contributor completed a submission." },
  { key: "opened", tab: "opened", label: "Opened", tone: "verified", explanation: "Links a contributor opened but has not submitted through yet." },
  { key: "failedDelivery", tab: "failed_delivery", label: "Failed delivery", tone: "risk", explanation: "Links whose most recent outbound message failed to deliver." },
  { key: "archived", tab: "archived", label: "Archived", tone: "neutral", explanation: "Links you moved out of the default view." },
  { key: "revokedOrExpired", tab: "revoked_or_expired", label: "Revoked or expired", tone: "risk", explanation: "Links that can no longer accept submissions — disabled by you, or past their expiry." },
];

export const KPI_OVERLAP_NOTE = "A link can appear in more than one count — these are filters, not a breakdown of the total.";

/** state-model.ts computeIntakeKpis: the same predicates as the tabs; archived short-circuits. */
export function computeIntakeKpis(items: ReadonlyArray<IntakeLinkItem>): Record<IntakeKpiKey, number> {
  const k: Record<IntakeKpiKey, number> = { total: items.length, active: 0, submitted: 0, opened: 0, failedDelivery: 0, archived: 0, revokedOrExpired: 0 };
  for (const it of items) {
    if (matchesIntakeTab(it, "archived")) {
      k.archived += 1;
      continue;
    }
    if (matchesIntakeTab(it, "active")) k.active += 1;
    if (matchesIntakeTab(it, "submitted")) k.submitted += 1;
    if (matchesIntakeTab(it, "opened")) k.opened += 1;
    if (matchesIntakeTab(it, "failed_delivery")) k.failedDelivery += 1;
    if (matchesIntakeTab(it, "revoked_or_expired")) k.revokedOrExpired += 1;
  }
  return k;
}

export type IntakeChannelFilter = "" | "EMAIL" | "SMS" | "WHATSAPP" | "MANUAL";
export type IntakeLifecycleFilter = "" | LinkOperationalState;
export type IntakeDeliveryFilter = "" | "NONE" | "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "UNDELIVERED" | "RETRY_SCHEDULED";
export type IntakeSort = "activity" | "created" | "expires";

export const INTAKE_CHANNEL_FILTERS: ReadonlyArray<{ value: IntakeChannelFilter; label: string }> = [
  { value: "", label: "Any channel" },
  { value: "EMAIL", label: "Email" },
  { value: "SMS", label: "SMS" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "MANUAL", label: "Copy link" },
];

export const INTAKE_LIFECYCLE_FILTERS: ReadonlyArray<{ value: IntakeLifecycleFilter; label: string }> = [
  { value: "", label: "Any lifecycle" },
  { value: "ACTIVE", label: LINK_STATE_VOCABULARY.ACTIVE.label },
  { value: "ARCHIVED", label: LINK_STATE_VOCABULARY.ARCHIVED.label },
  { value: "REVOKED", label: LINK_STATE_VOCABULARY.REVOKED.label },
  { value: "EXPIRED", label: LINK_STATE_VOCABULARY.EXPIRED.label },
];

/** vocabulary.ts DELIVERY_FILTER_LABEL: NONE is the manual population. */
export const INTAKE_DELIVERY_FILTERS: ReadonlyArray<{ value: IntakeDeliveryFilter; label: string }> = [
  { value: "", label: "Any delivery state" },
  { value: "NONE", label: "Manual" },
  { value: "QUEUED", label: DELIVERY_VOCABULARY.QUEUED.label },
  { value: "SENT", label: DELIVERY_VOCABULARY.SENT.label },
  { value: "DELIVERED", label: DELIVERY_VOCABULARY.DELIVERED.label },
  { value: "FAILED", label: DELIVERY_VOCABULARY.FAILED.label },
  { value: "UNDELIVERED", label: "Undelivered" },
  { value: "RETRY_SCHEDULED", label: DELIVERY_VOCABULARY.RETRY_SCHEDULED.label },
];

/** vocabulary.ts SORT_LABEL. */
export const INTAKE_SORTS: ReadonlyArray<{ value: IntakeSort; label: string }> = [
  { value: "activity", label: "Latest activity" },
  { value: "created", label: "Newest created" },
  { value: "expires", label: "Expiring soonest" },
];

export const INTAKE_PAGE_SIZES = [25, 50, 100] as const;

export interface IntakeFilterState {
  tab: IntakeTab;
  channel: IntakeChannelFilter;
  lifecycle: IntakeLifecycleFilter;
  delivery: IntakeDeliveryFilter;
  sort: IntakeSort;
  page: number;
  pageSize: number;
}

export const DEFAULT_INTAKE_FILTERS: IntakeFilterState = {
  tab: "all",
  channel: "",
  lifecycle: "",
  delivery: "",
  sort: "activity",
  page: 1,
  pageSize: 25,
};

export function buildIntakeListPath(teamId: string, search: string): string {
  const base = `/v1/workflow/intake-links?teamId=${encodeURIComponent(teamId)}&archiveScope=all`;
  const term = search.trim();
  return term ? `${base}&search=${encodeURIComponent(term)}` : base;
}

/** filters.ts anyFilterActive (page and page size are not filters). */
export function intakeFiltersActive(search: string, f: IntakeFilterState): boolean {
  return (
    search.trim() !== "" ||
    f.tab !== "all" ||
    f.channel !== "" ||
    f.lifecycle !== "" ||
    f.delivery !== "" ||
    f.sort !== "activity"
  );
}

function hasDeliveryRecord(d: IntakeLinkDetail["delivery"]): boolean {
  return d.attemptCount > 0 || d.latestChannel != null;
}

function matchesDeliveryFilter(item: IntakeLinkItem, f: IntakeDeliveryFilter): boolean {
  if (!f) return true;
  const d = item.detail.delivery;
  if (f === "NONE") return !hasDeliveryRecord(d);
  if (f === "FAILED") return deliveryStateOf(d.latestStatus ?? "") === "FAILED";
  return String(d.latestStatus ?? "").toUpperCase() === f;
}

function activitySortKey(i: IntakeLinkItem): string {
  const d = i.detail;
  return d.activity.lastSubmittedAtUtc ?? d.activity.lastStartedAtUtc ?? d.activity.lastOpenedAtUtc ?? d.delivery.latestAtUtc ?? d.updatedAt ?? d.createdAt ?? "";
}

export interface IntakeFilterResult {
  matched: IntakeLinkItem[];
  visible: IntakeLinkItem[];
  page: number;
  pageCount: number;
}

/** filters.ts applyFilters over rows the server already matched the search term against. */
export function applyIntakeFilters(items: ReadonlyArray<IntakeLinkItem>, f: IntakeFilterState): IntakeFilterResult {
  const matched = items.filter(
    (i) =>
      matchesIntakeTab(i, f.tab) &&
      (!f.channel || String(i.detail.delivery.latestChannel ?? "MANUAL").toUpperCase() === f.channel) &&
      (!f.lifecycle || i.status === f.lifecycle) &&
      matchesDeliveryFilter(i, f.delivery),
  );
  const key = (v: string | null | undefined) => v ?? "";
  if (f.sort === "activity") matched.sort((a, b) => activitySortKey(b).localeCompare(activitySortKey(a)));
  else if (f.sort === "created") matched.sort((a, b) => key(b.detail.createdAt).localeCompare(key(a.detail.createdAt)));
  else matched.sort((a, b) => key(a.expiresAtUtc).localeCompare(key(b.expiresAtUtc)));
  const pageCount = Math.max(1, Math.ceil(matched.length / f.pageSize));
  const page = Math.min(Math.max(1, f.page), pageCount);
  const start = (page - 1) * f.pageSize;
  return { matched, visible: matched.slice(start, start + f.pageSize), page, pageCount };
}

/**
 * What a failed list read means (page.tsx:156-173): 503 / FEATURE_DISABLED is
 * a deployment that has not enabled intake; 403 and the anti-enumeration 404
 * are RESTRICTED (no retry); everything else is a retryable error.
 */
export function classifyIntakeListFailure(e: { status?: number; code?: string }): "feature_disabled" | "restricted" | "error" {
  if (e.status === 503 || e.code === "FEATURE_DISABLED") return "feature_disabled";
  if (e.status === 403 || e.status === 404) return "restricted";
  return "error";
}

/** The web's page and state copy (page.tsx, States.tsx, SubmissionsDrawer.tsx). */
export const INTAKE_LINKS_COPY = {
  title: "External intake links",
  subtitle: "Secure links that let people outside your workspace upload photos, videos, audio, or documents — without an account.",
  linksIn: "Links in",
  personalSpace: "Personal Space",
  newLink: "New intake link",
  safetyNote:
    "Contributors submit files without ever accessing this workspace. You control the channel, expiry, accepted file types, and whether a link stays live.",
  refreshing: "Refreshing intake links…",
  loading: "Loading intake links…",
  emptyTitle: "No intake links yet",
  emptyBody:
    "Create a secure upload link to request evidence from someone outside your workspace — a client, a witness, a contractor. They upload without an account and never see your workspace.",
  quickStartTitle: "Start from a common request",
  noMatchTitle: "No intake links match these filters",
  noMatchBody: "Every link is still here — the current search and filters just exclude all of them.",
  clearFilters: "Clear filters",
  errorTitle: "Couldn't load intake links",
  errorFallback: "Unable to load intake links.",
  restrictedTitle: "You don't have access to intake links here",
  restrictedForbidden:
    "Managing external intake links needs an admin or owner role in this workspace. Ask a workspace owner to grant access.",
  restrictedNoEnvelope:
    "Your access for this workspace hasn't been confirmed. Reload the page, or ask a workspace owner to check your role.",
  featureDisabledTitle: "Not enabled yet",
  featureDisabledBody:
    "External intake links aren't turned on for your account yet. Contact your IT administrator or your PROOVRA support contact to enable this feature for your workspace.",
  rowsPerPage: "Rows per page",
  submissionsEmptyTitle: "No submissions yet",
  submissionsEmptyBody: "The link is ready. Nothing has been uploaded through it so far.",
  submissionsLoadFailed: "Couldn't load submissions.",
  mutationRetry: "The link was not changed. Try again in a moment.",
} as const;

/** vocabulary.ts INTAKE_MODE_VOCABULARY[].short. */
const MODE_SHORT: Record<string, string> = {
  EXTERNAL_ONE_TIME: "One-time",
  EXTERNAL_REUSABLE: "Reusable",
  EXTERNAL_ANONYMOUS: "Anonymous",
  EXTERNAL_PSEUDONYMOUS: "Alias",
};
export function intakeModeShortLabel(mode: string): string {
  return MODE_SHORT[mode] ?? "One-time";
}

/** rowModel.ts deliveryDetail: "3 attempts · <provider error>", empty when nothing to add. */
export function deliveryDetailLine(d: IntakeLinkDetail["delivery"]): string {
  return [d.attemptCount > 1 ? `${d.attemptCount} attempts` : "", d.latestErrorCode ? providerErrorCodeLabel(d.latestErrorCode) : ""]
    .filter(Boolean)
    .join(" · ");
}

/** rowModel.ts submissions cell. */
export function submissionsCell(a: IntakeLinkDetail["activity"]): { action: "view" | "in_progress" | "none"; label: string; count: number } {
  const submitted = a.sessionsSubmitted;
  const inProgress = Math.max(0, a.sessionsStarted - submitted);
  if (submitted > 0) return { action: "view", label: `View submissions (${submitted})`, count: submitted };
  if (inProgress > 0) return { action: "in_progress", label: `In progress (${inProgress})`, count: inProgress };
  return { action: "none", label: "None yet", count: 0 };
}

/** rowModel.ts hasSessions: the row menu offers "View submissions" only then. */
export function linkHasSessions(item: IntakeLinkItem): boolean {
  return item.detail.activity.sessionsCreated > 0;
}

export type ExpiryState = "expired" | "soon" | "ok";
export function expiryStateOf(iso: string | null, now: number = Date.now()): ExpiryState {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "ok";
  if (t <= now) return "expired";
  return t - now < 72 * 60 * 60 * 1000 ? "soon" : "ok";
}

/** SubmissionsDrawer.tsx sessionLabel / sessionTone (green→verified, indigo→governance, red→risk, slate→neutral). */
export function submissionSessionDisplay(status: string): { label: string; tone: ProovraStatusTone } {
  switch (status.toUpperCase()) {
    case "SUBMITTED":
      return { label: "Submitted", tone: "verified" };
    case "OPENED":
      return { label: "Opened", tone: "neutral" };
    case "UPLOAD_STARTED":
      return { label: "Upload started", tone: "governance" };
    case "UPLOAD_COMPLETED":
      return { label: "Upload complete", tone: "governance" };
    case "ABANDONED":
      return { label: "Abandoned", tone: "neutral" };
    case "EXPIRED":
      return { label: "Expired", tone: "neutral" };
    case "REVOKED":
      return { label: "Revoked", tone: "risk" };
    default:
      return { label: "Created", tone: "neutral" };
  }
}

/** SubmissionsDrawer.tsx contributor line. */
export function submissionContributor(s: IntakeSubmission): string {
  if (s.pseudonym) return `Alias: ${s.pseudonym}`;
  return s.submitterName ?? s.submitterEmailPreview ?? s.submitterPhonePreview ?? "Anonymous";
}

/** SubmissionsDrawer.tsx: why a session offers no Open evidence. */
export function submissionWaitingNote(s: IntakeSubmission): string | null {
  if (canOpenSubmissionEvidence(s)) return null;
  return s.evidenceId ? "This session is closed; no evidence record was produced." : "Waiting for files — no evidence record yet.";
}
