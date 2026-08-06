

// PHASE 12 POINT 5 — the CANONICAL email transport authority.
//
// This file used to contain two of the repository's three independent email
// transport policy engines: a `resendSingleton` reached through
// `sendCustomEmailViaResend`, and a SECOND provider SDK client constructed
// inside `getEmailService()`. Neither sent an idempotency key, neither had a
// timeout, and they classified provider errors differently — one returned a
// typed result, the other resolved the SDK's `{ data, error }` shape so a
// provider rejection looked like a success to any caller that did not inspect
// it. The third engine was a raw `fetch` in the worker's MFA digest sweep.
//
// All three now route through `deliverEmail`, which owns authentication, the
// idempotency key, the timeout, retry classification, acknowledgement
// projection, bounded error handling and PII-safe diagnostics. What stays here
// is RENDERING: the branded shell, the copy, and the subject lines.
import {
  AMBIGUOUS_ERROR_CODE,
  deliverEmail,
  mintEmailIdempotencyKey,
  registerEmailApiKeyResolver,
  registerEmailIdempotencySecretResolver,
  type EmailDeliveryOutcome,
} from "@proovra/shared-runtime";
// Phase O1.5E — bounded smtp.email_send span.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../observability/otel.js";
// PHASE 11 — canonical internal URL builder. Every internal (in-app)
// link this service composes by hand goes through these instead of
// ad-hoc template literals.
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

export type DemoRequestQuickLinks = {
  replyToLeadMailto: string;
  sampleReportUrl: string;
  verificationDemoUrl: string;
  methodologyUrl: string;
  pricingUrl: string;
  bookingUrl: string | null;
  requestDemoUrl: string;
  contactSalesUrl: string;
};

export type EmailService = {
  isConfigured: () => boolean;

  sendPasswordResetEmail: (
    email: string,
    resetUrl: string
  ) => Promise<EmailDeliveryOutcome>;

  // EV2 — enterprise email verification.
  // Sent on email/password registration and on resend. The verifyUrl
  // points at /auth/verify-email?token=<raw> on the public web app.
  // Subject + body are deliberately minimal so the email reads like
  // Stripe / Linear / Vanta transactional mail, not marketing.
  sendEmailVerificationEmail: (
    email: string,
    verifyUrl: string
  ) => Promise<EmailDeliveryOutcome>;

  // PHASE R8.1.5 — verified-email preflight for lost-factor MFA
  // recovery. The body carries a verification LINK (not the token
  // itself in plaintext URL params — the link points to a web page
  // that takes the user through a guided verification). Subject and
  // body language make clear this confirms mailbox access only and
  // does NOT replace MFA or grant a session.
  sendMfaRecoveryVerificationEmail: (
    email: string,
    verificationUrl: string
  ) => Promise<EmailDeliveryOutcome>;

  // PHASE R8.1.6 — pending MFA recovery digest for org admins.
  // Plain text + simple HTML; carries ONLY a count + a deep link to
  // the admin SPA. NEVER includes any user email, recovery reason,
  // verification token, OTP, recovery code, secret, or signed
  // pending token. Frequency-bounded by the worker's digest log so
  // a given admin receives at most one digest per team per UTC day.
  //
  // PHASE R8.1.9 — `snoozeUrl` is an optional signed one-click URL
  // that applies a 15-day snooze for this admin's global digest
  // preference. When omitted (e.g. RESEND_API_KEY not configured in
  // dev) the email is sent without the snooze link. The URL is
  // pre-built by the caller using `buildMfaDigestSnoozeUrl`.
  sendMfaRecoveryAdminDigestEmail: (
    adminEmail: string,
    teamDisplayName: string,
    pendingCount: number,
    adminSpaUrl: string,
    snoozeUrl?: string | null,
  ) => Promise<EmailDeliveryOutcome>;

  sendTeamInvitation: (
    email: string,
    orgName: string,
    invitationToken: string
  ) => Promise<EmailDeliveryOutcome>;

  sendBatchComplete: (
    email: string,
    orgName: string,
    batchName: string,
    totalItems: number,
    failedItems: number,
    batchUrl: string
  ) => Promise<EmailDeliveryOutcome>;

  sendDemoRequestNotification: (params: {
    to: string;
    requestId: string;
    fullName: string;
    workEmail: string;
    organization?: string | null;
    jobTitle?: string | null;
    country?: string | null;
    teamSize?: string | null;
    useCase: string;
    message?: string | null;
    source?: string | null;
    sourcePath?: string | null;
    referrer?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmTerm?: string | null;
    utmContent?: string | null;
    priority?: string | null;
    leadQuality?: string | null;
    leadTrack?: string | null;
    recommendedAction?: string | null;
    responseSlaHours?: number | null;
    qualificationScore?: number | null;
    qualificationReasons?: string[] | null;
    spamScore?: number | null;
    isSpam?: boolean | null;
    quickLinks?: DemoRequestQuickLinks | null;
  }) => Promise<EmailDeliveryOutcome>;

  sendDemoRequestAutoReply: (params: {
    to: string;
    fullName: string;
    responseWindowText: string;
    sampleReportUrl: string;
    verificationDemoUrl: string;
    methodologyUrl: string;
    pricingUrl: string;
    bookingUrl?: string | null;
  }) => Promise<EmailDeliveryOutcome>;

  sendDemoRequestFollowUp: (params: {
    to: string;
    /**
     * The durable `DemoRequest` id.
     *
     * POINT 5 — supplied so the provider idempotency key can be derived from
     * (durable id, step) instead of (recipient, step). The recipient is a
     * prospect's work email; deriving a key from it, even hashed, puts a
     * guessable identifier in the provider's request logs.
     */
    demoRequestId: string;
    fullName: string;
    step: 1 | 2 | 3;
    sampleReportUrl: string;
    verificationDemoUrl: string;
    methodologyUrl: string;
    pricingUrl: string;
    bookingUrl?: string | null;
    requestDemoUrl: string;
    contactSalesUrl: string;
  }) => Promise<EmailDeliveryOutcome>;

  // Contact Sales — operator notification + visitor auto-reply.
  // Mirrors the demo-request shape so admin notification copy and
  // routing logic stay consistent. Operator copy NEVER contains
  // secret-bearing tokens, magic links, or sender-IP geolocation.
  sendContactSalesNotification: (params: {
    to: string;
    requestId: string;
    fullName: string;
    workEmail: string;
    organization: string;
    jobTitle?: string | null;
    country?: string | null;
    teamSize?: string | null;
    discussionTopic: string;
    stage: string;
    currentChallenge: string;
    deploymentTimeline?: string | null;
    estimatedUsers?: string | null;
    additionalDetails?: string | null;
    source?: string | null;
    sourcePath?: string | null;
    referrer?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmTerm?: string | null;
    utmContent?: string | null;
    priority?: string | null;
  }) => Promise<EmailDeliveryOutcome>;

  sendContactSalesAutoReply: (params: {
    to: string;
    fullName: string;
    sampleReportUrl: string;
    verificationDemoUrl: string;
    methodologyUrl: string;
    pricingUrl: string;
  }) => Promise<EmailDeliveryOutcome>;
};

// Phase P2.0 — RESEND_API_KEY is in the migrated set. Migrated names
// are resolved through `getSecret()` (AWS first, env fallback). All
// other names (RESEND_FROM, ADMIN_CONTACT_EMAIL, ...) are kept on env.
import {
  getSecret,
  MIGRATED_SECRETS,
} from "../config/runtime-secrets.js";

function env(name: string): string | undefined {
  if ((MIGRATED_SECRETS as readonly string[]).includes(name)) {
    const v = getSecret(name);
    return v && v.trim() ? v.trim() : undefined;
  }
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

// Phase 8 — exported so the notification renderer can reuse the same
// branded shell, escaping rules, and brand-name resolution without
// duplicating helper code or instantiating a second Resend client.
export {
  brandName as getEmailBrandName,
  emailShell as renderEmailShell,
  fromHeader as getEmailFromHeader,
  safeHtml as escapeEmailHtml,
  supportEmail as getEmailSupportAddress,
  webBaseUrl as getEmailWebBaseUrl,
};

function fromHeader(): string {
  return (
    env("EMAIL_FROM") ??
    `${env("EMAIL_FROM_NAME") ?? "Proovra"} <no-reply@proovra.com>`
  );
}

function webBaseUrl(): string {
  return env("WEB_BASE_URL") ?? "https://www.proovra.com";
}

function brandName(): string {
  return env("EMAIL_BRAND_NAME") ?? "Proovra";
}

function supportEmail(): string {
  return env("SUPPORT_EMAIL") ?? "support@proovra.com";
}

// Public hero banner. Lives on the marketing site so it is reachable
// from every email client without a CDN swap. The image itself carries
// the PROOVRA wordmark + tagline — emails MUST NOT render a second
// logo above or below.
function heroBannerUrl(): string {
  const base = webBaseUrl().replace(/\/+$/, "");
  return `${base}/assets/branding/email-hero-banner.png`;
}

function legalLinks(): Array<{ label: string; href: string }> {
  const base = webBaseUrl().replace(/\/+$/, "");
  return [
    { label: "Terms of Service", href: `${base}/legal/terms` },
    { label: "Privacy Policy", href: `${base}/legal/privacy` },
    { label: "Trust Center", href: `${base}/trust` },
    { label: "Support", href: `${base}/support` },
  ];
}

// Admin app base — used by lead-capture notification emails to deep-link
// into the admin console. Resolution order: ADMIN_BASE_URL → APP_BASE_URL
// → fallback to https://app.proovra.com. Public marketing host
// (WEB_BASE_URL / www.proovra.com) MUST NOT be used here: admin pages
// live under the (app) route group on app.proovra.com.
//
// When neither env var is set we emit a structured log line so ops can
// fix it without exposing lead PII — only the resolved fallback host
// is recorded, never the requestId or any payload values.
let __adminBaseLogged = false;
function adminBaseUrl(): string {
  const explicit = env("ADMIN_BASE_URL") ?? env("APP_BASE_URL");
  if (explicit && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, "");
  }
  if (!__adminBaseLogged) {
    __adminBaseLogged = true;
    try {
      console.warn(
        JSON.stringify({
          tag: "admin_lead_url_fallback",
          message:
            "ADMIN_BASE_URL / APP_BASE_URL not configured — falling back to https://app.proovra.com",
        })
      );
    } catch {
      // logging must never throw
    }
  }
  return "https://app.proovra.com";
}

export function buildAdminLeadUrl(input: {
  kind: "demo-request" | "contact-sales";
  id: string;
}): string {
  const segment =
    input.kind === "demo-request" ? "demo-requests" : "contact-sales";
  return `${adminBaseUrl()}/admin/${segment}/${encodeURIComponent(input.id)}`;
}

function safeHtml(s: string): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inviteAcceptUrl(invitationToken: string): string {
  // PHASE 11 — /invite/:token is an authenticated in-app nav path
  // (not one of the resource-id families), so it is composed via
  // internalNavPath rather than internalResourcePath.
  return absoluteInternalUrl(
    webBaseUrl(),
    internalNavPath(`/invite/${encodeURIComponent(invitationToken)}`),
  );
}

function emailShell(params: {
  title: string;
  preheader: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  // Plain gray paragraph rendered below the CTA. Kept for back-compat —
  // new templates should prefer noticeTitle/noticeText so the message
  // sits inside a labelled card.
  secondaryText?: string;
  // Optional security/notice card (light surface, neutral border).
  noticeTitle?: string;
  noticeText?: string;
  // Optional list of secondary action links rendered below the CTA as a
  // single bulleted line. Cap at 3-4 per spec.
  secondaryLinks?: Array<{ label: string; url: string }>;
}) {
  const appName = brandName();
  const base = webBaseUrl().replace(/\/$/, "");
  const support = supportEmail();
  const hero = heroBannerUrl();

  const title = safeHtml(params.title);
  const preheader = safeHtml(params.preheader);
  const secondaryText = params.secondaryText
    ? safeHtml(params.secondaryText)
    : "";
  const noticeTitle = params.noticeTitle ? safeHtml(params.noticeTitle) : "";
  const noticeText = params.noticeText ? safeHtml(params.noticeText) : "";

  const ctaText = params.ctaText ? safeHtml(params.ctaText) : "";
  const ctaUrl = params.ctaUrl ? String(params.ctaUrl) : "";

  const year = new Date().getFullYear();

  const ctaBlock =
    params.ctaText && params.ctaUrl
      ? `
        <tr>
          <td style="padding: 4px 32px 10px 32px; text-align:center;">
            <a href="${ctaUrl}"
               style="
                 display:inline-block;
                 background:#07132B;
                 color:#FFFFFF;
                 text-decoration:none;
                 padding:14px 24px;
                 border-radius:12px;
                 font-weight:700;
                 font-size:14px;
                 line-height:14px;
                 font-family:Arial, Helvetica, sans-serif;
               ">
              ${ctaText}
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 32px 22px 32px; color:#64748B; font-size:12px; line-height:18px; text-align:center; font-family:Arial, Helvetica, sans-serif;">
            If the button does not work, copy and paste this link into your browser:
            <div style="word-break: break-all; margin-top:6px;">
              <a href="${ctaUrl}" style="color:#2563EB; text-decoration:none;">${safeHtml(
                ctaUrl
              )}</a>
            </div>
          </td>
        </tr>
      `
      : "";

  const noticeBlock =
    params.noticeText
      ? `
        <tr>
          <td style="padding: 0 32px 22px 32px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #E5E7EB; border-radius:14px; background:#F8FAFC;">
              <tr>
                <td style="padding:16px 18px; color:#475569; font-size:13px; line-height:20px; font-family:Arial, Helvetica, sans-serif;">
                  ${
                    noticeTitle
                      ? `<div style="margin:0 0 4px 0; color:#07132B; font-weight:700;">${noticeTitle}</div>`
                      : ""
                  }
                  ${noticeText}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `
      : "";

  const secondaryLinksBlock =
    params.secondaryLinks && params.secondaryLinks.length > 0
      ? `
        <tr>
          <td style="padding: 0 32px 22px 32px; color:#475569; font-size:13px; line-height:22px; text-align:center; font-family:Arial, Helvetica, sans-serif;">
            ${params.secondaryLinks
              .map(
                (link) =>
                  `<a href="${safeHtml(link.url)}" style="color:#2563EB; text-decoration:none; margin:0 8px;">${safeHtml(
                    link.label
                  )}</a>`
              )
              .join(`<span style="color:#CBD5E1;">·</span>`)}
          </td>
        </tr>
      `
      : "";

  const legalLinkRow = legalLinks()
    .map(
      (l) =>
        `<a href="${safeHtml(l.href)}" style="color:#475569; text-decoration:none; margin:0 6px;">${safeHtml(
          l.label
        )}</a>`
    )
    .join(`<span style="color:#CBD5E1;">·</span>`);

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background:#F4F7FB; font-family:Arial, Helvetica, sans-serif; color:#101828;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F4F7FB; padding:0; margin:0;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            style="max-width:620px; background:#FFFFFF; border:1px solid #E5E7EB; border-radius:18px; overflow:hidden; box-shadow:0 12px 36px rgba(15,23,42,0.10);"
          >
            <tr>
              <td style="padding:0; margin:0; font-size:0; line-height:0;">
                <a href="${base}" style="text-decoration:none; display:block;">
                  <img
                    src="${hero}"
                    alt="PROOVRA — Integrity in Every Evidence"
                    width="620"
                    style="display:block; width:100%; max-width:620px; height:auto; border:0; outline:none; text-decoration:none;"
                  />
                </a>
              </td>
            </tr>

            <tr>
              <td style="padding: 32px 32px 8px 32px; text-align:center; font-family:Arial, Helvetica, sans-serif;">
                <h1 style="margin:0; font-size:26px; line-height:32px; font-weight:800; color:#07132B;">
                  ${title}
                </h1>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 32px 22px 32px; color:#475569; font-size:15px; line-height:24px; font-family:Arial, Helvetica, sans-serif;">
                ${params.bodyHtml}
              </td>
            </tr>

            ${ctaBlock}

            ${noticeBlock}

            ${secondaryLinksBlock}

            ${
              secondaryText
                ? `
                <tr>
                  <td style="padding: 0 32px 22px 32px; color:#64748B; font-size:13px; line-height:20px; text-align:center; font-family:Arial, Helvetica, sans-serif;">
                    ${secondaryText}
                  </td>
                </tr>
                `
                : ""
            }

            <tr>
              <td style="padding:20px 32px 22px 32px; background:#FFFFFF; border-top:1px solid #E5E7EB; color:#64748B; font-size:12px; line-height:18px; text-align:center; font-family:Arial, Helvetica, sans-serif;">
                <div style="margin-bottom:8px;">
                  ${legalLinkRow}
                </div>
                <div style="margin-bottom:8px;">
                  Need help? Contact <a href="mailto:${safeHtml(
                    support
                  )}" style="color:#2563EB; text-decoration:none;">${safeHtml(
                    support
                  )}</a>
                </div>
                <div style="color:#94A3B8;">
                  © ${year} ${safeHtml(appName)}. All rights reserved.
                </div>
              </td>
            </tr>
          </table>

          <div style="max-width:620px; margin:14px auto 0 auto; color:#94A3B8; font-size:11px; line-height:16px; text-align:center; font-family:Arial, Helvetica, sans-serif;">
            This message was sent for account, security, support, or service-related purposes.
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();
}

function prettyReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function buildFollowUpContent(step: 1 | 2 | 3) {
  if (step === 1) {
    return {
      subject: "Still reviewing PROOVRA?",
      title: "Still reviewing PROOVRA?",
      preheader: "A quick follow-up with useful PROOVRA resources.",
      intro:
        "Just following up in case your demo request is still active. If you are evaluating evidence operations, verification workflows, or reviewer-ready reporting, these resources may help you assess the platform.",
      ctaText: "Open verification demo",
    };
  }

  if (step === 2) {
    return {
      subject: "See the PROOVRA workflow more clearly",
      title: "See the workflow more clearly",
      preheader: "Review a sample report and methodology overview.",
      intro:
        "PROOVRA is designed to help organizations preserve, review, and share evidence records with recorded integrity and custody context. The sample report and methodology overview show what reviewers can inspect.",
      ctaText: "View sample report",
    };
  }

  return {
    subject: "Still interested in a PROOVRA walkthrough?",
    title: "Still interested in a walkthrough?",
    preheader:
      "Book time with the PROOVRA team or continue reviewing resources.",
    intro:
      "If PROOVRA still looks relevant to your evidence operations workflow, you can request a walkthrough with the team. If not, no action is needed.",
    ctaText: "Book a walkthrough",
  };
}

// PHASE P2.0 / POINT 5 — the API resolves RESEND_API_KEY through its secret
// manager (AWS first, env fallback); the worker reads the environment. Rather
// than fork the transport over that one difference, this host registers HOW to
// obtain the key and the canonical transport keeps ownership of what to do
// with it.
registerEmailApiKeyResolver(() => env("RESEND_API_KEY"));

// PHASE 12 POINT 5 — the DEDICATED idempotency secret, resolved through the
// same secret manager and used for nothing else. It deliberately does not fall
// back to the communications, identity or JWT secrets: borrowing another
// subsystem couples two rotation schedules, and the day that subsystem rotates,
// every in-flight retry key silently changes.
registerEmailIdempotencySecretResolver(() => env("EMAIL_IDEMPOTENCY_SECRET"));

/**
 * A deterministic provider idempotency key for a send with no durable row.
 *
 * The template methods below are called with arguments, not with a database
 * id — `sendPasswordResetEmail(email, resetUrl)` has nothing to derive an id
 * from. The key is therefore derived from the message's own identifying
 * content: the template and the fields that make this message THIS message
 * (the reset URL, the invitation token, the request id, the follow-up step).
 *
 * The property that matters is stability under retry: re-sending the same
 * password-reset link, or the same follow-up step to the same prospect, yields
 * the same key and the provider collapses the duplicate. A genuinely new
 * message carries a new token, a new id or a new step, and so a new key.
 *
 * THIS IS A THIN ALIAS, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * All derivation lives in the idempotency authority. This function used to do
 * it here, reaching for whichever secret happened to be configured — the
 * communications hash secret, then the identity hash secret, then
 * `AUTH_JWT_SECRET`, then an unkeyed digest. Every link in that chain was
 * wrong: `AUTH_JWT_SECRET` signs SESSIONS and has no business deriving a value
 * transmitted to a vendor; borrowing another subsystem's secret couples two
 * rotation schedules; and the unkeyed fallback made the key a confirmable
 * guess, because email addresses come from an enumerable space.
 *
 * There is now one dedicated secret, used for nothing else, and production
 * fails closed without it.
 *
 * Callers that have a durable row should NOT use this function. They should
 * mint once at intent creation, persist the key on the row, and load it on
 * retry — see `readStoredIdempotencyKey`. This one is for the genuinely
 * row-less callers: a password reset has no outbox row to hang a key on.
 */
export function deterministicEmailKey(
  templateKey: string,
  ...parts: ReadonlyArray<string>
): string {
  return mintEmailIdempotencyKey(templateKey, ...parts);
}

/**
 * The one send path used by every method on the {@link EmailService}
 * singleton.
 *
 * Returns the transport's outcome rather than the SDK's response object.
 * Callers previously received `Promise<unknown>` and, in practice, ignored it;
 * those that want to react to a provider refusal can now do so honestly,
 * because a refusal is no longer indistinguishable from a success.
 */
async function transportSend(input: {
  templateKey: string;
  keyParts: ReadonlyArray<string>;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<EmailDeliveryOutcome> {
  // Phase O1.5E — bounded smtp.email_send span. NEVER recipient,
  // subject, body, or sender in attributes — operation only.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SMTP_EMAIL_SEND,
    {
      "proovra.operation": "smtp_email_send",
      "proovra.provider": "resend",
    },
    () =>
      deliverEmail({
        from: fromHeader(),
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        idempotencyKey: deterministicEmailKey(input.templateKey, ...input.keyParts),
        // Bounded attribution. Never reaches a real provider — it lets a local
        // recording provider say WHICH message a stored entry is, so a browser
        // journey can find its invitation instead of inferring it from a
        // subject line or reading the token out of the database.
        meta: { templateKind: input.templateKey },
      }),
  );
}

export type SendCustomEmailResult =
  | {
      ok: true;
      providerMessageId: string | null;
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
    };

/**
 * Generic transactional send. Used by Phase 8 notification renderers so
 * we never spin up a second Resend client.
 *
 * Returns a typed result rather than throwing — callers (the notification
 * orchestrator) classify the error and decide whether to retry. When
 * RESEND_API_KEY is not configured, returns `not_configured` so the
 * caller can downgrade to FAILED without entering a retry loop.
 */
export async function sendCustomEmailViaResend(input: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Derived from the caller's DURABLE row — a `NotificationDelivery` id, an
   * invite id, an intake message id. Required: every caller of this function
   * has such a row, and the one that does not is the one whose retry sends
   * twice.
   */
  idempotencyKey: string;
}): Promise<SendCustomEmailResult> {
  // Phase O1.5E — bounded smtp.email_send span. NEVER recipient,
  // subject, body, or sender in attributes — operation only.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.SMTP_EMAIL_SEND,
    {
      "proovra.operation": "smtp_email_send",
      "proovra.provider": "resend",
    },
    () => sendCustomEmailViaResendInner(input),
  );
}

async function sendCustomEmailViaResendInner(input: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}): Promise<SendCustomEmailResult> {
  const outcome = await deliverEmail(input);
  switch (outcome.kind) {
    case "acknowledged":
      return { ok: true, providerMessageId: outcome.providerMessageId };
    case "not_configured":
      return {
        ok: false,
        errorCode: "not_configured",
        errorMessage: "RESEND_API_KEY is not set",
      };
    case "ambiguous":
      // Flattened onto the ok:false shape because that is what this signature
      // can express, but flattened HONESTLY: the canonical ambiguous code is
      // what the caller records, so a delivery row written from this result
      // says "never confirmed" rather than "failed". The specific cause is
      // preserved in the message.
      return {
        ok: false,
        errorCode: AMBIGUOUS_ERROR_CODE,
        errorMessage: outcome.errorCode,
      };
    default:
      return {
        ok: false,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorCode,
      };
  }
}

let singleton: EmailService | null = null;

export function getEmailService(): EmailService {
  if (singleton) return singleton;

  const apiKey = env("RESEND_API_KEY");

  if (!apiKey) {
    singleton = {
      isConfigured: () => false,
      async sendPasswordResetEmail() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendEmailVerificationEmail() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendMfaRecoveryVerificationEmail() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendMfaRecoveryAdminDigestEmail() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendTeamInvitation() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendBatchComplete() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendDemoRequestNotification() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendDemoRequestAutoReply() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendDemoRequestFollowUp() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendContactSalesNotification() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
      async sendContactSalesAutoReply() {
        throw new Error("Email service not configured: RESEND_API_KEY missing");
      },
    };
    return singleton;
  }

  // No client is constructed here any more. `apiKey` is read ONLY to decide
  // whether this host has a transport at all — the not-configured singleton
  // below is a distinct object whose methods throw, and that contract is
  // unchanged. The key itself is resolved by the canonical transport through
  // the resolver registered at the top of this module, so there is exactly one
  // place in the process that authenticates to the provider.
  singleton = {
    isConfigured: () => true,

    async sendPasswordResetEmail(email: string, resetUrl: string) {
      const app = brandName();

      const html = emailShell({
        title: "Reset your password",
        preheader: "Use this secure link to choose a new password.",
        bodyHtml: `
          <div style="margin:0 0 12px 0;">
            We received a request to reset the password for your
            <strong>${safeHtml(app)}</strong> account.
          </div>
          <div style="margin:0;">
            Click the button below to choose a new password.
          </div>
        `.trim(),
        ctaText: "Reset password",
        ctaUrl: resetUrl,
        noticeTitle: "Security notice",
        noticeText:
          "This password reset link expires after the configured reset window. Your password will not change unless this link is used. If you did not request this reset, you can safely ignore this email.",
      });

      const text =
        `Reset your ${app} password.\n\n` +
        `We received a request to reset your password.\n` +
        `Reset link: ${resetUrl}\n\n` +
        `If you did not request this reset, you can safely ignore this email.\n` +
        `Your password will not change unless this link is used.\n\n` +
        `Support: ${supportEmail()}\n`;

      return transportSend({
        templateKey: "password_reset",
        // The reset URL carries the single-use token, so it identifies THIS
        // reset. A re-send of the same link deduplicates; a new reset request
        // mints a new token and therefore a new key.
        keyParts: [email, resetUrl],
        to: email,
        subject: `Reset your ${app} password`,
        html,
        text,
      });
    },

    // EV2 — enterprise email verification.
    // Minimal Stripe/Linear/Vanta-style transactional copy. No
    // marketing claims, no celebration art. The link is the single
    // CTA. `verifyUrl` already carries the raw token in a query
    // param so this function is provider-agnostic.
    async sendEmailVerificationEmail(email: string, verifyUrl: string) {
      const app = brandName();

      const html = emailShell({
        title: "Verify your email address",
        preheader: `Confirm your email address to activate your ${app} workspace.`,
        bodyHtml: `
          <div style="margin:0 0 12px 0;">
            Thank you for creating your <strong>${safeHtml(app)}</strong> account.
          </div>
          <div style="margin:0;">
            Please verify ownership of this email address before accessing your
            workspace.
          </div>
        `.trim(),
        ctaText: "Verify email address",
        ctaUrl: verifyUrl,
        noticeTitle: "Security notice",
        noticeText:
          "This verification link expires in 24 hours. If you did not create this account, you can safely ignore this email.",
      });

      const text =
        `Verify your ${app} account.\n\n` +
        `Please verify ownership of this email address before accessing your workspace.\n\n` +
        `Verification link: ${verifyUrl}\n\n` +
        `This link expires in 24 hours. If you did not create this account, you can safely ignore this email.\n\n` +
        `Support: ${supportEmail()}\n`;

      return transportSend({
        templateKey: "email_verification",
        keyParts: [email, verifyUrl],
        to: email,
        subject: `Verify your ${app} account`,
        html,
        text,
      });
    },

    async sendMfaRecoveryAdminDigestEmail(
      adminEmail: string,
      teamDisplayName: string,
      pendingCount: number,
      adminSpaUrl: string,
      snoozeUrl?: string | null,
    ) {
      // Bound the displayed count for safety.
      const safeCount = Number.isFinite(pendingCount)
        ? Math.max(0, Math.min(999, Math.floor(pendingCount)))
        : 0;
      // PHASE R8.1.9 — optional snooze link block embedded in the
      // HTML body and text fallback. The URL is a pre-signed
      // one-click endpoint; it carries NO user PII beyond the
      // opaque signed JWT. When omitted, the block is omitted.
      const snoozeHtmlBlock = snoozeUrl
        ? `
          <div style="margin:14px 0 0 0; padding:12px 14px; border:1px solid #E5E7EB; border-radius:10px; background:#F8FAFC; font-size:13px; color:#475569; line-height:20px;">
            Not ready to review now?
            <a href="${safeHtml(snoozeUrl)}"
               style="color:#2563EB; text-decoration:none; font-weight:600;">
              Snooze these digest emails for 15 days
            </a>
            — security events and audit logs are unaffected.
          </div>
        `.trim()
        : "";
      const snoozeTextLine = snoozeUrl
        ? `Snooze digest emails for 15 days: ${snoozeUrl}\n`
        : "";
      const html = emailShell({
        title: "Pending MFA recovery requests",
        preheader: "Review pending MFA recovery requests for your workspace.",
        bodyHtml: `
          <div style="margin:0 0 12px 0;">
            Members of <strong>${safeHtml(teamDisplayName)}</strong> have
            requested MFA recovery and verified mailbox access.
          </div>
          <div style="margin:0 0 14px 0;">
            These requests require administrator review before MFA settings are
            changed.
          </div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 0 0; border-collapse:collapse;">
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Workspace</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${safeHtml(
                teamDisplayName
              )}</td>
            </tr>
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Pending requests</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${safeCount}</td>
            </tr>
          </table>
          ${snoozeHtmlBlock}
        `.trim(),
        ctaText: "Open admin console",
        ctaUrl: adminSpaUrl,
        noticeTitle: "Administrator action required",
        noticeText:
          "Approving a recovery request revokes the member's existing MFA factors and requires re-enrollment. It does not grant the member an active session.",
      });
      const text =
        `Pending MFA recovery requests — ${teamDisplayName}\n\n` +
        `Workspace: ${teamDisplayName}\n` +
        `Pending requests: ${safeCount}\n\n` +
        `Open the admin console: ${adminSpaUrl}\n\n` +
        `Approving a recovery request revokes the member's existing MFA factors and requires re-enrollment. It does not grant the member an active session.\n` +
        snoozeTextLine +
        `\nSupport: ${supportEmail()}\n`;
      return transportSend({
        templateKey: "mfa_recovery_admin_digest_single_team",
        keyParts: [adminEmail, teamDisplayName, String(safeCount)],
        to: adminEmail,
        subject: `${safeCount} pending MFA recovery request${
          safeCount === 1 ? "" : "s"
        } — ${teamDisplayName}`,
        html,
        text,
      });
    },

    async sendMfaRecoveryVerificationEmail(
      email: string,
      verificationUrl: string,
    ) {
      const app = brandName();
      const html = emailShell({
        title: "Verify your MFA recovery request",
        preheader: "Confirm that you can access this mailbox before admin review.",
        bodyHtml: `
          <div style="margin:0 0 12px 0;">
            We received a request to recover multi-factor authentication access
            for your <strong>${safeHtml(app)}</strong> account.
          </div>
          <div style="margin:0;">
            Confirming this email only verifies mailbox access. Your organization
            administrator may still need to review and approve the recovery
            request before MFA settings are changed.
          </div>
        `.trim(),
        ctaText: "Confirm recovery request",
        ctaUrl: verificationUrl,
        noticeTitle: "Security notice",
        noticeText:
          "This link expires in 15 minutes. If you did not request MFA recovery, ignore this email and notify your administrator.",
      });
      const text =
        `Verify your ${app} MFA recovery request.\n\n` +
        `Confirm mailbox access: ${verificationUrl}\n\n` +
        `This does not grant a session or replace admin approval.\n\n` +
        `This link expires in 15 minutes. If you did not request MFA recovery, ignore this email and notify your administrator.\n\n` +
        `Support: ${supportEmail()}\n`;
      return transportSend({
        templateKey: "mfa_recovery_verification",
        keyParts: [email, verificationUrl],
        to: email,
        subject: `Verify your ${app} MFA recovery request`,
        html,
        text,
      });
    },

    async sendTeamInvitation(
      email: string,
      orgName: string,
      invitationToken: string
    ) {
      const url = inviteAcceptUrl(invitationToken);
      const app = brandName();

      const html = emailShell({
        title: `Join ${orgName} on ${app}`,
        preheader: `Accept your invitation to join ${orgName}.`,
        bodyHtml: `
          <div style="margin:0 0 12px 0;">
            You have been invited to collaborate in a <strong>${safeHtml(
              app
            )}</strong> workspace.
          </div>
          <div style="margin:0;">
            Accept the invitation to access <strong>${safeHtml(
              orgName
            )}</strong> according to the permissions assigned by the workspace
            administrator.
          </div>
        `.trim(),
        ctaText: "Accept invitation",
        ctaUrl: url,
        noticeTitle: "Security notice",
        noticeText:
          "Only accept this invitation if you recognize the organization or sender.",
      });

      const text =
        `You have been invited to a ${app} workspace.\n\n` +
        `Workspace: ${orgName}\n` +
        `Accept invitation: ${url}\n\n` +
        `Only accept this invitation if you recognize the organization or sender.\n\n` +
        `Support: ${supportEmail()}\n`;

      return transportSend({
        templateKey: "team_invitation",
        // The invitation token identifies the invite record; re-sending the
        // same invitation deduplicates, re-issuing it does not.
        keyParts: [email, invitationToken],
        to: email,
        subject: `You have been invited to a ${app} workspace`,
        html,
        text,
      });
    },

    async sendBatchComplete(
      email,
      orgName,
      batchName,
      totalItems,
      failedItems,
      batchUrl
    ) {
      const failed = Number.isFinite(failedItems) ? failedItems : 0;
      const total = Number.isFinite(totalItems) ? totalItems : 0;
      const succeeded = Math.max(0, total - failed);

      const html = emailShell({
        title: "Batch complete",
        preheader: `Your ${brandName()} batch has finished processing.`,
        bodyHtml: `
          <div style="margin:0 0 14px 0;">
            Your batch process has completed.
          </div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 10px 0; border-collapse:collapse;">
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Workspace</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${safeHtml(
                orgName
              )}</td>
            </tr>
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Batch</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${safeHtml(
                batchName
              )}</td>
            </tr>
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Total</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${total}</td>
            </tr>
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Successful</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${succeeded}</td>
            </tr>
            <tr>
              <td style="padding:4px 14px 4px 0; color:#64748B; font-size:14px;">Failed</td>
              <td style="padding:4px 0; font-weight:700; color:#07132B; font-size:14px;">${failed}</td>
            </tr>
          </table>
        `.trim(),
        ctaText: "View results",
        ctaUrl: batchUrl,
        noticeText:
          failed > 0
            ? "Some items did not complete. Open the results page to review the failure details and next steps."
            : undefined,
      });

      const text =
        `Batch complete: ${batchName}\n\n` +
        `Workspace: ${orgName}\n` +
        `Total: ${total}\nSuccessful: ${succeeded}\nFailed: ${failed}\n\n` +
        `View results: ${batchUrl}\n` +
        (failed > 0
          ? `\nSome items did not complete. Open the results page to review the failure details and next steps.\n`
          : "") +
        `\nSupport: ${supportEmail()}\n`;

      return transportSend({
        templateKey: "batch_complete",
        keyParts: [
          email,
          batchUrl,
          batchName,
          String(totalItems),
          String(failedItems),
        ],
        to: email,
        subject: `Batch complete: ${batchName}`,
        html,
        text,
      });
    },

    async sendDemoRequestNotification(params) {
      const qualificationReasons = Array.isArray(params.qualificationReasons)
        ? params.qualificationReasons
        : [];

      const quickLinks = params.quickLinks;

      // Compact internal email — five concise sections + one CTA into the
      // admin console. Heavy CRM detail (UTMs, qualification breakdown,
      // spam scores) is preserved in the plaintext payload but kept out
      // of the HTML so the message reads in under 20 seconds.
      // Quick Actions block is retained: it's pinned by the
      // admin-lead-cta.contract source-contract test and is genuinely
      // useful in the operator inbox.
      const quickLinksHtml = quickLinks
        ? `
          <div style="margin:18px 0 8px 0; color:#07132B;"><strong>Quick actions</strong></div>
          <ul style="margin:0; padding-left:18px; color:#475569; font-size:14px; line-height:22px;">
            <li><a href="${safeHtml(
              quickLinks.replyToLeadMailto
            )}" style="color:#2563EB; text-decoration:none;">Reply to lead</a></li>
            <li><a href="${safeHtml(
              quickLinks.sampleReportUrl
            )}" style="color:#2563EB; text-decoration:none;">Open sample report</a></li>
            <li><a href="${safeHtml(
              quickLinks.verificationDemoUrl
            )}" style="color:#2563EB; text-decoration:none;">Open verification demo</a></li>
            <li><a href="${safeHtml(
              quickLinks.methodologyUrl
            )}" style="color:#2563EB; text-decoration:none;">Open methodology</a></li>
            <li><a href="${safeHtml(
              quickLinks.pricingUrl
            )}" style="color:#2563EB; text-decoration:none;">Open pricing</a></li>
            <li><a href="${safeHtml(
              quickLinks.requestDemoUrl
            )}" style="color:#2563EB; text-decoration:none;">Open request demo page</a></li>
            <li><a href="${safeHtml(
              quickLinks.contactSalesUrl
            )}" style="color:#2563EB; text-decoration:none;">Open contact sales page</a></li>
            ${
              quickLinks.bookingUrl
                ? `<li><a href="${safeHtml(
                    quickLinks.bookingUrl
                  )}" style="color:#2563EB; text-decoration:none;">Open booking</a></li>`
                : ""
            }
          </ul>
        `
        : "";

      const adminConsoleUrl = buildAdminLeadUrl({
        kind: "demo-request",
        id: params.requestId,
      });

      const detail = (label: string, value?: string | null) =>
        value && String(value).trim()
          ? `<tr><td style="padding:5px 14px 5px 0; color:#64748B; font-size:13px; vertical-align:top; white-space:nowrap;">${safeHtml(
              label
            )}</td><td style="padding:5px 0; color:#07132B; font-size:13px; font-weight:600;">${safeHtml(
              String(value)
            )}</td></tr>`
          : "";

      const html = emailShell({
        title: "New demo request",
        preheader: `New demo request from ${params.fullName}.`,
        ctaText: "Open in admin console",
        ctaUrl: adminConsoleUrl,
        bodyHtml: `
          <div style="margin:0 0 14px 0;">
            A new demo request was submitted through the ${safeHtml(
              brandName()
            )} website.
          </div>

          <div style="margin:14px 0 6px 0; color:#07132B;"><strong>Requester</strong></div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:0 0 10px 0;">
            ${detail("Name", params.fullName)}
            ${detail("Work email", params.workEmail)}
            ${detail("Organization", params.organization)}
            ${detail("Job title", params.jobTitle)}
            ${detail("Country", params.country)}
            ${detail("Workspace size", params.teamSize)}
          </table>

          <div style="margin:14px 0 6px 0; color:#07132B;"><strong>Request</strong></div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:0 0 10px 0;">
            ${detail("Use case", params.useCase)}
            ${detail("Recommended action", params.recommendedAction)}
            ${detail("Priority", params.priority)}
          </table>
          ${
            params.message && params.message.trim()
              ? `<div style="margin:0 0 12px 0; padding:10px 14px; background:#F8FAFC; border:1px solid #E5E7EB; border-radius:10px; color:#0F172A; font-size:13.5px; line-height:1.55; white-space:pre-wrap;">${safeHtml(
                  params.message
                )}</div>`
              : ""
          }

          <div style="margin:14px 0 6px 0; color:#07132B;"><strong>Source</strong></div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:0 0 10px 0;">
            ${detail("Source path", params.sourcePath)}
            ${detail("Submitted at", new Date().toISOString())}
            ${detail("Referrer", params.referrer)}
            ${detail("Record ID", params.requestId)}
          </table>

          ${quickLinksHtml}
        `.trim(),
      });

      const text = [
        "New demo request",
        `Request ID: ${params.requestId}`,
        `Name: ${params.fullName}`,
        `Work email: ${params.workEmail}`,
        `Organization: ${params.organization ?? "-"}`,
        `Job title: ${params.jobTitle ?? "-"}`,
        `Country: ${params.country ?? "-"}`,
        `Team size: ${params.teamSize ?? "-"}`,
        `Source: ${params.source ?? "-"}`,
        `Source path: ${params.sourcePath ?? "-"}`,
        `Referrer: ${params.referrer ?? "-"}`,
        `UTM source: ${params.utmSource ?? "-"}`,
        `UTM medium: ${params.utmMedium ?? "-"}`,
        `UTM campaign: ${params.utmCampaign ?? "-"}`,
        `UTM term: ${params.utmTerm ?? "-"}`,
        `UTM content: ${params.utmContent ?? "-"}`,
        "",
        "Qualification",
        `Priority: ${params.priority ?? "-"}`,
        `Lead quality: ${params.leadQuality ?? "-"}`,
        `Lead track: ${params.leadTrack ?? "-"}`,
        `Recommended action: ${params.recommendedAction ?? "-"}`,
        `Response SLA: ${
          params.responseSlaHours != null ? `${params.responseSlaHours}h` : "-"
        }`,
        `Qualification score: ${
          params.qualificationScore != null
            ? String(params.qualificationScore)
            : "-"
        }`,
        "Qualification reasons:",
        ...(qualificationReasons.length > 0
          ? qualificationReasons.map((reason) => `- ${prettyReason(reason)}`)
          : ["- No qualification reasons recorded."]),
        "",
        "Spam assessment",
        `Spam score: ${String(params.spamScore ?? 0)}`,
        `Flagged as spam: ${params.isSpam ? "yes" : "no"}`,
        "",
        "Use case:",
        params.useCase,
        "",
        "Message:",
        params.message ?? "-",
        "",
        `Open in admin console: ${adminConsoleUrl}`,
        "",
        ...(quickLinks
          ? [
              "Quick actions:",
              `Reply to lead: ${quickLinks.replyToLeadMailto}`,
              `Sample report: ${quickLinks.sampleReportUrl}`,
              `Verification demo: ${quickLinks.verificationDemoUrl}`,
              `Methodology: ${quickLinks.methodologyUrl}`,
              `Pricing: ${quickLinks.pricingUrl}`,
              `Request demo page: ${quickLinks.requestDemoUrl}`,
              `Contact sales page: ${quickLinks.contactSalesUrl}`,
              ...(quickLinks.bookingUrl
                ? [`Booking: ${quickLinks.bookingUrl}`]
                : []),
            ]
          : []),
      ].join("\n");

      return transportSend({
        templateKey: "demo_request_notification",
        keyParts: [params.to, params.requestId],
        to: params.to,
        subject: `New demo request — ${params.fullName}`,
        html,
        text,
      });
    },

    async sendDemoRequestAutoReply(params) {
      // Quick links kept in plaintext but rendered in HTML as a compact
      // 3-link secondary row (Sample Report / Methodology / Pricing) per
      // spec — booking link appended if configured.
      const trustCenterUrl = `${webBaseUrl().replace(/\/+$/, "")}/trust`;

      const secondaryLinks: Array<{ label: string; url: string }> = [
        { label: "Verification Methodology", url: params.methodologyUrl },
        { label: "Sample Report", url: params.sampleReportUrl },
        { label: "Pricing", url: params.pricingUrl },
      ];
      if (params.bookingUrl) {
        secondaryLinks.push({
          label: "Book a walkthrough",
          url: params.bookingUrl,
        });
      }

      const html = emailShell({
        title: "Your demo request has been received",
        preheader: `Thank you for contacting ${brandName()}.`,
        bodyHtml: `
          <div style="margin:0 0 14px 0;">
            Hello <strong>${safeHtml(params.fullName)}</strong>,
          </div>
          <div style="margin:0 0 12px 0;">
            Thank you for contacting ${safeHtml(brandName())}.
          </div>
          <div style="margin:0;">
            A member of our team will review your request and contact you if
            the workflow is a fit for a live walkthrough.
          </div>
        `.trim(),
        ctaText: "Visit Trust Center",
        ctaUrl: trustCenterUrl,
        secondaryLinks,
        noticeText:
          "For security, procurement, or legal review, the Trust Center provides public documentation.",
      });

      void params.responseWindowText;

      const text = [
        `Hello ${params.fullName},`,
        "",
        `Thank you for contacting ${brandName()}. Your demo request has been received.`,
        `A member of our team will review your request and contact you if the workflow is a fit for a live walkthrough.`,
        "",
        "Helpful resources:",
        `- Sample report: ${params.sampleReportUrl}`,
        `- Verification demo: ${params.verificationDemoUrl}`,
        `- Methodology: ${params.methodologyUrl}`,
        `- Pricing: ${params.pricingUrl}`,
        ...(params.bookingUrl ? [`- Booking: ${params.bookingUrl}`] : []),
        "",
        `Support: ${supportEmail()}`,
      ].join("\n");

      return transportSend({
        templateKey: "demo_request_auto_reply",
        keyParts: [params.to, params.fullName, params.responseWindowText],
        to: params.to,
        subject: `We received your ${brandName()} demo request`,
        html,
        text,
      });
    },

    async sendDemoRequestFollowUp(params) {
      const content = buildFollowUpContent(params.step);

      const ctaUrl =
        params.step === 1
          ? params.verificationDemoUrl
          : params.step === 2
          ? params.sampleReportUrl
          : params.bookingUrl ?? params.requestDemoUrl;

      // Per-step secondary links, capped at the spec's two-link set.
      const secondaryLinks: Array<{ label: string; url: string }> =
        params.step === 1
          ? [
              { label: "Sample Report", url: params.sampleReportUrl },
              { label: "Verification Methodology", url: params.methodologyUrl },
            ]
          : params.step === 2
          ? [
              { label: "Verification Demo", url: params.verificationDemoUrl },
              { label: "Verification Methodology", url: params.methodologyUrl },
            ]
          : [
              { label: "Contact Sales", url: params.contactSalesUrl },
              {
                label: "Trust Center",
                url: `${webBaseUrl().replace(/\/+$/, "")}/trust`,
              },
            ];

      const html = emailShell({
        title: content.title,
        preheader: content.preheader,
        bodyHtml: `
          <div style="margin:0 0 14px 0;">
            Hello <strong>${safeHtml(params.fullName)}</strong>,
          </div>
          <div style="margin:0;">
            ${safeHtml(content.intro)}
          </div>
        `.trim(),
        ctaText: content.ctaText,
        ctaUrl,
        secondaryLinks,
      });

      const text = [
        `Hello ${params.fullName},`,
        "",
        content.intro,
        "",
        "Useful next links:",
        `- Sample report: ${params.sampleReportUrl}`,
        `- Verification demo: ${params.verificationDemoUrl}`,
        `- Methodology: ${params.methodologyUrl}`,
        `- Pricing: ${params.pricingUrl}`,
        `- Request demo: ${params.requestDemoUrl}`,
        `- Contact sales: ${params.contactSalesUrl}`,
        ...(params.bookingUrl ? [`- Booking: ${params.bookingUrl}`] : []),
        "",
        `Support: ${supportEmail()}`,
      ].join("\n");

      return transportSend({
        templateKey: "demo_request_follow_up",
        // Durable request id plus step — NOT the recipient. The follow-up
        // sweep retries a step it could not confirm, and that retry must reach
        // the provider as the SAME message; the durable id is what makes the
        // key stable, and keeping the address out of the preimage is what
        // keeps it opaque.
        keyParts: [params.demoRequestId, String(params.step)],
        to: params.to,
        subject: content.subject,
        html,
        text,
      });
    },

    // ────────────────────────────────────────────────────────────────
    // Contact Sales — operator notification
    //
    // Sent to CONTACT_SALES_NOTIFICATION_EMAIL (with DEMO_REQUEST_
    // NOTIFICATION_EMAIL → SUPPORT_EMAIL → support@proovra.com
    // fallback resolved by the caller). Body never contains visitor
    // tokens, link secrets, or IP geolocation — only the form fields
    // the visitor submitted plus the synthetic record id for admin
    // deep-linking.
    // ────────────────────────────────────────────────────────────────
    async sendContactSalesNotification(params) {
      const app = brandName();
      const subject = `New contact sales inquiry — ${params.organization}`;
      const escalation =
        params.priority === "HIGH"
          ? `<div style="margin:0 0 14px 0; padding:10px 14px; background:#FEF3C7; border:1px solid #FCD34D; border-radius:10px; font-weight:700; color:#92400E; font-size:13px;">High priority — respond within the published SLA window.</div>`
          : "";

      const detail = (label: string, value?: string | null) =>
        value && String(value).trim()
          ? `<tr><td style="padding:5px 14px 5px 0; color:#64748B; font-size:13px; vertical-align:top; white-space:nowrap;">${safeHtml(
              label
            )}</td><td style="padding:5px 0; color:#07132B; font-size:13px; font-weight:600;">${safeHtml(
              String(value)
            )}</td></tr>`
          : "";

      const bodyHtml = `
        ${escalation}
        <div style="margin:0 0 14px 0;">
          A new contact sales inquiry was submitted through the ${safeHtml(
            app
          )} website.
        </div>

        <div style="margin:14px 0 6px 0; color:#07132B;"><strong>Contact</strong></div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:0 0 10px 0;">
          ${detail("Name", params.fullName)}
          ${detail("Work email", params.workEmail)}
          ${detail("Organization", params.organization)}
          ${detail("Job title", params.jobTitle)}
        </table>

        <div style="margin:14px 0 6px 0; color:#07132B;"><strong>Inquiry</strong></div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:0 0 10px 0;">
          ${detail("Topic", params.discussionTopic)}
          ${detail("Current stage", params.stage)}
          ${detail("Timeline", params.deploymentTimeline)}
          ${detail("Estimated users", params.estimatedUsers)}
        </table>
        <div style="margin:0 0 12px 0; padding:10px 14px; background:#F8FAFC; border:1px solid #E5E7EB; border-radius:10px; color:#0F172A; font-size:13.5px; line-height:1.55; white-space:pre-wrap;"><strong style="display:block; margin:0 0 4px 0; color:#475569; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Challenge</strong>${safeHtml(
          params.currentChallenge
        )}</div>
        ${
          params.additionalDetails
            ? `<div style="margin:0 0 12px 0; padding:10px 14px; background:#F8FAFC; border:1px solid #E5E7EB; border-radius:10px; color:#0F172A; font-size:13.5px; line-height:1.55; white-space:pre-wrap;"><strong style="display:block; margin:0 0 4px 0; color:#475569; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em;">Additional details</strong>${safeHtml(
                params.additionalDetails
              )}</div>`
            : ""
        }

        <div style="margin:14px 0 6px 0; color:#07132B;"><strong>Routing</strong></div>
        <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin:0 0 10px 0;">
          ${detail("Priority", params.priority)}
          ${detail("Source path", params.sourcePath)}
          ${detail("Submitted at", new Date().toISOString())}
          ${detail("Record ID", params.requestId)}
        </table>
      `.trim();

      const html = emailShell({
        title: "New contact sales inquiry",
        preheader: `${params.organization} — ${params.discussionTopic} · ${params.stage}`,
        bodyHtml,
        ctaText: "Open in admin console",
        ctaUrl: buildAdminLeadUrl({
          kind: "contact-sales",
          id: params.requestId,
        }),
        noticeText:
          "Reply directly to the visitor's work email above. Do not forward this notification externally.",
      });

      const lines = [
        `New contact-sales inquiry on ${app}`,
        "",
        `From: ${params.fullName} <${params.workEmail}>`,
        `Organization: ${params.organization}`,
      ];
      if (params.jobTitle) lines.push(`Job title: ${params.jobTitle}`);
      if (params.country) lines.push(`Country: ${params.country}`);
      if (params.teamSize) lines.push(`Team size: ${params.teamSize}`);
      lines.push(`Topic: ${params.discussionTopic}`);
      lines.push(`Stage: ${params.stage}`);
      if (params.deploymentTimeline)
        lines.push(`Timeline: ${params.deploymentTimeline}`);
      if (params.estimatedUsers)
        lines.push(`Estimated users: ${params.estimatedUsers}`);
      lines.push("", "Current challenge:", params.currentChallenge);
      if (params.additionalDetails)
        lines.push("", "Additional details:", params.additionalDetails);
      lines.push(
        "",
        `Record id: ${params.requestId}`,
        `Source: ${params.source ?? "website"}${
          params.sourcePath ? ` (${params.sourcePath})` : ""
        }`,
        `Support: ${supportEmail()}`
      );

      return transportSend({
        templateKey: "contact_sales_notification",
        keyParts: [params.to, params.requestId],
        to: params.to,
        subject,
        html,
        text: lines.join("\n"),
      });
    },

    // ────────────────────────────────────────────────────────────────
    // Contact Sales — visitor auto-reply (no enterprise-routing
    // language; spec calls for "your inquiry has been submitted").
    // ────────────────────────────────────────────────────────────────
    async sendContactSalesAutoReply(params) {
      const app = brandName();
      const subject = `We received your inquiry`;
      const trustCenterUrl = `${webBaseUrl().replace(/\/+$/, "")}/trust`;
      const supportCenterUrl = `${webBaseUrl().replace(/\/+$/, "")}/support`;

      const html = emailShell({
        title: "Your inquiry has been received",
        preheader: `Thank you for contacting ${app}.`,
        bodyHtml: `
          <div style="margin:0 0 14px 0;">
            Hello <strong>${safeHtml(params.fullName)}</strong>,
          </div>
          <div style="margin:0 0 12px 0;">
            Thank you for contacting ${safeHtml(app)}.
          </div>
          <div style="margin:0;">
            Your inquiry has been submitted successfully and will be reviewed
            by the appropriate team.
          </div>
        `.trim(),
        ctaText: "Visit Trust Center",
        ctaUrl: trustCenterUrl,
        secondaryLinks: [
          { label: "Pricing", url: params.pricingUrl },
          {
            label: "Verification Methodology",
            url: params.methodologyUrl,
          },
          { label: "Support Center", url: supportCenterUrl },
        ],
        noticeText:
          "If your request relates to privacy, abuse, law-enforcement, or security vulnerabilities, use the dedicated request path in the Trust Center.",
      });

      void params.sampleReportUrl;
      void params.verificationDemoUrl;

      const text = [
        `Hello ${params.fullName},`,
        "",
        `Thank you for contacting ${app}. Your inquiry has been submitted successfully and will be reviewed by the appropriate team.`,
        "",
        "Useful resources:",
        `- Sample report: ${params.sampleReportUrl}`,
        `- Verification demo: ${params.verificationDemoUrl}`,
        `- Methodology: ${params.methodologyUrl}`,
        `- Pricing: ${params.pricingUrl}`,
        `- Trust Center: ${trustCenterUrl}`,
        "",
        `Support: ${supportEmail()}`,
      ].join("\n");

      return transportSend({
        templateKey: "contact_sales_auto_reply",
        keyParts: [params.to, params.fullName],
        to: params.to,
        subject,
        html,
        text,
      });
    },
  };

  return singleton;
}