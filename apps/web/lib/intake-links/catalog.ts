/**
 * Intake links — the request/delivery/collection catalogs.
 *
 * Everything the creation wizard offers as a CHOICE lives here: request
 * purposes, delivery channels, accepted file kinds and the numeric limits.
 * Kept beside the vocabulary (and away from React) so the wizard, the review
 * step, the preview and the tests all read one list.
 *
 * Every wire value in this file is verified against the API:
 *   - request purpose  → `workflowTemplateSlug`, resolved by
 *     `loadEffectiveWorkflowTemplate` against the seeded IntakeTemplate
 *     registry (`services/api/src/services/capture-intake-templates.ts`)
 *   - delivery channel → `deliveryMethod` ∈ MANUAL | EMAIL | SMS | WHATSAPP
 *   - accepted kinds   → `allowedAcceptedKinds` ∈ PHOTO | VIDEO | AUDIO | DOCUMENT
 *   - limits           → the Zod bounds on `maxFileCountPerSession` and the
 *     `expiresAtUtc` the UI computes from a duration
 */

export type AcceptedKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

// =============================================================================
// REQUEST PURPOSES
// =============================================================================
//
// SMB and professional users do not think in "workflow templates" — they think
// in "what am I asking the other side to send me". These nine entries are the
// canonical seed slugs, so every workspace resolves them without first creating
// a template. Workspace-specific templates are surfaced separately by the
// wizard as an "Other templates in this workspace" group when the
// `/v1/workflow/templates` fetch returns rows the catalog does not cover.
//
// `icon` is a semantic key the presentation layer maps to an SVG — never a
// colour and never an emoji.

export type RequestPurpose = {
  slug: string;
  label: string;
  description: string;
  icon: RequestPurposeIcon;
  recommendedKinds: ReadonlyArray<AcceptedKind>;
};

export type RequestPurposeIcon =
  | "general"
  | "media"
  | "document"
  | "insurance"
  | "legal"
  | "property"
  | "incident"
  | "compliance"
  | "source";

export const REQUEST_PURPOSES: ReadonlyArray<RequestPurpose> = [
  {
    slug: "general-evidence-record",
    label: "General evidence request",
    description:
      "Catch-all for anything — photos, documents, or a quick description.",
    icon: "general",
    recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  },
  {
    slug: "photos-videos",
    label: "Photos & videos",
    description: "Ask for photos and short videos only — no documents required.",
    icon: "media",
    recommendedKinds: ["PHOTO", "VIDEO"],
  },
  {
    slug: "documents",
    label: "Documents",
    description:
      "Ask for documents — PDFs, scans, or clear photos of paperwork.",
    icon: "document",
    recommendedKinds: ["DOCUMENT", "PHOTO"],
  },
  {
    slug: "insurance-claim",
    label: "Insurance claim evidence",
    description:
      "Damage photos, repair quotes, receipts, and supporting paperwork.",
    icon: "insurance",
    recommendedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
  },
  {
    slug: "legal-matter",
    label: "Legal document collection",
    description:
      "Contracts, signed forms, sworn statements, and other case documents.",
    icon: "legal",
    recommendedKinds: ["DOCUMENT", "PHOTO"],
  },
  {
    slug: "property-damage",
    label: "Property damage",
    description:
      "Scene overview, close-up damage shots, and any repair estimates.",
    icon: "property",
    recommendedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
  },
  {
    slug: "incident-investigation",
    label: "Incident investigation",
    description:
      "Photos of the scene, witness statements, and supporting context.",
    icon: "incident",
    recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  },
  {
    slug: "compliance-audit",
    label: "Compliance / audit submission",
    description:
      "Policies, procedures, training records, and audit-trail documents.",
    icon: "compliance",
    recommendedKinds: ["DOCUMENT"],
  },
  {
    slug: "journalism-field-capture",
    label: "Source / witness submission",
    description:
      "Anonymous or display-name submissions from sources or witnesses.",
    icon: "source",
    recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  },
];

/** The safe catch-all. Never removed, never renamed. */
export const DEFAULT_REQUEST_PURPOSE_SLUG = "general-evidence-record";

export function findRequestPurpose(
  slug: string | null | undefined,
): RequestPurpose | null {
  if (!slug) return null;
  return REQUEST_PURPOSES.find((p) => p.slug === slug) ?? null;
}

// =============================================================================
// DELIVERY CHANNELS
// =============================================================================
//
// Mirrors the backend `DELIVERY_METHODS` enum exactly. `requires` is the
// CONDITIONAL VALIDATION MATRIX, re-stated on the server by the CreateBody
// `superRefine`: EMAIL demands `recipientEmail`, SMS/WHATSAPP demand
// `recipientPhone`, MANUAL demands neither. The wizard renders exactly the
// field the selected channel requires and nothing else.

export type DeliveryChannelWire = "MANUAL" | "EMAIL" | "SMS" | "WHATSAPP";

export type DeliveryChannel = {
  value: DeliveryChannelWire;
  label: string;
  description: string;
  icon: "link" | "mail" | "sms" | "whatsapp";
  /** The recipient field the API requires for this channel. */
  requires: "none" | "email" | "phone";
  /** Whether a message is composed and sent for this channel. */
  sendsMessage: boolean;
  /** Key into the sender-transport envelope; MANUAL needs no provider. */
  transportKey: "email" | "sms" | "whatsapp" | null;
};

export const DELIVERY_CHANNELS: ReadonlyArray<DeliveryChannel> = [
  {
    value: "SMS",
    label: "SMS",
    description: "PROOVRA texts the secure upload link to a mobile number.",
    icon: "sms",
    requires: "phone",
    sendsMessage: true,
    transportKey: "sms",
  },
  {
    value: "EMAIL",
    label: "Email",
    description: "PROOVRA sends a secure request email.",
    icon: "mail",
    requires: "email",
    sendsMessage: true,
    transportKey: "email",
  },
  {
    value: "WHATSAPP",
    label: "WhatsApp",
    description: "PROOVRA sends the approved WhatsApp request template.",
    icon: "whatsapp",
    requires: "phone",
    sendsMessage: true,
    transportKey: "whatsapp",
  },
  {
    value: "MANUAL",
    label: "Copy link",
    description: "Create the link and share it yourself. Nothing is sent.",
    icon: "link",
    requires: "none",
    sendsMessage: false,
    transportKey: null,
  },
];

export function findDeliveryChannel(
  value: string | null | undefined,
): DeliveryChannel {
  return (
    DELIVERY_CHANNELS.find((c) => c.value === value) ??
    DELIVERY_CHANNELS[DELIVERY_CHANNELS.length - 1]
  );
}

/**
 * The single truth about which recipient field a channel needs. Both the
 * wizard's field rendering and its step validation call this — they cannot
 * drift into "asks for a phone the channel does not want".
 */
export function requiredRecipientField(
  channel: DeliveryChannelWire,
): "none" | "email" | "phone" {
  return findDeliveryChannel(channel).requires;
}

/**
 * Only SMS carries a carrier opt-out sentence. It is rendered by the shared
 * message renderer, so the wizard states the fact rather than composing it.
 */
export function channelCarriesOptOut(channel: DeliveryChannelWire): boolean {
  return channel === "SMS";
}

// =============================================================================
// ACCEPTED FILE TYPES
// =============================================================================
//
// Backend values are UNCHANGED (`PHOTO` / `VIDEO` / `AUDIO` / `DOCUMENT`); only
// the operator-facing label is humanised. The old UI printed the raw enum in
// uppercase beside a browser-default checkbox.

export type AcceptedKindOption = {
  value: AcceptedKind;
  label: string;
  hint: string;
  icon: "photo" | "video" | "audio" | "document";
};

export const ACCEPTED_KIND_OPTIONS: ReadonlyArray<AcceptedKindOption> = [
  {
    value: "PHOTO",
    label: "Photos",
    hint: "JPEG, PNG, HEIC",
    icon: "photo",
  },
  {
    value: "VIDEO",
    label: "Videos",
    hint: "MP4, MOV",
    icon: "video",
  },
  {
    value: "AUDIO",
    label: "Audio",
    hint: "Voice notes, recordings",
    icon: "audio",
  },
  {
    value: "DOCUMENT",
    label: "Documents",
    hint: "PDF, Office, scans",
    icon: "document",
  },
];

export function acceptedKindLabel(kind: string): string {
  return (
    ACCEPTED_KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind
  );
}

// =============================================================================
// LIMITS
// =============================================================================
//
// API units are preserved exactly: the create call sends an absolute
// `expiresAtUtc` ISO string computed from the chosen number of HOURS, and
// `maxFileCountPerSession` as an integer (or null for "no per-session cap").

export const EXPIRY_HOURS_MIN = 1;
/** 365 days — the ceiling the previous form enforced and the API accepts. */
export const EXPIRY_HOURS_MAX = 24 * 365;
export const EXPIRY_HOURS_DEFAULT = 72;

/** Duration presets. `custom` reveals the raw hours field. */
export const EXPIRY_PRESETS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

export const MAX_FILES_MIN = 1;
export const MAX_FILES_MAX = 500;
export const MAX_FILES_DEFAULT = 10;

export const CONSENT_TEXT_MAX = 4000;
export const RECIPIENT_LABEL_MAX = 180;
export const RECIPIENT_EMAIL_MAX = 320;
export const RECIPIENT_PHONE_MAX = 32;
export const SENDER_NAME_MAX = 80;

/** Reusable links accept many submissions; every other mode accepts one. */
export const REUSABLE_MAX_USES = 1000;
export const SINGLE_USE_MAX_USES = 1;

export function maxUsesForMode(mode: string): number {
  return mode === "EXTERNAL_REUSABLE" ? REUSABLE_MAX_USES : SINGLE_USE_MAX_USES;
}

/** Absolute expiry the create call will send, from a duration in hours. */
export function expiryFromHours(hours: number, now: number = Date.now()): Date {
  const safe = Math.min(
    EXPIRY_HOURS_MAX,
    Math.max(EXPIRY_HOURS_MIN, Math.round(hours)),
  );
  return new Date(now + safe * 3_600_000);
}
