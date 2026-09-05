/**
 * Intake links — the creation wizard's state machine.
 *
 * Pure and React-free so every rule below is unit-testable: the step order,
 * the per-step validation, the dirty check that guards dismissal, and the
 * exact request body the create call sends.
 *
 * The contract this file protects: moving between steps NEVER discards entered
 * state, and NEVER creates or sends anything. Only `Create secure link` on the
 * final step performs a mutation.
 */

import {
  validateCustomSenderDisplayName,
  type IntakeLinkLocationPolicy,
  type IntakeSenderDisplayMode,
} from "@proovra/shared";

import { validateE164 } from "../../../../lib/phone/e164";
import {
  ACCEPTED_KIND_OPTIONS,
  CONSENT_TEXT_MAX,
  DEFAULT_REQUEST_PURPOSE_SLUG,
  EXPIRY_HOURS_DEFAULT,
  EXPIRY_HOURS_MAX,
  EXPIRY_HOURS_MIN,
  MAX_FILES_DEFAULT,
  MAX_FILES_MAX,
  MAX_FILES_MIN,
  expiryFromHours,
  findRequestPurpose,
  maxUsesForMode,
  requiredRecipientField,
  type AcceptedKind,
  type DeliveryChannelWire,
} from "../../../../lib/intake-links/catalog";
import type { IntakeModeWireValue } from "../../../../lib/intake-links/vocabulary";
import type { SenderTransportInfo, WorkflowTemplateRow } from "./types";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const WIZARD_STEPS = ["request", "delivery", "rules", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_LABEL: Record<WizardStep, string> = {
  request: "Request",
  delivery: "Delivery",
  rules: "Collection rules",
  review: "Review",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type WizardState = {
  purposeSlug: string;
  intakeMode: IntakeModeWireValue;
  channel: DeliveryChannelWire;
  /** True once the operator picked a channel; stops the config-aware default. */
  channelTouched: boolean;
  recipientLabel: string;
  recipientEmail: string;
  recipientPhone: string;
  /**
   * The organization's own identifier for this customer. Optional, opaque to
   * us, and never a PROOVRA identifier — see the API's shared validation rule.
   */
  customerId: string;
  senderMode: IntakeSenderDisplayMode;
  senderName: string;
  locationPolicy: IntakeLinkLocationPolicy;
  expiresInHours: number;
  /** Number matches a preset; "custom" reveals the raw hours field. */
  expiryChoice: number | "custom";
  maxFiles: number | "";
  acceptedKinds: AcceptedKind[];
  /** True once the operator edited the type set; purpose changes stop resetting it. */
  kindsTouched: boolean;
  consentText: string;
};

export function initialWizardState(input: {
  initialSlug?: string;
  workspaceName: string;
}): WizardState {
  const purpose =
    findRequestPurpose(input.initialSlug) ??
    findRequestPurpose(DEFAULT_REQUEST_PURPOSE_SLUG);
  return {
    purposeSlug: purpose?.slug ?? DEFAULT_REQUEST_PURPOSE_SLUG,
    intakeMode: "EXTERNAL_ONE_TIME",
    // SMS is the most common real channel; the config-aware effect steps it
    // down to a channel this deployment can actually deliver on.
    channel: "SMS",
    channelTouched: false,
    recipientLabel: "",
    customerId: "",
    recipientEmail: "",
    recipientPhone: "",
    senderMode: input.workspaceName ? "WORKSPACE" : "PROOVRA",
    senderName: "",
    locationPolicy: "OPTIONAL",
    expiresInHours: EXPIRY_HOURS_DEFAULT,
    expiryChoice: EXPIRY_HOURS_DEFAULT,
    maxFiles: MAX_FILES_DEFAULT,
    acceptedKinds: [...(purpose?.recommendedKinds ?? ["PHOTO", "DOCUMENT"])],
    kindsTouched: false,
    consentText: "",
  };
}

/**
 * Has the operator entered anything worth warning about before dismissing?
 * Compared against the state the wizard OPENED with, so a preselected purpose
 * is not itself "unsaved work".
 */
export function isWizardDirty(
  state: WizardState,
  initial: WizardState,
): boolean {
  return (
    state.purposeSlug !== initial.purposeSlug ||
    state.intakeMode !== initial.intakeMode ||
    state.channelTouched ||
    state.recipientLabel.trim() !== "" ||
    state.customerId.trim() !== "" ||
    state.recipientEmail.trim() !== "" ||
    state.recipientPhone.trim() !== "" ||
    state.senderMode !== initial.senderMode ||
    state.senderName.trim() !== "" ||
    state.locationPolicy !== initial.locationPolicy ||
    state.expiresInHours !== initial.expiresInHours ||
    state.maxFiles !== initial.maxFiles ||
    state.kindsTouched ||
    state.consentText.trim() !== ""
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type WizardField =
  | "purposeSlug"
  | "intakeMode"
  | "channel"
  | "customerId"
  | "recipientEmail"
  | "recipientPhone"
  | "senderName"
  | "expiresInHours"
  | "maxFiles"
  | "acceptedKinds"
  | "consentText";

export type WizardErrors = Partial<Record<WizardField, string>>;

export type ValidationContext = {
  transport: SenderTransportInfo | null;
  /** Workspace templates, when the fetch succeeded. */
  templates: ReadonlyArray<WorkflowTemplateRow>;
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Channel availability is a SERVER fact, never a plan-name guess. */
export function channelUnavailableReason(
  channel: DeliveryChannelWire,
  transport: SenderTransportInfo | null,
): string | null {
  if (channel === "MANUAL") return null;
  if (!transport) return null;
  const key = channel === "EMAIL" ? "email" : "sms";
  if (transport[key]?.configured) return null;
  return "This deployment can't send on that channel yet. Choose another, or copy the link and share it yourself.";
}

/**
 * Modes the SELECTED template actually advertises. When the template fetch
 * has not resolved (or the slug is a built-in with no workspace row) every
 * external mode is offered, exactly as the backend would accept.
 */
export function eligibleIntakeModes(
  purposeSlug: string,
  templates: ReadonlyArray<WorkflowTemplateRow>,
): ReadonlyArray<IntakeModeWireValue> {
  const all: ReadonlyArray<IntakeModeWireValue> = [
    "EXTERNAL_ONE_TIME",
    "EXTERNAL_REUSABLE",
    "EXTERNAL_ANONYMOUS",
    "EXTERNAL_PSEUDONYMOUS",
  ];
  const template = templates.find((t) => t.slug === purposeSlug);
  if (!template) return all;
  const supported = all.filter((m) => template.intakeModes.includes(m));
  return supported.length > 0 ? supported : all;
}

export function validateStep(
  step: WizardStep,
  state: WizardState,
  ctx: ValidationContext,
): WizardErrors {
  const errors: WizardErrors = {};

  if (step === "request") {
    if (!state.purposeSlug) {
      errors.purposeSlug = "Choose what you're asking for.";
    }
    const eligible = eligibleIntakeModes(state.purposeSlug, ctx.templates);
    if (!eligible.includes(state.intakeMode)) {
      errors.intakeMode =
        "This request type doesn't support that link type. Pick another.";
    }
  }

  if (step === "delivery") {
    const unavailable = channelUnavailableReason(state.channel, ctx.transport);
    if (unavailable) errors.channel = unavailable;

    const requires = requiredRecipientField(state.channel);
    if (requires === "email") {
      const email = state.recipientEmail.trim();
      if (!email) {
        errors.recipientEmail = "Enter the recipient's email address.";
      } else if (!EMAIL_SHAPE.test(email)) {
        errors.recipientEmail = "That doesn't look like an email address.";
      }
    }
    if (requires === "phone") {
      const phone = state.recipientPhone.trim();
      if (!phone) {
        errors.recipientPhone =
          "Enter the recipient's phone number in international format.";
      } else {
        const check = validateE164(phone);
        if (!check.ok) {
          errors.recipientPhone =
            check.reason === "missing_plus"
              ? "Include the country code, for example +14155550123."
              : "That doesn't look like a valid international number.";
        }
      }
    }
    // A phone typed for a channel that doesn't need it is still sent to the
    // API, so it still has to be well-formed.
    if (requires !== "phone" && state.recipientPhone.trim()) {
      const check = validateE164(state.recipientPhone.trim());
      if (!check.ok) {
        errors.recipientPhone =
          "Remove the number, or write it in international format like +14155550123.";
      }
    }
    if (requires !== "email" && state.recipientEmail.trim()) {
      if (!EMAIL_SHAPE.test(state.recipientEmail.trim())) {
        errors.recipientEmail =
          "Remove the address, or correct it — it isn't a valid email.";
      }
    }
    if (state.senderMode === "CUSTOM") {
      const check = validateCustomSenderDisplayName(state.senderName);
      if (!check.ok) errors.senderName = senderNameReasonCopy(check.reason);
    }
  }

  if (step === "rules") {
    if (
      !Number.isFinite(state.expiresInHours) ||
      state.expiresInHours < EXPIRY_HOURS_MIN ||
      state.expiresInHours > EXPIRY_HOURS_MAX
    ) {
      errors.expiresInHours = `Choose between ${EXPIRY_HOURS_MIN} and ${EXPIRY_HOURS_MAX} hours.`;
    }
    if (state.maxFiles !== "") {
      const n = Number(state.maxFiles);
      if (!Number.isInteger(n) || n < MAX_FILES_MIN || n > MAX_FILES_MAX) {
        errors.maxFiles = `Choose between ${MAX_FILES_MIN} and ${MAX_FILES_MAX} files.`;
      }
    }
    if (state.acceptedKinds.length === 0) {
      errors.acceptedKinds = "Allow at least one type of file.";
    }
    if (state.consentText.length > CONSENT_TEXT_MAX) {
      errors.consentText = `Keep the disclosure under ${CONSENT_TEXT_MAX} characters.`;
    }
  }

  return errors;
}

/** Field order per step — drives "focus the FIRST invalid field". */
export const STEP_FIELD_ORDER: Record<WizardStep, ReadonlyArray<WizardField>> = {
  request: ["purposeSlug", "intakeMode"],
  delivery: [
    "channel",
    "customerId",
    "recipientEmail",
    "recipientPhone",
    "senderName",
  ],
  rules: ["expiresInHours", "maxFiles", "acceptedKinds", "consentText"],
  review: [],
};

export function firstInvalidField(
  step: WizardStep,
  errors: WizardErrors,
): WizardField | null {
  for (const field of STEP_FIELD_ORDER[step]) {
    if (errors[field]) return field;
  }
  return null;
}

/** Translates `validateCustomSenderDisplayName` reason codes to plain English. */
export function senderNameReasonCopy(reason: string): string {
  switch (reason) {
    case "empty":
      return "Enter a display name.";
    case "too_long":
      return "Keep the name under 80 characters.";
    case "contains_url":
      return "Display names can't contain web addresses.";
    case "contains_email":
      return "Display names can't contain email addresses.";
    case "contains_phone":
      return "Display names can't contain phone numbers.";
    case "contains_control_chars":
      return "Display names can't contain invisible or directional characters.";
    case "impersonation":
      return "Display names can't impersonate courts, police, government, or banks.";
    case "reserved_brand":
      return "PROOVRA is reserved — pick a different name. It's added automatically.";
    default:
      return "That display name isn't allowed.";
  }
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export type CreateBodyContext = {
  teamId: string;
  /** Public origin; the API appends `/intake/<token>` itself. */
  intakeUrlBase: string | undefined;
  idempotencyKey: string;
  now?: number;
};

export function buildCreateBody(
  state: WizardState,
  ctx: CreateBodyContext,
): Record<string, unknown> {
  const phone = state.recipientPhone.trim();
  const phoneCheck = phone ? validateE164(phone) : null;
  const canonicalPhone =
    phoneCheck && phoneCheck.ok && phoneCheck.canonical
      ? phoneCheck.canonical
      : null;

  return {
    teamId: ctx.teamId,
    workflowTemplateSlug: state.purposeSlug,
    intakeMode: state.intakeMode,
    deliveryMethod: state.channel,
    intakeUrlBase: state.channel === "MANUAL" ? undefined : ctx.intakeUrlBase,
    recipientLabel: state.recipientLabel.trim() || null,
    // Empty stays null. An absent customer id is an absence, not "".
    customerId: state.customerId.trim() || null,
    recipientEmail: state.recipientEmail.trim() || null,
    recipientPhone: canonicalPhone,
    maxUses: maxUsesForMode(state.intakeMode),
    maxFileCountPerSession: state.maxFiles === "" ? null : Number(state.maxFiles),
    allowedAcceptedKinds: ACCEPTED_KIND_OPTIONS.map((k) => k.value).filter((k) =>
      state.acceptedKinds.includes(k),
    ),
    consentDisclosureText: state.consentText.trim() || null,
    expiresAtUtc: expiryFromHours(state.expiresInHours, ctx.now).toISOString(),
    idempotencyKey: ctx.idempotencyKey,
    senderDisplayMode: state.senderMode,
    senderDisplayName:
      state.senderMode === "CUSTOM" ? state.senderName.trim() : null,
    locationPolicy: state.locationPolicy,
  };
}

// ---------------------------------------------------------------------------
// Server error copy
// ---------------------------------------------------------------------------

/**
 * Backend reason codes → plain English. A raw enum such as
 * `intake_mode_not_supported_by_template` must never reach the operator.
 */
export function friendlyCreateError(
  code: string | undefined,
  message: string | undefined,
): string {
  const map: Record<string, string> = {
    FEATURE_DISABLED: "External intake isn't enabled on this deployment.",
    feature_disabled: "External intake isn't enabled on this deployment.",
    INTAKE_NOT_INCLUDED:
      "Your current plan doesn't include external intake links.",
    intake_mode_not_supported_by_template:
      "This request type doesn't support the selected link type. Pick another.",
    template_not_found:
      "That request type isn't available for this workspace.",
    max_uses_invalid: "Pick a usage limit between 1 and 10,000.",
    rate_limited: "Too many intake links — wait a minute and try again.",
    intake_disabled_by_policy:
      "Your workspace policy doesn't allow this kind of intake link.",
    anonymous_intake_disabled_by_policy:
      "Your workspace policy doesn't allow anonymous intake links.",
  };
  if (code && map[code]) return map[code];
  if (message && map[message]) return map[message];
  return message ?? "Couldn't create the intake link.";
}

/**
 * Delivery-failure reason codes → plain English.
 *
 * THIS IS A READ-SIDE MAPPER AND IT HAS TO OUTLIVE THE CHANNELS.
 *
 * A delivery record is history: it says what happened when it happened, and it
 * is still on screen long after the channel that produced it is gone. When
 * WhatsApp was retired from External Intake the SEND path went — correctly —
 * and its reason mapping went with it, which left every stored WhatsApp
 * failure rendering as `whatsapp_template_unconfigured` to an operator.
 *
 * Retiring a way of SENDING does not retire the records it already wrote. The
 * WhatsApp entries below are past tense and read-only; nothing here can start
 * a send, and no WhatsApp send path exists to reach.
 */
export function friendlyDeliveryReason(reason: string): string {
  const map: Record<string, string> = {
    link_missing_email: "no recipient email on the link",
    link_missing_phone: "no recipient phone on the link",
    link_revoked: "this link has been disabled",
    link_expired: "this link has already expired",
    provider_unconfigured: "messaging isn't configured on this deployment",
    delivery_failed: "the message provider rejected the send",
    delivery_failed_or_skipped:
      "the message provider rejected or skipped the send",

    // Historical only — WhatsApp is retired as an intake delivery option and
    // no send path can produce these again. They are kept so records written
    // while it was supported stay readable.
    whatsapp_template_unconfigured:
      "the WhatsApp request template was never approved",
    whatsapp_unconfigured: "WhatsApp was not configured on this deployment",
  };
  return map[reason] ?? reason;
}
