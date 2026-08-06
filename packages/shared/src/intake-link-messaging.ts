/**
 * Intake-link enterprise messaging — shared between API (real send) and
 * web (preview studio).
 *
 * This module is the SINGLE source of truth for:
 *   - intake-link message bodies (email + SMS + WhatsApp)
 *   - sender identity resolution + validation
 *   - the secure preview sanitizer that redacts raw intake tokens
 *     before any non-provider persistence (DB row, audit metadata,
 *     logs, Sentry context)
 *   - per-request-type copy
 *
 * Why one module: the audit demanded "no duplicate independent
 * templates in frontend and backend". The web preview imports the
 * same renderer the API send path uses, so what the operator sees in
 * the modal is what the recipient gets.
 *
 * SECURITY CONTRACT — `sanitizeIntakeMessagePreview` is the hard line
 * separating "what the provider sends" from "what we persist for
 * support / audit / DB introspection". The raw token MUST NEVER land
 * in a sanitized preview. Real provider payloads continue to receive
 * the unredacted URL.
 */

// =============================================================================
// Brand + product copy
// =============================================================================

/** The PROOVRA wordmark used in every channel. Centralised so a future
 *  brand refresh changes one constant. */
export const INTAKE_BRAND_NAME = "PROOVRA";

/** Placeholder substituted by the sanitizer for redacted tokens / URLs.
 *  Stable across logs + DB rows so support can grep on it. */
export const SANITIZED_INTAKE_TOKEN_PLACEHOLDER = "[secure-link]";

/** A tighter placeholder for token-shaped strings that aren't full URLs
 *  (e.g. stray query-string remnants). */
export const SANITIZED_TOKEN_ONLY_PLACEHOLDER = "[secure-token]";

/** Max chars for the preview row stored in CommunicationMessage.body_preview
 *  (VarChar(400)). Caller may further trim. */
export const SANITIZED_PREVIEW_MAX_CHARS = 400;

/** Per-channel max — SMS stays within a 2-segment GSM-7 envelope; the
 *  WhatsApp limit is far higher but we keep it tight by default. */
export const INTAKE_SMS_MAX_CHARS = 280;
export const INTAKE_WHATSAPP_MAX_CHARS = 1024;

// =============================================================================
// Sanitizer — raw-token redaction
// =============================================================================

// Matches: `/intake/<token>` path segment where <token> is a substantial
// opaque string (so we don't accidentally redact `/intake/help`). We
// allow URL-safe base64 + hex + dash characters; anything 12+ chars
// after `/intake/` is treated as a token candidate.
const INTAKE_PATH_TOKEN_REGEX = /\/intake\/[A-Za-z0-9._\-=+/%]{12,}/g;

// Matches: a full URL whose path contains `/intake/<token>`. We rewrite
// the path component only; protocol + host stay so support staff can
// see WHICH origin issued the link.
const INTAKE_FULL_URL_REGEX =
  /(https?:\/\/[^\s<>"']+\/intake\/)[A-Za-z0-9._\-=+/%]{12,}([?#][^\s<>"']*)?/g;

// Standalone token-shaped string (e.g. `?token=...` query param value or
// a raw token pasted by accident into a label). 24+ chars of URL-safe
// base64/hex/dash characters with no path / hostname / whitespace
// surrounding them — conservative so we don't over-redact legitimate
// IDs. UUIDs (8-4-4-4-12 with dashes) are 36 chars and would be
// redacted; that's acceptable because intake-link previews don't carry
// raw UUIDs the operator needs.
const STANDALONE_TOKEN_REGEX = /\b[A-Za-z0-9_\-=]{24,}\b/g;

// Query-string parameters whose names typically carry secret material.
// We replace the value but keep the key so the shape of the URL is
// preserved for log readability.
const SECRET_QUERY_PARAM_REGEX =
  /([?&](?:token|key|secret|auth|sig|signature|hash|password)=)[^&\s]+/gi;

/**
 * Redact raw intake-link tokens (and adjacent secret-shaped query
 * parameters) from a string. Idempotent — calling twice does not
 * mangle a previously-sanitized string further.
 *
 * The function is intentionally OVER-eager: when in doubt, redact.
 * The preview row exists for support legibility, not data recovery.
 */
export function sanitizeIntakeMessagePreview(
  input: string | null | undefined,
): string {
  if (input === null || input === undefined || input === "") return "";

  let out = String(input);

  // 1) Full URLs first — most specific match wins so the `https://...`
  //    head + the trailing query stay intact.
  out = out.replace(
    INTAKE_FULL_URL_REGEX,
    (_match, head: string, tail: string | undefined) =>
      `${head}${SANITIZED_INTAKE_TOKEN_PLACEHOLDER}${tail ?? ""}`,
  );

  // 2) Bare paths (any `/intake/<token>` not preceded by a host).
  out = out.replace(
    INTAKE_PATH_TOKEN_REGEX,
    `/intake/${SANITIZED_INTAKE_TOKEN_PLACEHOLDER}`,
  );

  // 3) Secret-looking query params (token=, key=, sig= …).
  out = out.replace(SECRET_QUERY_PARAM_REGEX, `$1${SANITIZED_TOKEN_ONLY_PLACEHOLDER}`);

  // 4) Standalone token-shaped strings — only apply when the rest of
  //    the line has at least one safe word so we don't reduce a string
  //    that IS nothing but a token to just `[secure-token]` (that's
  //    intentional and desirable, but the regex must run last so URLs
  //    don't get hit again).
  out = out.replace(STANDALONE_TOKEN_REGEX, (match) => {
    // Skip our own placeholders so we stay idempotent.
    if (
      match === SANITIZED_INTAKE_TOKEN_PLACEHOLDER.replace(/[[\]]/g, "") ||
      match === SANITIZED_TOKEN_ONLY_PLACEHOLDER.replace(/[[\]]/g, "")
    ) {
      return match;
    }
    return SANITIZED_TOKEN_ONLY_PLACEHOLDER;
  });

  // 5) Cap length.
  if (out.length > SANITIZED_PREVIEW_MAX_CHARS) {
    out = out.slice(0, SANITIZED_PREVIEW_MAX_CHARS - 1) + "…";
  }
  return out;
}

// =============================================================================
// Sender identity
// =============================================================================

export const INTAKE_SENDER_DISPLAY_MODES = [
  "PROOVRA",
  "WORKSPACE",
  "CUSTOM",
] as const;
export type IntakeSenderDisplayMode =
  (typeof INTAKE_SENDER_DISPLAY_MODES)[number];

/** Result of `resolveIntakeSenderDisplay` — the final string to embed
 *  in the message (always carries "via PROOVRA" except for the pure
 *  PROOVRA mode which IS the brand). */
export type IntakeSenderIdentity = {
  mode: IntakeSenderDisplayMode;
  /** What the recipient reads in the message body, e.g.
   *  "Acme Insurance via PROOVRA" or "PROOVRA secure intake". */
  display: string;
};

export type ResolveSenderInput = {
  mode: IntakeSenderDisplayMode;
  /** Workspace / team display name. Required when mode === "WORKSPACE";
   *  ignored otherwise. */
  workspaceName?: string | null;
  /** Operator-supplied display name. Required when mode === "CUSTOM";
   *  ignored otherwise. Must already be validated via
   *  `validateCustomSenderDisplayName` — `resolveIntakeSenderDisplay`
   *  will THROW on an invalid custom name. */
  customName?: string | null;
};

/**
 * Resolve the verbatim "Appears from" string for a message. Always
 * includes "via PROOVRA" except for the canonical PROOVRA mode (which
 * already carries the brand). The brand cannot be removed by any
 * caller.
 */
export function resolveIntakeSenderDisplay(
  input: ResolveSenderInput,
): IntakeSenderIdentity {
  if (input.mode === "PROOVRA") {
    return {
      mode: "PROOVRA",
      display: `${INTAKE_BRAND_NAME} secure intake`,
    };
  }
  if (input.mode === "WORKSPACE") {
    const rawName = (input.workspaceName ?? "").trim();
    // P0 audit-fix — personal-workspace names embarrass the recipient.
    // The product surfaces names like "Jalal Attar's personal workspace"
    // as the default for Personal-plan users; that wording looks
    // unprofessional in an SMS or email going to a client/witness.
    // Map every personal-workspace pattern to either the brand or the
    // simple "Personal Space via PROOVRA" form, so the message never
    // leads with a personal name unless the operator explicitly chose
    // CUSTOM. Pattern detection is intentionally narrow — we only
    // collapse strings that literally end in "personal workspace" or
    // "personal space" (case-insensitive). Real business names like
    // "Personal Defenders Ltd" are unaffected.
    const lowered = rawName.toLowerCase();
    const isPersonalSpace =
      lowered === "personal space" ||
      lowered === "personal workspace" ||
      lowered.endsWith("'s personal workspace") ||
      lowered.endsWith("'s personal space") ||
      lowered.endsWith("’s personal workspace") || // curly apostrophe
      lowered.endsWith("’s personal space");
    const name = isPersonalSpace ? "Personal Space" : rawName;

    if (name.length === 0) {
      // Fall back to PROOVRA when the workspace has no usable name —
      // safer than emitting "via PROOVRA" with a blank prefix.
      return {
        mode: "PROOVRA",
        display: `${INTAKE_BRAND_NAME} secure intake`,
      };
    }
    return {
      mode: "WORKSPACE",
      display: `${name.slice(0, 80)} via ${INTAKE_BRAND_NAME}`,
    };
  }
  // CUSTOM
  const validation = validateCustomSenderDisplayName(input.customName ?? "");
  if (!validation.ok) {
    throw new Error(
      `Invalid custom sender display name: ${validation.reason}`,
    );
  }
  return {
    mode: "CUSTOM",
    display: `${validation.value} via ${INTAKE_BRAND_NAME}`,
  };
}

/**
 * Pick the right default sender mode for a workspace. When the
 * workspace has a usable name, default to WORKSPACE; otherwise fall
 * back to the bare PROOVRA brand. The brief is explicit: the personal
 * user name MUST NOT be used as default.
 */
export function defaultIntakeSenderMode(input: {
  workspaceName?: string | null;
}): IntakeSenderDisplayMode {
  if ((input.workspaceName ?? "").trim().length > 0) return "WORKSPACE";
  return "PROOVRA";
}

// -----------------------------------------------------------------------------
// Custom-name validation
// -----------------------------------------------------------------------------

const FORBIDDEN_IMPERSONATION_TOKENS = [
  "court",
  "police",
  "government",
  "bank",
  "irs",
  "fbi",
  "interpol",
  "ministry",
  "sheriff",
  "attorney general",
  "tax office",
  "customs",
  "immigration",
];

const URL_LIKE_REGEX = /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/i;
const EMAIL_LIKE_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_LIKE_REGEX = /(?:\+?\d[\d\s\-().]{6,})/;
// Control characters incl. zero-width + bidi overrides — anything that
// could let an attacker craft a name that LOOKS like the brand but
// renders something different. All literals are unicode-escaped so the
// TS parser does not stumble on the actual control characters.
/**
 * Control, C1, zero-width, bidi-override and BOM code points — anything that
 * could let an attacker craft a name that LOOKS like the brand but renders
 * differently. Declared as explicit inclusive ranges instead of a regex
 * character class, so the set is readable and needs no lint suppression.
 */
const CONTROL_OR_BIDI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width space .. right-to-left mark
  [0x202a, 0x202e], // bidi embedding / override
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
];

function hasControlOrBidiCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    for (const [lo, hi] of CONTROL_OR_BIDI_RANGES) {
      if (code >= lo && code <= hi) return true;
    }
  }
  return false;
}

export type CustomSenderValidation =
  | { ok: true; value: string }
  | {
      ok: false;
      reason:
        | "empty"
        | "too_long"
        | "contains_url"
        | "contains_email"
        | "contains_phone"
        | "contains_control_chars"
        | "impersonation"
        | "reserved_brand";
    };

/**
 * Validate a user-supplied custom sender display name. The "via
 * PROOVRA" suffix is added by the resolver, so callers pass JUST the
 * custom portion (e.g. "Acme Insurance", not "Acme Insurance via
 * PROOVRA").
 */
export function validateCustomSenderDisplayName(
  raw: string,
): CustomSenderValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > 80) return { ok: false, reason: "too_long" };
  if (hasControlOrBidiCharacter(trimmed)) {
    return { ok: false, reason: "contains_control_chars" };
  }
  // Check email BEFORE URL — the URL regex matches bare domain
  // strings (e.g. "acme.io"), so an email like "info@acme.io" would
  // otherwise be reported as a URL. Email is the more specific case
  // and the more useful reason for the operator to see in the UI.
  if (EMAIL_LIKE_REGEX.test(trimmed)) {
    return { ok: false, reason: "contains_email" };
  }
  if (URL_LIKE_REGEX.test(trimmed)) {
    return { ok: false, reason: "contains_url" };
  }
  if (PHONE_LIKE_REGEX.test(trimmed)) {
    return { ok: false, reason: "contains_phone" };
  }
  const lower = trimmed.toLowerCase();
  for (const tok of FORBIDDEN_IMPERSONATION_TOKENS) {
    if (lower.includes(tok)) {
      return { ok: false, reason: "impersonation" };
    }
  }
  // The brand itself cannot be impersonated as a custom name. A user
  // writing "PROOVRA" would render "PROOVRA via PROOVRA" — confusing
  // at best, deceptive at worst.
  if (lower === INTAKE_BRAND_NAME.toLowerCase()) {
    return { ok: false, reason: "reserved_brand" };
  }
  return { ok: true, value: trimmed };
}

// =============================================================================
// Per-request-type copy
// =============================================================================

/** Short phrase plugged into the message body's "Request:" line and
 *  the email subject suffix. */
export function intakeRequestTypeLabel(slug: string | null | undefined): string {
  switch (slug) {
    case "general-evidence-record":
      return "Files were requested from you.";
    case "photos-videos":
      return "Photos and videos were requested.";
    case "documents":
      return "Documents were requested.";
    case "insurance-claim":
      return "Evidence for a claim was requested.";
    case "legal-matter":
      return "Documents for a legal matter were requested.";
    case "property-damage":
      return "Property damage evidence was requested.";
    case "incident-investigation":
      return "Evidence for an incident investigation was requested.";
    case "compliance-audit":
      return "Documents for a compliance review were requested.";
    case "journalism-field-capture":
      return "Files for a secure media submission were requested.";
    default:
      return "Files were requested from you.";
  }
}

/** Short, capitalised noun phrase suitable for email subject /
 *  preview headings, e.g. "Property damage evidence". Distinct from
 *  the sentence variant above. */
export function intakeRequestTypeNounLabel(
  slug: string | null | undefined,
): string {
  switch (slug) {
    case "general-evidence-record":
      return "General evidence request";
    case "photos-videos":
      return "Photos and videos";
    case "documents":
      return "Documents";
    case "insurance-claim":
      return "Insurance claim evidence";
    case "legal-matter":
      return "Legal document collection";
    case "property-damage":
      return "Property damage evidence";
    case "incident-investigation":
      return "Incident investigation";
    case "compliance-audit":
      return "Compliance / audit submission";
    case "journalism-field-capture":
      return "Source / witness submission";
    default:
      return "Evidence request";
  }
}

// =============================================================================
// Template renderers — Email + SMS + WhatsApp
// =============================================================================

export type IntakeMessageRenderInput = {
  senderDisplay: string;
  /** The request-type slug — drives the "what is being requested"
   *  copy and the subject suffix. */
  requestTypeSlug: string | null;
  /** Operator's reference (e.g. "Claim 4821"). Optional. Never used
   *  as the requester identity — only as a Reference line. */
  recipientLabel: string | null;
  /** Real intake URL the recipient will open. The renderer NEVER
   *  modifies this; callers wanting a redacted preview must call
   *  `sanitizeIntakeMessagePreview` on the rendered output. */
  intakeUrl: string;
  /** ISO timestamp; renderer formats as both an absolute date and a
   *  short relative phrase. */
  expiresAtUtc: string;
  /** Channel discriminator — drives small per-channel tweaks (e.g.
   *  WhatsApp uses `*bold*` markdown). */
  channel: "EMAIL" | "SMS" | "WHATSAPP";
  /** Locale — currently ONLY "en" is supported; the parameter is here
   *  so a future i18n layer can hang off the same signature without
   *  another breaking change. */
  locale?: "en";
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

/** Mandatory trust footer used across all channels. Centralised so a
 *  copy update lands once. */
export const INTAKE_DO_NOT_FORWARD_LINE = "Please do not forward this link.";
export const INTAKE_UNEXPECTED_LINE =
  "If you were not expecting this request, you can ignore this message.";
export const INTAKE_NO_ACCOUNT_LINE = "No account is required.";
export const INTAKE_FOOTER_LINE = `Sent securely via ${INTAKE_BRAND_NAME}.`;

function formatAbsoluteExpiry(iso: string): string {
  // YYYY-MM-DD HH:MM UTC — explicit timezone so the recipient knows
  // what they're reading regardless of their locale.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "expiration not set";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mn = pad(d.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mn} UTC`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function htmlAttrEscape(s: string): string {
  return htmlEscape(s).replace(/"/g, "&quot;");
}

// -----------------------------------------------------------------------------
// EMAIL
// -----------------------------------------------------------------------------

export function renderIntakeEmailMessage(
  input: IntakeMessageRenderInput,
): RenderedEmail {
  const noun = intakeRequestTypeNounLabel(input.requestTypeSlug);
  const askLine = intakeRequestTypeLabel(input.requestTypeSlug);
  const absoluteExpiry = formatAbsoluteExpiry(input.expiresAtUtc);

  const subject = input.requestTypeSlug
    ? `Secure evidence request: ${noun}`
    : `Secure evidence request via ${INTAKE_BRAND_NAME}`;

  const referenceLine = input.recipientLabel
    ? `Reference: ${input.recipientLabel}\n`
    : "";

  const text =
    `${INTAKE_BRAND_NAME} secure intake\n\n` +
    `${input.senderDisplay} is requesting files using ${INTAKE_BRAND_NAME}.\n\n` +
    `Request: ${noun}\n` +
    `${referenceLine}` +
    `${askLine}\n\n` +
    `Use the secure upload link below to submit the requested files.\n` +
    `${INTAKE_NO_ACCOUNT_LINE}\n\n` +
    `Upload securely:\n${input.intakeUrl}\n\n` +
    `This link expires on ${absoluteExpiry}.\n` +
    `${INTAKE_DO_NOT_FORWARD_LINE}\n\n` +
    `${INTAKE_UNEXPECTED_LINE}\n\n` +
    `${INTAKE_FOOTER_LINE}\n`;

  const referenceHtml = input.recipientLabel
    ? `<p style="margin:4px 0;color:#475569;font-size:14px"><strong>Reference:</strong> ${htmlEscape(input.recipientLabel)}</p>`
    : "";

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.5;max-width:560px">` +
    `<div style="font-size:12px;font-weight:700;letter-spacing:1px;color:#64748b;text-transform:uppercase;margin-bottom:16px">${INTAKE_BRAND_NAME} secure intake</div>` +
    `<p style="margin:0 0 12px;font-size:15px"><strong>${htmlEscape(input.senderDisplay)}</strong> is requesting files using ${INTAKE_BRAND_NAME}.</p>` +
    `<p style="margin:0 0 4px;color:#475569;font-size:14px"><strong>Request:</strong> ${htmlEscape(noun)}</p>` +
    referenceHtml +
    `<p style="margin:8px 0 16px;font-size:14px;color:#334155">${htmlEscape(askLine)}</p>` +
    `<p style="margin:0 0 8px;font-size:14px">Use the secure upload link below to submit the requested files. ${INTAKE_NO_ACCOUNT_LINE}</p>` +
    `<p style="margin:16px 0"><a href="${htmlAttrEscape(input.intakeUrl)}" style="display:inline-block;padding:12px 22px;background:#0f172a;color:#ffffff;font-weight:600;text-decoration:none;border-radius:8px">Upload files securely</a></p>` +
    `<p style="margin:0 0 16px;font-size:12px;color:#64748b;word-break:break-all">If the button doesn't work, paste this link into your browser:<br><span style="font-family:monospace">${htmlEscape(input.intakeUrl)}</span></p>` +
    `<p style="margin:0 0 4px;font-size:13px;color:#475569">This link expires on <strong>${absoluteExpiry}</strong>.</p>` +
    `<p style="margin:0 0 12px;font-size:13px;color:#475569">${INTAKE_DO_NOT_FORWARD_LINE}</p>` +
    `<p style="margin:16px 0 0;font-size:12px;color:#64748b">${INTAKE_UNEXPECTED_LINE}</p>` +
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">` +
    `<p style="margin:0;font-size:12px;color:#64748b">${INTAKE_FOOTER_LINE}</p>` +
    `</div>`;

  return { subject, text, html };
}

// -----------------------------------------------------------------------------
// SMS
// -----------------------------------------------------------------------------

function clipBody(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function renderIntakeSmsMessage(
  input: IntakeMessageRenderInput,
): string {
  const noun = intakeRequestTypeNounLabel(input.requestTypeSlug).toLowerCase();
  const senderShort = input.senderDisplay.slice(0, 60);
  const d = new Date(input.expiresAtUtc);
  const shortDate = Number.isNaN(d.getTime())
    ? ""
    : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const stopFooter = " Reply STOP to opt out.";

  // Long form first; trim down if it exceeds the segment cap.
  const long =
    `${INTAKE_BRAND_NAME} secure intake: ${senderShort} requested ${noun}. ` +
    `Upload: ${input.intakeUrl}. Expires ${shortDate}. ` +
    `${INTAKE_NO_ACCOUNT_LINE} ${INTAKE_DO_NOT_FORWARD_LINE}${stopFooter}`;

  if (long.length <= INTAKE_SMS_MAX_CHARS) return long;

  // Tighter fallback — drop the no-account + do-not-forward lines but
  // keep brand, sender, URL, expiry, STOP.
  const tight =
    `${INTAKE_BRAND_NAME}: secure file request from ${senderShort}. ` +
    `Upload: ${input.intakeUrl}. Expires ${shortDate}.${stopFooter}`;

  if (tight.length <= INTAKE_SMS_MAX_CHARS) return tight;

  // Last-resort hard clip — keep the URL above all else so the link
  // remains usable.
  return clipBody(
    `${INTAKE_BRAND_NAME}: secure file request. ${input.intakeUrl}.${stopFooter}`,
    INTAKE_SMS_MAX_CHARS,
  );
}

// -----------------------------------------------------------------------------
// WHATSAPP
// -----------------------------------------------------------------------------

/** WhatsApp template mode, env-driven on the API side. The default
 *  `"plain"` reuses the SMS body shape so we don't accidentally ship
 *  a free-form template into a WABA-strict number. `"rich"` activates
 *  the multi-line markdown template — only enable after the number
 *  has been approved for free-form sends or is inside the 24-hour
 *  session window. */
export const INTAKE_WHATSAPP_TEMPLATE_MODES = [
  "plain",
  "approved_template",
  "rich",
] as const;
export type IntakeWhatsappTemplateMode =
  (typeof INTAKE_WHATSAPP_TEMPLATE_MODES)[number];

export function renderIntakeWhatsappMessage(
  input: IntakeMessageRenderInput,
  mode: IntakeWhatsappTemplateMode = "plain",
): string {
  if (mode === "plain") {
    // Same body shape as SMS — safe for unapproved WhatsApp senders.
    return renderIntakeSmsMessage({ ...input, channel: "SMS" });
  }

  // `approved_template` and `rich` both emit the multi-line body.
  // For `approved_template` the caller is expected to upload a matching
  // WABA template; the body returned here is what the variables
  // resolve to AFTER substitution.
  const noun = intakeRequestTypeNounLabel(input.requestTypeSlug);
  const absolute = formatAbsoluteExpiry(input.expiresAtUtc);
  const referenceLine = input.recipientLabel
    ? `\nReference: ${input.recipientLabel}`
    : "";

  const body =
    `*${INTAKE_BRAND_NAME} secure intake*\n\n` +
    `${input.senderDisplay} is requesting files from you.\n\n` +
    `Request: ${noun}${referenceLine}\n\n` +
    `Upload securely:\n${input.intakeUrl}\n\n` +
    `${INTAKE_NO_ACCOUNT_LINE}\n` +
    `Expires: ${absolute}\n` +
    `${INTAKE_DO_NOT_FORWARD_LINE}\n\n` +
    `${INTAKE_UNEXPECTED_LINE}\n\n` +
    `${INTAKE_FOOTER_LINE}`;

  return clipBody(body, INTAKE_WHATSAPP_MAX_CHARS);
}
