/**
 * Phase C — Operational Inbox.
 *
 * GET /v1/me/inbox
 *
 * Caller-scoped operational inbox. Returns the unified stream of
 * "things that require this user's attention right now" derived from
 * existing canonical signals. The endpoint is read-only and never
 * creates a new signal — it only aggregates what other systems
 * already own.
 *
 * Signal sources (each one is a REAL backend table, not invented):
 *
 *   1. Pending organization invites addressed to the caller (Phase
 *      2.7X Stage 5 email-matched invites). Reuses the same query
 *      shape as /v1/me/operational-priorities.
 *
 *   2. Admin pending invites — count of open invites in orgs where
 *      the caller is ORG_OWNER / ORG_ADMIN, surfaced as a single
 *      operational item per org (so a 20-invite backlog renders as
 *      one inbox row, not 20).
 *
 *   3. Governance notifications — rows from `GovernanceNotification`
 *      for teams the caller is a member of, where
 *      `acknowledgedAtUtc IS NULL`. These are workspace-scoped
 *      governance signals (legal hold placed, destruction pending,
 *      retention conflict, lifecycle drift, export blocked, etc.)
 *      that already carry severity + dedupe + occurrence counting
 *      server-side. The inbox is the operator-visible surface for
 *      that pre-built pipeline.
 *
 *   4. Onboarding items — derived from membership state (no org yet,
 *      no email identity). Same logic as the priorities endpoint.
 *
 * Hard rules:
 *
 *   - Caller-scoped. We never return inbox items for a different
 *     user, even if the caller is an admin in the same org. Items
 *     are operator-relevant to THIS account.
 *
 *   - Workspace-scoped governance notifications are filtered to
 *     teams the caller is a Team member of. We do NOT surface
 *     notifications for teams the caller has no relationship with,
 *     even when ORG_OWNER of the parent org — the existing
 *     governance notification model is team-scoped by design.
 *
 *   - Read state is INHERENT in source backend state, not tracked
 *     here. An invite is "resolved" when accepted/revoked/expired.
 *     A governance notification is "resolved" when its
 *     `acknowledgedAtUtc` is set. We do NOT introduce a separate
 *     read-state column to avoid the "infinite unread growth" the
 *     brief explicitly forbids.
 *
 *   - No new events emitted; this is a pure read. The underlying
 *     systems own the audit chain.
 *
 *   - No cross-org / cross-workspace data leak. Every query is
 *     scoped to memberships the caller already has.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import {
  isPreferenceEnabled,
  OPTIONAL_INAPP_CATEGORY_TO_TYPE,
  type NotificationPreferenceType,
} from "../services/notifications/notification-preferences.service.js";
import {
  getCachedOperationsSummary,
  invalidateOperationsSummary,
  setCachedOperationsSummary,
} from "../services/notifications/operations-summary-cache.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { formatTimestampForReportUtc } from "@proovra/shared";

/**
 * Phase IA-enterprise — server-driven filter enum. Every chip the
 * frontend renders maps to one of these keys; the backend applies the
 * filter AFTER aggregation so admin-only items never reach a non-admin
 * caller even via crafted requests (the admin items are simply not
 * included in the aggregation pool for that caller).
 *
 *   all              — no filter
 *   critical         — tone === "critical"
 *   assigned_to_me   — discussion_assigned + review_escalation
 *   review           — review_decision + review_escalation
 *   governance       — governance + access_review_pending
 *   failures         — communication_failure + report_failure
 *                      + verification_package_failure + ots_failure
 *   security         — security_event_high + mfa_recovery_pending
 *   mentions         — discussion_mention
 *   unread           — currently equivalent to `all` because the
 *                      inbox has no per-user read-state model;
 *                      documented honestly so the chip can ship.
 *   due_soon         — has a dueAt within the next 7 days
 *   overdue          — has a dueAt in the past
 *   admin            — admin-only categories (mfa_recovery_pending,
 *                      communication_failure, org_admin,
 *                      report_failure, verification_package_failure)
 */
const INBOX_FILTER_KEYS = [
  "all",
  "critical",
  "assigned_to_me",
  "review",
  "governance",
  "failures",
  "security",
  "mentions",
  "unread",
  "due_soon",
  "overdue",
  "admin",
  // Operations-Center redesign — every key below is backed by a real
  // server-side query (category membership or state-join predicate):
  //   invitations    — org_invite
  //   intake         — the three intake categories
  //   reports        — report_failure
  //   packages       — verification_package_failure
  //   integrity      — ots_failure (deterministic integrity pipeline)
  //   collaboration  — collaboration-team notifications + discussion
  //                    mentions/assignments
  //   snoozed        — items with an ACTIVE snooze (normally hidden)
  //   history        — read or dismissed items whose source signal is
  //                    still present (source-resolved items leave the
  //                    aggregation entirely; see the docstring above)
  "invitations",
  "intake",
  "reports",
  "packages",
  "integrity",
  "collaboration",
  "snoozed",
  "history",
] as const;
type InboxFilter = (typeof INBOX_FILTER_KEYS)[number];

const inboxQuerySchema = z.object({
  // Opaque cursor. Encodes a forward offset into the post-filter,
  // post-sort items array. Base64-encoded for forward compatibility
  // (we may swap to a richer payload later without breaking clients).
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  filter: z.enum(INBOX_FILTER_KEYS).optional(),
  // All-workspaces scope — the page may narrow to ONE workspace,
  // validated against the caller's memberships server-side.
  workspaceId: z.string().uuid().optional(),
  // Existing tone enum — same key as the in-page chips. Server-side
  // tone filtering complements the filter enum.
  tone: z.enum(["critical", "high", "warning", "info"]).optional(),
});

const DEFAULT_PAGE_SIZE = 25;

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { offset?: number };
    const offset = parsed.offset;
    if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
      return 0;
    }
    return Math.floor(offset);
  } catch {
    // Malformed cursor falls through to the start of the list. We do
    // NOT throw — clients should not be able to crash the inbox by
    // sending a bad cursor.
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64");
}

async function requireAuthAndLegal(
  req: FastifyRequest,
  reply: Parameters<typeof requireAuth>[1],
) {
  await requireAuth(req, reply);
  await requireLegalAcceptance(req, reply);
}

type InboxTone = "info" | "warning" | "high" | "critical";
type InboxCategory =
  | "onboarding"
  | "org_invite"
  | "org_admin"
  | "governance"
  | "review_decision"
  // Phase C2 — operational evidence collaboration signals.
  // `discussion_mention` — the caller is @-mentioned in a workspace
  //   discussion thread and has not yet been notified
  //   (DiscussionMention.notifiedAtUtc IS NULL).
  // `discussion_assigned` — a discussion thread in the caller's
  //   workspace has assignedToUserId = caller AND status is not
  //   RESOLVED or CLOSED.
  // Deep-link metadata in `context` lets the inbox row open the
  // exact evidence/matter surface anchored to the thread.
  | "discussion_mention"
  | "discussion_assigned"
  // Phase IA-cleanup — post-/collaboration attention center expansion.
  // Each new category is backed by a REAL model and gated to the actor
  // it concerns. Admin-only categories never surface to non-admins.
  //   * `review_escalation` — ReviewEscalation rows where
  //       assignedToUserId = caller AND status = OPEN. Operator action
  //       surface for the workflow-tier escalation pipeline.
  //   * `access_review_pending` — AccessReview rows where the caller
  //       is the subject (`subjectUserId = userId`) OR the initiator
  //       (`initiatedByUserId = userId`) AND status = PENDING. Never
  //       leaks access reviews where the caller has no relationship.
  //   * `mfa_recovery_pending` — MfaRecoveryRequest rows in
  //       PENDING_ADMIN_REVIEW for teams where the caller is OWNER or
  //       ADMIN. Never surfaces to non-admins (the same gate that the
  //       Identity & Security console uses).
  //   * `communication_failure` — CommunicationMessage rows with
  //       status = FAILED in the last 24h for teams where the caller
  //       is OWNER or ADMIN. Same admin gate as messaging-ops mutate.
  //   * `security_event_high` — SecurityEvent rows for THIS caller's
  //       userId with severity = HIGH in the last 7 days. Never
  //       surfaces other users' events even to admins; the security
  //       center is the surface for cross-user inspection.
  | "review_escalation"
  | "access_review_pending"
  | "mfa_recovery_pending"
  | "communication_failure"
  | "security_event_high"
  // Phase IA-enterprise — operational failure surfacing. All three are
  // sourced from existing persistence: `report_failure` and
  // `verification_package_failure` come from OperationalIncident rows
  // (category REPORT / PACKAGE) populated by the incident-generator
  // service. `ots_failure` comes from Evidence rows where
  // otsStatus = "FAILED" (the Phase-12 OTS anchoring pipeline writes
  // this terminal state, encoding the specific failure code in
  // `otsFailureReason` — e.g. OTS_GLOBAL_BUDGET_EXHAUSTED). We never
  // surface PENDING / RETRY_SCHEDULED / WAITING_CONFIRMATIONS — those
  // are normal lifecycle states and would be noise.
  | "report_failure"
  | "verification_package_failure"
  | "ots_failure"
  // Phase IA-reliability — intake action-required signals. All three
  // source from canonical persisted state — NO migration. We deliberately
  // surface only ACTIONABLE statuses; normal successful submissions
  // never appear here.
  //   * `intake_submission_pending_review` — EvidenceRequest rows with
  //       status RESPONSE_RECEIVED or UNDER_REVIEW + no assigned
  //       reviewer. The team needs to claim and triage.
  //   * `intake_required_items_missing` — EvidenceRequest rows in
  //       PARTIALLY_FULFILLED or NEEDS_MORE_INFO. The contributor (or
  //       a team requester following up) needs to supply more.
  //   * `intake_link_expiring` — WorkflowIntakeLink rows in ACTIVE
  //       state whose `expiresAtUtc` is within the next 7 days. The
  //       creator should renew or revoke.
  | "intake_submission_pending_review"
  | "intake_required_items_missing"
  | "intake_link_expiring"
  // Operations-Center redesign — collaboration-team notifications
  // (CollaborationTeamNotification rows: invites accepted, role changes,
  // replies, removals …). The COLLAB ROW's `readAt` is the single source
  // of read truth for this category: reading in the Operations Center
  // updates the row, so the Team page reflects it — and vice versa.
  | "collaboration"
  // Forensic completion — first-class RFC3161 timestamping failures and
  // real case assignments (CaseAssignment model, status ACTIVE).
  | "tsa_failure"
  | "case_assignment";

/**
 * Phase IA-enterprise — bounded operator-priority tier per item.
 *
 *   P1 — Critical operational failure or critical-tone signal that
 *        blocks downstream work (report / package / OTS failure,
 *        critical-tone governance).
 *   P2 — Requires action (escalations, access reviews, MFA approval
 *        queue, security events, communication failures, conflict
 *        adjudication, org invites).
 *   P3 — Assigned-to-me (discussion mentions + assigned threads).
 *   P4 — Governance / admin notifications.
 *   P5 — Awareness / onboarding signals.
 */
type InboxPriority = "P1" | "P2" | "P3" | "P4" | "P5";

export type InboxItem = {
  /**
   * Stable, deterministic identifier for this item. Composite of
   * (sourceTable, sourceId). The frontend keys lists on this and an
   * eventual receipt model could read-track on this key.
   */
  id: string;
  /**
   * Phase IA-reliability — deterministic per-user state key. By
   * convention `itemKey === id` so the four mutation endpoints
   * (/v1/me/inbox/items/:itemKey/{read,unread,dismiss,snooze}) accept
   * the same value the frontend already has on every row. The key
   * prefix MUST be one of `INBOX_ITEM_KEY_PREFIXES` — the mutation
   * endpoints reject any other prefix to prevent enumeration.
   */
  itemKey: string;
  category: InboxCategory;
  tone: InboxTone;
  /**
   * Phase IA-enterprise — operator-facing priority tier. Driven by
   * category + tone via `priorityForItem()`. Sorting prefers priority
   * over tone so a P1 INFO never sits below a P5 WARNING.
   */
  priority: InboxPriority;
  title: string;
  body: string;
  href: string;
  /** ISO timestamp of the most recent occurrence of this item. */
  occurredAt: string;
  /**
   * Phase IA-reliability — per-user read state. Driven by an
   * InboxItemState row keyed by (userId, itemKey). `readAt` is the
   * timestamp on the state row; `isRead` is its boolean projection
   * for convenience.
   */
  isRead: boolean;
  readAt?: string | null;
  /** Set only when the user actively dismissed an earlier occurrence. */
  dismissedAt?: string | null;
  /** Set only when the user snoozed this item; null after expiry. */
  snoozedUntil?: string | null;
  /** Operator-visible action capabilities. All true today; future
   * categories that don't make sense to mark read or snooze can flip
   * these without breaking the UI. */
  canMarkRead: boolean;
  canDismiss: boolean;
  canSnooze: boolean;
  /**
   * IN_APP-honesty — true when the item's category maps to an OPTIONAL
   * preference type whose IN_APP toggle the user disabled for this
   * workspace. Suppressed items are excluded from the live view, the
   * summary count, bulk-read targets, and history sync — but stay in
   * `allItems` so the EMAIL/digest channel remains fully independent.
   */
  suppressedInApp?: boolean;
  /**
   * Optional deadline for the action. Populated when the underlying
   * source carries a real expiry / due date (access review dueAtUtc,
   * MFA recovery expiresAt, org invite expiresAt). null otherwise —
   * we never fabricate a deadline.
   */
  dueAt?: string | null;
  /**
   * Optional context for the operator (org name, workspace name).
   * Never PII; only short identifiers + names already visible to the
   * caller.
   */
  context: Record<string, string | number | null>;
};

/**
 * Phase IA-reliability — allowlist of valid itemKey source-type
 * prefixes. The four mutation endpoints reject any key whose left
 * side isn't in this set, so a hostile client cannot use the
 * endpoint to spray InboxItemState rows with arbitrary content. The
 * scoping in the table (one row per (userId, itemKey)) means a
 * misaligned key has no impact on other users, but this allowlist
 * also keeps the table free of garbage for storage hygiene.
 *
 * Update this list whenever a new InboxCategory is added with an id
 * prefix the aggregator emits. The mapping is intentionally manual
 * so a forgotten allowlist entry surfaces as a 400 rather than a
 * silent write.
 */
const INBOX_ITEM_KEY_PREFIXES = new Set<string>([
  "onboarding",
  "org_invite",
  "org_admin",
  "governance",
  "review_decision",
  "discussion_mention",
  "discussion_assigned",
  "review_escalation",
  "access_review_pending",
  "mfa_recovery_pending",
  "communication_failure",
  "security_event_high",
  "report_failure",
  "verification_package_failure",
  "ots_failure",
  "intake_submission_pending_review",
  "intake_required_items_missing",
  "intake_link_expiring",
  "collaboration",
  // Remediation 2026-07-14 — these two categories emitted items whose
  // keys the mutation endpoints rejected 400 (forgotten allowlist
  // entries, exactly the failure mode this manual list is designed to
  // surface). Keys match the aggregation emitters verbatim:
  // `tsa_failure:${evidence.id}` / `case_assignment:${assignment.id}`.
  "tsa_failure",
  "case_assignment",
]);

/**
 * Phase IA-reliability — validate that an itemKey claims one of the
 * known source prefixes and stays under the schema's 200-char cap.
 * Returns the parsed source-type prefix on success and null on any
 * shape failure. The caller surfaces null as a 400.
 */
function parseInboxItemKey(itemKey: string): {
  sourceType: string;
  sourceId: string | null;
} | null {
  if (typeof itemKey !== "string" || itemKey.length === 0) return null;
  if (itemKey.length > 200) return null;
  // Source type is everything before the first ":". The rest (possibly
  // containing additional ":" separators — e.g. org_admin:<orgId>:pending_invites
  // — is the source id half. Either may be empty for keys like
  // "onboarding:no_organizations" where the right side is a literal.
  const colon = itemKey.indexOf(":");
  if (colon < 1 || colon === itemKey.length - 1) return null;
  const sourceType = itemKey.slice(0, colon);
  if (!INBOX_ITEM_KEY_PREFIXES.has(sourceType)) return null;
  const sourceId = itemKey.slice(colon + 1);
  // The right side must be benign — letters/digits, ":", "-", "_", ".".
  // No "/", "?", "<", ">", whitespace, etc. — these don't appear in
  // any UUID / slug we emit and would indicate a crafted payload.
  if (!/^[A-Za-z0-9_.:-]+$/.test(sourceId)) return null;
  return { sourceType, sourceId };
}

/**
 * Phase IA-enterprise — priority tier per category. The spec maps:
 *   P1 — report / package / OTS failure, critical-tone signals
 *   P2 — escalation / access review / MFA approval / security event /
 *        communication failure / review conflict / org invite
 *   P3 — discussion mention + discussion assigned
 *   P4 — governance + org admin rollup
 *   P5 — onboarding + review awareness
 *
 * `tone === "critical"` upgrades any item to P1 so a CRITICAL
 * governance event isn't buried behind a P2 personal escalation.
 */
function priorityForItem(item: {
  category: InboxCategory;
  tone: InboxTone;
}): InboxPriority {
  if (item.tone === "critical") return "P1";
  switch (item.category) {
    case "report_failure":
    case "verification_package_failure":
    case "ots_failure":
    case "tsa_failure":
      return "P1";
    case "review_escalation":
    case "access_review_pending":
    case "mfa_recovery_pending":
    case "security_event_high":
    case "communication_failure":
    case "org_invite":
    case "intake_submission_pending_review":
    case "intake_required_items_missing":
      return "P2";
    case "intake_link_expiring":
      return "P4";
    case "review_decision":
      // Conflict-detected workflows are P2; awaiting-second awareness
      // items are P5. Distinguished by id-prefix because both share
      // the same category name.
      return "P2"; // upgraded below per-id when known
    case "discussion_mention":
    case "discussion_assigned":
    case "collaboration":
    case "case_assignment":
      return "P3";
    case "governance":
    case "org_admin":
      return "P4";
    case "onboarding":
      return "P5";
    default:
      // Future-proof: unknown categories default to "needs action"
      // rather than getting hidden at the bottom.
      return "P2";
  }
}

/**
 * Phase IA-enterprise — filter membership. For category-keyed filters
 * we use this table; tone/due-date filters live inline because they
 * need runtime data.
 */
const FILTER_CATEGORY_MEMBERS: Partial<
  Record<InboxFilter, ReadonlyArray<InboxCategory>>
> = {
  assigned_to_me: ["discussion_assigned", "review_escalation", "case_assignment"],
  review: [
    "review_decision",
    "review_escalation",
    "intake_submission_pending_review",
  ],
  // intake_link_expiring is an INTAKE operational deadline, NOT a
  // governance (retention/legal-hold/destruction) event — it lives under
  // `intake` (core) + `admin` (resolution requires ADMIN: revoke/extend
  // are requireAdmin in workflow-intake-links.routes.ts) + the dueAt
  // Due-soon/Overdue lenses. It is deliberately NOT a governance member.
  governance: ["governance", "access_review_pending"],
  failures: [
    "communication_failure",
    "report_failure",
    "verification_package_failure",
    "ots_failure",
    "tsa_failure",
    // intake_required_items_missing surfaces as a "failure" in the
    // sense that the intake didn't complete — operators expect to find
    // it under Failures alongside report/package issues.
    "intake_required_items_missing",
  ],
  security: ["security_event_high", "mfa_recovery_pending"],
  mentions: ["discussion_mention"],
  admin: [
    "mfa_recovery_pending",
    "communication_failure",
    "org_admin",
    "report_failure",
    "verification_package_failure",
    "intake_submission_pending_review",
    "intake_link_expiring",
  ],
  // Operations-Center redesign — additional real category filters.
  invitations: ["org_invite"],
  intake: [
    "intake_submission_pending_review",
    "intake_required_items_missing",
    "intake_link_expiring",
  ],
  reports: ["report_failure"],
  packages: ["verification_package_failure"],
  integrity: ["ots_failure", "tsa_failure"],
  collaboration: [
    "collaboration",
    "discussion_mention",
    "discussion_assigned",
  ],
};

function matchesFilter(
  item: InboxItem,
  filter: InboxFilter | undefined,
  nowMs: number,
): boolean {
  if (!filter || filter === "all") return true;
  // Phase IA-reliability — `unread` is now a REAL filter against the
  // per-user InboxItemState join; an item is unread when no state row
  // exists or its `readAt` is null. (Dismissed and snoozed items are
  // already filtered out upstream.)
  if (filter === "unread") return !item.isRead;
  // Operations-Center redesign — snoozed shows ONLY actively-snoozed
  // items (they are included upstream when this filter is requested);
  // history shows read or dismissed items whose source signal still
  // exists. Both are state-join-backed, never decorative.
  if (filter === "snoozed") {
    return (
      item.snoozedUntil != null &&
      new Date(item.snoozedUntil).getTime() > nowMs
    );
  }
  if (filter === "history") {
    return item.isRead || item.dismissedAt != null;
  }
  if (filter === "critical") return item.tone === "critical";
  if (filter === "overdue") {
    return item.dueAt !== null && item.dueAt !== undefined
      ? new Date(item.dueAt).getTime() < nowMs
      : false;
  }
  if (filter === "due_soon") {
    if (!item.dueAt) return false;
    const due = new Date(item.dueAt).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return due >= nowMs && due <= nowMs + sevenDays;
  }
  const members = FILTER_CATEGORY_MEMBERS[filter];
  if (!members) return true;
  return members.includes(item.category);
}

const PRIORITY_ORDER: Record<InboxPriority, number> = {
  P1: 5,
  P2: 4,
  P3: 3,
  P4: 2,
  P5: 1,
};

const TONE_PRIORITY: Record<InboxTone, number> = {
  critical: 4,
  high: 3,
  warning: 2,
  info: 1,
};

/**
 * Phase IA-enterprise — operator-friendly sort.
 *
 *   priority (P1..P5)  →
 *   due-date posture (overdue → due-soon → no-due) →
 *   tone (critical..info) →
 *   occurredAt desc
 *
 * The due-date posture step keeps overdue items above future-due items
 * within the same priority tier; otherwise sorting purely on
 * occurredAt would surface a stale overdue item below a fresh-but-
 * future item.
 */
function compareInboxItems(a: InboxItem, b: InboxItem, nowMs: number): number {
  const dp = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
  if (dp !== 0) return dp;
  const aDueScore = dueScore(a.dueAt, nowMs);
  const bDueScore = dueScore(b.dueAt, nowMs);
  if (aDueScore !== bDueScore) return bDueScore - aDueScore;
  const dt = TONE_PRIORITY[b.tone] - TONE_PRIORITY[a.tone];
  if (dt !== 0) return dt;
  return b.occurredAt.localeCompare(a.occurredAt);
}

function dueScore(dueAt: string | null | undefined, nowMs: number): number {
  if (!dueAt) return 0;
  const due = new Date(dueAt).getTime();
  if (due < nowMs) return 2; // overdue — surface highest
  if (due <= nowMs + 7 * 24 * 60 * 60 * 1000) return 1; // due soon
  return 0;
}

// ---------------------------------------------------------------------------
// Operations-Center completion — persistent history snapshots.
//
// `operations_inbox_snapshots` preserves a per-user copy of every surfaced
// item so History survives source resolution. The table may not exist on an
// un-migrated environment; a cached one-time probe downgrades gracefully
// (History reports historyAvailable:false, sync/no-ops elsewhere).
// ---------------------------------------------------------------------------
let snapshotTableState: "unknown" | "available" | "missing" = "unknown";

async function snapshotsAvailable(): Promise<boolean> {
  if (snapshotTableState === "unknown") {
    try {
      await prisma.operationsInboxSnapshot.findFirst({ select: { id: true } });
      snapshotTableState = "available";
    } catch (err) {
      const code = (err as { code?: string })?.code;
      snapshotTableState =
        code === "P2021" || code === "P2022" ? "missing" : "available";
    }
  }
  return snapshotTableState === "available";
}

/** Bounded metadata copy — string/number/null values only, capped. The
 *  source `context` map already contains ONLY fields the user saw. */
function boundedSnapshotMetadata(
  context: Record<string, string | number | null>,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  let n = 0;
  for (const [k, v] of Object.entries(context ?? {})) {
    if (n >= 20) break;
    if (v === null || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 300);
    else continue;
    n += 1;
  }
  return out;
}

/**
 * Upsert snapshots for every currently-live item and mark previously-live
 * snapshots RESOLVED when their source stopped emitting them. Title/body
 * are written ONCE at first surface and never rewritten. Bounded to four
 * statements per request. Failures never break the inbox response.
 */
export async function syncInboxSnapshots(
  userId: string,
  items: InboxItem[],
  now: Date,
  log: FastifyRequest["log"],
): Promise<void> {
  if (!(await snapshotsAvailable())) return;
  try {
    const keys = items.map((i) => i.itemKey);
    if (keys.length > 0) {
      const existing = await prisma.operationsInboxSnapshot.findMany({
        where: { userId, itemKey: { in: keys } },
        select: { itemKey: true },
      });
      const existingSet = new Set(existing.map((e) => e.itemKey));
      const missing = items.filter((i) => !existingSet.has(i.itemKey));
      if (missing.length > 0) {
        await prisma.operationsInboxSnapshot.createMany({
          data: missing.map((i) => {
            const colon = i.itemKey.indexOf(":");
            return {
              userId,
              itemKey: i.itemKey,
              sourceType: colon > 0 ? i.itemKey.slice(0, colon) : i.category,
              sourceId: colon > 0 ? i.itemKey.slice(colon + 1).slice(0, 200) : null,
              teamId:
                typeof i.context?.teamId === "string" ? i.context.teamId : null,
              orgId:
                typeof i.context?.organizationId === "string"
                  ? i.context.organizationId
                  : null,
              category: i.category,
              severity: i.tone,
              priority: i.priority,
              title: i.title.slice(0, 300),
              body: i.body.slice(0, 1200),
              href: i.href.slice(0, 300),
              dueAtUtc: i.dueAt ? new Date(i.dueAt) : null,
              sourceOccurredAtUtc: new Date(i.occurredAt),
              readAtUtc: i.readAt ? new Date(i.readAt) : null,
              dismissedAtUtc: i.dismissedAt ? new Date(i.dismissedAt) : null,
              snoozedUntilUtc: i.snoozedUntil ? new Date(i.snoozedUntil) : null,
              metadataJson: boundedSnapshotMetadata(i.context),
            };
          }),
          skipDuplicates: true,
        });
      }
      // Still live: refresh lastSeen and clear any earlier resolution
      // (a source that re-fires under the same key is live again).
      await prisma.operationsInboxSnapshot.updateMany({
        where: { userId, itemKey: { in: keys } },
        data: {
          lastSeenAtUtc: now,
          resolvedAtUtc: null,
          resolutionSource: null,
          resolvedByUserId: null,
        },
      });
    }
    // Previously live, absent now → the canonical source resolved it.
    await prisma.operationsInboxSnapshot.updateMany({
      where: {
        userId,
        resolvedAtUtc: null,
        ...(keys.length > 0 ? { itemKey: { notIn: keys } } : {}),
      },
      // Provenance is labeled SYSTEM/source-state — no human resolver is
      // ever fabricated for automatic resolutions.
      data: { resolvedAtUtc: now, resolutionSource: "SOURCE_STATE" },
    });
  } catch (err) {
    log.error({ err, userId }, "inbox.snapshot_sync_failed");
  }
}

/**
 * Operations-Center completion — the CANONICAL aggregation, shared by:
 *   GET  /v1/me/inbox           (the Operations Center page)
 *   GET  /v1/me/inbox/summary   (the header bell — cached)
 *   POST /v1/me/inbox/mark-all-read
 *
 * One computation means the badge, the page, and bulk actions can never
 * disagree on authorization, category scope, or read state. Returns the
 * post-state item set with dismissed items REMOVED (History reads the
 * persistent snapshot table instead) and actively-snoozed items removed
 * unless `opts.includeSnoozed` is set (the live `snoozed` filter).
 */
export type InboxAggregationResult =
  | {
      ok: true;
      caller: { id: string; email: string | null; displayName: string | null };
      allItems: InboxItem[];
      degradedSources: string[];
      truncated: Record<string, boolean>;
      anyTruncated: boolean;
      generatedAt: Date;
    }
  | { ok: false };

/**
 * EXPORTED at module scope so the digest scheduler runs the EXACT same
 * canonical aggregation as the Operations Center page, the Bell summary,
 * and bulk read — digests never depend on a prior UI visit and never use
 * a second aggregator.
 */
export async function buildInboxAggregation(
    userId: string,
    log: FastifyRequest["log"],
  ): Promise<InboxAggregationResult> {
      const now = new Date();
      const nowMs = now.getTime();

      // Phase IA-securityEvent-driftFix — bounded source isolation.
      //
      // The inbox aggregates ~16 distinct backend queries. Before this
      // wrapper, a single failing source — e.g. the
      // `prisma.securityEvent.findMany({ severity: "HIGH" })` query
      // erroring with "operator does not exist: character varying =
      // 'SecurityEventSeverity'" on a schema-drift production — would
      // bubble up as a 500 and destroy the entire endpoint.
      //
      // `safelyLoadSource` lets us run each OPTIONAL source under a
      // bounded try/catch. On failure:
      //   * the source name is recorded in `degradedSources`
      //   * a structured error is logged at error level
      //   * the caller continues with the requested fallback (usually
      //     an empty array) so the rest of the inbox keeps working
      //
      // CORE sources (user lookup, org memberships, team memberships,
      // org invites, governance notifications) are deliberately NOT
      // wrapped — if those fail the operator deserves a 500 rather
      // than a silently broken attention center.
      //
      // The contract is exposed on the response envelope as
      // `degraded: boolean` + `degradedSources: string[]` so the UI
      // can render an honest banner without inventing fake states.
      const degradedSources: string[] = [];
      async function safelyLoadSource<T>(
        name: string,
        fn: () => Promise<T>,
        fallback: T,
      ): Promise<T> {
        try {
          return await fn();
        } catch (err) {
          degradedSources.push(name);
          log.error(
            {
              err,
              source: name,
              userId,
              route: "/v1/me/inbox",
            },
            "inbox.source_failed",
          );
          return fallback;
        }
      }

      // -----------------------------------------------------------------
      // Caller identity probe.
      // -----------------------------------------------------------------
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, displayName: true },
      });
      if (!me) {
        return { ok: false as const };
      }
      const callerEmail = (me.email ?? "").trim().toLowerCase();

      // -----------------------------------------------------------------
      // Caller's org memberships (for admin-pending-invite rollup).
      // -----------------------------------------------------------------
      const orgMemberships = await prisma.organizationMembership.findMany({
        where: { userId },
        select: {
          role: true,
          organization: {
            select: { id: true, name: true, status: true },
          },
        },
      });
      const adminOrgIds = orgMemberships
        .filter((m) => m.role === "ORG_OWNER" || m.role === "ORG_ADMIN")
        .map((m) => m.organization.id);
      const orgNameById = new Map<string, string>(
        orgMemberships.map((m) => [m.organization.id, m.organization.name]),
      );

      // -----------------------------------------------------------------
      // Caller's team memberships (for governance-notification scope).
      // -----------------------------------------------------------------
      // The team table carries `ownerUserId` for personal teams and
      // explicit TeamMember rows for collaborative teams. To capture
      // both we query TeamMember + the personal-owner fallback.
      const teamMemberships = await prisma.teamMember.findMany({
        where: { userId },
        select: {
          team: { select: { id: true, name: true } },
        },
      });
      const teamIdSet = new Set<string>(
        teamMemberships.map((tm) => tm.team.id),
      );
      // Also include personal teams the caller owns. These may not
      // have a TeamMember row in some seeding paths.
      const ownedPersonalTeams = await prisma.team.findMany({
        where: { ownerUserId: userId },
        select: { id: true, name: true },
      });
      for (const t of ownedPersonalTeams) teamIdSet.add(t.id);
      const teamIds = Array.from(teamIdSet);
      const teamNameById = new Map<string, string>([
        ...teamMemberships.map(
          (tm) => [tm.team.id, tm.team.name] as [string, string],
        ),
        ...ownedPersonalTeams.map((t) => [t.id, t.name] as [string, string]),
      ]);

      // -----------------------------------------------------------------
      // Source 1: pending org invites addressed to the caller.
      // -----------------------------------------------------------------
      const pendingOrgInvites = callerEmail
        ? await prisma.organizationInvite.findMany({
            where: {
              email: callerEmail,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
            select: {
              id: true,
              role: true,
              expiresAt: true,
              createdAt: true,
              organization: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "asc" },
          })
        : [];

      // -----------------------------------------------------------------
      // Source 2: admin pending-invite rollup (one item per org).
      // -----------------------------------------------------------------
      const adminPendingByOrg =
        adminOrgIds.length === 0
          ? []
          : await prisma.organizationInvite.groupBy({
              by: ["organizationId"],
              where: {
                organizationId: { in: adminOrgIds },
                acceptedAt: null,
                revokedAt: null,
                expiresAt: { gt: now },
              },
              _count: { id: true },
              _max: { createdAt: true },
            });

      // Caller's per-team role lookup for the adjudicator subset.
      const teamRoles =
        teamIds.length === 0
          ? []
          : await prisma.teamMember.findMany({
              where: {
                userId,
                teamId: { in: teamIds },
              },
              select: { teamId: true, role: true },
            });
      const adjudicatorTeamIds = teamRoles
        .filter((r) => r.role === "OWNER" || r.role === "ADMIN")
        .map((r) => r.teamId);

      // (a) Conflict-detected workflows where caller is adjudicator.
      //
      // A workflow is in conflict_detected when FIRST and SECOND
      // decisions exist AND they differ AND no ADJUDICATION row exists.
      // We do this in one round trip by selecting all workflows with
      // FIRST+SECOND decisions in adjudicator teams and filtering in
      // memory.
      const conflictCandidates =
        adjudicatorTeamIds.length === 0
          ? []
          : await prisma.workflowReviewDecision.findMany({
              where: {
                teamId: { in: adjudicatorTeamIds },
                stage: { in: ["FIRST", "SECOND", "ADJUDICATION"] },
              },
              select: {
                workflowId: true,
                teamId: true,
                stage: true,
                decision: true,
                decidedAt: true,
              },
            });

      type StageMap = Map<
        string,
        {
          teamId: string;
          first?: { decision: string };
          second?: { decision: string; decidedAt: Date };
          adjudication?: boolean;
        }
      >;
      const stagesByWorkflow: StageMap = new Map();
      for (const r of conflictCandidates) {
        const entry = stagesByWorkflow.get(r.workflowId) ?? {
          teamId: r.teamId,
        };
        if (r.stage === "FIRST") entry.first = { decision: r.decision };
        else if (r.stage === "SECOND")
          entry.second = { decision: r.decision, decidedAt: r.decidedAt };
        else if (r.stage === "ADJUDICATION") entry.adjudication = true;
        stagesByWorkflow.set(r.workflowId, entry);
      }
      const conflictWorkflows: Array<{
        workflowId: string;
        teamId: string;
        decidedAt: Date;
      }> = [];
      for (const [workflowId, entry] of stagesByWorkflow) {
        if (
          entry.first &&
          entry.second &&
          !entry.adjudication &&
          entry.first.decision !== entry.second.decision
        ) {
          conflictWorkflows.push({
            workflowId,
            teamId: entry.teamId,
            decidedAt: entry.second.decidedAt,
          });
        }
      }

      // (b) Workflows where caller submitted FIRST and SECOND is still
      // pending. We surface this as awareness only.
      const myFirstDecisions =
        teamIds.length === 0
          ? []
          : await prisma.workflowReviewDecision.findMany({
              where: {
                reviewerUserId: userId,
                stage: "FIRST",
                teamId: { in: teamIds },
              },
              select: {
                workflowId: true,
                teamId: true,
                decidedAt: true,
              },
            });
      // Filter to ones that DON'T yet have a SECOND row.
      const myFirstWorkflowIds = myFirstDecisions.map((d) => d.workflowId);
      const secondsForMyFirsts =
        myFirstWorkflowIds.length === 0
          ? []
          : await prisma.workflowReviewDecision.findMany({
              where: {
                workflowId: { in: myFirstWorkflowIds },
                stage: "SECOND",
              },
              select: { workflowId: true },
            });
      const haveSecond = new Set<string>(
        secondsForMyFirsts.map((s) => s.workflowId),
      );
      const pendingSecondForMe = myFirstDecisions.filter(
        (d) => !haveSecond.has(d.workflowId),
      );

      // -----------------------------------------------------------------
      // Source 3: unacknowledged governance notifications for teams
      // the caller is a member of.
      // -----------------------------------------------------------------
      const governanceRows =
        teamIds.length === 0
          ? []
          : await prisma.governanceNotification.findMany({
              where: {
                teamId: { in: teamIds },
                acknowledgedAtUtc: null,
              },
              select: {
                id: true,
                teamId: true,
                kind: true,
                severity: true,
                lastSeenAtUtc: true,
                occurrenceCount: true,
                metadata: true,
              },
              orderBy: [
                { severity: "desc" },
                { lastSeenAtUtc: "desc" },
              ],
              take: 100,
            });

      // -----------------------------------------------------------------
      // Source 4: Phase C2 — unread discussion mentions for the caller.
      //
      // A row in DiscussionMention with notifiedAtUtc IS NULL represents
      // an unread @-mention. The query is scoped to teamIds the caller
      // is a member of so cross-workspace mentions cannot leak. Each
      // mention rolls up to one inbox item with deep-link metadata
      // (evidenceId + threadId + messageId) so the frontend opens the
      // exact thread.
      // -----------------------------------------------------------------
      const unreadMentions =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "discussion_mention",
              () =>
                prisma.discussionMention.findMany({
              where: {
                teamId: { in: teamIds },
                mentionedUserId: userId,
                notifiedAtUtc: null,
              },
              select: {
                id: true,
                teamId: true,
                threadId: true,
                messageId: true,
                createdAt: true,
                message: {
                  select: {
                    thread: {
                      select: {
                        id: true,
                        title: true,
                        evidenceId: true,
                        status: true,
                      },
                    },
                  },
                },
              },
              orderBy: { createdAt: "desc" },
              take: 100,
            }),
              [],
            );

      // -----------------------------------------------------------------
      // Source 5: Phase C2 — unresolved discussion threads assigned to
      // the caller. Threads in status RESOLVED or CLOSED do not surface.
      // -----------------------------------------------------------------
      const PER_CATEGORY_TAKE = 50;
      const assignedThreads =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "discussion_assigned",
              () =>
                prisma.discussionThread.findMany({
                  where: {
                    teamId: { in: teamIds },
                    assignedToUserId: userId,
                    status: { notIn: ["RESOLVED", "CLOSED"] },
                  },
                  select: {
                    id: true,
                    teamId: true,
                    evidenceId: true,
                    title: true,
                    status: true,
                    escalatedAtUtc: true,
                    updatedAt: true,
                  },
                  orderBy: { updatedAt: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-cleanup — Source 6: workflow-tier escalations assigned
      // to the caller. ReviewEscalation is the canonical operator-action
      // surface (status OPEN means it still needs human action). We
      // workspace-scope to all teams the caller belongs to so both
      // adjudicator and assignee see their queue items.
      // -----------------------------------------------------------------
      const myReviewEscalations =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "review_escalation",
              () =>
                prisma.reviewEscalation.findMany({
                  where: {
                    teamId: { in: teamIds },
                    assignedToUserId: userId,
                    status: "OPEN",
                  },
                  select: {
                    id: true,
                    teamId: true,
                    workflowId: true,
                    evidenceId: true,
                    reason: true,
                    severity: true,
                    safeSummary: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                  orderBy: { updatedAt: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-cleanup — Source 7: access reviews where the caller is
      // the SUBJECT (their access is being reviewed) OR the INITIATOR
      // (they kicked the review off). We deliberately do NOT surface
      // every pending access review in the workspace — that would leak
      // governance signal to actors with no role in the review.
      // Admin/team-wide queue lives in the access-review console.
      // -----------------------------------------------------------------
      const myAccessReviews = await safelyLoadSource(
        "access_review_pending",
        () =>
          prisma.accessReview.findMany({
            where: {
              status: { in: ["PENDING", "IN_PROGRESS"] },
              OR: [
                { subjectUserId: userId },
                { initiatedByUserId: userId },
              ],
            },
            select: {
              id: true,
              teamId: true,
              kind: true,
              status: true,
              dueAtUtc: true,
              subjectKind: true,
              subjectUserId: true,
              initiatedByUserId: true,
              createdAt: true,
            },
            orderBy: [{ dueAtUtc: "asc" }, { createdAt: "desc" }],
            take: PER_CATEGORY_TAKE,
          }),
        [],
      );

      // -----------------------------------------------------------------
      // Phase IA-cleanup — Source 8: pending MFA recovery requests for
      // teams where the caller is OWNER or ADMIN. This mirrors the
      // gating on the existing Identity & Security console
      // (/security-center) — admins see the queue, non-admins never do.
      // The endpoint we call when the admin opens the queue (
      // /v1/identity/mfa-admin/recovery-requests/:teamId) enforces the
      // same gate server-side, so even a forged inbox would be blocked
      // at the action surface.
      // -----------------------------------------------------------------
      const pendingMfaRecovery =
        adjudicatorTeamIds.length === 0
          ? []
          : await safelyLoadSource(
              "mfa_recovery_pending",
              () =>
                prisma.mfaRecoveryRequest.findMany({
                  where: {
                    teamId: { in: adjudicatorTeamIds },
                    status: "PENDING_ADMIN_REVIEW",
                  },
                  select: {
                    id: true,
                    teamId: true,
                    userId: true,
                    reason: true,
                    requiredApprovals: true,
                    approvalCount: true,
                    createdAt: true,
                  },
                  orderBy: { createdAt: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-cleanup — Source 9: recent communication delivery
      // failures for teams where the caller is OWNER or ADMIN. Same
      // admin gate as messaging-ops mutations. We scope to the last
      // 24h to keep the inbox actionable (older failures still appear
      // in /communications). Only surfaces the failed-status rows.
      // -----------------------------------------------------------------
      const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
      const failureCutoff = new Date(now.getTime() - FAILURE_WINDOW_MS);
      const failedCommunications =
        adjudicatorTeamIds.length === 0
          ? []
          : await safelyLoadSource(
              "communication_failure",
              () =>
                prisma.communicationMessage.findMany({
                  where: {
                    teamId: { in: adjudicatorTeamIds },
                    status: "FAILED",
                    updatedAt: { gte: failureCutoff },
                  },
                  select: {
                    id: true,
                    teamId: true,
                    channel: true,
                    purpose: true,
                    errorCode: true,
                    recipientPreview: true,
                    attemptCount: true,
                    updatedAt: true,
                  },
                  orderBy: { updatedAt: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-cleanup — Source 10: high-severity security events for
      // THIS caller's identity in the last 7 days. We scope to
      // userId = caller so admins do NOT see other users' security
      // events via this endpoint — the security center is the
      // canonical cross-user surface. SecurityEventSeverity enum is
      // INFO | WARNING | HIGH (no CRITICAL — verified in schema), so
      // HIGH is the elevated tone for this category.
      // -----------------------------------------------------------------
      const SECURITY_EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const securityCutoff = new Date(now.getTime() - SECURITY_EVENT_WINDOW_MS);
      const myHighSecurityEvents = await safelyLoadSource(
        "security_event_high",
        () =>
          prisma.securityEvent.findMany({
            where: {
              userId,
              severity: "HIGH",
              createdAt: { gte: securityCutoff },
            },
            select: {
              id: true,
              teamId: true,
              eventType: true,
              severity: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: PER_CATEGORY_TAKE,
          }),
        [],
      );

      // -----------------------------------------------------------------
      // Phase IA-enterprise — Source 11: report generation failure
      // incidents. OperationalIncident is the canonical aggregator
      // populated by `incident-generator.service.ts`; rows in
      // (OPEN | ACKNOWLEDGED) state with category REPORT are the
      // operator-relevant surface. Workspace-scoped to caller's teams.
      // Severity (CRITICAL | HIGH | WARNING | INFO) maps directly to
      // inbox tone.
      // -----------------------------------------------------------------
      const reportIncidents =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "report_failure",
              () =>
                prisma.operationalIncident.findMany({
                  where: {
                    teamId: { in: teamIds },
                    category: "REPORT",
                    status: { in: ["OPEN", "ACKNOWLEDGED"] },
                  },
                  select: {
                    id: true,
                    teamId: true,
                    title: true,
                    safeSummary: true,
                    severity: true,
                    status: true,
                    occurrenceCount: true,
                    relatedEvidenceId: true,
                    relatedJobId: true,
                    lastSeenAtUtc: true,
                    firstSeenAtUtc: true,
                    runbookSlug: true,
                  },
                  orderBy: { lastSeenAtUtc: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-enterprise — Source 12: verification package failure
      // incidents. Same persistence + scoping as report failures, just
      // category PACKAGE.
      // -----------------------------------------------------------------
      const packageIncidents =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "verification_package_failure",
              () =>
                prisma.operationalIncident.findMany({
                  where: {
                    teamId: { in: teamIds },
                    category: "PACKAGE",
                    status: { in: ["OPEN", "ACKNOWLEDGED"] },
                  },
                  select: {
                    id: true,
                    teamId: true,
                    title: true,
                    safeSummary: true,
                    severity: true,
                    status: true,
                    occurrenceCount: true,
                    relatedEvidenceId: true,
                    relatedJobId: true,
                    lastSeenAtUtc: true,
                    firstSeenAtUtc: true,
                    runbookSlug: true,
                  },
                  orderBy: { lastSeenAtUtc: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-enterprise — Source 13: OTS anchoring failures.
      // The OTS pipeline writes its terminal state directly on Evidence
      // (otsStatus = "FAILED" + a machine-readable code in
      // otsFailureReason — e.g. "OTS_GLOBAL_BUDGET_EXHAUSTED" or the
      // normalized error from the OTS binary). We deliberately do NOT
      // surface PENDING / WAITING_CONFIRMATIONS / RETRY_SCHEDULED —
      // those are normal lifecycle states and would be alert spam.
      // We also exclude soft-deleted evidence.
      // -----------------------------------------------------------------
      const otsFailedEvidence =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "ots_failure",
              () =>
                prisma.evidence.findMany({
                  where: {
                    teamId: { in: teamIds },
                    otsStatus: "FAILED",
                    deletedAt: null,
                  },
                  select: {
                    id: true,
                    teamId: true,
                    caseLinks: {
                      orderBy: { linkedAtUtc: "asc" },
                      select: { caseId: true },
                      take: 1,
                    },
                    title: true,
                    originalFileName: true,
                    otsFailureReason: true,
                    otsUpgradedAtUtc: true,
                    otsHash: true,
                    updatedAt: true,
                  },
                  orderBy: { otsUpgradedAtUtc: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-reliability — Source 14: intake submissions pending
      // review. We surface EvidenceRequest rows whose response has
      // arrived (RESPONSE_RECEIVED) or is being reviewed (UNDER_REVIEW)
      // but no reviewer has claimed ownership yet. Workspace-scoped via
      // caller's teamIds.
      // -----------------------------------------------------------------
      const pendingReviewRequests =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "intake_submission_pending_review",
              () =>
                prisma.evidenceRequest.findMany({
                  where: {
                    teamId: { in: teamIds },
                    status: { in: ["RESPONSE_RECEIVED", "UNDER_REVIEW"] },
                    assignedReviewerUserId: null,
                  },
                  select: {
                    id: true,
                    teamId: true,
                    title: true,
                    status: true,
                    priority: true,
                    dueAtUtc: true,
                    updatedAt: true,
                  },
                  orderBy: [{ dueAtUtc: "asc" }, { updatedAt: "desc" }],
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-reliability — Source 15: intake submissions where
      // required items are missing. We use the canonical
      // EvidenceRequest.status values that explicitly mean "submission
      // is incomplete" — PARTIALLY_FULFILLED + NEEDS_MORE_INFO. We do
      // NOT join EvidenceRequestDeliverable here because the parent
      // status already encodes the incompleteness; the deliverables
      // table is the operator detail view at /evidence-requests/:id.
      // -----------------------------------------------------------------
      const incompleteRequests =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "intake_required_items_missing",
              () =>
                prisma.evidenceRequest.findMany({
                  where: {
                    teamId: { in: teamIds },
                    status: { in: ["PARTIALLY_FULFILLED", "NEEDS_MORE_INFO"] },
                  },
                  select: {
                    id: true,
                    teamId: true,
                    title: true,
                    status: true,
                    priority: true,
                    dueAtUtc: true,
                    updatedAt: true,
                  },
                  orderBy: [{ dueAtUtc: "asc" }, { updatedAt: "desc" }],
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Phase IA-reliability — Source 16: intake links approaching
      // expiry. Window: next 7 days, ACTIVE links only. We
      // intentionally cap at the WORKSPACE scope (not just the
      // creator) so any team member sees the rollup; revocation /
      // renewal still requires the operator role on the target route.
      // -----------------------------------------------------------------
      const INTAKE_LINK_EXPIRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const intakeLinkExpiryCutoff = new Date(
        nowMs + INTAKE_LINK_EXPIRY_WINDOW_MS,
      );
      const expiringIntakeLinks =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "intake_link_expiring",
              () =>
                prisma.workflowIntakeLink.findMany({
                  where: {
                    teamId: { in: teamIds },
                    status: "ACTIVE",
                    expiresAtUtc: {
                      gt: now,
                      lt: intakeLinkExpiryCutoff,
                    },
                  },
                  select: {
                    id: true,
                    teamId: true,
                    status: true,
                    expiresAtUtc: true,
                    usedCount: true,
                    maxUses: true,
                    updatedAt: true,
                  },
                  orderBy: { expiresAtUtc: "asc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Forensic completion — Source 18: RFC3161 TIMESTAMPING failures.
      // The TSA pipeline writes its terminal state on Evidence
      // (tsaStatus = "FAILED" + a bounded reason in tsaFailureReason).
      // Normal lifecycle states (pending / retry-scheduled) never alert;
      // records where timestamping was never promised (tsaStatus null)
      // never alert. Soft-deleted evidence is excluded.
      // -----------------------------------------------------------------
      const tsaFailedEvidence =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "tsa_failure",
              () =>
                prisma.evidence.findMany({
                  where: {
                    teamId: { in: teamIds },
                    tsaStatus: "FAILED",
                    deletedAt: null,
                  },
                  select: {
                    id: true,
                    teamId: true,
                    caseLinks: {
                      orderBy: { linkedAtUtc: "asc" },
                      select: { caseId: true },
                      take: 1,
                    },
                    title: true,
                    originalFileName: true,
                    tsaFailureReason: true,
                    updatedAt: true,
                  },
                  orderBy: { updatedAt: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Forensic completion — Source 19: CASE ASSIGNMENTS. Real
      // CaseAssignment rows (status ACTIVE) addressed to the caller —
      // never a fabricated assignment concept. Resolved when the
      // assignment leaves ACTIVE (completed / removed).
      // -----------------------------------------------------------------
      const myCaseAssignments =
        teamIds.length === 0
          ? []
          : await safelyLoadSource(
              "case_assignment",
              () =>
                prisma.caseAssignment.findMany({
                  where: {
                    teamId: { in: teamIds },
                    assignedToUserId: userId,
                    status: "ACTIVE",
                  },
                  select: {
                    id: true,
                    teamId: true,
                    caseId: true,
                    role: true,
                    note: true,
                    assignedAtUtc: true,
                    case: { select: { name: true } },
                  },
                  orderBy: { assignedAtUtc: "desc" },
                  take: PER_CATEGORY_TAKE,
                }),
              [],
            );

      // -----------------------------------------------------------------
      // Operations-Center redesign — Source 17: collaboration-team
      // notifications addressed to THIS caller (CollaborationTeamNotification
      // rows: invite accepted, role change, discussion reply, removal…).
      // We fetch the last 30 days INCLUDING read rows so read items can
      // render as read (and appear under the History filter); the row's
      // own `readAt` is the single source of read truth for this
      // category — reading here or on the Team page updates the same row.
      // -----------------------------------------------------------------
      const COLLAB_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
      const collabNotifications = await safelyLoadSource(
        "collaboration",
        () =>
          prisma.collaborationTeamNotification.findMany({
            where: {
              userId,
              createdAt: { gte: new Date(nowMs - COLLAB_WINDOW_MS) },
            },
            select: {
              id: true,
              workspaceId: true,
              teamId: true,
              type: true,
              title: true,
              body: true,
              readAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: PER_CATEGORY_TAKE,
          }),
        [],
      );

      // -----------------------------------------------------------------
      // Truncation tracking. We expose a per-category boolean so the
      // frontend can render an honest "showing latest N" banner and
      // point operators at the canonical console for the full set.
      // No silent data loss.
      // -----------------------------------------------------------------
      // Per-query take limit constants. The legacy queries (governance,
      // mentions) used 100; the new Phase-IA-cleanup queries use 50 to
      // keep page weight bounded. The truncated flag compares against
      // the exact limit of THAT query so we never lie about whether
      // results were capped.
      const LEGACY_TAKE = 100;
      const truncated = {
        governance: governanceRows.length >= LEGACY_TAKE,
        discussion_mention: unreadMentions.length >= LEGACY_TAKE,
        discussion_assigned: assignedThreads.length >= PER_CATEGORY_TAKE,
        review_escalation: myReviewEscalations.length >= PER_CATEGORY_TAKE,
        access_review_pending: myAccessReviews.length >= PER_CATEGORY_TAKE,
        mfa_recovery_pending: pendingMfaRecovery.length >= PER_CATEGORY_TAKE,
        communication_failure: failedCommunications.length >= PER_CATEGORY_TAKE,
        security_event_high: myHighSecurityEvents.length >= PER_CATEGORY_TAKE,
        // Phase IA-enterprise — failure categories.
        report_failure: reportIncidents.length >= PER_CATEGORY_TAKE,
        verification_package_failure:
          packageIncidents.length >= PER_CATEGORY_TAKE,
        ots_failure: otsFailedEvidence.length >= PER_CATEGORY_TAKE,
        // Phase IA-reliability — intake categories.
        intake_submission_pending_review:
          pendingReviewRequests.length >= PER_CATEGORY_TAKE,
        intake_required_items_missing:
          incompleteRequests.length >= PER_CATEGORY_TAKE,
        intake_link_expiring:
          expiringIntakeLinks.length >= PER_CATEGORY_TAKE,
        collaboration: collabNotifications.length >= PER_CATEGORY_TAKE,
        tsa_failure: tsaFailedEvidence.length >= PER_CATEGORY_TAKE,
        case_assignment: myCaseAssignments.length >= PER_CATEGORY_TAKE,
      };
      const anyTruncated = Object.values(truncated).some((v) => v);

      // -----------------------------------------------------------------
      // Assemble the unified items array.
      //
      // Phase IA-enterprise + Phase IA-reliability — items are
      // assembled WITHOUT downstream-derived fields (priority comes
      // from category+tone+id; itemKey === id; isRead / canMarkRead
      // / canDismiss / canSnooze come from the per-user state join).
      // Centralizing those assignments below means an emitter loop
      // can never set them inconsistently.
      // -----------------------------------------------------------------
      type AssembledItem = Omit<
        InboxItem,
        | "priority"
        | "itemKey"
        | "isRead"
        | "readAt"
        | "dismissedAt"
        | "snoozedUntil"
        | "canMarkRead"
        | "canDismiss"
        | "canSnooze"
      >;
      const items: Array<AssembledItem> = [];

      // Onboarding — only when no org membership.
      if (orgMemberships.length === 0) {
        items.push({
          id: "onboarding:no_organizations",
          category: "onboarding",
          tone: "info",
          title: "You haven't joined an organization yet",
          body: "Organizations group workspaces for governance, members, and audit. Create one, or accept an invite token.",
          href: "/organizations",
          occurredAt: now.toISOString(),
          context: {},
        });
      }
      if (orgMemberships.length > 0 && !callerEmail) {
        items.push({
          id: "onboarding:no_email_identity",
          category: "onboarding",
          tone: "info",
          title: "Add an email to your account",
          body: "Email-matched invites and audit-trail attribution require an email identity.",
          href: "/settings",
          occurredAt: now.toISOString(),
          context: {},
        });
      }

      // Pending org invites — one item per invite, addressed to caller.
      for (const inv of pendingOrgInvites) {
        items.push({
          id: `org_invite:${inv.id}`,
          category: "org_invite",
          tone: "high",
          title: `Organization invite waiting: ${inv.organization.name}`,
          body: `You have been invited to join ${inv.organization.name} as ${inv.role}. Accept before ${formatTimestampForReportUtc(
            inv.expiresAt,
          )}.`,
          href: "/organizations",
          occurredAt: inv.createdAt.toISOString(),
          context: {
            organizationId: inv.organization.id,
            organizationName: inv.organization.name,
            role: inv.role,
            expiresAt: inv.expiresAt.toISOString(),
          },
        });
      }

      // Admin pending invites — one rollup item per org with N pending.
      for (const row of adminPendingByOrg) {
        if (!row.organizationId) continue;
        const count = row._count.id;
        const orgName = orgNameById.get(row.organizationId) ?? "your organization";
        items.push({
          id: `org_admin:${row.organizationId}:pending_invites`,
          category: "org_admin",
          tone: "warning",
          title: `${count} pending invite${count === 1 ? "" : "s"} in ${orgName}`,
          body: `As an admin you can resend or revoke open invites from this organization's detail page.`,
          href: `/organizations/${row.organizationId}`,
          occurredAt: (row._max.createdAt ?? now).toISOString(),
          context: {
            organizationId: row.organizationId,
            organizationName: orgName,
            pendingCount: count,
          },
        });
      }

      // Phase B.3 — review_decision items.
      //
      // (a) Conflict-detected workflows where caller is adjudicator.
      //     High tone — these block workflow resolution and only the
      //     caller's role can act.
      for (const c of conflictWorkflows) {
        items.push({
          id: `review_decision:conflict:${c.workflowId}`,
          category: "review_decision",
          tone: "high",
          title: `Reviewer conflict — adjudication required`,
          body: `Two reviewers disagreed on this workflow. As team OWNER/ADMIN you can resolve it via the multi-stage review panel.`,
          href: `/reviewer-ops/${encodeURIComponent(c.workflowId)}`,
          occurredAt: c.decidedAt.toISOString(),
          context: {
            workflowId: c.workflowId,
            teamId: c.teamId,
            stage: "ADJUDICATION",
          },
        });
      }

      // (b) Workflows where caller submitted FIRST and SECOND is
      //     still pending. Awareness only — info tone.
      for (const d of pendingSecondForMe) {
        items.push({
          id: `review_decision:awaiting_second:${d.workflowId}`,
          category: "review_decision",
          tone: "info",
          title: `Your first-stage decision is awaiting peer review`,
          body: `Independence policy requires a different reviewer to submit the second-stage decision. No action needed from you.`,
          href: `/reviewer-ops/${encodeURIComponent(d.workflowId)}`,
          occurredAt: d.decidedAt.toISOString(),
          context: {
            workflowId: d.workflowId,
            teamId: d.teamId,
            stage: "SECOND_AWAITED",
          },
        });
      }

      // Governance notifications — one item per unacknowledged row.
      for (const g of governanceRows) {
        const teamName = teamNameById.get(g.teamId) ?? "workspace";
        const toneMap: Record<typeof g.severity, InboxTone> = {
          CRITICAL: "critical",
          HIGH: "high",
          WARNING: "warning",
          INFO: "info",
        };
        items.push({
          id: `governance:${g.id}`,
          category: "governance",
          tone: toneMap[g.severity] ?? "info",
          title: `${governanceKindTitle(g.kind)} — ${teamName}`,
          body: governanceKindBody(g.kind, g.occurrenceCount),
          href: governanceKindHref(g.kind),
          occurredAt: g.lastSeenAtUtc.toISOString(),
          context: {
            teamId: g.teamId,
            teamName,
            kind: g.kind,
            severity: g.severity,
            occurrenceCount: g.occurrenceCount,
          },
        });
      }

      // -----------------------------------------------------------------
      // IN_APP preference verdicts (one cached lookup per workspace ×
      // type). Suppression is applied as an ANNOTATION in the finalize
      // loop below — never at emit time — so the EMAIL/digest channel
      // stays independent of the IN_APP toggles. The category → type
      // mapping is the canonical OPTIONAL_INAPP_CATEGORY_TO_TYPE;
      // mandatory types (SLA_NEAR_BREACH, GOVERNANCE_UPDATE) are absent
      // from it and therefore can never be suppressed.
      // -----------------------------------------------------------------
      const preferenceCache = new Map<string, boolean>();
      async function isAllowed(
        teamIdLookup: string | null,
        type: NotificationPreferenceType,
      ): Promise<boolean> {
        // No teamId → fall back to the global default (in-app
        // enabled). This handles legacy rows where the teamId field
        // may be nullable on the source.
        if (!teamIdLookup) return true;
        const key = `${teamIdLookup}|${type}`;
        const cached = preferenceCache.get(key);
        if (cached !== undefined) return cached;
        const allowed = await isPreferenceEnabled({
          userId,
          teamId: teamIdLookup,
          preferenceType: type,
          channel: "IN_APP",
        });
        preferenceCache.set(key, allowed);
        return allowed;
      }

      // -----------------------------------------------------------------
      // Phase C2 — unread discussion mentions (one inbox item per
      // mention). Tone = high because an explicit @-mention is the
      // strongest operational coordination signal Phase 16 emits.
      // -----------------------------------------------------------------
      for (const m of unreadMentions) {
        const thread = m.message?.thread;
        if (!thread) continue;
        items.push({
          id: `discussion_mention:${m.id}`,
          category: "discussion_mention",
          tone: "high",
          title: `You were mentioned in "${thread.title}"`,
          body: `A reviewer or investigator @-mentioned you in a workspace discussion. Open the thread to respond.`,
          href: `/evidence/${encodeURIComponent(thread.evidenceId)}?tab=discussion&thread=${encodeURIComponent(thread.id)}`,
          occurredAt: m.createdAt.toISOString(),
          context: {
            teamId: m.teamId,
            evidenceId: thread.evidenceId,
            threadId: thread.id,
            messageId: m.messageId,
            threadStatus: thread.status,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase C2 — unresolved threads assigned to the caller. Tone =
      // warning by default; escalated threads bump to high.
      // Phase G3.1 — respect per-workspace ASSIGNED_THREAD toggle.
      // -----------------------------------------------------------------
      for (const t of assignedThreads) {
        items.push({
          id: `discussion_assigned:${t.id}`,
          category: "discussion_assigned",
          tone: t.escalatedAtUtc ? "high" : "warning",
          title: `Discussion assigned to you: "${t.title}"`,
          body: t.escalatedAtUtc
            ? `An escalated discussion is assigned to you. Status: ${t.status}.`
            : `An open discussion is assigned to you. Status: ${t.status}.`,
          href: `/evidence/${encodeURIComponent(t.evidenceId)}?tab=discussion&thread=${encodeURIComponent(t.id)}`,
          occurredAt: t.updatedAt.toISOString(),
          dueAt: null,
          context: {
            teamId: t.teamId,
            evidenceId: t.evidenceId,
            threadId: t.id,
            threadStatus: t.status,
            escalated: t.escalatedAtUtc ? 1 : 0,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-cleanup — review escalations assigned to caller.
      // ReviewEscalation severity is "INFO" | "WARNING" | "HIGH" |
      // "CRITICAL" (matches IncidentSeverity); we map directly. The
      // deep-link goes to the canonical escalations console scoped to
      // the workflow id.
      // -----------------------------------------------------------------
      const escalationToneMap: Record<string, InboxTone> = {
        CRITICAL: "critical",
        HIGH: "high",
        WARNING: "warning",
        INFO: "info",
      };
      for (const esc of myReviewEscalations) {
        items.push({
          id: `review_escalation:${esc.id}`,
          category: "review_escalation",
          tone: escalationToneMap[esc.severity] ?? "warning",
          title: `Escalation assigned to you: ${humanizeEscalationReason(esc.reason)}`,
          body: esc.safeSummary,
          href: `/reviewer-ops/escalations?escalationId=${encodeURIComponent(esc.id)}`,
          occurredAt: esc.updatedAt.toISOString(),
          dueAt: null,
          context: {
            teamId: esc.teamId,
            workflowId: esc.workflowId,
            evidenceId: esc.evidenceId ?? null,
            reason: esc.reason,
            severity: esc.severity,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-cleanup — access reviews where the caller is subject
      // or initiator. We surface PENDING + IN_PROGRESS as warning tone
      // (HIGH if dueAt is in the past). dueAt is real — we never invent.
      // -----------------------------------------------------------------
      for (const ar of myAccessReviews) {
        const overdue =
          ar.dueAtUtc !== null && ar.dueAtUtc.getTime() < now.getTime();
        const subjectLine =
          ar.subjectUserId === userId
            ? "Your access is being reviewed"
            : "An access review you initiated is pending";
        items.push({
          id: `access_review_pending:${ar.id}`,
          category: "access_review_pending",
          tone: overdue ? "high" : "warning",
          title: subjectLine,
          body: overdue
            ? `Review kind: ${ar.kind}. Past due — please act in the access reviews console.`
            : `Review kind: ${ar.kind}. Open the access reviews console to certify, revoke, or suspend.`,
          href: `/admin/identity/access-reviews?reviewId=${encodeURIComponent(ar.id)}`,
          occurredAt: ar.createdAt.toISOString(),
          dueAt: ar.dueAtUtc ? ar.dueAtUtc.toISOString() : null,
          context: {
            teamId: ar.teamId,
            kind: ar.kind,
            status: ar.status,
            subjectKind: ar.subjectKind,
            isSubject: ar.subjectUserId === userId ? 1 : 0,
            isInitiator: ar.initiatedByUserId === userId ? 1 : 0,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-cleanup — pending MFA recovery requests (admin queue).
      // Only the team OWNER/ADMIN caller's queue. The destination
      // console (/security-center/mfa-recovery) enforces the same gate
      // server-side at action time.
      // -----------------------------------------------------------------
      for (const req of pendingMfaRecovery) {
        const teamName = teamNameById.get(req.teamId) ?? "workspace";
        items.push({
          id: `mfa_recovery_pending:${req.id}`,
          category: "mfa_recovery_pending",
          tone: "high",
          title: `MFA recovery request pending — ${teamName}`,
          body: `A member has requested a lost-factor reset. Approvals: ${req.approvalCount}/${req.requiredApprovals}. Quorum-based approval forces re-enrollment; it does NOT grant a session.`,
          href: `/security-center/mfa-recovery?requestId=${encodeURIComponent(req.id)}`,
          occurredAt: req.createdAt.toISOString(),
          dueAt: null,
          context: {
            teamId: req.teamId,
            teamName,
            subjectUserId: req.userId,
            requiredApprovals: req.requiredApprovals,
            approvalCount: req.approvalCount,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-cleanup — recent failed communications (admin queue).
      // Same admin gate as messaging-ops mutations. We render one item
      // per failed message and deep-link to /communications with the
      // failed-status filter pre-applied. The phone preview is the
      // masked HMAC preview (e.g. "+••• 1234"); never raw.
      // -----------------------------------------------------------------
      for (const msg of failedCommunications) {
        const teamName = teamNameById.get(msg.teamId) ?? "workspace";
        items.push({
          id: `communication_failure:${msg.id}`,
          category: "communication_failure",
          tone: "warning",
          title: `Failed ${msg.channel.toLowerCase()} delivery — ${teamName}`,
          body: `${msg.purpose} to ${msg.recipientPreview} failed after ${msg.attemptCount} attempt${msg.attemptCount === 1 ? "" : "s"}${msg.errorCode ? ` (${msg.errorCode})` : ""}. Open Messaging operations to retry or cancel.`,
          href: `/communications?status=FAILED&messageId=${encodeURIComponent(msg.id)}`,
          occurredAt: msg.updatedAt.toISOString(),
          dueAt: null,
          context: {
            teamId: msg.teamId,
            teamName,
            channel: msg.channel,
            purpose: msg.purpose,
            errorCode: msg.errorCode ?? null,
            attemptCount: msg.attemptCount,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-cleanup — high-severity security events for the
      // caller (user-scoped). Always private to the actor; the
      // Identity & Security console is the surface for cross-user
      // inspection. We deep-link to the Account Security home where
      // the user can see their personal security events feed.
      // -----------------------------------------------------------------
      for (const ev of myHighSecurityEvents) {
        items.push({
          id: `security_event_high:${ev.id}`,
          category: "security_event_high",
          tone: "high",
          title: `Security alert: ${humanizeSecurityEventType(ev.eventType)}`,
          body: `A high-severity event on your account was recorded. Open Account security to review the timeline.`,
          href: "/settings/security",
          occurredAt: ev.createdAt.toISOString(),
          dueAt: null,
          context: {
            teamId: ev.teamId ?? null,
            eventType: ev.eventType,
            severity: ev.severity,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-enterprise — report-generation failure incidents.
      // Maps IncidentSeverity → InboxTone directly. Deep-link prefers
      // the related evidence detail when set (most actionable), else
      // the Operations / Observability console where the incident
      // lives.
      // -----------------------------------------------------------------
      const incidentSeverityTone: Record<string, InboxTone> = {
        CRITICAL: "critical",
        HIGH: "high",
        WARNING: "warning",
        INFO: "info",
      };
      for (const inc of reportIncidents) {
        const teamName = inc.teamId
          ? teamNameById.get(inc.teamId) ?? "workspace"
          : "workspace";
        const occBlurb =
          inc.occurrenceCount > 1
            ? ` Seen ${inc.occurrenceCount} times.`
            : "";
        const status = inc.status === "ACKNOWLEDGED" ? " (acknowledged)" : "";
        items.push({
          id: `report_failure:${inc.id}`,
          category: "report_failure",
          tone: incidentSeverityTone[inc.severity] ?? "high",
          title: `Report generation failure — ${teamName}${status}`,
          body: `${inc.safeSummary}${occBlurb}`,
          href: inc.relatedEvidenceId
            ? `/evidence/${encodeURIComponent(inc.relatedEvidenceId)}?tab=integrity`
            : "/operations/observability",
          occurredAt: inc.lastSeenAtUtc.toISOString(),
          dueAt: null,
          context: {
            teamId: inc.teamId ?? null,
            teamName,
            incidentId: inc.id,
            evidenceId: inc.relatedEvidenceId ?? null,
            jobId: inc.relatedJobId ?? null,
            occurrenceCount: inc.occurrenceCount,
            runbook: inc.runbookSlug ?? null,
            incidentStatus: inc.status,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-enterprise — verification package failure incidents.
      // Same persistence + projection as report failures.
      // -----------------------------------------------------------------
      for (const inc of packageIncidents) {
        const teamName = inc.teamId
          ? teamNameById.get(inc.teamId) ?? "workspace"
          : "workspace";
        const occBlurb =
          inc.occurrenceCount > 1
            ? ` Seen ${inc.occurrenceCount} times.`
            : "";
        const status = inc.status === "ACKNOWLEDGED" ? " (acknowledged)" : "";
        items.push({
          id: `verification_package_failure:${inc.id}`,
          category: "verification_package_failure",
          tone: incidentSeverityTone[inc.severity] ?? "high",
          title: `Verification package failure — ${teamName}${status}`,
          body: `${inc.safeSummary}${occBlurb}`,
          href: inc.relatedEvidenceId
            ? `/evidence/${encodeURIComponent(inc.relatedEvidenceId)}?tab=integrity`
            : "/operations/observability",
          occurredAt: inc.lastSeenAtUtc.toISOString(),
          dueAt: null,
          context: {
            teamId: inc.teamId ?? null,
            teamName,
            incidentId: inc.id,
            evidenceId: inc.relatedEvidenceId ?? null,
            jobId: inc.relatedJobId ?? null,
            occurrenceCount: inc.occurrenceCount,
            runbook: inc.runbookSlug ?? null,
            incidentStatus: inc.status,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-enterprise — OTS anchoring failures. Per-evidence row
      // with otsStatus = "FAILED". The failure code lives in
      // `otsFailureReason` — we humanize known codes and pass through
      // unknown error text (bounded at the schema layer).
      //
      // Tone: GLOBAL_BUDGET_EXHAUSTED → "critical" (terminal — the
      // proof will never anchor on the public chain); other failures
      // → "high" (operator-actionable, often transient infrastructure).
      // -----------------------------------------------------------------
      for (const ev of otsFailedEvidence) {
        const teamName = ev.teamId
          ? teamNameById.get(ev.teamId) ?? "workspace"
          : "workspace";
        const reasonCode = ev.otsFailureReason ?? "OTS_UNKNOWN_FAILURE";
        const terminal = reasonCode.includes("OTS_GLOBAL_BUDGET_EXHAUSTED");
        const evidenceLabel =
          ev.title ?? ev.originalFileName ?? ev.id.slice(0, 8);
        items.push({
          id: `ots_failure:${ev.id}`,
          category: "ots_failure",
          tone: terminal ? "critical" : "high",
          title: `OTS anchoring failed — ${evidenceLabel}`,
          body: `${humanizeOtsFailureReason(reasonCode)} Open the evidence Integrity tab for the preservation status and operator runbook.`,
          href: `/evidence/${encodeURIComponent(ev.id)}?tab=integrity`,
          occurredAt: (ev.otsUpgradedAtUtc ?? ev.updatedAt).toISOString(),
          dueAt: null,
          context: {
            teamId: ev.teamId ?? null,
            teamName,
            evidenceId: ev.id,
            caseId: ev.caseLinks[0]?.caseId ?? null,
            failureCode: reasonCode,
            otsHash: ev.otsHash ?? null,
          },
        });
      }


      // -----------------------------------------------------------------
      // Forensic completion — RFC3161 timestamping failure items. P1:
      // the record's time-based evidentiary confidence is affected and
      // an operator decision is required. The reason is the bounded
      // pipeline reason, never provider internals.
      // -----------------------------------------------------------------
      for (const ev of tsaFailedEvidence) {
        const teamName = ev.teamId
          ? teamNameById.get(ev.teamId) ?? "workspace"
          : "workspace";
        const evidenceLabel =
          ev.title ?? ev.originalFileName ?? ev.id.slice(0, 8);
        const reason = (ev.tsaFailureReason ?? "Timestamping failed.").slice(0, 240);
        items.push({
          id: `tsa_failure:${ev.id}`,
          category: "tsa_failure",
          tone: "high",
          title: `Trusted timestamp failed — ${evidenceLabel}`,
          body: `${reason} Open the evidence Integrity tab for the timestamping status and retry posture.`,
          href: `/evidence/${encodeURIComponent(ev.id)}?tab=integrity`,
          occurredAt: ev.updatedAt.toISOString(),
          dueAt: null,
          context: {
            teamId: ev.teamId ?? null,
            teamName,
            evidenceId: ev.id,
            caseId: ev.caseLinks[0]?.caseId ?? null,
            failureReason: reason,
          },
        });
      }

      // -----------------------------------------------------------------
      // Forensic completion — active case assignments addressed to the
      // caller. Resolved automatically when the assignment leaves ACTIVE.
      // -----------------------------------------------------------------
      for (const ca of myCaseAssignments) {
        const teamName = ca.teamId
          ? teamNameById.get(ca.teamId) ?? "workspace"
          : "workspace";
        items.push({
          id: `case_assignment:${ca.id}`,
          category: "case_assignment",
          tone: "warning",
          title: `Case assigned to you: "${ca.case?.name ?? "Untitled case"}"`,
          body: ca.note
            ? `Role: ${String(ca.role).toLowerCase()}. ${ca.note}`
            : `Role: ${String(ca.role).toLowerCase()}. Open the case to begin.`,
          href: `/cases/${encodeURIComponent(ca.caseId)}`,
          occurredAt: ca.assignedAtUtc.toISOString(),
          dueAt: null,
          context: {
            teamId: ca.teamId ?? null,
            teamName,
            caseId: ca.caseId,
            role: String(ca.role),
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-reliability — batch-fetch per-user state for every
      // assembled item. We do ONE round trip with `itemKey IN (...)`
      // so the join is bounded even for the largest inbox. The state
      // table is owned by THIS user (the FK is ON DELETE CASCADE);
      // we additionally scope every query by `userId = caller` for
      // defense in depth.
      // -----------------------------------------------------------------
      const assembledKeys = items.map((it) => it.id);
      const stateRows =
        assembledKeys.length === 0
          ? []
          : await prisma.inboxItemState.findMany({
              where: {
                userId,
                itemKey: { in: assembledKeys },
              },
              select: {
                itemKey: true,
                readAt: true,
                dismissedAt: true,
                snoozedUntil: true,
              },
            });
      const stateByKey = new Map(
        stateRows.map((row) => [row.itemKey, row] as const),
      );

      // -----------------------------------------------------------------
      // Phase IA-reliability — intake_submission_pending_review.
      // Maps to P2 (action required). Deep-link goes to the canonical
      // evidence-request detail surface.
      // -----------------------------------------------------------------
      for (const r of pendingReviewRequests) {
        const teamName = r.teamId
          ? teamNameById.get(r.teamId) ?? "workspace"
          : "workspace";
        const dueOverdue =
          r.dueAtUtc !== null && r.dueAtUtc.getTime() < nowMs;
        items.push({
          id: `intake_submission_pending_review:${r.id}`,
          category: "intake_submission_pending_review",
          tone: dueOverdue ? "high" : "warning",
          title: `Intake submission awaiting review — ${teamName}`,
          body: `"${r.title ?? "Untitled request"}" is in ${r.status.toLowerCase().replace(/_/g, " ")} state with no assigned reviewer. Open evidence requests to claim it.`,
          href: `/evidence-requests/${encodeURIComponent(r.id)}`,
          occurredAt: r.updatedAt.toISOString(),
          dueAt: r.dueAtUtc ? r.dueAtUtc.toISOString() : null,
          context: {
            teamId: r.teamId ?? null,
            teamName,
            requestId: r.id,
            status: r.status,
            priority: r.priority,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-reliability — intake_required_items_missing. The
      // parent status carries the "incomplete" signal explicitly so we
      // don't need a deliverable join here.
      // -----------------------------------------------------------------
      for (const r of incompleteRequests) {
        const teamName = r.teamId
          ? teamNameById.get(r.teamId) ?? "workspace"
          : "workspace";
        const dueOverdue =
          r.dueAtUtc !== null && r.dueAtUtc.getTime() < nowMs;
        const reason =
          r.status === "NEEDS_MORE_INFO"
            ? "the reviewer requested more information"
            : "required deliverables are still outstanding";
        items.push({
          id: `intake_required_items_missing:${r.id}`,
          category: "intake_required_items_missing",
          tone: dueOverdue ? "high" : "warning",
          title: `Intake incomplete — ${teamName}`,
          body: `"${r.title ?? "Untitled request"}" cannot complete because ${reason}. Open evidence requests for the checklist.`,
          href: `/evidence-requests/${encodeURIComponent(r.id)}`,
          occurredAt: r.updatedAt.toISOString(),
          dueAt: r.dueAtUtc ? r.dueAtUtc.toISOString() : null,
          context: {
            teamId: r.teamId ?? null,
            teamName,
            requestId: r.id,
            status: r.status,
            priority: r.priority,
          },
        });
      }

      // -----------------------------------------------------------------
      // Phase IA-reliability — intake_link_expiring. P4 (awareness)
      // because the link still works today; the operator's call is
      // whether to rotate / extend before expiry. dueAt is the real
      // expiresAtUtc so the operator can see the deadline.
      // -----------------------------------------------------------------
      for (const link of expiringIntakeLinks) {
        const teamName = link.teamId
          ? teamNameById.get(link.teamId) ?? "workspace"
          : "workspace";
        const useFraction =
          link.maxUses !== null && link.maxUses !== undefined
            ? ` (${link.usedCount}/${link.maxUses} uses)`
            : "";
        items.push({
          id: `intake_link_expiring:${link.id}`,
          category: "intake_link_expiring",
          tone: "info",
          title: `Intake link expiring soon — ${teamName}`,
          body: `An active intake link${useFraction} expires on ${formatTimestampForReportUtc(link.expiresAtUtc)}. Open intake links to renew or revoke.`,
          href: `/intake-links?linkId=${encodeURIComponent(link.id)}`,
          occurredAt: link.updatedAt.toISOString(),
          dueAt: link.expiresAtUtc.toISOString(),
          context: {
            teamId: link.teamId ?? null,
            teamName,
            linkId: link.id,
            usedCount: link.usedCount,
            maxUses: link.maxUses ?? null,
          },
        });
      }

      // -----------------------------------------------------------------
      // Operations-Center redesign — collaboration items + source-truth
      // read state. Emitted here (after the state batch-fetch is safe —
      // itemKeys are collected right below in a second pass).
      // -----------------------------------------------------------------
      const collabReadAtByKey = new Map<string, Date>();
      for (const n of collabNotifications) {
        const wsName = teamNameById.get(n.workspaceId) ?? "workspace";
        const key = `collaboration:${n.id}`;
        if (n.readAt) collabReadAtByKey.set(key, n.readAt);
        items.push({
          id: key,
          category: "collaboration",
          tone: "info",
          title: n.title,
          body: n.body ?? "Open the collaboration team page for details.",
          href: n.teamId
            ? `/collaboration-teams/${encodeURIComponent(n.teamId)}/collaboration`
            : "/collaboration-teams",
          occurredAt: n.createdAt.toISOString(),
          context: {
            teamId: n.workspaceId,
            teamName: wsName,
            collaborationTeamId: n.teamId ?? null,
            type: n.type,
          },
        });
      }
      // Collaboration items were emitted AFTER the state batch-fetch, so
      // load their state rows in one extra bounded round trip.
      const collabKeys = collabNotifications.map(
        (n) => `collaboration:${n.id}`,
      );
      if (collabKeys.length > 0) {
        const collabState = await prisma.inboxItemState.findMany({
          where: { userId, itemKey: { in: collabKeys } },
          select: {
            itemKey: true,
            readAt: true,
            dismissedAt: true,
            snoozedUntil: true,
          },
        });
        for (const row of collabState) stateByKey.set(row.itemKey, row);
      }

      // -----------------------------------------------------------------
      // Phase IA-enterprise — finalize: assign priority to every item,
      // apply the requested server-side filters (filter + tone), sort
      // by the operator-friendly comparator, then paginate.
      //
      // Phase IA-reliability — fold per-user state into each item and
      // drop dismissed / actively-snoozed items from the default
      // result. Snooze expiry is timestamp-based so we never need a
      // cron — a snoozed item simply re-emerges on the next request
      // after `snoozedUntil` passes.
      //
      // Operations-Center completion — the aggregation returns EVERY item
      // ANNOTATED with its per-user state (dismissed / snoozed included).
      // Consumers apply visibility: the page hides dismissed + actively-
      // snoozed items by default (the `snoozed` filter opts them back
      // in), the summary counts only default-visible unread items, and
      // the snapshot sync needs the full set so a dismissed/snoozed item
      // is never falsely marked resolved. History reads the persistent
      // snapshot table, not this live set.
      // -----------------------------------------------------------------
      const allItems: InboxItem[] = [];
      for (const it of items) {
        const state = stateByKey.get(it.id);
        // review_decision awaiting_second is awareness-only — demote
        // from the default P2 to P5. Recognized by its id prefix.
        const isAwaitingSecond = it.id.startsWith(
          "review_decision:awaiting_second:",
        );
        const basePriority = priorityForItem(it);
        const priority: InboxPriority = isAwaitingSecond ? "P5" : basePriority;
        // Collaboration items OR the source row's readAt into the read
        // state so a read on the Team page reads here too.
        const sourceReadAt = collabReadAtByKey.get(it.id) ?? null;
        const effectiveReadAt = state?.readAt ?? sourceReadAt;
        // IN_APP-honesty — annotate (never drop) items whose OPTIONAL
        // preference type is disabled for this workspace.
        const optionalType = OPTIONAL_INAPP_CATEGORY_TO_TYPE.get(it.category);
        const teamIdForPref =
          typeof it.context?.teamId === "string" ? it.context.teamId : null;
        const suppressedInApp =
          optionalType != null &&
          !(await isAllowed(teamIdForPref, optionalType));
        allItems.push({
          ...it,
          itemKey: it.id,
          priority,
          isRead: effectiveReadAt != null,
          readAt: effectiveReadAt ? effectiveReadAt.toISOString() : null,
          dismissedAt: state?.dismissedAt
            ? state.dismissedAt.toISOString()
            : null,
          snoozedUntil: state?.snoozedUntil
            ? state.snoozedUntil.toISOString()
            : null,
          canMarkRead: true,
          canDismiss: true,
          canSnooze: true,
          ...(suppressedInApp ? { suppressedInApp: true } : {}),
        } satisfies InboxItem);
      }

      return {
        ok: true as const,
        caller: me,
        allItems,
        degradedSources,
        truncated,
        anyTruncated,
        generatedAt: now,
      };
}

export async function meInboxRoutes(app: FastifyInstance) {
  app.get(
    "/v1/me/inbox",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const now = new Date();
      const nowMs = now.getTime();

      // Phase IA-enterprise — parse pagination + filter query. The
      // schema rejects malformed input by silently falling through to
      // defaults (decodeCursor swallows bad cursors and returns 0), so
      // callers never see a 4xx for benign client glitches.
      const parsed = inboxQuerySchema.safeParse(req.query ?? {});
      const queryParams: z.infer<typeof inboxQuerySchema> = parsed.success
        ? parsed.data
        : {};
      const pageSize = queryParams.pageSize ?? DEFAULT_PAGE_SIZE;
      const offset = decodeCursor(queryParams.cursor);
      const requestedFilter: InboxFilter = queryParams.filter ?? "all";
      const requestedTone = queryParams.tone;
      const requestedWorkspaceId = queryParams.workspaceId;

      // Workspace narrowing — the caller may only narrow to a workspace
      // they belong to (anti-enumeration 403 otherwise). Validated up
      // front so BOTH the live view and the history view honor it.
      if (requestedWorkspaceId) {
        const wsMembership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: { teamId: requestedWorkspaceId, userId },
          },
          select: { teamId: true },
        });
        if (!wsMembership) {
          return reply.code(403).send({ error: { code: "not_a_member" } });
        }
      }

      // ---------------------------------------------------------------
      // Operations-Center completion — HISTORY is served from the
      // PERSISTENT snapshot table, so items remain available after the
      // canonical source resolves. Snapshot rows are per-user copies of
      // content the user was already authorized to see when it was
      // surfaced; every query is userId-scoped.
      // ---------------------------------------------------------------
      if (requestedFilter === "history") {
        if (!(await snapshotsAvailable())) {
          return reply.code(200).send({
            generatedAt: now.toISOString(),
            degraded: false,
            degradedSources: [],
            historyAvailable: false,
            summary: { total: 0, byTone: {}, byCategory: {}, byPriority: {} },
            truncated: {},
            anyTruncated: false,
            pagination: {
              offset: 0,
              pageSize,
              returned: 0,
              nextCursor: null,
              totalEstimate: 0,
              totalIsExact: true,
              appliedFilter: requestedFilter,
              appliedTone: requestedTone ?? null,
            },
            items: [],
          });
        }
        const where = {
          userId,
          ...(requestedTone ? { severity: requestedTone } : {}),
          // Membership was validated above, so narrowing the snapshot
          // window to one workspace is safe here.
          ...(requestedWorkspaceId ? { teamId: requestedWorkspaceId } : {}),
        };
        const [total, rows] = await Promise.all([
          prisma.operationsInboxSnapshot.count({ where }),
          prisma.operationsInboxSnapshot.findMany({
            where,
            orderBy: { lastSeenAtUtc: "desc" },
            skip: offset,
            take: pageSize,
          }),
        ]);
        // Membership-loss redaction — snapshots whose workspace the
        // caller can no longer access keep ONLY safe personal-state
        // metadata; tenant-sensitive content and deep links are
        // withheld. Organization-side audit trails are unaffected.
        const currentMemberships = await prisma.teamMember.findMany({
          where: { userId },
          select: { teamId: true },
        });
        const currentTeamIds = new Set(
          currentMemberships.map((m) => m.teamId),
        );
        const items = rows.map((s) => {
          const accessible = s.teamId == null || currentTeamIds.has(s.teamId);
          if (!accessible) {
            return {
              id: s.itemKey,
              itemKey: s.itemKey,
              category: s.category as InboxCategory,
              tone: s.severity as InboxTone,
              priority: s.priority as InboxPriority,
              title: "[No longer accessible — workspace access removed]",
              body: "This historical item belongs to a workspace you no longer have access to.",
              href: "",
              occurredAt: s.sourceOccurredAtUtc.toISOString(),
              isRead: s.readAtUtc != null,
              readAt: s.readAtUtc ? s.readAtUtc.toISOString() : null,
              dismissedAt: s.dismissedAtUtc ? s.dismissedAtUtc.toISOString() : null,
              snoozedUntil: null,
              resolvedAt: s.resolvedAtUtc ? s.resolvedAtUtc.toISOString() : null,
              resolutionSource: s.resolutionSource ?? null,
              canMarkRead: false,
              canDismiss: false,
              canSnooze: false,
              dueAt: null,
              context: {},
            };
          }
          return {
          id: s.itemKey,
          itemKey: s.itemKey,
          category: s.category as InboxCategory,
          tone: s.severity as InboxTone,
          priority: s.priority as InboxPriority,
          title: s.title,
          body: s.body,
          href: s.href,
          occurredAt: s.sourceOccurredAtUtc.toISOString(),
          isRead: s.readAtUtc != null,
          readAt: s.readAtUtc ? s.readAtUtc.toISOString() : null,
          dismissedAt: s.dismissedAtUtc ? s.dismissedAtUtc.toISOString() : null,
          snoozedUntil: s.snoozedUntilUtc ? s.snoozedUntilUtc.toISOString() : null,
          resolvedAt: s.resolvedAtUtc ? s.resolvedAtUtc.toISOString() : null,
          resolutionSource: s.resolutionSource ?? null,
          canMarkRead: s.resolvedAtUtc == null,
          canDismiss: s.resolvedAtUtc == null,
          canSnooze: s.resolvedAtUtc == null,
          dueAt: s.dueAtUtc ? s.dueAtUtc.toISOString() : null,
          context: (s.metadataJson ?? {}) as Record<string, string | number | null>,
          };
        });
        const nextOffset = offset + items.length;
        return reply.code(200).send({
          generatedAt: now.toISOString(),
          degraded: false,
          degradedSources: [],
          historyAvailable: true,
          summary: { total, byTone: {}, byCategory: {}, byPriority: {} },
          truncated: {},
          anyTruncated: false,
          pagination: {
            offset,
            pageSize,
            returned: items.length,
            nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
            totalEstimate: total,
            totalIsExact: true,
            appliedFilter: requestedFilter,
            appliedTone: requestedTone ?? null,
          },
          items,
        });
      }

      const agg = await buildInboxAggregation(userId, req.log);
      if (!agg.ok) {
        return reply.code(401).send({ message: "Unknown caller" });
      }
      const { allItems, degradedSources, truncated, anyTruncated, caller: me } = agg;

      // Persist/refresh history snapshots for everything surfaced in this
      // response window (bounded; skipped gracefully on un-migrated envs).
      await syncInboxSnapshots(
        userId,
        // Suppressed items accrue no operational history.
        allItems.filter((it) => !it.suppressedInApp),
        now,
        req.log,
      );

      // Visibility (per-user state) BEFORE category/tone filters: dismissed
      // and actively-snoozed items are hidden by default; the `snoozed`
      // filter shows exactly the actively-snoozed set.
      const visibleItems = allItems.filter((it) => {
        // IN_APP-honesty — a disabled optional type is invisible in the
        // app (all filters, including the snoozed view).
        if (it.suppressedInApp) return false;
        const activeSnooze =
          it.snoozedUntil != null &&
          new Date(it.snoozedUntil).getTime() > nowMs;
        if (requestedFilter === "snoozed") {
          return activeSnooze && it.dismissedAt == null;
        }
        if (it.dismissedAt != null) return false;
        if (activeSnooze) return false;
        return true;
      });

      // -----------------------------------------------------------------
      // HYBRID summary contract (UX remediation 2026-07-14).
      //
      // scopeItems — the workspace-scoped ACTIVE attention set: same
      // authorization/preference/state visibility as the default view
      // (never suppressed, never dismissed, never actively snoozed —
      // regardless of the requested filter), narrowed only by the
      // validated workspace selector. This feeds `scopeSummary`, so the
      // severity cards keep showing real operational conditions even
      // while a non-matching category filter is selected. The category/
      // tone-filtered `summary` below remains the FILTERED result scope.
      // Both derive from the one authorized aggregation — no second
      // aggregation runs.
      // -----------------------------------------------------------------
      const scopeItems = allItems.filter((it) => {
        if (it.suppressedInApp) return false;
        if (it.dismissedAt != null) return false;
        if (
          it.snoozedUntil != null &&
          new Date(it.snoozedUntil).getTime() > nowMs
        ) {
          return false;
        }
        if (
          requestedWorkspaceId &&
          it.context?.teamId !== requestedWorkspaceId
        ) {
          return false;
        }
        return true;
      });
      // Actual-item override signal (2026-07-15). The filter-independent
      // per-category presence + deadline posture over the workspace scope.
      // Every scopeItem is ALREADY membership/role-authorized by the
      // aggregation, so this set is a backend-authorized, leak-proof,
      // filter-stable answer to "does an eligible item exist in category
      // X?" — the frontend uses it to REVEAL a category chip that static
      // plan/participation eligibility would otherwise hide (e.g. a FREE
      // user mentioned inside a paid Team, or a downgraded user's
      // historical assignment). It never hides a category and never adds
      // an item — visibility only. No second aggregation runs.
      const scopeCategoryCount = (category: InboxCategory): number =>
        scopeItems.filter((i) => i.category === category).length;
      const scopeSummary = {
        total: scopeItems.length,
        unread: scopeItems.filter((i) => !i.isRead).length,
        byTone: {
          critical: scopeItems.filter((i) => i.tone === "critical").length,
          high: scopeItems.filter((i) => i.tone === "high").length,
          warning: scopeItems.filter((i) => i.tone === "warning").length,
          info: scopeItems.filter((i) => i.tone === "info").length,
        },
        byCategory: {
          onboarding: scopeCategoryCount("onboarding"),
          org_invite: scopeCategoryCount("org_invite"),
          org_admin: scopeCategoryCount("org_admin"),
          governance: scopeCategoryCount("governance"),
          review_decision: scopeCategoryCount("review_decision"),
          discussion_mention: scopeCategoryCount("discussion_mention"),
          discussion_assigned: scopeCategoryCount("discussion_assigned"),
          review_escalation: scopeCategoryCount("review_escalation"),
          access_review_pending: scopeCategoryCount("access_review_pending"),
          mfa_recovery_pending: scopeCategoryCount("mfa_recovery_pending"),
          communication_failure: scopeCategoryCount("communication_failure"),
          security_event_high: scopeCategoryCount("security_event_high"),
          report_failure: scopeCategoryCount("report_failure"),
          verification_package_failure: scopeCategoryCount(
            "verification_package_failure",
          ),
          ots_failure: scopeCategoryCount("ots_failure"),
          intake_submission_pending_review: scopeCategoryCount(
            "intake_submission_pending_review",
          ),
          intake_required_items_missing: scopeCategoryCount(
            "intake_required_items_missing",
          ),
          intake_link_expiring: scopeCategoryCount("intake_link_expiring"),
          collaboration: scopeCategoryCount("collaboration"),
          tsa_failure: scopeCategoryCount("tsa_failure"),
          case_assignment: scopeCategoryCount("case_assignment"),
        },
        // Deadline posture over the scope — powers due_soon / overdue
        // filter eligibility (only 5 categories carry a real dueAt, so a
        // scope with none must not show permanent empty deadline filters).
        deadlines: {
          dueSoon: scopeItems.filter((i) => {
            if (!i.dueAt) return false;
            const due = new Date(i.dueAt).getTime();
            return due >= nowMs && due <= nowMs + 7 * 24 * 60 * 60 * 1000;
          }).length,
          overdue: scopeItems.filter(
            (i) => i.dueAt != null && new Date(i.dueAt).getTime() < nowMs,
          ).length,
        },
      };

      const filteredItems = visibleItems.filter((it) => {
        if (
          requestedWorkspaceId &&
          it.context?.teamId !== requestedWorkspaceId
        ) {
          return false;
        }
        if (requestedTone && it.tone !== requestedTone) return false;
        if (!matchesFilter(it, requestedFilter, nowMs)) return false;
        return true;
      });

      filteredItems.sort((a, b) => compareInboxItems(a, b, nowMs));

      const totalEstimate = filteredItems.length;
      // Exact when no source query hit its take limit. If we capped a
      // category, the true total may be higher — we say so honestly.
      const totalIsExact = !anyTruncated;
      const pagedItems = filteredItems.slice(offset, offset + pageSize);
      const nextOffset = offset + pagedItems.length;
      const nextCursor =
        nextOffset < filteredItems.length ? encodeCursor(nextOffset) : null;

      // -----------------------------------------------------------------
      // Summary counts. Computed over the FULL filtered set so the UI's
      // tone tiles + category counters reflect the entire attention
      // queue, not just the current page.
      // -----------------------------------------------------------------
      const summary = {
        total: filteredItems.length,
        byTone: {
          critical: filteredItems.filter((i) => i.tone === "critical").length,
          high: filteredItems.filter((i) => i.tone === "high").length,
          warning: filteredItems.filter((i) => i.tone === "warning").length,
          info: filteredItems.filter((i) => i.tone === "info").length,
        },
        byCategory: {
          onboarding: filteredItems.filter((i) => i.category === "onboarding")
            .length,
          org_invite: filteredItems.filter((i) => i.category === "org_invite")
            .length,
          org_admin: filteredItems.filter((i) => i.category === "org_admin")
            .length,
          governance: filteredItems.filter((i) => i.category === "governance")
            .length,
          review_decision: filteredItems.filter(
            (i) => i.category === "review_decision",
          ).length,
          discussion_mention: filteredItems.filter(
            (i) => i.category === "discussion_mention",
          ).length,
          discussion_assigned: filteredItems.filter(
            (i) => i.category === "discussion_assigned",
          ).length,
          // Phase IA-cleanup — attention categories.
          review_escalation: filteredItems.filter(
            (i) => i.category === "review_escalation",
          ).length,
          access_review_pending: filteredItems.filter(
            (i) => i.category === "access_review_pending",
          ).length,
          mfa_recovery_pending: filteredItems.filter(
            (i) => i.category === "mfa_recovery_pending",
          ).length,
          communication_failure: filteredItems.filter(
            (i) => i.category === "communication_failure",
          ).length,
          security_event_high: filteredItems.filter(
            (i) => i.category === "security_event_high",
          ).length,
          // Phase IA-enterprise — failure categories.
          report_failure: filteredItems.filter(
            (i) => i.category === "report_failure",
          ).length,
          verification_package_failure: filteredItems.filter(
            (i) => i.category === "verification_package_failure",
          ).length,
          ots_failure: filteredItems.filter((i) => i.category === "ots_failure")
            .length,
          // Phase IA-reliability — intake action categories.
          intake_submission_pending_review: filteredItems.filter(
            (i) => i.category === "intake_submission_pending_review",
          ).length,
          intake_required_items_missing: filteredItems.filter(
            (i) => i.category === "intake_required_items_missing",
          ).length,
          intake_link_expiring: filteredItems.filter(
            (i) => i.category === "intake_link_expiring",
          ).length,
          collaboration: filteredItems.filter(
            (i) => i.category === "collaboration",
          ).length,
          tsa_failure: filteredItems.filter(
            (i) => i.category === "tsa_failure",
          ).length,
          case_assignment: filteredItems.filter(
            (i) => i.category === "case_assignment",
          ).length,
        },
        byPriority: {
          P1: filteredItems.filter((i) => i.priority === "P1").length,
          P2: filteredItems.filter((i) => i.priority === "P2").length,
          P3: filteredItems.filter((i) => i.priority === "P3").length,
          P4: filteredItems.filter((i) => i.priority === "P4").length,
          P5: filteredItems.filter((i) => i.priority === "P5").length,
        },
      };

      return reply.code(200).send({
        generatedAt: now.toISOString(),
        caller: {
          userId: me.id,
          email: me.email,
          displayName: me.displayName,
        },
        // Phase IA-securityEvent-driftFix — honest degraded-source
        // signal. When ≥1 optional source threw (e.g., schema drift,
        // transient DB error), the response still returns 200 with the
        // remaining sources intact, and the UI reads these fields to
        // render a banner explaining what is currently unavailable.
        // CORE sources (user, memberships, invites, governance) are
        // not wrapped — their failure produces a 500 by design.
        degraded: degradedSources.length > 0,
        degradedSources,
        // FILTERED result scope — reflects the active category/tone
        // filter (kept under its long-standing name for compatibility).
        summary,
        // WORKSPACE scope — active-item totals BEFORE category/tone
        // filters (hybrid contract): the severity cards read this so a
        // non-matching filter can never hide live critical/high
        // conditions. Absent on History responses (snapshot store, not
        // the live aggregation).
        scopeSummary,
        // Phase IA-cleanup — honest pagination signal. Per-category +
        // top-level boolean. UI banners read these so the operator
        // knows when to drill into the canonical console for the
        // remainder; we never silently truncate.
        truncated,
        anyTruncated,
        // Phase IA-enterprise — pagination block. `nextCursor` is null
        // when the client has seen every item; otherwise pass it back
        // verbatim on the next request. `totalEstimate` + `totalIsExact`
        // power the "Showing X of Y" indicator honestly.
        pagination: {
          offset,
          pageSize,
          returned: pagedItems.length,
          nextCursor,
          totalEstimate,
          totalIsExact,
          appliedFilter: requestedFilter,
          appliedTone: requestedTone ?? null,
        },
        items: pagedItems,
      });
    },
  );

  // ---------------------------------------------------------------------
  // Operations-Center completion — CACHED full-fidelity summary.
  //
  // GET /v1/me/inbox/summary
  //
  // The bell polls this instead of the full aggregation. It is computed
  // from the SAME buildInboxAggregation the page uses (identical
  // authorization, categories, and per-user state), cached per USER for
  // a short TTL, and explicitly invalidated by every state mutation
  // (read / unread / dismiss / snooze / bulk read). The cache key is the
  // caller's user id — entries can never be shared across users or
  // tenants, and the aggregation itself is membership-scoped so no
  // cross-organization count can enter the entry. Source-side changes
  // are bounded by the TTL (≤45s staleness), user mutations reconcile
  // immediately.
  //
  // The old two-category summary (mentions + assignments only) is NOT
  // restored — every count below is derived from the full item set.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/me/inbox/summary",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const cached = await getCachedOperationsSummary(userId);
      if (cached) {
        try {
          return reply.code(200).send(JSON.parse(cached));
        } catch {
          /* fall through to recompute on a corrupt entry */
        }
      }
      const agg = await buildInboxAggregation(userId, req.log);
      if (!agg.ok) {
        return reply.code(401).send({ message: "Unknown caller" });
      }
      const nowMs = agg.generatedAt.getTime();
      const visible = agg.allItems.filter((it) => {
        if (it.suppressedInApp) return false;
        if (it.dismissedAt != null) return false;
        if (
          it.snoozedUntil != null &&
          new Date(it.snoozedUntil).getTime() > nowMs
        ) {
          return false;
        }
        return true;
      });
      const unreadItems = visible.filter((i) => !i.isRead);
      const assignedCats = FILTER_CATEGORY_MEMBERS.assigned_to_me ?? [];
      const summary = {
        unread: unreadItems.length,
        critical: unreadItems.filter((i) => i.tone === "critical").length,
        high: unreadItems.filter((i) => i.tone === "high").length,
        assignedToMe: unreadItems.filter((i) =>
          assignedCats.includes(i.category),
        ).length,
        overdue: unreadItems.filter(
          (i) => i.dueAt != null && new Date(i.dueAt).getTime() < nowMs,
        ).length,
        total: visible.length,
        hasTruncatedSources: agg.anyTruncated,
        degraded: agg.degradedSources.length > 0,
        degradedSources: agg.degradedSources,
        generatedAtUtc: agg.generatedAt.toISOString(),
      };
      await setCachedOperationsSummary(userId, JSON.stringify(summary));
      return reply.code(200).send(summary);
    },
  );

  // ---------------------------------------------------------------------
  // Operations-Center completion — BULK mark-read.
  //
  // POST /v1/me/inbox/mark-all-read   body: { filter?: <InboxFilter> }
  //
  // The FRONTEND never supplies item keys for mass updates: the server
  // re-runs the canonical aggregation for the caller and marks exactly
  // the currently-visible unread items (optionally narrowed by ONE
  // validated backend filter — the same enum the page chips use).
  // Because the aggregation is membership-scoped, the operation can only
  // ever touch the caller's own attention state within their own
  // workspaces — never another user's state, never another tenant's
  // items.
  //
  // Semantics: read ≠ resolve / dismiss / acknowledge / complete. Bulk
  // read changes ONLY the caller's attention state. Collaboration items
  // update their canonical row readAt in the same transaction.
  // ---------------------------------------------------------------------
  app.post(
    "/v1/me/inbox/mark-all-read",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = z
        .object({ filter: z.string().min(1).max(32).optional() })
        .safeParse(req.body ?? {});
      const rawFilter = body.success ? body.data.filter : undefined;
      // History and snoozed are state views, not attention queues —
      // bulk-reading them is rejected explicitly.
      if (
        rawFilter &&
        (!INBOX_FILTER_KEYS.includes(rawFilter as InboxFilter) ||
          rawFilter === "history" ||
          rawFilter === "snoozed")
      ) {
        return reply.code(400).send({
          message: "INBOX_FILTER_INVALID",
          details: "filter must be a bulk-readable Operations Center filter.",
        });
      }
      const bulkFilter = rawFilter as InboxFilter | undefined;
      const agg = await buildInboxAggregation(userId, req.log);
      if (!agg.ok) {
        return reply.code(401).send({ message: "Unknown caller" });
      }
      const now = new Date();
      const nowMs = now.getTime();
      const targets = agg.allItems.filter((it) => {
        if (it.suppressedInApp) return false;
        if (it.dismissedAt != null) return false;
        if (
          it.snoozedUntil != null &&
          new Date(it.snoozedUntil).getTime() > nowMs
        ) {
          return false;
        }
        if (it.isRead) return false;
        if (bulkFilter && !matchesFilter(it, bulkFilter, nowMs)) return false;
        return true;
      });
      if (targets.length === 0) {
        return reply
          .code(200)
          .send({ markedRead: 0, filter: bulkFilter ?? null });
      }
      const keys = targets.map((t) => t.itemKey);
      const collabIds = targets
        .filter((t) => t.category === "collaboration")
        .map((t) => t.itemKey.slice("collaboration:".length))
        .filter((id) => id.length > 0);
      const snapAvail = await snapshotsAvailable();
      await prisma.$transaction(async (tx) => {
        if (collabIds.length > 0) {
          // Canonical read owner for collaboration items is the collab row.
          await tx.collaborationTeamNotification.updateMany({
            where: { userId, id: { in: collabIds } },
            data: { readAt: now },
          });
        }
        await tx.inboxItemState.createMany({
          data: keys.map((k) => {
            const colon = k.indexOf(":");
            return {
              userId,
              itemKey: k,
              sourceType: colon > 0 ? k.slice(0, colon) : k,
              sourceId: colon > 0 ? k.slice(colon + 1).slice(0, 200) : null,
              readAt: now,
            };
          }),
          skipDuplicates: true,
        });
        await tx.inboxItemState.updateMany({
          where: { userId, itemKey: { in: keys } },
          data: { readAt: now },
        });
        if (snapAvail) {
          await tx.operationsInboxSnapshot.updateMany({
            where: { userId, itemKey: { in: keys } },
            data: { readAtUtc: now },
          });
        }
      });
      await invalidateOperationsSummary(userId);
      // PLATFORM — a bulk-read spans the caller's own inbox items across
      // however many workspaces they belong to; there is no single owning
      // Workspace to attribute the event to.
      await emitPlatformAudit({
        action: "inbox.bulk_mark_read",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        resourceType: "user",
        resourceId: userId,
        correlationId: req.id ?? null,
        metadata: { markedRead: keys.length, appliedFilter: bulkFilter ?? null },
      }).catch(() => undefined);
      return reply
        .code(200)
        .send({ markedRead: keys.length, filter: bulkFilter ?? null });
    },
  );

  // ---------------------------------------------------------------------
  // Phase IA-reliability — per-item mutation endpoints.
  //
  //   POST /v1/me/inbox/items/:itemKey/read
  //   POST /v1/me/inbox/items/:itemKey/unread
  //   POST /v1/me/inbox/items/:itemKey/dismiss
  //   POST /v1/me/inbox/items/:itemKey/snooze
  //
  // Each one validates the itemKey prefix against `INBOX_ITEM_KEY_PREFIXES`
  // (defense against enumeration / arbitrary writes), then upserts the
  // per-user InboxItemState row by the compound (userId, itemKey)
  // unique. Writes are idempotent — a repeated mark-read POST never
  // creates a duplicate row.
  //
  // Security model:
  //   * `userId = getAuthUserId(req)` is the authority. No request
  //     parameter, query string, or body field can substitute another
  //     user's id.
  //   * The endpoint never reads or returns OTHER users' state — the
  //     upsert key is always (caller, itemKey).
  //   * itemKey is constrained by `parseInboxItemKey()` to a known
  //     prefix + a benign right-hand pattern. Arbitrary keys 400.
  // ---------------------------------------------------------------------

  const itemKeyParamsSchema = z.object({
    itemKey: z.string().min(1).max(200),
  });

  const snoozeBodySchema = z.object({
    snoozedUntil: z.string().datetime(),
  });

  /**
   * Reject malformed item keys + extract the parsed source-type +
   * source-id pair (used to populate the audit-context columns on
   * the InboxItemState row). On reject, the caller's reply has
   * already been short-circuited with 400.
   */
  async function resolveItemKey(
    req: FastifyRequest,
    reply: Parameters<typeof requireAuth>[1],
  ): Promise<{ itemKey: string; sourceType: string; sourceId: string } | null> {
    const parsed = itemKeyParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      await reply.code(400).send({
        message: "INBOX_ITEM_KEY_INVALID",
        details: "itemKey path parameter is missing or longer than 200 chars.",
      });
      return null;
    }
    const { itemKey } = parsed.data;
    const decoded = parseInboxItemKey(itemKey);
    if (!decoded) {
      await reply.code(400).send({
        message: "INBOX_ITEM_KEY_INVALID",
        details:
          "itemKey must start with a known source-type prefix and contain only safe characters.",
      });
      return null;
    }
    return {
      itemKey,
      sourceType: decoded.sourceType,
      sourceId: decoded.sourceId ?? "",
    };
  }

  /**
   * Operations-Center completion — TRANSACTIONAL state mutation.
   *
   * CANONICAL READ-STATE OWNERSHIP: for `collaboration:*` items the
   * CollaborationTeamNotification ROW's `readAt` is the canonical read
   * state (the Team page reads/writes the same row); InboxItemState is a
   * derived mirror. Both records are written inside ONE database
   * transaction — read, unread, and dismiss all use this path — so
   * partial success is impossible: if either write fails the whole
   * mutation rolls back and neither store changes. The collab update is
   * scoped to `userId = caller`, so a crafted itemKey can never mutate
   * another user's notification, and the operation is idempotent
   * (repeated read/unread converges on the same state).
   *
   * The persistent history snapshot mirrors the state change in the same
   * transaction when the snapshot table exists. The per-user summary
   * cache is invalidated after commit so the bell reconciles.
   */
  async function applyStateMutation(
    userId: string,
    parsed: { itemKey: string; sourceType: string; sourceId: string },
    delta: {
      readAt?: Date | null;
      dismissedAt?: Date | null;
      snoozedUntil?: Date | null;
    },
  ) {
    const isCollab =
      parsed.sourceType === "collaboration" && parsed.sourceId.length > 0;
    const snapAvail = await snapshotsAvailable();
    const row = await prisma.$transaction(async (tx) => {
      if (isCollab && "readAt" in delta) {
        await tx.collaborationTeamNotification.updateMany({
          where: { id: parsed.sourceId, userId },
          data: { readAt: delta.readAt ?? null },
        });
      }
      const stateRow = await tx.inboxItemState.upsert({
        where: { userId_itemKey: { userId, itemKey: parsed.itemKey } },
        create: {
          userId,
          itemKey: parsed.itemKey,
          sourceType: parsed.sourceType,
          sourceId: parsed.sourceId || null,
          readAt: delta.readAt ?? null,
          dismissedAt: delta.dismissedAt ?? null,
          snoozedUntil: delta.snoozedUntil ?? null,
        },
        update: delta,
        select: {
          itemKey: true,
          readAt: true,
          dismissedAt: true,
          snoozedUntil: true,
          updatedAt: true,
        },
      });
      if (snapAvail) {
        await tx.operationsInboxSnapshot.updateMany({
          where: { userId, itemKey: parsed.itemKey },
          data: {
            ...("readAt" in delta ? { readAtUtc: delta.readAt ?? null } : {}),
            ...("dismissedAt" in delta
              ? { dismissedAtUtc: delta.dismissedAt ?? null }
              : {}),
            ...("snoozedUntil" in delta
              ? { snoozedUntilUtc: delta.snoozedUntil ?? null }
              : {}),
          },
        });
      }
      return stateRow;
    });
    await invalidateOperationsSummary(userId);
    return row;
  }

  app.post(
    "/v1/me/inbox/items/:itemKey/read",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const parsed = await resolveItemKey(req, reply);
      if (!parsed) return;
      const row = await applyStateMutation(userId, parsed, { readAt: new Date() });
      return reply.code(200).send({
        itemKey: row.itemKey,
        isRead: row.readAt != null,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
      });
    },
  );

  app.post(
    "/v1/me/inbox/items/:itemKey/unread",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const parsed = await resolveItemKey(req, reply);
      if (!parsed) return;
      const row = await applyStateMutation(userId, parsed, { readAt: null });
      return reply.code(200).send({
        itemKey: row.itemKey,
        isRead: row.readAt != null,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
      });
    },
  );

  app.post(
    "/v1/me/inbox/items/:itemKey/dismiss",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const parsed = await resolveItemKey(req, reply);
      if (!parsed) return;
      const row = await applyStateMutation(userId, parsed, {
        dismissedAt: new Date(),
        // Dismissing implicitly marks the item read — we'd rather be
        // strict about read-state than have a "dismissed but unread"
        // ghost item polluting unread counters. For collaboration items
        // the canonical row's readAt updates in the same transaction.
        readAt: new Date(),
      });
      return reply.code(200).send({
        itemKey: row.itemKey,
        isRead: row.readAt != null,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
      });
    },
  );

  app.post(
    "/v1/me/inbox/items/:itemKey/snooze",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const parsed = await resolveItemKey(req, reply);
      if (!parsed) return;
      const bodyResult = snoozeBodySchema.safeParse(req.body ?? {});
      if (!bodyResult.success) {
        return reply.code(400).send({
          message: "SNOOZE_PAYLOAD_INVALID",
          details:
            "Body must include `snoozedUntil` as an ISO-8601 datetime.",
        });
      }
      const snoozedUntil = new Date(bodyResult.data.snoozedUntil);
      // Defensive bounds — snoozedUntil must be in the future and no
      // farther than one year out. Past-due snoozes are pointless;
      // forever-snooze is what /dismiss is for.
      const now = new Date();
      const maxSnooze = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
      if (snoozedUntil.getTime() <= now.getTime()) {
        return reply.code(400).send({
          message: "SNOOZE_PAYLOAD_INVALID",
          details: "snoozedUntil must be in the future.",
        });
      }
      if (snoozedUntil.getTime() > maxSnooze.getTime()) {
        return reply.code(400).send({
          message: "SNOOZE_PAYLOAD_INVALID",
          details: "snoozedUntil cannot be more than 365 days out.",
        });
      }
      const row = await applyStateMutation(userId, parsed, {
        snoozedUntil,
      });
      return reply.code(200).send({
        itemKey: row.itemKey,
        isRead: row.readAt != null,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Governance-notification kind → operator-readable copy.
//
// Every kind in `GovernanceNotificationKind` is mapped here. If a new
// kind is added to the schema without a mapping, we fall back to a
// generic readable label — but the test suite asserts every known
// kind has a mapping so the fallback path is a regression signal.
// ---------------------------------------------------------------------------
function governanceKindTitle(kind: string): string {
  switch (kind) {
    case "DESTRUCTION_PENDING":
      return "Evidence destruction pending review";
    case "DESTRUCTION_APPROVED":
      return "Evidence destruction approved";
    case "DESTRUCTION_EXECUTED":
      return "Evidence destruction executed";
    case "DESTRUCTION_BLOCKED":
      return "Evidence destruction blocked";
    case "LEGAL_HOLD_PLACED":
      return "Legal hold placed";
    case "LEGAL_HOLD_RELEASED":
      return "Legal hold released";
    case "RETENTION_CONFLICT":
      return "Retention policy conflict";
    case "RETENTION_EXTENSION_APPLIED":
      return "Retention extension applied";
    case "LIFECYCLE_DRIFT":
      return "Evidence lifecycle drift";
    case "IMMUTABLE_RECONCILIATION_FAILURE":
      return "Object-lock reconciliation failure";
    case "GOVERNANCE_INCIDENT_RAISED":
      return "Governance incident raised";
    case "EXPORT_BLOCKED":
      return "Export blocked by governance";
    default:
      return `Governance event: ${kind.toLowerCase().replace(/_/g, " ")}`;
  }
}

function governanceKindBody(kind: string, occurrenceCount: number): string {
  const occBlurb =
    occurrenceCount > 1 ? ` Seen ${occurrenceCount} times.` : "";
  switch (kind) {
    case "DESTRUCTION_PENDING":
      return `An evidence item is awaiting destruction review.${occBlurb}`;
    case "LEGAL_HOLD_PLACED":
      return `A legal hold has been placed on evidence in this workspace.${occBlurb}`;
    case "RETENTION_CONFLICT":
      return `A retention policy conflict needs governance review.${occBlurb}`;
    case "IMMUTABLE_RECONCILIATION_FAILURE":
      return `Object-lock reconciliation failed for evidence in this workspace.${occBlurb}`;
    case "EXPORT_BLOCKED":
      return `An evidence export was blocked by governance policy.${occBlurb}`;
    default:
      return `A governance event requires acknowledgement.${occBlurb}`;
  }
}

function governanceKindHref(kind: string): string {
  switch (kind) {
    case "DESTRUCTION_PENDING":
    case "DESTRUCTION_APPROVED":
    case "DESTRUCTION_EXECUTED":
    case "DESTRUCTION_BLOCKED":
      return "/governance/destruction";
    case "LEGAL_HOLD_PLACED":
    case "LEGAL_HOLD_RELEASED":
      return "/governance/lifecycle";
    case "RETENTION_CONFLICT":
    case "RETENTION_EXTENSION_APPLIED":
      return "/governance/retention";
    case "EXPORT_BLOCKED":
      return "/governance";
    default:
      return "/governance";
  }
}

// ---------------------------------------------------------------------------
// Phase IA-cleanup — operator-readable labels for the new categories.
//
// Escalation reasons are validated by the service layer against a fixed
// catalog (`REVIEW_ESCALATION_REASONS` in the shared package). We render
// the common ones as short human strings; unknown reasons fall through
// to a normalized snake-case-to-readable transform so the inbox never
// shows a raw enum.
// ---------------------------------------------------------------------------
function humanizeEscalationReason(reason: string): string {
  switch (reason) {
    case "SLA_BREACH":
    case "SLA_NEAR_BREACH":
      return "SLA breach";
    case "REVIEWER_INACTIVITY":
      return "Reviewer inactivity";
    case "QUEUE_BACKLOG":
      return "Queue backlog";
    case "CONFLICT_DETECTED":
      return "Reviewer conflict";
    case "MANUAL_ESCALATION":
      return "Manual escalation";
    case "QC_FAILURE":
      return "QC failure";
    default:
      return reason
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/^./, (c) => c.toUpperCase());
  }
}

// Bounded list of high-severity SecurityEvent eventType strings the
// platform emits today. Unknown types fall through to the normalized
// snake-case-to-readable transform — never raw, never invented.
// ---------------------------------------------------------------------------
// Phase IA-enterprise — OTS failure-reason humanizer. The OTS pipeline
// writes a small set of machine-readable codes (with at least
// "OTS_GLOBAL_BUDGET_EXHAUSTED" being terminal) plus the normalized
// stderr from the OpenTimestamps binary. We map known codes to a
// 1-sentence operator explanation and pass through unknown codes
// truncated. We never invent a failure mode the code didn't emit.
// ---------------------------------------------------------------------------
function humanizeOtsFailureReason(code: string): string {
  // Known terminal code from the worker (`ots-upgrade.processor.ts`).
  if (code.includes("OTS_GLOBAL_BUDGET_EXHAUSTED")) {
    return "Global budget exhausted: the proof did not anchor on the public chain within the configured retry budget — no further attempts will be made.";
  }
  if (code.includes("OpenTimestamps binary is missing")) {
    return "The OpenTimestamps binary is not installed in the worker environment — restart the OTS worker with the binary on PATH.";
  }
  if (/calendar/i.test(code)) {
    return "An OTS calendar was unreachable. The retry budget is unchanged; an operator can re-trigger anchoring once the calendar is available.";
  }
  // Unknown free-form error — surface a truncated copy. Schema is
  // unbounded; we cap at 240 chars so a single failure doesn't blow
  // out the inbox row body.
  const safe = code.length > 240 ? `${code.slice(0, 237)}...` : code;
  return `Unrecoverable failure recorded: ${safe}`;
}

function humanizeSecurityEventType(eventType: string): string {
  switch (eventType) {
    case "step_up_failed":
    case "step_up_required":
      return "Step-up verification required";
    case "mfa_recovery_requested":
      return "MFA recovery requested";
    case "session_quarantined":
      return "Session quarantined";
    case "session_revoked_self":
      return "Session revoked";
    case "device_revoked":
      return "Trusted device revoked";
    case "password_changed":
      return "Password changed";
    case "anomalous_login":
      return "Anomalous login detected";
    default:
      return eventType
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/^./, (c) => c.toUpperCase());
  }
}
