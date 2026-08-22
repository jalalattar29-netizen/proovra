/**
 * Intake links — the ONE operator vocabulary.
 *
 * Every word and every colour the operator reads about an intake link's state
 * comes from this module: the KPI cards, the filter listboxes, the desktop row
 * chips, the mobile card chips, the details drawer, the wizard review step and
 * the action confirmations. A surface that invents its own label for a wire
 * value is how "Revoked" ends up meaning three different things in three
 * places, which is exactly what this file replaces.
 *
 * Shape of an entry: wire value → operator label → semantic tone → one-sentence
 * explanation. Tone names are the canonical `AppTone` values from
 * `components/app-primitives/AppStatusBadge`. Colour is NEVER the only carrier
 * of meaning — every consumer renders the `label` as text alongside the tone.
 *
 * No React, no I/O: pure data + pure functions, so the whole vocabulary is
 * unit-testable with `node --test`.
 */

import type {
  DeliveryState,
  IntakeKpis,
  IntakeTab,
  LatestSessionState,
  LinkOperationalState,
} from "./state-model";

/**
 * Mirrors `AppTone` in `components/app-primitives/AppStatusBadge`.
 *
 * `orange` is the product's CLASSIFICATION tone (`--orange-fill`), deliberately
 * distinct from `amber`, which means "needs attention". It is used here for
 * "Not opened" — a state that is a fact about the contributor, not a warning
 * about the link.
 */
export type IntakeTone =
  | "green"
  | "amber"
  | "orange"
  | "red"
  | "indigo"
  | "blue"
  | "slate";

export type IntakeVocabularyEntry = {
  /** What the operator reads. */
  label: string;
  /** Semantic tone. Never the only carrier of meaning. */
  tone: IntakeTone;
  /** One sentence stating exactly what the state means operationally. */
  explanation: string;
};

// =============================================================================
// LINK LIFECYCLE — can this link still accept submissions?
// =============================================================================
//
// `REVOKED` keeps its wire name in the API, in the audit vocabulary
// (`intake.link.revoked`) and in every `data-*` probe. The OPERATOR label is
// "Link disabled", chosen after tracing the endpoint:
// `POST /v1/workflow/intake-links/:id/revoke` sets `status = REVOKED` plus
// `revokedAtUtc`, and there is NO inverse route anywhere in the service — so
// the action is IRREVERSIBLE and the confirmation must say so. It is also NOT
// a delete: the row, its delivery history and its submissions all survive, so
// the label must not imply removal.

export const LINK_STATE_VOCABULARY: Record<
  LinkOperationalState,
  IntakeVocabularyEntry
> = {
  ACTIVE: {
    label: "Active",
    // GREEN, not indigo. Indigo is the product's BRAND accent — it says "this
    // is ours", not "this is healthy" — and a row scanned for operational
    // state should read its one healthy terminal in the colour the rest of the
    // application already uses for healthy. Green is that colour everywhere
    // else in the redesigned surfaces.
    //
    // The badge renders it as the canonical soft capsule (light green fill,
    // readable green ink), which is the "standard green" treatment the rest of
    // the app shows — not a saturated slab.
    //
    // PRESENTATION ONLY. `getLinkOperationalState` is untouched: what counts
    // as ACTIVE, ARCHIVED, REVOKED or EXPIRED is unchanged.
    tone: "green",
    explanation: "This link can still accept submissions.",
  },
  ARCHIVED: {
    label: "Archived",
    tone: "slate",
    explanation:
      "Hidden from the default view. Archiving does not change public access.",
  },
  REVOKED: {
    label: "Link disabled",
    tone: "red",
    explanation: "This link can no longer accept submissions.",
  },
  EXPIRED: {
    // BLUE, not slate: an expired link is a completed lifecycle, not an
    // inactive one, and the operational rows are scanned for exactly that.
    tone: "blue",
    label: "Expired",
    explanation:
      "The expiry time passed, or every allowed submission has been used.",
  },
};

/** Copy for the irreversible disable action. Used by the confirmation only. */
export const DISABLE_LINK_COPY = {
  actionLabel: "Disable link",
  title: "Disable this intake link?",
  description:
    "Anyone holding this link will be refused immediately. This cannot be undone — the link cannot be re-enabled. Submissions already received are kept.",
  confirmLabel: "Disable link",
  pendingLabel: "Disabling…",
} as const;

// =============================================================================
// CONTRIBUTOR ACTIVITY — what the people holding the link have done
// =============================================================================
//
// Orthogonal to the lifecycle above AND to delivery below. A delivered message
// with an unopened link is an ordinary, truthful combination.

export const SESSION_STATE_VOCABULARY: Record<
  LatestSessionState,
  IntakeVocabularyEntry
> = {
  NO_ACTIVITY: {
    // RED. "Nobody has looked at this yet" is the state an operator most needs
    // to find, and it is the one outcome this surface exists to prevent —
    // orange read as a caution among other cautions rather than as the thing
    // to act on.
    tone: "red",
    label: "Not opened",
    explanation: "Nobody has opened this link yet.",
  },
  OPENED: {
    // AMBER — progress, not completion. With `Not opened` red and
    // `Submitted` blue, the middle of the journey needs its own reading:
    // somebody arrived, nothing has been delivered yet.
    label: "Opened",
    tone: "amber",
    explanation: "The link was opened but no upload has started.",
  },
  UPLOAD_STARTED: {
    // AMBER, with `Opened` — both are "in flight". Indigo was the brand
    // accent standing in for a state, which is the same conflation the
    // lifecycle `Active` had.
    label: "Upload started",
    tone: "amber",
    explanation: "An upload is in progress and has not been submitted.",
  },
  SUBMITTED: {
    // BLUE — the completed terminal of the contributor journey.
    //
    // Green now belongs to the DELIVERY axis, where it means "the message got
    // where it was going". Keeping green here made the two orthogonal columns
    // share one colour for two unrelated successes, so a row scanned quickly
    // read as one fact instead of two.
    tone: "blue",
    label: "Submitted",
    explanation: "At least one contributor completed a submission.",
  },
};

// =============================================================================
// OUTBOUND DELIVERY — what the message provider did with the request
// =============================================================================

export const DELIVERY_STATE_VOCABULARY: Record<
  DeliveryState,
  IntakeVocabularyEntry
> = {
  NOT_SENT: {
    // RED. Slate filed this among the neutral facts, where it disappeared —
    // and "no message was sent" is the delivery state most likely to explain
    // why a contributor never appeared.
    //
    // A DELIBERATE OVERSTATEMENT, recorded as one: manual sharing is a
    // legitimate choice, so this is not always a fault. The `explanation`
    // ("the link is shared manually") is what every consumer surfaces as the
    // accessible description, and it still says so.
    label: "Not sent",
    tone: "red",
    explanation: "No message was sent — the link is shared manually.",
  },
  QUEUED: {
    // "Queued with provider" said the same thing twice. The column is headed
    // `Delivery`, so an operator reading this cell already knows they are
    // looking at where the message got to; "Queued" was the redundant half,
    // and it was also the half that made the value wrap in a table cell.
    //
    // The WIRE value is untouched: this is `DeliveryState.QUEUED`, the enum is
    // `QUEUED`, and `DELIVERY_FILTER_WIRE_VALUES` still sends `QUEUED`. Only
    // the sentence a person reads is shorter. The queued-ness that the word
    // carried is preserved verbatim in `explanation`, which every renderer
    // surfaces as the accessible description.
    label: "With provider",
    // GREEN — the message is where it should be. Amber implied something
    // needed attention; the provider holding a message is the normal, healthy
    // middle of a send.
    tone: "green",
    explanation:
      "Queued with the provider — the provider accepted the message and has not handed it off yet.",
  },
  SENT: {
    // GREEN, with the rest of the healthy send path. Blue is the ACTIVITY
    // axis's completion colour now, and reusing it here would put the same
    // colour on two unrelated facts in one row.
    label: "Sent to provider",
    tone: "green",
    explanation: "The provider accepted the send; delivery is not confirmed.",
  },
  DELIVERED: {
    label: "Delivered",
    tone: "green",
    explanation: "The provider confirmed delivery to the recipient.",
  },
  FAILED: {
    label: "Failed",
    tone: "red",
    explanation: "The provider rejected or could not deliver the message.",
  },
  RETRY_SCHEDULED: {
    label: "Retry scheduled",
    tone: "amber",
    explanation: "Delivery failed and another attempt is scheduled.",
  },
};

/**
 * The raw `CommunicationMessage.status` values the list filter offers, mapped
 * onto the canonical delivery states above so the dropdown can never disagree
 * with the row. `UNDELIVERED` and `CANCELLED` both fold into FAILED exactly as
 * `getDeliveryState` folds them.
 */
export const DELIVERY_FILTER_WIRE_VALUES = [
  "NONE",
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNDELIVERED",
  "RETRY_SCHEDULED",
] as const;
export type DeliveryFilterWireValue =
  (typeof DELIVERY_FILTER_WIRE_VALUES)[number];

export const DELIVERY_FILTER_LABEL: Record<DeliveryFilterWireValue, string> = {
  NONE: DELIVERY_STATE_VOCABULARY.NOT_SENT.label,
  QUEUED: DELIVERY_STATE_VOCABULARY.QUEUED.label,
  SENT: DELIVERY_STATE_VOCABULARY.SENT.label,
  DELIVERED: DELIVERY_STATE_VOCABULARY.DELIVERED.label,
  FAILED: DELIVERY_STATE_VOCABULARY.FAILED.label,
  UNDELIVERED: "Undelivered",
  RETRY_SCHEDULED: DELIVERY_STATE_VOCABULARY.RETRY_SCHEDULED.label,
};

// =============================================================================
// KPI VOCABULARY
// =============================================================================
//
// TRUTH NOTE — these seven counts are NOT mutually exclusive and MUST NOT be
// presented as a breakdown of `total`. `computeIntakeKpis` walks every item
// once and increments EVERY bucket the item matches, so a one-time link that
// was submitted (and therefore flipped to EXPIRED by the backend the moment
// the session reached SUBMITTED) counts under BOTH `submitted` AND
// `revokedOrExpired`. Only `archived` is exclusive: an archived row
// short-circuits and is counted nowhere else. `total` is `items.length`. The
// sum of the other six routinely exceeds it, and the UI says so out loud
// rather than pretending the numbers add up.

export const KPI_COUNTS_ARE_MUTUALLY_EXCLUSIVE = false;

export const KPI_OVERLAP_NOTE =
  "A link can appear in more than one count — these are filters, not a breakdown of the total.";

export type IntakeKpiKey = keyof IntakeKpis;

export const KPI_VOCABULARY: Record<
  IntakeKpiKey,
  IntakeVocabularyEntry & { tab: IntakeTab }
> = {
  total: {
    label: "Total links",
    // Neutral primary ink — the total is a scope statement, not a status.
    tone: "slate",
    explanation: "Every intake link in this workspace, including archived ones.",
    tab: "all",
  },
  active: {
    label: "Active",
    tone: "indigo",
    explanation: "Links that can still accept a submission right now.",
    tab: "active",
  },
  submitted: {
    label: "Submitted",
    tone: "blue",
    explanation: "Links where at least one contributor completed a submission.",
    tab: "submitted",
  },
  opened: {
    label: "Opened",
    tone: "green",
    explanation: "Links a contributor opened but has not submitted through yet.",
    tab: "opened",
  },
  failedDelivery: {
    label: "Failed delivery",
    tone: "red",
    explanation: "Links whose most recent outbound message failed to deliver.",
    tab: "failed_delivery",
  },
  archived: {
    label: "Archived",
    tone: "slate",
    explanation: "Links you moved out of the default view.",
    tab: "archived",
  },
  revokedOrExpired: {
    label: "Revoked or expired",
    tone: "red",
    explanation:
      "Links that can no longer accept submissions — disabled by you, or past their expiry.",
    tab: "revoked_or_expired",
  },
};

/** KPI cards in display order. */
export const KPI_ORDER: ReadonlyArray<IntakeKpiKey> = [
  "total",
  "active",
  "submitted",
  "opened",
  "failedDelivery",
  "archived",
  "revokedOrExpired",
];

// =============================================================================
// DELIVERY CHANNEL
// =============================================================================

export const CHANNEL_WIRE_VALUES = [
  "EMAIL",
  "SMS",
  "WHATSAPP",
  "MANUAL",
] as const;
export type ChannelWireValue = (typeof CHANNEL_WIRE_VALUES)[number];

export const CHANNEL_LABEL: Record<ChannelWireValue, string> = {
  EMAIL: "Email",
  SMS: "SMS",
  WHATSAPP: "WhatsApp",
  MANUAL: "Copy link",
};

export function channelLabel(channel: string | null | undefined): string {
  const key = String(channel ?? "MANUAL").toUpperCase() as ChannelWireValue;
  return CHANNEL_LABEL[key] ?? CHANNEL_LABEL.MANUAL;
}

// =============================================================================
// INTAKE MODE
// =============================================================================
//
// ONE backend enum carrying BOTH the reuse policy and the contributor-identity
// policy — traced against `recordIntakeSubmitterIdentity` in
// `services/api/src/services/workflow-intake-session.service.ts`:
//   PSEUDONYMOUS demands an alias and REFUSES a real name or email;
//   ANONYMOUS refuses every identity field;
//   ONE_TIME / REUSABLE accept an optional display name and/or email.
// Only REUSABLE raises `maxUses` above 1 (the create call sends 1000).
// Because it is a single field on the wire it is presented as a single
// labelled group — splitting it into two controls would fabricate a contract
// the API does not have.

export const INTAKE_MODE_WIRE_VALUES = [
  "EXTERNAL_ONE_TIME",
  "EXTERNAL_REUSABLE",
  "EXTERNAL_ANONYMOUS",
  "EXTERNAL_PSEUDONYMOUS",
] as const;
export type IntakeModeWireValue = (typeof INTAKE_MODE_WIRE_VALUES)[number];

export const INTAKE_MODE_VOCABULARY: Record<
  IntakeModeWireValue,
  { label: string; short: string; description: string }
> = {
  EXTERNAL_ONE_TIME: {
    label: "One-time link",
    short: "One-time",
    description:
      "One submission. The contributor may add a name or email, but is not asked for one.",
  },
  EXTERNAL_REUSABLE: {
    label: "Reusable link",
    short: "Reusable",
    description:
      "Several people can submit through the same link. Each may add a name or email.",
  },
  EXTERNAL_ANONYMOUS: {
    label: "Anonymous link",
    short: "Anonymous",
    description:
      "One submission, and no contributor identity is requested or stored.",
  },
  EXTERNAL_PSEUDONYMOUS: {
    label: "Display-name link",
    short: "Alias",
    description:
      "One submission. The contributor chooses a display name shown with it.",
  },
};

export function intakeModeShortLabel(mode: string): string {
  return (
    INTAKE_MODE_VOCABULARY[mode as IntakeModeWireValue]?.short ?? "One-time"
  );
}

export function intakeModeLabel(mode: string): string {
  return (
    INTAKE_MODE_VOCABULARY[mode as IntakeModeWireValue]?.label ?? "One-time link"
  );
}

// =============================================================================
// PROVIDER ERROR CODES
// =============================================================================
//
// Operators must never have to look up a carrier code from a row. The codes we
// routinely see on the intake-link delivery path get plain English; anything
// else passes through unchanged so a new code is never silently swallowed.

export function providerErrorCodeLabel(code: string): string {
  switch (code) {
    case "63016":
      return "WhatsApp template required or not approved.";
    case "63015":
      return "WhatsApp recipient is not opted in / sandbox not joined.";
    case "63018":
      return "WhatsApp recipient blocked the sender.";
    case "63003":
      return "WhatsApp number is not a valid recipient.";
    case "30007":
      return "Carrier filtered the message as spam.";
    case "30008":
      return "Carrier reported the message as undeliverable.";
    default:
      return `code ${code}`;
  }
}

// =============================================================================
// SORT
// =============================================================================

export const SORT_WIRE_VALUES = ["activity", "created", "expires"] as const;
export type SortWireValue = (typeof SORT_WIRE_VALUES)[number];

export const SORT_LABEL: Record<SortWireValue, string> = {
  activity: "Latest activity",
  created: "Newest created",
  expires: "Expiring soonest",
};
