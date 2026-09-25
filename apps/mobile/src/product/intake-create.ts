/**
 * INTAKE-LINK CREATION (T-16 / RC-20, with T-12's two absent selects).
 *
 * THE DEFECT
 * ----------
 * Native could list, revoke, archive and inspect intake links, and said that
 * creating one "stays in the PROOVRA web app" — justified by the resend
 * constraint (a resend needs the raw token, which the API never persists).
 * That reason is true of RESEND and says nothing about CREATION: the create
 * response carries the raw token, so the session that creates a link can show
 * it, share it and send it. A caseworker on a phone could not ask anyone for
 * evidence.
 *
 * This is the web wizard (`intake-links/_components/wizard/*`, `_lib/wizardState.ts`)
 * as pure data and functions: catalog, vocabulary, validation, the request
 * body, the response parse and every string, verbatim with its web source.
 * Spec: `docs/audit/pwa-native-2026-09-24-v2/T-16-INTAKE-CREATE-SPEC.md`.
 *
 * Reused from `@proovra/shared` exactly where the web uses it: the custom
 * sender-name validator and the location-policy options — one rule, not two.
 */
import {
  INTAKE_LINK_LOCATION_POLICY_OPTIONS,
  validateCustomSenderDisplayName,
  type IntakeLinkLocationPolicy,
} from "@proovra/shared";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/* ------------------------------------------------------------ catalog (CAT:54-126) */

export type AcceptedKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";
export const ACCEPTED_KINDS: ReadonlyArray<{ value: AcceptedKind; label: string; hint: string }> = [
  { value: "PHOTO", label: "Photos", hint: "JPEG, PNG, HEIC" },
  { value: "VIDEO", label: "Videos", hint: "MP4, MOV" },
  { value: "AUDIO", label: "Audio", hint: "Voice notes, recordings" },
  { value: "DOCUMENT", label: "Documents", hint: "PDF, Office, scans" },
];

export interface IntakePurpose {
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly recommendedKinds: readonly AcceptedKind[];
  readonly builtIn: boolean;
  /** Template-declared modes; empty = every mode eligible. */
  readonly intakeModes: readonly string[];
}

export const BUILT_IN_PURPOSES: readonly IntakePurpose[] = [
  { slug: "general-evidence-record", label: "General evidence request", description: "Catch-all for anything — photos, documents, or a quick description.", recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"], builtIn: true, intakeModes: [] },
  { slug: "photos-videos", label: "Photos & videos", description: "Ask for photos and short videos only — no documents required.", recommendedKinds: ["PHOTO", "VIDEO"], builtIn: true, intakeModes: [] },
  { slug: "documents", label: "Documents", description: "Ask for documents — PDFs, scans, or clear photos of paperwork.", recommendedKinds: ["DOCUMENT", "PHOTO"], builtIn: true, intakeModes: [] },
  { slug: "insurance-claim", label: "Insurance claim evidence", description: "Damage photos, repair quotes, receipts, and supporting paperwork.", recommendedKinds: ["PHOTO", "VIDEO", "DOCUMENT"], builtIn: true, intakeModes: [] },
  { slug: "legal-matter", label: "Legal document collection", description: "Contracts, signed forms, sworn statements, and other case documents.", recommendedKinds: ["DOCUMENT", "PHOTO"], builtIn: true, intakeModes: [] },
  { slug: "property-damage", label: "Property damage", description: "Scene overview, close-up damage shots, and any repair estimates.", recommendedKinds: ["PHOTO", "VIDEO", "DOCUMENT"], builtIn: true, intakeModes: [] },
  { slug: "incident-investigation", label: "Incident investigation", description: "Photos of the scene, witness statements, and supporting context.", recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"], builtIn: true, intakeModes: [] },
  { slug: "compliance-audit", label: "Compliance / audit submission", description: "Policies, procedures, training records, and audit-trail documents.", recommendedKinds: ["DOCUMENT"], builtIn: true, intakeModes: [] },
  { slug: "journalism-field-capture", label: "Source / witness submission", description: "Anonymous or display-name submissions from sources or witnesses.", recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"], builtIn: true, intakeModes: [] },
];

export const WORKFLOW_TEMPLATES_PATH_BASE = "/v1/workflow/templates";
export function buildWorkflowTemplatesPath(teamId: string): string {
  return `/v1/workflow/templates?teamId=${encodeURIComponent(teamId)}`;
}

/**
 * The purpose list: built-ins, then workspace templates whose slug is not
 * built-in (steps.tsx:142-146). A template that shares a built-in slug
 * contributes its declared modes to that built-in.
 */
export function parsePurposes(templatesResponse: unknown): IntakePurpose[] {
  const templates = (Array.isArray(obj(templatesResponse)["templates"]) ? (obj(templatesResponse)["templates"] as unknown[]) : []).map(obj);
  const modesFor = (slug: string) => {
    const t = templates.find((x) => x["slug"] === slug);
    return Array.isArray(t?.["intakeModes"]) ? (t!["intakeModes"] as unknown[]).filter((m): m is string => typeof m === "string") : [];
  };
  const builtIns = BUILT_IN_PURPOSES.map((p) => ({ ...p, intakeModes: modesFor(p.slug) }));
  const extra: IntakePurpose[] = [];
  for (const t of templates) {
    const slug = str(t["slug"]);
    if (!slug || BUILT_IN_PURPOSES.some((b) => b.slug === slug)) continue;
    extra.push({
      slug,
      label: str(t["name"]) ?? slug,
      description: str(t["description"]) ?? "A workspace template. Its collection rules follow the settings below.",
      recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
      builtIn: false,
      intakeModes: modesFor(slug),
    });
  }
  return [...builtIns, ...extra];
}

/* ------------------------------------------------------------ modes (VOC:451-474) */

export type IntakeMode = "EXTERNAL_ONE_TIME" | "EXTERNAL_REUSABLE" | "EXTERNAL_ANONYMOUS" | "EXTERNAL_PSEUDONYMOUS";
export const INTAKE_MODES: ReadonlyArray<{ value: IntakeMode; title: string; description: string }> = [
  { value: "EXTERNAL_ONE_TIME", title: "One-time link", description: "One submission. The contributor may add a name or email, but is not asked for one." },
  { value: "EXTERNAL_REUSABLE", title: "Reusable link", description: "Several people can submit through the same link. Each may add a name or email." },
  { value: "EXTERNAL_ANONYMOUS", title: "Anonymous link", description: "One submission, and no contributor identity is requested or stored." },
  { value: "EXTERNAL_PSEUDONYMOUS", title: "Display-name link", description: "One submission. The contributor chooses a display name shown with it." },
];
export function modeEligible(purpose: IntakePurpose | undefined, mode: IntakeMode): boolean {
  return !purpose || purpose.intakeModes.length === 0 || purpose.intakeModes.includes(mode);
}

/* ------------------------------------------------------------ delivery (CAT:187-215) */

export type Channel = "SMS" | "EMAIL" | "MANUAL";
export const CHANNELS: ReadonlyArray<{ value: Channel; title: string; description: string }> = [
  { value: "SMS", title: "SMS", description: "PROOVRA texts the secure upload link to a mobile number." },
  { value: "EMAIL", title: "Email", description: "PROOVRA sends a secure request email." },
  { value: "MANUAL", title: "Copy link", description: "Create the link and share it yourself. Nothing is sent." },
];
export const CHANNEL_LABEL: Readonly<Record<Channel, string>> = { EMAIL: "Email", SMS: "SMS", MANUAL: "Copy link" };

export interface SenderIdentity {
  readonly email: { configured: boolean; fromName: string | null; fromAddressPreview: string | null };
  readonly sms: { configured: boolean; fromNumberPreview: string | null };
}
export function buildSenderIdentityPath(teamId: string): string {
  return `/v1/workflow/intake-links/sender-identity?teamId=${encodeURIComponent(teamId)}`;
}
export function parseSenderIdentity(v: unknown): SenderIdentity {
  const d = obj(v);
  const e = obj(d["email"]);
  const s = obj(d["sms"]);
  return {
    email: { configured: e["configured"] === true, fromName: str(e["fromName"]), fromAddressPreview: str(e["fromAddressPreview"]) },
    sms: { configured: s["configured"] === true, fromNumberPreview: str(s["fromNumberPreview"]) },
  };
}
/** Default channel (CreateLinkWizard.tsx:152-162): SMS if configured, else EMAIL, else MANUAL. */
export function defaultChannel(t: SenderIdentity | null): Channel {
  if (!t) return "SMS";
  if (t.sms.configured) return "SMS";
  if (t.email.configured) return "EMAIL";
  return "MANUAL";
}
export function channelConfigured(t: SenderIdentity | null, c: Channel): boolean {
  if (c === "MANUAL" || !t) return true;
  return c === "SMS" ? t.sms.configured : t.email.configured;
}

export type SenderMode = "PROOVRA" | "WORKSPACE" | "CUSTOM";

/* ------------------------------------------------------------ rules (CAT:260-339) */

export const EXPIRY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "24", label: "24 hours" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "custom", label: "Custom…" },
];
export const EXPIRY_MIN_HOURS = 1;
export const EXPIRY_MAX_HOURS = 24 * 365;

/** The web overrides REQUIRED's description (steps.tsx). */
export const LOCATION_OPTIONS = INTAKE_LINK_LOCATION_POLICY_OPTIONS.map((o) =>
  o.value === "REQUIRED"
    ? {
        ...o,
        description:
          "Contributors must share location before submitting. If their device cannot provide it, they can still submit and the submission records that location was unavailable.",
      }
    : o,
);

/* ------------------------------------------------------------ state + validation */

export interface WizardState {
  purposeSlug: string;
  intakeMode: IntakeMode;
  channel: Channel;
  recipientLabel: string;
  customerId: string;
  recipientEmail: string;
  recipientPhone: string;
  senderMode: SenderMode;
  senderName: string;
  locationPolicy: IntakeLinkLocationPolicy;
  expiryChoice: string;
  expiresInHours: string;
  maxFiles: string;
  acceptedKinds: AcceptedKind[];
  consentText: string;
}

export function initialWizardState(opts: { workspaceName: string | null; channel: Channel; initialSlug?: string | null }): WizardState {
  const slug = BUILT_IN_PURPOSES.some((p) => p.slug === opts.initialSlug) ? opts.initialSlug! : "general-evidence-record";
  const purpose = BUILT_IN_PURPOSES.find((p) => p.slug === slug)!;
  return {
    purposeSlug: slug,
    intakeMode: "EXTERNAL_ONE_TIME",
    channel: opts.channel,
    recipientLabel: "",
    customerId: "",
    recipientEmail: "",
    recipientPhone: "",
    senderMode: opts.workspaceName ? "WORKSPACE" : "PROOVRA",
    senderName: "",
    locationPolicy: "OPTIONAL",
    expiryChoice: "72",
    expiresInHours: "72",
    maxFiles: "10",
    acceptedKinds: [...purpose.recommendedKinds],
    consentText: "",
  };
}

export const STEPS = ["request", "delivery", "rules", "review"] as const;
export type StepId = (typeof STEPS)[number];
export const STEP_LABEL: Readonly<Record<StepId, string>> = {
  request: "Request",
  delivery: "Delivery",
  rules: "Collection rules",
  review: "Review",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** `validateE164` (apps/web/lib/phone/e164.ts), same three outcomes. */
export function validateE164(input: string): { ok: true; canonical: string } | { ok: false; reason: "empty" | "missing_plus" | "invalid_length" } {
  const t = input.trim();
  if (t.length === 0) return { ok: false, reason: "empty" };
  if (!t.startsWith("+")) return { ok: false, reason: "missing_plus" };
  const canonical = `+${t.slice(1).replace(/\D+/g, "")}`;
  return E164_RE.test(canonical) ? { ok: true, canonical } : { ok: false, reason: "invalid_length" };
}

const SENDER_NAME_ERRORS: Readonly<Record<string, string>> = {
  empty: "Enter a display name.",
  too_long: "Keep the name under 80 characters.",
  contains_url: "Display names can't contain web addresses.",
  contains_email: "Display names can't contain email addresses.",
  contains_phone: "Display names can't contain phone numbers.",
  contains_control_chars: "Display names can't contain invisible or directional characters.",
  impersonation: "Display names can't impersonate courts, police, government, or banks.",
  reserved_brand: "PROOVRA is reserved — pick a different name. It's added automatically.",
};

export type WizardErrors = Partial<Record<keyof WizardState, string>>;

/** `validateStep` (WS:205-290), step by step. */
export function validateStep(step: StepId, s: WizardState, purposes: readonly IntakePurpose[], transport: SenderIdentity | null): WizardErrors {
  const e: WizardErrors = {};
  const purpose = purposes.find((p) => p.slug === s.purposeSlug);
  if (step === "request") {
    if (!s.purposeSlug) e.purposeSlug = "Choose what you're asking for.";
    if (!modeEligible(purpose, s.intakeMode)) e.intakeMode = "This request type doesn't support that link type. Pick another.";
  }
  if (step === "delivery") {
    if (!channelConfigured(transport, s.channel)) e.channel = "This deployment can't send on that channel yet. Choose another, or copy the link and share it yourself.";
    if (s.channel === "EMAIL") {
      if (!s.recipientEmail.trim()) e.recipientEmail = "Enter the recipient's email address.";
      else if (!EMAIL_RE.test(s.recipientEmail.trim())) e.recipientEmail = "That doesn't look like an email address.";
    } else if (s.recipientEmail.trim() && !EMAIL_RE.test(s.recipientEmail.trim())) {
      e.recipientEmail = "Remove the address, or correct it — it isn't a valid email.";
    }
    if (s.channel === "SMS") {
      const v = validateE164(s.recipientPhone);
      if (!v.ok) {
        e.recipientPhone =
          v.reason === "empty"
            ? "Enter the recipient's phone number in international format."
            : v.reason === "missing_plus"
              ? "Include the country code, for example +14155550123."
              : "That doesn't look like a valid international number.";
      }
    } else if (s.recipientPhone.trim() && !validateE164(s.recipientPhone).ok) {
      e.recipientPhone = "Remove the number, or write it in international format like +14155550123.";
    }
    if (s.senderMode === "CUSTOM") {
      const v = validateCustomSenderDisplayName(s.senderName);
      if (!v.ok) e.senderName = SENDER_NAME_ERRORS[v.reason] ?? "That display name isn't allowed.";
    }
  }
  if (step === "rules") {
    const hours = Number(s.expiresInHours);
    if (!Number.isFinite(hours) || hours < EXPIRY_MIN_HOURS || hours > EXPIRY_MAX_HOURS) e.expiresInHours = "Choose between 1 and 8760 hours.";
    if (s.maxFiles.trim()) {
      const n = Number(s.maxFiles);
      if (!Number.isInteger(n) || n < 1 || n > 500) e.maxFiles = "Choose between 1 and 500 files.";
    }
    if (s.acceptedKinds.length === 0) e.acceptedKinds = "Allow at least one type of file.";
    if (s.consentText.length > 4000) e.consentText = "Keep the disclosure under 4000 characters.";
  }
  return e;
}

export function firstInvalidStep(s: WizardState, purposes: readonly IntakePurpose[], transport: SenderIdentity | null): StepId | null {
  for (const step of STEPS) if (Object.keys(validateStep(step, s, purposes, transport)).length > 0) return step;
  return null;
}

/* ------------------------------------------------------------ request */

export const CREATE_INTAKE_LINK_PATH = "/v1/workflow/intake-links";

/** The public web origin the link lives on (`EXPO_PUBLIC_WEB_BASE`, set in every eas.json profile). */
export function webOrigin(): string | null {
  const v = process.env.EXPO_PUBLIC_WEB_BASE;
  return typeof v === "string" && /^https?:\/\//.test(v) ? v.replace(/\/+$/, "") : null;
}
export function intakeUrlFor(origin: string, rawToken: string): string {
  return `${origin}/intake/${encodeURIComponent(rawToken)}`;
}

export function expiresAtFor(hours: number, nowMs: number = Date.now()): string {
  const h = Math.min(EXPIRY_MAX_HOURS, Math.max(EXPIRY_MIN_HOURS, hours));
  return new Date(nowMs + h * 3_600_000).toISOString();
}

/** `buildCreateBody` (WS:354-389). */
export function buildCreateBody(
  s: WizardState,
  ctx: { teamId: string; origin: string | null; idempotencyKey: string; nowMs?: number },
) {
  const phone = validateE164(s.recipientPhone);
  return {
    teamId: ctx.teamId,
    workflowTemplateSlug: s.purposeSlug,
    intakeMode: s.intakeMode,
    deliveryMethod: s.channel,
    ...(s.channel === "MANUAL" || !ctx.origin ? {} : { intakeUrlBase: ctx.origin }),
    recipientLabel: s.recipientLabel.trim() || null,
    customerId: s.customerId.trim() || null,
    recipientEmail: s.recipientEmail.trim() || null,
    recipientPhone: phone.ok ? phone.canonical : null,
    maxUses: s.intakeMode === "EXTERNAL_REUSABLE" ? 1000 : 1,
    maxFileCountPerSession: s.maxFiles.trim() ? Number(s.maxFiles) : null,
    allowedAcceptedKinds: ACCEPTED_KINDS.map((k) => k.value).filter((k) => s.acceptedKinds.includes(k)),
    consentDisclosureText: s.consentText.trim() || null,
    expiresAtUtc: expiresAtFor(Number(s.expiresInHours), ctx.nowMs),
    idempotencyKey: ctx.idempotencyKey,
    senderDisplayMode: s.senderMode,
    senderDisplayName: s.senderMode === "CUSTOM" ? s.senderName.trim() : null,
    // The server default is NONE while the UI default is OPTIONAL, so the
    // choice is always sent (spec §B.4).
    locationPolicy: s.locationPolicy,
  };
}

export interface CreatedIntakeLink {
  readonly linkId: string;
  readonly rawToken: string;
  readonly hasRecipientEmail: boolean;
  readonly hasRecipientPhone: boolean;
  readonly delivery: { method: string; status: "sent" | "failed" | "skipped"; reason: string | null };
}

export function parseCreatedIntakeLink(v: unknown): CreatedIntakeLink | null {
  const d = obj(v);
  const link = obj(d["link"]);
  const id = str(link["id"]);
  const raw = str(d["rawToken"]);
  if (!id || !raw) return null;
  const del = obj(d["delivery"]);
  const status = del["status"] === "sent" || del["status"] === "failed" ? (del["status"] as "sent" | "failed") : "skipped";
  return {
    linkId: id,
    rawToken: raw,
    hasRecipientEmail: link["hasRecipientEmail"] === true,
    hasRecipientPhone: link["hasRecipientPhone"] === true,
    delivery: { method: str(del["method"]) ?? "MANUAL", status, reason: str(del["reason"]) },
  };
}

/* ------------------------------------------------------------ copy */

/**
 * `friendlyCreateError` (WS:399-422). Includes the policy code the WEB fails
 * to match — its map key is `intake_disabled_by_policy` while the API sends
 * `external_intake_disabled_by_policy`, so the web shows "HTTP 403: API error".
 */
export function friendlyCreateError(code: string | null, message: string | null): string {
  switch (code) {
    case "FEATURE_DISABLED":
    case "feature_disabled":
      return "External intake isn't enabled on this deployment.";
    case "INTAKE_NOT_INCLUDED":
      return "Your current plan doesn't include external intake links.";
    case "rate_limited":
      return "Too many intake links — wait a minute and try again.";
    case "external_intake_disabled_by_policy":
    case "intake_disabled_by_policy":
      return "Your workspace policy doesn't allow this kind of intake link.";
    case "anonymous_intake_disabled_by_policy":
      return "Your workspace policy doesn't allow anonymous intake links.";
    case "template_not_found":
      return "That request type isn't available for this workspace.";
    case "intake_mode_not_supported_by_template":
      return "This request type doesn't support the selected link type. Pick another.";
    case "max_uses_invalid":
      return "Pick a usage limit between 1 and 10,000.";
    default:
      return message && !/^HTTP \d+/.test(message) ? message : "Couldn't create the intake link.";
  }
}

/** WS:439-458 */
export function friendlyDeliveryReason(reason: string | null): string | null {
  const map: Record<string, string> = {
    link_missing_email: "no recipient email on the link",
    link_missing_phone: "no recipient phone on the link",
    link_revoked: "this link has been disabled",
    link_expired: "this link has already expired",
    provider_unconfigured: "messaging isn't configured on this deployment",
    delivery_failed: "the message provider rejected the send",
    delivery_failed_or_skipped: "the message provider rejected or skipped the send",
  };
  return reason ? (map[reason] ?? reason) : null;
}

/** LinkCreatedDialog.tsx:99-111 */
export function friendlySendError(code: string | null): string | null {
  const map: Record<string, string> = {
    link_missing_phone: "Add a recipient phone number to the link before sending.",
    link_missing_email: "Add a recipient email address to the link before sending.",
    link_revoked: "This link has been disabled.",
    link_expired: "This link has already expired.",
    provider_unconfigured: "Messaging isn't configured on this deployment. Copy the link instead.",
    rate_limited: "Too many resend attempts — wait a minute.",
    max_attempts_exceeded: "Too many resend attempts — wait a minute.",
  };
  return code ? (map[code] ?? null) : null;
}

export const CREATE_COPY = {
  title: "New intake link",
  purposeField: "What are you asking for?",
  modeField: "How should the link work?",
  modeHelp: "Reuse and contributor identity are one setting in PROOVRA — each option below states both.",
  modeIneligible: "This request type doesn't support this link type.",
  channelField: "How should the link reach them?",
  channelHelp: "Only the channel you pick is used. PROOVRA never sends on two channels at once.",
  channelUnconfigured: "Not configured on this deployment.",
  recipientLabel: "Recipient label",
  recipientLabelHelp: "Optional. Only you see this — for example “John Smith — claim 4842”.",
  customerId: "Customer ID (optional)",
  customerIdHelp: "Your organization's identifier for this customer.",
  recipientEmail: "Recipient email",
  recipientPhone: "Recipient phone",
  recipientPhoneHelp: "International format with country code, for example +14155550123.",
  manualNote:
    "Nothing is sent for a copy-link request. You'll get the secure link once, right after it is created, to share however you want.",
  senderField: "Request appears from",
  senderHelp: "“via PROOVRA” is always appended so the recipient can verify who sent it.",
  senderName: "Display name",
  senderNameHelp: "Shown in the request before “via PROOVRA”.",
  locationField: "Location collection",
  locationHelp:
    "Location comes from the contributor's own browser, only after they tap Share. It is stored on the submitted evidence and labelled “Contributor browser permission” — it records what their device reported, not proof of where they were.",
  expiryField: "Link expires in",
  customHours: "Expires in (hours)",
  customHoursHelp: "Between 1 and 8760 hours.",
  maxFiles: "Maximum files per submission",
  maxFilesHelp: "Between 1 and 500. Leave blank for no per-submission cap.",
  kindsField: "Accepted file types",
  kindsHelp: "Contributors can only upload the types you allow.",
  consentField: "Consent or disclosure text",
  consentHelp: "Optional. Shown to the contributor before they upload.",
  reviewManual: "No message is sent for a copy-link request. The secure link is shown once, immediately after you create it.",
  discardTitle: "Discard this intake link?",
  discardBody: "You've entered details that haven't been used yet. Closing now discards them — nothing has been created or sent.",
  noOrigin:
    "This build has no public web address configured (EXPO_PUBLIC_WEB_BASE), so a link cannot be addressed. Nothing was created.",
  createdTitle: "Secure link created",
  createdSubtitle:
    "This link is shown once. Copy or send it now — after you close this dialog the only way to share it is to create a new link.",
  createdLinkHelp: "Anyone with this link can upload until it expires. Ask the recipient not to forward it.",
  createdSkipped: "Nothing was sent — you chose to share this link yourself.",
} as const;

export function createdSentLine(method: string): string {
  const label = CHANNEL_LABEL[method as Channel] ?? method;
  return `Handed to the provider via ${label}. Track it under Delivery history on the link.`;
}
export function createdFailedLine(method: string, reason: string | null): string {
  const label = CHANNEL_LABEL[method as Channel] ?? method;
  const why = friendlyDeliveryReason(reason);
  return `Delivery failed on ${label}${why ? ` — ${why}` : ""}. The link itself was created: copy it below, or retry from Delivery history.`;
}

/** Suggested kinds note (steps.tsx:187-201), built-ins only. */
export function suggestedKindsNote(p: IntakePurpose): string | null {
  if (!p.builtIn) return null;
  const labels = ACCEPTED_KINDS.filter((k) => p.recommendedKinds.includes(k.value)).map((k) => k.label);
  return `Suggested file types: ${labels.join(", ")}. You can change them in step 3.`;
}
