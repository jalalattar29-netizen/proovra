/**
 * HOME — INTAKE STATUS (T-15 / T-14) — the native port of the web Home's
 * `IntakePipelineCard` and the `buildCollection` / `buildCollectionStats` /
 * `buildIntakePipeline` normalisers in `home-view-model.ts`.
 *
 * Native Home carried only an aggregate Intake KPI. The web card is the
 * collection LIFECYCLE: six distinct real counts, and per-link rows showing the
 * latest delivery with a Retry on a failed send. Four sources, none shared:
 *
 *   GET /v1/workflow/intake-links?teamId=                 → { links[] }  (row projection)
 *   GET /v1/communications/messages?purpose=INTAKE_LINK&teamId= → { messages[] }
 *   GET /v1/me/inbox                                      → intake review categories
 *   POST /v1/communications/messages/:id/retry  { teamId } (the web's RetryDeliveryButton)
 *
 * A source that did not load is `null`, and the card then says the figures
 * are unavailable — it never draws a pipeline of zeros for a workspace whose
 * links simply were not read.
 */
export const HOME_INTAKE_MESSAGES_PATH = "/v1/communications/messages?purpose=INTAKE_LINK";

/** The card shows five rows; the projection carries ten so "View intake" can be reached. */
export const INTAKE_PREVIEW_LIMIT = 5;
const COLLECTION_BOUND = 10;

const FAILED_DELIVERY_STATUSES = new Set(["FAILED", "UNDELIVERED"]);

export type IntakeStageTone = "neutral" | "ok" | "warn" | "danger";
export interface IntakeStage {
  key: "active" | "delivered" | "awaiting" | "in_review" | "needs_more" | "failed";
  label: string;
  count: number;
  tone: IntakeStageTone;
}
export interface IntakeRowDelivery {
  messageId: string;
  channel: string;
  status: string;
  statusLabel: string;
  failed: boolean;
  at: string | null;
}
export interface IntakeRow {
  id: string;
  label: string;
  usedCount: number;
  maxUses: number | null;
  expiresAtUtc: string | null;
  delivery: IntakeRowDelivery | null;
}
export interface IntakePipeline {
  stages: IntakeStage[];
  links: IntakeRow[];
  empty: boolean;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function deliveryStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "QUEUED":
      return "Queued";
    case "SENT":
      return "Sent";
    case "DELIVERED":
      return "Delivered";
    case "FAILED":
    case "UNDELIVERED":
      return "Failed";
    case "RETRY_SCHEDULED":
      return "Retrying";
    case "CANCELLED":
      return "Cancelled";
    default:
      return status
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

interface Msg {
  id: string;
  channel: string;
  status: string;
  createdAt: string;
  at: string | null;
  delivered: boolean;
  linkId: string | null;
}
function messagesOf(payload: unknown): Msg[] {
  const out: Msg[] = [];
  for (const raw of arr(o(payload)["messages"])) {
    const m = o(raw);
    const id = s(m["id"]);
    if (!id) continue;
    const createdAt = s(m["createdAt"]) ?? "";
    out.push({
      id,
      channel: s(m["channel"]) ?? "",
      status: s(m["status"]) ?? "",
      createdAt,
      at: s(m["deliveredAtUtc"]) ?? s(m["sentAtUtc"]) ?? s(m["failedAtUtc"]) ?? (createdAt || null),
      delivered: s(m["deliveredAtUtc"]) !== null,
      linkId: s(m["relatedIntakeLinkId"]),
    });
  }
  return out;
}

interface Link {
  id: string;
  status: string;
  label: string;
  usedCount: number;
  maxUses: number | null;
  expiresAtUtc: string | null;
}
function activeLinksOf(payload: unknown): Link[] {
  const out: Link[] = [];
  // The row projection (`links`) — the web Home reads the same array.
  for (const raw of arr(o(payload)["links"])) {
    const l = o(raw);
    const id = s(l["id"]);
    if (!id || l["status"] !== "ACTIVE") continue;
    out.push({
      id,
      status: "ACTIVE",
      label: s(l["recipientLabel"]) ?? s(l["recipientPhone"]) ?? s(l["workflowTemplateSlug"]) ?? "Intake link",
      usedCount: num(l["usedCount"]) ?? 0,
      maxUses: num(l["maxUses"]),
      expiresAtUtc: s(l["expiresAtUtc"]),
    });
  }
  return out;
}

function latestByLink(messages: Msg[]): Map<string, Msg> {
  const sorted = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const map = new Map<string, Msg>();
  for (const m of sorted) {
    if (!m.linkId || map.has(m.linkId)) continue;
    map.set(m.linkId, m);
  }
  return map;
}

/**
 * null when the links or the messages did not load — the stage counts are
 * then unknowable, and the card says so rather than showing zeros.
 */
export function buildIntakePipeline(args: {
  intakeLinks: unknown;
  communications: unknown;
  inbox: unknown;
  workspaceId: string | null;
}): IntakePipeline | null {
  if (args.intakeLinks == null || args.communications == null) return null;
  const active = activeLinksOf(args.intakeLinks);
  const messages = messagesOf(args.communications);
  const latest = latestByLink(messages);

  let failedDeliveries = 0;
  for (const l of active) {
    const d = latest.get(l.id);
    if (d && FAILED_DELIVERY_STATUSES.has(d.status.toUpperCase())) failedDeliveries += 1;
  }
  const delivered = messages.filter((m) => m.delivered).length;
  const awaiting = active.filter((l) => l.usedCount === 0).length;

  const inWorkspace = (it: Record<string, unknown>) => {
    const team = o(it["context"])["teamId"];
    return !args.workspaceId || team == null || String(team) === args.workspaceId;
  };
  const items = arr(o(args.inbox)["items"]).map(o);
  const pendingReview = items.filter((it) => it["category"] === "intake_submission_pending_review" && inWorkspace(it)).length;
  const needsMore = items.filter((it) => it["category"] === "intake_required_items_missing" && inWorkspace(it)).length;

  const links: IntakeRow[] = active.slice(0, COLLECTION_BOUND).map((l) => {
    const d = latest.get(l.id) ?? null;
    return {
      id: l.id,
      label: l.label,
      usedCount: l.usedCount,
      maxUses: l.maxUses,
      expiresAtUtc: l.expiresAtUtc,
      delivery: d
        ? {
            messageId: d.id,
            channel: d.channel,
            status: d.status,
            statusLabel: deliveryStatusLabel(d.status),
            failed: FAILED_DELIVERY_STATUSES.has(d.status.toUpperCase()),
            at: d.at,
          }
        : null,
    };
  });

  const stages: IntakeStage[] = [
    // A live "Active links" count reads success green, as on the web.
    { key: "active", label: "Active links", count: active.length, tone: active.length > 0 ? "ok" : "neutral" },
    { key: "delivered", label: "Delivered", count: delivered, tone: delivered > 0 ? "ok" : "neutral" },
    { key: "awaiting", label: "Awaiting response", count: awaiting, tone: awaiting > 0 ? "warn" : "neutral" },
    { key: "in_review", label: "Pending review", count: pendingReview, tone: pendingReview > 0 ? "warn" : "neutral" },
    { key: "needs_more", label: "Needs more info", count: needsMore, tone: needsMore > 0 ? "warn" : "neutral" },
    { key: "failed", label: "Failed sends", count: failedDeliveries, tone: failedDeliveries > 0 ? "danger" : "neutral" },
  ];
  return {
    stages,
    links,
    empty: active.length === 0 && links.length === 0 && pendingReview === 0 && needsMore === 0,
  };
}

export function buildHomeDeliveryRetryPath(messageId: string): string {
  return `/v1/communications/messages/${encodeURIComponent(messageId)}/retry`;
}

export const HOME_INTAKE_COPY = {
  title: "Intake status",
  locked:
    "Request evidence securely from a client, witness, source, or contributor — with delivery tracking and a review queue. Available on Pro and Team.",
  seePlans: "See plans",
  empty: "Request evidence securely from a client, witness, source, or contributor — then track delivery and review what comes back.",
  create: "Create intake link",
  unavailable: "Intake status could not be loaded, so these counts are not shown.",
  notSent: "Not yet sent",
  open: "Open →",
  retry: "Retry delivery",
  retrying: "Retrying…",
  retried: "Retry scheduled",
  openDelivery: "Open delivery →",
  viewAll: "View intake →",
} as const;
