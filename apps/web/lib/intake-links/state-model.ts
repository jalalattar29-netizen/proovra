/**
 * Canonical state model for the Intake Links operations console.
 *
 * Why this module exists
 * ----------------------
 * The backend ships a `computedLifecycle` enum that conflates three
 * orthogonal axes into a single value: the LINK's operational
 * status (active/expired/revoked/archived), the latest CONTRIBUTOR
 * SESSION state (created/opened/upload-started/submitted), and the
 * DELIVERY state of the outbound message. Reading that single
 * enum to drive KPI counts, tab filtering, AND the lifecycle chip
 * meant the operations console showed nonsense to the operator —
 * "Active" tab counts included rows whose visible badge said
 * "Submitted", "Opened" tab counts included submitted rows, and
 * "Delivery failed" rows appeared under both Active AND Failed.
 *
 * Everything that needs to ask "what state is this link in" — KPI
 * predicates, tab matching, the lifecycle column, the row-action
 * gating — goes through THIS module. The console is a thin
 * renderer over these pure predicates.
 *
 * Contract
 * --------
 * Every function is pure (no React, no side effects, no I/O). The
 * input is a `ConsoleItem` shape; the output is a stable enum/value.
 * No function returns "unknown" — every code path has a concrete
 * value so the renderer can't accidentally fall through to a hole.
 */

// =============================================================================
// Item shape — duplicated here (not imported from the console) so the
// state model has zero React/component deps and can be safely unit-
// tested with `node --test` or vitest.
// =============================================================================

export type StateModelItem = {
  link: {
    status: string;
    expiresAtUtc: string;
    revokedAtUtc: string | null;
    archivedAtUtc: string | null;
    maxUses: number;
    usedCount: number;
    intakeMode: string;
  };
  delivery: {
    latestStatus: string | null;
    latestFailedAtUtc: string | null;
  };
  activity: {
    sessionsOpened: number;
    sessionsStarted: number;
    sessionsSubmitted: number;
    evidenceCount: number;
  };
};

// Minimum subset of session fields the model needs to gate the
// submissions modal's per-row actions. Keeps the helper decoupled
// from the rest of the SubmissionsPayload shape.
export type StateModelSession = {
  status: string;
  evidenceId: string | null;
  submittedAtUtc: string | null;
};

// =============================================================================
// (A) Link operational state — IS THE LINK USABLE
// =============================================================================
//
// This is about the LINK itself, not what contributors have done with
// it. A REUSABLE link with capacity remaining is ACTIVE even when one
// session already submitted; a ONE_TIME link is EXPIRED after its
// single use. Archive overrides everything else because it's the
// operator's own private "out of rotation" flag.

export type LinkOperationalState = "ACTIVE" | "ARCHIVED" | "REVOKED" | "EXPIRED";

export function getLinkOperationalState(
  link: StateModelItem["link"],
  now: Date = new Date(),
): LinkOperationalState {
  // ARCHIVED takes priority: the operator put this row out of
  // rotation, and we honour that regardless of the underlying
  // status (an archived REVOKED link still reads as "Archived").
  if (link.archivedAtUtc) return "ARCHIVED";

  // REVOKED is a hard terminal — operator-initiated kill.
  if (link.status === "REVOKED" || link.revokedAtUtc) return "REVOKED";

  // EXPIRED can arrive three ways:
  //   - the backend already flipped link.status to "EXPIRED"
  //     (this is what `transitionIntakeSession` does for ONE_TIME
  //     links the moment a session enters SUBMITTED);
  //   - the expiry timestamp has elapsed;
  //   - the capacity is exhausted (usedCount >= maxUses).
  // All three converge to the same operational meaning: no more
  // contributions accepted.
  if (link.status === "EXPIRED") return "EXPIRED";
  if (link.expiresAtUtc) {
    const expiresMs = Date.parse(link.expiresAtUtc);
    if (Number.isFinite(expiresMs) && expiresMs <= now.getTime()) {
      return "EXPIRED";
    }
  }
  if (link.maxUses > 0 && link.usedCount >= link.maxUses) {
    return "EXPIRED";
  }

  return "ACTIVE";
}

// =============================================================================
// (B) Latest session state — WHAT CONTRIBUTORS HAVE DONE
// =============================================================================
//
// Reads off the activity aggregates. Strict precedence: if anyone
// submitted, the latest-session state is SUBMITTED, period. If no
// one submitted but someone started an upload, it's UPLOAD_STARTED.
// If they only opened the link, it's OPENED. Otherwise NO_ACTIVITY.
//
// NOTE: SUBMITTED is the strongest signal even if multiple sessions
// exist in mixed states (one opened, one submitted) — the operator
// cares that SOMETHING landed, not that some sessions were
// abandoned.

export type LatestSessionState =
  | "NO_ACTIVITY"
  | "OPENED"
  | "UPLOAD_STARTED"
  | "SUBMITTED";

export function getLatestSessionState(
  activity: StateModelItem["activity"],
): LatestSessionState {
  if (activity.sessionsSubmitted > 0) return "SUBMITTED";
  if (activity.sessionsStarted > 0) return "UPLOAD_STARTED";
  if (activity.sessionsOpened > 0) return "OPENED";
  return "NO_ACTIVITY";
}

// =============================================================================
// (C) Delivery state — WHAT THE OUTBOUND MESSAGE DID
// =============================================================================
//
// Strictly about the CommunicationMessage status. Completely
// orthogonal to whether the contributor took action — a delivered
// message and an unopened session is perfectly valid (the contributor
// hasn't clicked yet).

export type DeliveryState =
  | "NOT_SENT"
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  | "RETRY_SCHEDULED";

export function getDeliveryState(
  delivery: StateModelItem["delivery"],
): DeliveryState {
  const status = String(delivery.latestStatus ?? "").toUpperCase();
  switch (status) {
    case "DELIVERED":
      return "DELIVERED";
    case "FAILED":
    case "UNDELIVERED":
    case "CANCELLED":
      return "FAILED";
    case "RETRY_SCHEDULED":
      return "RETRY_SCHEDULED";
    case "SENT":
      return "SENT";
    case "QUEUED":
      return "QUEUED";
    default:
      return "NOT_SENT";
  }
}

// =============================================================================
// (D) Intake tab — the operator-facing primary filter
// =============================================================================
//
// Mutually exclusive predicates. Archived overrides everything.
// Opened never includes Submitted. Active never includes Archived /
// Revoked / Expired. Failed delivery is delivery-axis ONLY.

export type IntakeTab =
  | "all"
  | "active"
  | "submitted"
  | "opened"
  | "failed_delivery"
  | "archived"
  | "revoked_or_expired";

export const INTAKE_TABS: ReadonlyArray<IntakeTab> = [
  "all",
  "active",
  "submitted",
  "opened",
  "failed_delivery",
  "archived",
  "revoked_or_expired",
];

export function matchesIntakeTab(
  item: StateModelItem,
  tab: IntakeTab,
  now: Date = new Date(),
): boolean {
  if (tab === "all") return true;
  const link = getLinkOperationalState(item.link, now);
  const sess = getLatestSessionState(item.activity);
  const delivery = getDeliveryState(item.delivery);

  // Archived bucket is exclusive: archived rows ONLY appear here.
  if (tab === "archived") return link === "ARCHIVED";
  if (link === "ARCHIVED") return false;

  switch (tab) {
    case "active":
      // The link must be operationally open for contributions. A
      // REUSABLE link with one SUBMITTED session is fine (capacity
      // remains); a ONE_TIME link after SUBMITTED is not (status
      // flipped to EXPIRED by the backend).
      return link === "ACTIVE";
    case "submitted":
      // Anyone submitted. Independent of whether more capacity
      // remains.
      return sess === "SUBMITTED";
    case "opened":
      // "Opened but not yet submitted". The strict interpretation
      // — the user explicitly named SUBMITTED as not belonging
      // here, so we exclude it.
      return sess === "OPENED" || sess === "UPLOAD_STARTED";
    case "failed_delivery":
      // Delivery axis ONLY. The contributor may not have done
      // anything (delivery never reached them) or may have
      // received the link via a side channel and submitted — that
      // doesn't move them out of this bucket.
      return delivery === "FAILED";
    case "revoked_or_expired":
      return link === "REVOKED" || link === "EXPIRED";
  }
  return false;
}

// =============================================================================
// KPI strip — same predicates as the tabs
// =============================================================================
//
// Computed once from the full items array. Each KPI maps to exactly
// one canonical tab so clicking a KPI is unambiguous.

export type IntakeKpis = {
  total: number;
  active: number;
  submitted: number;
  opened: number;
  failedDelivery: number;
  archived: number;
  revokedOrExpired: number;
};

export function computeIntakeKpis(
  items: ReadonlyArray<StateModelItem>,
  now: Date = new Date(),
): IntakeKpis {
  let active = 0;
  let submitted = 0;
  let opened = 0;
  let failedDelivery = 0;
  let archived = 0;
  let revokedOrExpired = 0;
  for (const it of items) {
    if (matchesIntakeTab(it, "archived", now)) {
      archived += 1;
      // archived overrides — see matchesIntakeTab for the rule.
      continue;
    }
    if (matchesIntakeTab(it, "active", now)) active += 1;
    if (matchesIntakeTab(it, "submitted", now)) submitted += 1;
    if (matchesIntakeTab(it, "opened", now)) opened += 1;
    if (matchesIntakeTab(it, "failed_delivery", now)) failedDelivery += 1;
    if (matchesIntakeTab(it, "revoked_or_expired", now))
      revokedOrExpired += 1;
  }
  return {
    total: items.length,
    active,
    submitted,
    opened,
    failedDelivery,
    archived,
    revokedOrExpired,
  };
}

// =============================================================================
// Lifecycle column — TWO separate chips
// =============================================================================
//
// The old single-chip column conflated link/session/delivery state.
// The new model returns two distinct labels: one for the LINK, one
// for the LATEST SESSION. The console renders them as a small
// two-chip stack. Delivery state has its own column, so it never
// appears in this stack.

export type LifecycleBadges = {
  link: LinkOperationalState;
  /** undefined when there's no session activity; the chip is hidden. */
  session: Exclude<LatestSessionState, "NO_ACTIVITY"> | undefined;
};

export function getLifecycleBadges(
  item: StateModelItem,
  now: Date = new Date(),
): LifecycleBadges {
  const link = getLinkOperationalState(item.link, now);
  const session = getLatestSessionState(item.activity);
  return {
    link,
    session: session === "NO_ACTIVITY" ? undefined : session,
  };
}

/**
 * DISPLAY COPY LIVES IN `lib/intake-links/vocabulary.ts`, NOT HERE.
 *
 * This module used to export `LINK_STATE_LABEL`, `SESSION_STATE_LABEL` and
 * `DELIVERY_STATE_LABEL` — three label maps that restated, word for word, the
 * `label` fields already carried by `LINK_STATE_VOCABULARY`,
 * `SESSION_STATE_VOCABULARY` and `DELIVERY_STATE_VOCABULARY`.
 *
 * Nothing imported them. Every renderer, the filter dropdown and the delivery
 * drawer all read the vocabulary. So they were a second copy of the product's
 * wording with no consumer to keep it honest — the shape that lets one surface
 * say "With provider" while another still says "Queued with provider".
 *
 * Removed after proving zero consumers. This module keeps the PREDICATES; the
 * vocabulary module keeps the WORDS.
 */

// =============================================================================
// Per-row action guards
// =============================================================================

export function canRevokeLink(link: StateModelItem["link"]): boolean {
  // Operator can revoke any link that's still operationally usable
  // OR already-expired-by-time-but-not-revoked (so they can flip a
  // soft-expired link to a hard-revoked one for audit clarity).
  // Revoking an already-revoked or archived link is a no-op; we
  // hide the action to keep the menu clean.
  if (link.archivedAtUtc) return false;
  if (link.status === "REVOKED" || link.revokedAtUtc) return false;
  return true;
}

export function canArchiveLink(link: StateModelItem["link"]): boolean {
  // Archive is allowed on anything that ISN'T already archived.
  // Archived links can be unarchived through the inverse action,
  // which is a separate predicate (caller checks archivedAtUtc).
  return !link.archivedAtUtc;
}

/**
 * Whether the submissions modal should render the "Open evidence"
 * button for a given session. We refuse when there is no evidence
 * ID yet (session is mid-upload) so the user can't click into a
 * 404 — the rest of the page still loads since the evidence detail
 * route now handles pending-signing without blocking.
 *
 * Returning a tuple of (boolean, reason) lets the modal show a tiny
 * "Waiting for files" muted note instead of a silent missing
 * button — that's the difference between "you can act on this" and
 * "we know, nothing to do here yet".
 */
export type EvidenceOpenability =
  | { canOpen: true }
  | { canOpen: false; reason: "no_evidence_yet" | "session_terminal" };

export function canOpenEvidence(
  session: StateModelSession,
): EvidenceOpenability {
  const status = String(session.status ?? "").toUpperCase();
  if (!session.evidenceId) {
    return { canOpen: false, reason: "no_evidence_yet" };
  }
  if (status === "ABANDONED" || status === "REVOKED" || status === "EXPIRED") {
    return { canOpen: false, reason: "session_terminal" };
  }
  return { canOpen: true };
}
