/**
 * Intake-links-e2e Phase 1 — lifecycle + activity + delivery projection
 * for the workflow-intake-links list.
 *
 * The base `projectWorkflowIntakeLink` returns the link row as-is. SMB
 * operators need much more: the lifecycle state ("Sent" vs "Opened" vs
 * "Submitted"), latest delivery outcome, aggregate session counts, and
 * activity timestamps. That data lives across three tables
 * (WorkflowIntakeLink, WorkflowIntakeSession, CommunicationMessage); this
 * service does the joining + reduction + lifecycle derivation in one
 * place so the route handler stays thin.
 *
 * Design notes:
 *   - `computeIntakeLinkLifecycle` is PURE so the priority order is
 *     unit-testable in isolation. The route handler never re-derives it.
 *   - Aggregation is batched: we accept a list of link IDs and run one
 *     CommunicationMessage findMany + one WorkflowIntakeSession findMany,
 *     then bucket in JS. For typical workspace sizes (≤200 links per
 *     list) this is faster + simpler than N+1 per-link queries.
 *   - PII is masked at the projection layer: the recipient email/phone
 *     are returned as masked previews; the provider message ID is only
 *     included if the caller is an admin (the route gates this).
 *   - This service NEVER returns the raw token, the token hash, or the
 *     provider's raw error message.
 */

import type {
  CommunicationMessage as DbCommunicationMessage,
  PrismaClient,
  WorkflowIntakeLink as DbWorkflowIntakeLink,
  WorkflowIntakeSession as DbWorkflowIntakeSession,
} from "@prisma/client";

import { maskEmail, maskPhonePreview } from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import {
  projectRecipientContact,
  type RecipientContactDisclosure,
} from "./privacy/recipient-contact-disclosure.js";

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * The computed lifecycle state for a single intake link.
 *
 * Priority order, highest to lowest:
 *   REVOKED > EXPIRED > SUBMITTED > STARTED > OPENED > DELIVERY_FAILED >
 *   SENT > CREATED
 *
 * Carve-out: a SUBMITTED session is preserved even if the link later
 * expires or is revoked (the work the contributor did is real). This is
 * why SUBMITTED is checked BEFORE the EXPIRED branch.
 */
export type IntakeLinkLifecycle =
  | "CREATED"
  | "SENT"
  | "DELIVERY_FAILED"
  | "OPENED"
  | "STARTED"
  | "SUBMITTED"
  | "EXPIRED"
  | "REVOKED";

export type LifecycleInput = {
  /** From WorkflowIntakeLink.status. */
  linkStatus: string;
  /** From WorkflowIntakeLink.expiresAtUtc, compared against `now`. */
  expiresAtUtc: Date;
  /** Aggregated session counts per session status bucket. */
  sessionCounts: {
    submitted: number;
    started: number;
    opened: number;
  };
  /**
   * The status of the latest CommunicationMessage attempt for this link
   * (any channel). Null when no send has ever been attempted.
   */
  latestDeliveryStatus:
    | "QUEUED"
    | "SENT"
    | "DELIVERED"
    | "FAILED"
    | "UNDELIVERED"
    | "RETRY_SCHEDULED"
    | "CANCELLED"
    | "RECEIVED"
    | null;
  /** Override for the "now" comparison; defaults to new Date(). */
  now?: Date;
};

export function computeIntakeLinkLifecycle(
  input: LifecycleInput,
): IntakeLinkLifecycle {
  const now = input.now ?? new Date();
  const { sessionCounts, latestDeliveryStatus, linkStatus, expiresAtUtc } =
    input;

  // SUBMITTED wins over expiry/revocation: the contributor's upload
  // already exists, so the lifecycle should reflect that even on a link
  // that's now closed. (The list UI still shows the EXPIRED/REVOKED
  // status as a separate chip so the operator knows the door is shut.)
  if (sessionCounts.submitted > 0) return "SUBMITTED";

  // Revoked is operator-initiated; outranks everything except an
  // already-submitted contribution.
  if (linkStatus === "REVOKED") return "REVOKED";

  // Expired beats "in-flight" states. If a contributor opened the link
  // but never submitted, and the link has since expired, the lifecycle
  // is EXPIRED (the door is closed) — not OPENED.
  if (linkStatus === "EXPIRED" || expiresAtUtc.getTime() <= now.getTime()) {
    return "EXPIRED";
  }

  if (sessionCounts.started > 0) return "STARTED";
  if (sessionCounts.opened > 0) return "OPENED";

  // No contributor activity. Delivery state is the next signal.
  if (latestDeliveryStatus === "FAILED" || latestDeliveryStatus === "UNDELIVERED") {
    return "DELIVERY_FAILED";
  }
  if (
    latestDeliveryStatus === "SENT" ||
    latestDeliveryStatus === "DELIVERED" ||
    latestDeliveryStatus === "QUEUED" ||
    latestDeliveryStatus === "RETRY_SCHEDULED"
  ) {
    return "SENT";
  }

  // No send, no activity — the link exists but nothing has happened.
  return "CREATED";
}

// =============================================================================
// Aggregation
// =============================================================================

export type SessionAggregate = {
  /** How many sessions reached each phase. */
  counts: {
    created: number;
    opened: number;
    uploadStarted: number;
    uploadCompleted: number;
    submitted: number;
    expired: number;
    revoked: number;
    abandoned: number;
  };
  /** Earliest / latest timestamps across sessions. */
  firstOpenedAtUtc: string | null;
  lastOpenedAtUtc: string | null;
  firstStartedAtUtc: string | null;
  lastStartedAtUtc: string | null;
  firstSubmittedAtUtc: string | null;
  lastSubmittedAtUtc: string | null;
  /** Count of sessions that have an evidenceId — proxy for submissions
   *  that produced a stored Evidence row. */
  evidenceCount: number;
};

export type DeliveryAggregate = {
  latestStatus: DbCommunicationMessage["status"] | null;
  latestChannel: DbCommunicationMessage["channel"] | null;
  latestAtUtc: string | null;
  latestSentAtUtc: string | null;
  latestDeliveredAtUtc: string | null;
  latestFailedAtUtc: string | null;
  latestErrorCode: string | null;
  /** Total CommunicationMessage rows tagged with this link. */
  attemptCount: number;
  /** Only safe to expose to admins/support. */
  latestProviderMessageId: string | null;
  /** All distinct channels ever attempted, ordered most-recent first. */
  channelsAttempted: DbCommunicationMessage["channel"][];
};

/**
 * Bulk-load every CommunicationMessage tagged with one of the given
 * link IDs. Returns a map keyed by linkId.
 */
export async function loadDeliveryAggregateByLink(
  linkIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, DeliveryAggregate>> {
  const map = new Map<string, DeliveryAggregate>();
  if (linkIds.length === 0) return map;

  const messages = await client.communicationMessage.findMany({
    where: { relatedIntakeLinkId: { in: linkIds } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      relatedIntakeLinkId: true,
      status: true,
      channel: true,
      providerMessageId: true,
      errorCode: true,
      createdAt: true,
      sentAtUtc: true,
      deliveredAtUtc: true,
      failedAtUtc: true,
    },
  });

  for (const id of linkIds) {
    map.set(id, emptyDeliveryAggregate());
  }

  for (const m of messages) {
    const linkId = m.relatedIntakeLinkId;
    if (!linkId) continue;
    const agg = map.get(linkId);
    if (!agg) continue;

    agg.attemptCount += 1;
    // findMany orderBy createdAt desc → first message we see per link
    // IS the latest. Subsequent messages just bump counters.
    if (agg.latestStatus === null) {
      agg.latestStatus = m.status;
      agg.latestChannel = m.channel;
      agg.latestAtUtc = m.createdAt.toISOString();
      agg.latestSentAtUtc = m.sentAtUtc?.toISOString() ?? null;
      agg.latestDeliveredAtUtc = m.deliveredAtUtc?.toISOString() ?? null;
      agg.latestFailedAtUtc = m.failedAtUtc?.toISOString() ?? null;
      agg.latestErrorCode = m.errorCode;
      agg.latestProviderMessageId = m.providerMessageId;
    }
    if (!agg.channelsAttempted.includes(m.channel)) {
      agg.channelsAttempted.push(m.channel);
    }
  }

  return map;
}

function emptyDeliveryAggregate(): DeliveryAggregate {
  return {
    latestStatus: null,
    latestChannel: null,
    latestAtUtc: null,
    latestSentAtUtc: null,
    latestDeliveredAtUtc: null,
    latestFailedAtUtc: null,
    latestErrorCode: null,
    attemptCount: 0,
    latestProviderMessageId: null,
    channelsAttempted: [],
  };
}

export async function loadSessionAggregateByLink(
  linkIds: string[],
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, SessionAggregate>> {
  const map = new Map<string, SessionAggregate>();
  if (linkIds.length === 0) return map;

  const sessions = await client.workflowIntakeSession.findMany({
    where: { intakeLinkId: { in: linkIds } },
    select: {
      intakeLinkId: true,
      status: true,
      openedAtUtc: true,
      uploadStartedAtUtc: true,
      uploadCompletedAtUtc: true,
      submittedAtUtc: true,
      evidenceId: true,
    },
  });

  for (const id of linkIds) {
    map.set(id, emptySessionAggregate());
  }

  for (const s of sessions) {
    const agg = map.get(s.intakeLinkId);
    if (!agg) continue;

    // Bump status counters.
    switch (s.status) {
      case "CREATED":
        agg.counts.created += 1;
        break;
      case "OPENED":
        agg.counts.opened += 1;
        break;
      case "UPLOAD_STARTED":
        agg.counts.uploadStarted += 1;
        break;
      case "UPLOAD_COMPLETED":
        agg.counts.uploadCompleted += 1;
        break;
      case "SUBMITTED":
        agg.counts.submitted += 1;
        break;
      case "EXPIRED":
        agg.counts.expired += 1;
        break;
      case "REVOKED":
        agg.counts.revoked += 1;
        break;
      case "ABANDONED":
        agg.counts.abandoned += 1;
        break;
    }

    if (s.evidenceId) agg.evidenceCount += 1;

    updateRange(agg, "openedAt", s.openedAtUtc);
    updateRange(agg, "startedAt", s.uploadStartedAtUtc);
    updateRange(agg, "submittedAt", s.submittedAtUtc);
  }

  return map;
}

function emptySessionAggregate(): SessionAggregate {
  return {
    counts: {
      created: 0,
      opened: 0,
      uploadStarted: 0,
      uploadCompleted: 0,
      submitted: 0,
      expired: 0,
      revoked: 0,
      abandoned: 0,
    },
    firstOpenedAtUtc: null,
    lastOpenedAtUtc: null,
    firstStartedAtUtc: null,
    lastStartedAtUtc: null,
    firstSubmittedAtUtc: null,
    lastSubmittedAtUtc: null,
    evidenceCount: 0,
  };
}

function updateRange(
  agg: SessionAggregate,
  field: "openedAt" | "startedAt" | "submittedAt",
  ts: Date | null,
): void {
  if (!ts) return;
  const iso = ts.toISOString();
  if (field === "openedAt") {
    if (!agg.firstOpenedAtUtc || iso < agg.firstOpenedAtUtc) {
      agg.firstOpenedAtUtc = iso;
    }
    if (!agg.lastOpenedAtUtc || iso > agg.lastOpenedAtUtc) {
      agg.lastOpenedAtUtc = iso;
    }
  } else if (field === "startedAt") {
    if (!agg.firstStartedAtUtc || iso < agg.firstStartedAtUtc) {
      agg.firstStartedAtUtc = iso;
    }
    if (!agg.lastStartedAtUtc || iso > agg.lastStartedAtUtc) {
      agg.lastStartedAtUtc = iso;
    }
  } else {
    if (!agg.firstSubmittedAtUtc || iso < agg.firstSubmittedAtUtc) {
      agg.firstSubmittedAtUtc = iso;
    }
    if (!agg.lastSubmittedAtUtc || iso > agg.lastSubmittedAtUtc) {
      agg.lastSubmittedAtUtc = iso;
    }
  }
}

// =============================================================================
// PII masking — recipient previews for the list
// =============================================================================

/**
 * @deprecated Recipient and submitter contact are masked by the platform's
 * shared helpers now, through `projectRecipientContact`. This local pair
 * produced a THIRD rendering of the same data class (`j••e@x.com` here,
 * `j***@x.com` on Evidence Detail), so the same address looked different
 * depending on which screen you were on. Retained only because its contract
 * test documents the old behaviour; nothing in the service calls it.
 */
export function maskEmailForList(email: string | null): string | null {
  if (!email) return null;
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at <= 0) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const masked =
    local.length <= 2
      ? local[0] + "•"
      : local[0] + "•".repeat(Math.max(1, local.length - 2)) + local[local.length - 1];
  return `${masked}@${domain}`;
}

export function maskPhoneForList(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.length <= 4) return digits;
  // Keep the leading + and country digits + last two so the operator
  // recognises the recipient without us echoing the whole number into
  // the list response.
  const head = digits.slice(0, Math.min(4, digits.length - 2));
  const tail = digits.slice(-2);
  return `${head}••${tail}`;
}

// =============================================================================
// Projection — the rich list-item shape consumed by the frontend
// =============================================================================

export type IntakeLinkListItem = {
  // Base link fields (a subset of projectWorkflowIntakeLink — we intentionally
  // drop fields the SMB list view doesn't need so the JSON stays compact).
  link: {
    id: string;
    teamId: string;
    workflowTemplateSlug: string;
    workflowTemplateVersion: number;
    workflowTemplateName: string;
    intakeMode: string;
    caseId: string | null;
    recipientLabel: string | null;
    /** Masked. The raw values are not part of this projection at all. */
    recipientEmailPreview: string | null;
    recipientPhonePreview: string | null;
    hasRecipientEmail: boolean;
    hasRecipientPhone: boolean;
    recipientContactRevealAuthorized: boolean;
    maxUses: number;
    usedCount: number;
    status: string;
    expiresAtUtc: string;
    revokedAtUtc: string | null;
    revokedReason: string | null;
    archivedAtUtc: string | null;
    locationPolicy: string;
    createdAt: string;
    updatedAt: string;
  };
  delivery: {
    latestStatus: string | null;
    latestChannel: string | null;
    latestAtUtc: string | null;
    latestSentAtUtc: string | null;
    latestDeliveredAtUtc: string | null;
    latestFailedAtUtc: string | null;
    latestErrorCode: string | null;
    attemptCount: number;
    channelsAttempted: string[];
    /** Only populated when `includeProviderMessageId` is true. */
    latestProviderMessageId: string | null;
  };
  activity: {
    firstOpenedAtUtc: string | null;
    lastOpenedAtUtc: string | null;
    firstStartedAtUtc: string | null;
    lastStartedAtUtc: string | null;
    firstSubmittedAtUtc: string | null;
    lastSubmittedAtUtc: string | null;
    sessionsCreated: number;
    sessionsOpened: number;
    sessionsStarted: number;
    sessionsSubmitted: number;
    sessionsExpired: number;
    sessionsRevoked: number;
    evidenceCount: number;
  };
  computedLifecycle: IntakeLinkLifecycle;
};

export type ProjectIntakeLinkListInput = {
  /**
   * What this caller may be shown. Optional, and absent means MASKED: a
   * route that forgets to pass it discloses nothing, which is the only safe
   * direction for a default to fail in.
   */
  recipientContactDisclosure?: RecipientContactDisclosure;
  links: DbWorkflowIntakeLink[];
  /** Pass true for platform admins or `?_debug=intake-delivery` opt-in. */
  includeProviderMessageId?: boolean;
  client?: PrismaClient;
  now?: Date;
};

/**
 * Top-level entry point used by the list endpoint. Loads delivery +
 * session aggregates for every link in a single round-trip apiece, then
 * derives the lifecycle.
 */
export async function projectIntakeLinkList(
  input: ProjectIntakeLinkListInput,
): Promise<IntakeLinkListItem[]> {
  /*
   * One decision for the whole page. Every link in this list belongs to the
   * workspace the caller was authorized against, so the disclosure is the
   * same for all of them and is resolved once by the route rather than
   * re-derived per row.
   */
  const disclosure: RecipientContactDisclosure =
    input.recipientContactDisclosure ?? "MASKED";
  const client = input.client ?? defaultPrisma;
  const linkIds = input.links.map((l) => l.id);

  const [deliveryMap, sessionMap] = await Promise.all([
    loadDeliveryAggregateByLink(linkIds, client),
    loadSessionAggregateByLink(linkIds, client),
  ]);

  return input.links.map((link) => {
    const delivery = deliveryMap.get(link.id) ?? emptyDeliveryAggregate();
    const sessions = sessionMap.get(link.id) ?? emptySessionAggregate();
    const lifecycle = computeIntakeLinkLifecycle({
      linkStatus: link.status,
      expiresAtUtc: link.expiresAtUtc,
      sessionCounts: {
        submitted: sessions.counts.submitted,
        started:
          sessions.counts.uploadStarted + sessions.counts.uploadCompleted,
        opened: sessions.counts.opened,
      },
      latestDeliveryStatus: delivery.latestStatus,
      now: input.now,
    });

    const snapshot = link.workflowTemplateSnapshot as { name?: string } | null;
    const templateName =
      typeof snapshot?.name === "string"
        ? snapshot.name
        : link.workflowTemplateSlug;

    const recipientContact = projectRecipientContact(link, disclosure);

    return {
      link: {
        id: link.id,
        teamId: link.teamId,
        workflowTemplateSlug: link.workflowTemplateSlug,
        workflowTemplateVersion: link.workflowTemplateVersion,
        workflowTemplateName: templateName,
        intakeMode: link.intakeMode,
        caseId: link.caseId,
        recipientLabel: link.recipientLabel,
        // Masked by the one policy, not by a helper local to this file.
        // The list was already masked — correctly — but with its own
        // renderer; it now agrees with every other surface character for
        // character.
        recipientEmailPreview: recipientContact.recipientEmailMasked,
        recipientPhonePreview: recipientContact.recipientPhoneMasked,
        hasRecipientEmail: recipientContact.hasRecipientEmail,
        hasRecipientPhone: recipientContact.hasRecipientPhone,
        recipientContactRevealAuthorized:
          recipientContact.recipientContactRevealAuthorized,
        maxUses: link.maxUses,
        usedCount: link.usedCount,
        status: link.status,
        expiresAtUtc: link.expiresAtUtc.toISOString(),
        revokedAtUtc: link.revokedAtUtc?.toISOString() ?? null,
        revokedReason: link.revokedReason,
        archivedAtUtc: link.archivedAtUtc?.toISOString() ?? null,
        locationPolicy: link.locationPolicy,
        createdAt: link.createdAt.toISOString(),
        updatedAt: link.updatedAt.toISOString(),
      },
      delivery: {
        latestStatus: delivery.latestStatus,
        latestChannel: delivery.latestChannel,
        latestAtUtc: delivery.latestAtUtc,
        latestSentAtUtc: delivery.latestSentAtUtc,
        latestDeliveredAtUtc: delivery.latestDeliveredAtUtc,
        latestFailedAtUtc: delivery.latestFailedAtUtc,
        latestErrorCode: delivery.latestErrorCode,
        attemptCount: delivery.attemptCount,
        channelsAttempted: delivery.channelsAttempted,
        latestProviderMessageId: input.includeProviderMessageId
          ? delivery.latestProviderMessageId
          : null,
      },
      activity: {
        firstOpenedAtUtc: sessions.firstOpenedAtUtc,
        lastOpenedAtUtc: sessions.lastOpenedAtUtc,
        firstStartedAtUtc: sessions.firstStartedAtUtc,
        lastStartedAtUtc: sessions.lastStartedAtUtc,
        firstSubmittedAtUtc: sessions.firstSubmittedAtUtc,
        lastSubmittedAtUtc: sessions.lastSubmittedAtUtc,
        sessionsCreated: sessions.counts.created,
        sessionsOpened: sessions.counts.opened,
        sessionsStarted:
          sessions.counts.uploadStarted + sessions.counts.uploadCompleted,
        sessionsSubmitted: sessions.counts.submitted,
        sessionsExpired: sessions.counts.expired,
        sessionsRevoked: sessions.counts.revoked,
        evidenceCount: sessions.evidenceCount,
      },
      computedLifecycle: lifecycle,
    };
  });
}

// =============================================================================
// Single-link variant — same projection but for the GET /:id route.
// =============================================================================

export async function projectIntakeLinkListItem(
  link: DbWorkflowIntakeLink,
  options: {
    includeProviderMessageId?: boolean;
    client?: PrismaClient;
    now?: Date;
    recipientContactDisclosure?: RecipientContactDisclosure;
  } = {},
): Promise<IntakeLinkListItem> {
  const [item] = await projectIntakeLinkList({
    links: [link],
    includeProviderMessageId: options.includeProviderMessageId,
    client: options.client,
    now: options.now,
    recipientContactDisclosure: options.recipientContactDisclosure,
  });
  return item;
}

// =============================================================================
// Re-exported types for callers that already need the raw session row
// (e.g. the submissions endpoint in Phase 3).
// =============================================================================

export type RawIntakeSession = DbWorkflowIntakeSession;

// =============================================================================
// Phase 3 — Submissions projection
//
// `loadIntakeLinkSubmissions` returns the per-session view used by the
// "View submissions" drawer on the link list. Owner / team-only access
// is enforced by the route handler (this service trusts the caller has
// already validated workspace membership for `teamId`).
//
// Anonymous / pseudonymous redaction is enforced HERE as defense in
// depth: even if the session row has a contributor email/phone (it
// shouldn't for ANONYMOUS mode, but legacy data could), we strip it
// before projection so the API contract is hard.
// =============================================================================

export type IntakeLinkSubmissionSession = {
  id: string;
  status: string;
  /** Anonymous/pseudonymous: null. Identified intake: full label. */
  submitterDisplayName: string | null;
  /** Masked preview. Never the raw email. Null in anonymous mode. */
  submitterEmailPreview: string | null;
  /** Masked preview. Never the raw phone. Null in anonymous mode. */
  submitterPhonePreview: string | null;
  /** Only populated when intakeMode === EXTERNAL_PSEUDONYMOUS. */
  pseudonym: string | null;
  openedAtUtc: string | null;
  uploadStartedAtUtc: string | null;
  uploadCompletedAtUtc: string | null;
  submittedAtUtc: string | null;
  abandonedAtUtc: string | null;
  revokedAtUtc: string | null;
  expiresAtUtc: string;
  consentAcceptedAtUtc: string | null;
  /** Single Evidence row this session produced, if it reached SUBMITTED. */
  evidenceId: string | null;
};

export type IntakeLinkSubmissionsPayload = {
  link: {
    id: string;
    teamId: string;
    intakeMode: string;
    recipientLabel: string | null;
    workflowTemplateSlug: string;
    workflowTemplateName: string;
  };
  sessions: IntakeLinkSubmissionSession[];
  /** Aggregate counts so the drawer can render a header summary. */
  totals: {
    sessions: number;
    submitted: number;
    inProgress: number;
    evidenceProduced: number;
  };
};

export async function loadIntakeLinkSubmissions(
  link: DbWorkflowIntakeLink,
  client: PrismaClient = defaultPrisma,
): Promise<IntakeLinkSubmissionsPayload> {
  const rows = await client.workflowIntakeSession.findMany({
    where: { intakeLinkId: link.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const isAnonymous =
    link.intakeMode === "EXTERNAL_ANONYMOUS" ||
    link.intakeMode === "EXTERNAL_PSEUDONYMOUS";

  const sessions: IntakeLinkSubmissionSession[] = rows.map((s) => ({
    id: s.id,
    status: s.status,
    submitterDisplayName: isAnonymous ? null : s.submitterDisplayName,
    submitterEmailPreview: isAnonymous
      ? null
      : maskEmail(s.submitterEmail),
    submitterPhonePreview: isAnonymous
      ? null
      : maskPhonePreview(s.submitterPhone),
    pseudonym:
      link.intakeMode === "EXTERNAL_PSEUDONYMOUS" ? s.pseudonym : null,
    openedAtUtc: s.openedAtUtc?.toISOString() ?? null,
    uploadStartedAtUtc: s.uploadStartedAtUtc?.toISOString() ?? null,
    uploadCompletedAtUtc: s.uploadCompletedAtUtc?.toISOString() ?? null,
    submittedAtUtc: s.submittedAtUtc?.toISOString() ?? null,
    abandonedAtUtc: s.abandonedAtUtc?.toISOString() ?? null,
    revokedAtUtc: s.revokedAtUtc?.toISOString() ?? null,
    expiresAtUtc: s.expiresAtUtc.toISOString(),
    consentAcceptedAtUtc: s.consentAcceptedAtUtc?.toISOString() ?? null,
    evidenceId: s.evidenceId,
  }));

  const snapshot = link.workflowTemplateSnapshot as { name?: string } | null;
  const templateName =
    typeof snapshot?.name === "string"
      ? snapshot.name
      : link.workflowTemplateSlug;

  const totals = {
    sessions: sessions.length,
    submitted: sessions.filter((s) => s.status === "SUBMITTED").length,
    inProgress: sessions.filter(
      (s) =>
        s.status === "OPENED" ||
        s.status === "UPLOAD_STARTED" ||
        s.status === "UPLOAD_COMPLETED",
    ).length,
    evidenceProduced: sessions.filter((s) => s.evidenceId !== null).length,
  };

  return {
    link: {
      id: link.id,
      teamId: link.teamId,
      intakeMode: link.intakeMode,
      recipientLabel: link.recipientLabel,
      workflowTemplateSlug: link.workflowTemplateSlug,
      workflowTemplateName: templateName,
    },
    sessions,
    totals,
  };
}
