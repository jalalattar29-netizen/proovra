import { Resend } from "resend";
// Phase O1.5E — bounded smtp.email_send span.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../observability/otel.js";

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
  ) => Promise<unknown>;

  // EV2 — enterprise email verification.
  // Sent on email/password registration and on resend. The verifyUrl
  // points at /auth/verify-email?token=<raw> on the public web app.
  // Subject + body are deliberately minimal so the email reads like
  // Stripe / Linear / Vanta transactional mail, not marketing.
  sendEmailVerificationEmail: (
    email: string,
    verifyUrl: string
  ) => Promise<unknown>;

  // PHASE R8.1.5 — verified-email preflight for lost-factor MFA
  // recovery. The body carries a verification LINK (not the token
  // itself in plaintext URL params — the link points to a web page
  // that takes the user through a guided verification). Subject and
  // body language make clear this confirms mailbox access only and
  // does NOT replace MFA or grant a session.
  sendMfaRecoveryVerificationEmail: (
    email: string,
    verificationUrl: string
  ) => Promise<unknown>;

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
  ) => Promise<unknown>;

  sendTeamInvitation: (
    email: string,
    orgName: string,
    invitationToken: string
  ) => Promise<unknown>;

  sendBatchComplete: (
    email: string,
    orgName: string,
    batchName: string,
    totalItems: number,
    failedItems: number,
    batchUrl: string
  ) => Promise<unknown>;

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
  }) => Promise<unknown>;

  sendDemoRequestAutoReply: (params: {
    to: string;
    fullName: string;
    responseWindowText: string;
    sampleReportUrl: string;
    verificationDemoUrl: string;
    methodologyUrl: string;
    pricingUrl: string;
    bookingUrl?: string | null;
  }) => Promise<unknown>;

  sendDemoRequestFollowUp: (params: {
    to: string;
    fullName: string;
    step: 1 | 2 | 3;
    sampleReportUrl: string;
    verificationDemoUrl: string;
    methodologyUrl: string;
    pricingUrl: string;
    bookingUrl?: string | null;
    requestDemoUrl: string;
    contactSalesUrl: string;
  }) => Promise<unknown>;

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
  }) => Promise<unknown>;

  sendContactSalesAutoReply: (params: {
    to: string;
    fullName: string;
    sampleReportUrl: string;
    verificationDemoUrl: string;
    methodologyUrl: string;
    pricingUrl: string;
  }) => Promise<unknown>;
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

function logoUrl(): string | undefined {
  const u = env("EMAIL_LOGO_URL");
  return u ? u : undefined;
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
  const base = webBaseUrl().replace(/\/$/, "");
  return `${base}/invite/${encodeURIComponent(invitationToken)}`;
}

function emailShell(params: {
  title: string;
  preheader: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  secondaryText?: string;
}) {
  const appName = brandName();
  const base = webBaseUrl().replace(/\/$/, "");
  const logo = logoUrl();

  const title = safeHtml(params.title);
  const preheader = safeHtml(params.preheader);
  const secondaryText = params.secondaryText
    ? safeHtml(params.secondaryText)
    : "";

  const ctaText = params.ctaText ? safeHtml(params.ctaText) : "";
  const ctaUrl = params.ctaUrl ? String(params.ctaUrl) : "";

  const year = new Date().getFullYear();

  const ctaBlock =
    params.ctaText && params.ctaUrl
      ? `
        <tr>
          <td style="padding: 0 28px 18px 28px;">
            <a href="${ctaUrl}"
               style="
                 display:inline-block;
                 background:#0f172a;
                 color:#ffffff;
                 text-decoration:none;
                 padding:12px 18px;
                 border-radius:9999px;
                 font-weight:700;
                 font-size:14px;
                 line-height:14px;
               ">
              ${ctaText}
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 28px 18px 28px; color:#64748b; font-size:12px; line-height:18px;">
            If the button doesn’t work, copy and paste this link into your browser:
            <div style="word-break: break-all; margin-top:8px;">
              <a href="${ctaUrl}" style="color:#2563eb; text-decoration:none;">${safeHtml(
                ctaUrl
              )}</a>
            </div>
          </td>
        </tr>
      `
      : "";

  const headerLogo = logo
    ? `
      <tr>
        <td style="padding: 24px 0 8px 0; text-align:center;">
          <a href="${base}" style="text-decoration:none;">
            <img
              src="${logo}"
              width="140"
              alt="${safeHtml(appName)}"
              style="display:block; margin:0 auto; border:0; outline:none; text-decoration:none;"
            />
          </a>
        </td>
      </tr>
    `
    : `
      <tr>
        <td style="padding: 24px 0 8px 0; text-align:center; font-weight:800; font-size:18px; color:#0f172a;">
          <a href="${base}" style="color:#0f172a; text-decoration:none;">${safeHtml(
            appName
          )}</a>
        </td>
      </tr>
    `;

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background:#f1f5f9;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9; padding:0; margin:0;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            style="max-width:560px; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(2,6,23,0.10);"
          >
            ${headerLogo}

            <tr>
              <td style="padding: 6px 28px 0 28px; text-align:center;">
                <div style="font-size:20px; line-height:28px; font-weight:800; color:#0f172a;">
                  ${title}
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 28px 18px 28px; color:#334155; font-size:14px; line-height:22px;">
                ${params.bodyHtml}
              </td>
            </tr>

            ${ctaBlock}

            ${
              secondaryText
                ? `
                <tr>
                  <td style="padding: 0 28px 20px 28px; color:#64748b; font-size:12px; line-height:18px;">
                    ${secondaryText}
                  </td>
                </tr>
                `
                : ""
            }

            <tr>
              <td style="padding:16px 28px; background:#f8fafc; border-top:1px solid #e2e8f0; color:#64748b; font-size:12px; line-height:18px;">
                <div style="margin-bottom:8px;">
                  Need help? Contact us at
                  <a href="mailto:${safeHtml(
                    supportEmail()
                  )}" style="color:#2563eb; text-decoration:none;">
                    ${safeHtml(supportEmail())}
                  </a>
                </div>
                <div>
                  © ${year} ${safeHtml(appName)} ·
                  <a href="${base}" style="color:#2563eb; text-decoration:none;">${safeHtml(
                    base
                  )}</a>
                </div>
              </td>
            </tr>
          </table>

          <div style="max-width:560px; margin:14px auto 0 auto; color:#94a3b8; font-size:11px; line-height:16px; text-align:center;">
            Please don’t reply to this email. This inbox is not monitored.
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
      subject: `Still reviewing PROOVRA?`,
      title: "A quick follow-up on your PROOVRA request",
      preheader: "A short reminder with the most useful PROOVRA resources.",
      intro:
        "Just following up in case your demo request is still active. The links below are usually the fastest way to evaluate the workflow before a live walkthrough.",
      ctaText: "Open verification demo",
    };
  }

  if (step === 2) {
    return {
      subject: `See the workflow more clearly`,
      title: "A clearer way to evaluate the workflow",
      preheader: "Resources to help you review the PROOVRA workflow in practice.",
      intro:
        "If you are still evaluating fit, these materials usually answer the practical questions faster than another confirmation email.",
      ctaText: "View sample report",
    };
  }

  return {
    subject: `Still interested in a walkthrough?`,
    title: "Final follow-up on your PROOVRA request",
    preheader: "One last check-in on your demo request.",
    intro:
      "This is a final follow-up in case the request is still relevant. If the workflow is still active on your side, you can use the links below to continue or book a walkthrough.",
    ctaText: "Book a walkthrough",
  };
}

// Phase 8 — generic Resend send helper, shared by the EmailService
// singleton AND the Phase 8 notification orchestrator. Keeping a single
// Resend client across the codebase avoids duplicate connections, dual
// rate-limit accounting, and divergent retry policies.
let resendSingleton: Resend | null = null;

function getResendClient(): Resend | null {
  if (resendSingleton) return resendSingleton;
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return null;
  resendSingleton = new Resend(apiKey);
  return resendSingleton;
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
}): Promise<SendCustomEmailResult> {
  const client = getResendClient();
  if (!client) {
    return {
      ok: false,
      errorCode: "not_configured",
      errorMessage: "RESEND_API_KEY is not set",
    };
  }
  try {
    const result = (await client.emails.send({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })) as unknown as {
      id?: string;
      data?: { id?: string } | null;
      error?: { message?: string; name?: string } | null;
    };

    if (result?.error) {
      return {
        ok: false,
        errorCode: String(result.error.name ?? "resend_error"),
        errorMessage: String(result.error.message ?? "unknown_resend_error"),
      };
    }
    const id = result?.data?.id ?? result?.id ?? null;
    return { ok: true, providerMessageId: id };
  } catch (err) {
    return {
      ok: false,
      errorCode: "exception",
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

let singleton: EmailService | null = null;

export function getEmailService(): EmailService {
  if (singleton) return singleton;

  const apiKey = env("RESEND_API_KEY");
  const from = fromHeader();

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

  const resend = new Resend(apiKey);

  singleton = {
    isConfigured: () => true,

    async sendPasswordResetEmail(email: string, resetUrl: string) {
      const app = brandName();

      const html = emailShell({
        title: "Reset your password",
        preheader: `Reset your ${app} password.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            We received a request to reset the password for your <strong>${safeHtml(
              app
            )}</strong> account.
          </div>
          <div style="margin:0 0 10px 0;">
            Click the button below to choose a new password.
          </div>
        `.trim(),
        ctaText: "Reset password",
        ctaUrl: resetUrl,
        secondaryText:
          "If you did not request this reset, you can safely ignore this email. Your password will not change unless this link is used.",
      });

      const text =
        `Reset your ${app} password\n\n` +
        `We received a request to reset the password for your ${app} account.\n` +
        `Open this link to choose a new password:\n${resetUrl}\n\n` +
        `If you did not request this reset, you can safely ignore this email.\n` +
        `Your password will not change unless this link is used.\n\n` +
        `Support: ${supportEmail()}\n`;

      return resend.emails.send({
        from,
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
        preheader: `Confirm ownership of this email to activate your ${app} account.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            Thank you for creating a <strong>${safeHtml(app)}</strong> account.
          </div>
          <div style="margin:0 0 10px 0;">
            Before you can access your workspace, please verify ownership of this
            email address.
          </div>
        `.trim(),
        ctaText: "Verify email address",
        ctaUrl: verifyUrl,
        secondaryText:
          "If you did not create this account, you can safely ignore this email.",
      });

      const text =
        `Verify your ${app} email address\n\n` +
        `Thank you for creating a ${app} account.\n` +
        `Before you can access your workspace, please verify ownership of\n` +
        `this email address by opening the link below:\n\n` +
        `${verifyUrl}\n\n` +
        `If you did not create this account, ignore this email.\n` +
        `Support: ${supportEmail()}\n`;

      return resend.emails.send({
        from,
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
      const app = brandName();
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
          <div style="margin:12px 0 0 0; padding:10px 14px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; color:#475569;">
            Not ready to review now?
            <a href="${safeHtml(snoozeUrl)}"
               style="color:#2563eb; text-decoration:none; font-weight:600;">
              Snooze these digest emails for 15 days
            </a>
            — security events and audit logs are unaffected.
          </div>
        `.trim()
        : "";
      const snoozeTextLine = snoozeUrl
        ? `To snooze digest emails for 15 days: ${snoozeUrl}\n`
        : "";
      const html = emailShell({
        title: "Pending MFA recovery requests",
        preheader: `You have ${safeCount} pending recovery request${
          safeCount === 1 ? "" : "s"
        } awaiting your review.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            Members of <strong>${safeHtml(teamDisplayName)}</strong> have
            requested two-factor authentication recovery and verified
            their mailbox. Their requests have been waiting more than
            24 hours for an administrator decision.
          </div>
          <div style="margin:0 0 10px 0;">
            Open the admin console below to review and approve or
            reject each request.
          </div>
          <div style="margin:0 0 10px 0;">
            <strong>${safeCount}</strong> pending request${
              safeCount === 1 ? "" : "s"
            }
          </div>
          <div style="margin:0 0 10px 0; color:#475569; font-size:13px;">
            Approving a request revokes the user&apos;s MFA factors and
            forces them to re-enroll on their next sign-in. It does
            NOT grant the user a session.
          </div>
          ${snoozeHtmlBlock}
        `.trim(),
        ctaText: "Open admin console",
        ctaUrl: adminSpaUrl,
        secondaryText:
          "If you are no longer an administrator of this workspace, you can ignore this email.",
      });
      const text =
        `Pending MFA recovery requests for ${teamDisplayName} on ${app}\n\n` +
        `${safeCount} request${safeCount === 1 ? "" : "s"} awaiting review.\n` +
        `Open the admin console: ${adminSpaUrl}\n\n` +
        `Approving a request does NOT grant a session — the user must still re-enroll.\n` +
        snoozeTextLine +
        `Support: ${supportEmail()}\n`;
      return resend.emails.send({
        from,
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
        preheader: `Confirm you initiated an MFA recovery on ${app}.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            We received a request to reset the two-factor
            authentication on your <strong>${safeHtml(app)}</strong>
            account.
          </div>
          <div style="margin:0 0 10px 0;">
            Click the button below to confirm this request was you.
            This step ONLY confirms that you can access this mailbox
            — your organization's administrator must still approve
            the reset before MFA is changed.
          </div>
          <div style="margin:0 0 10px 0;">
            This link expires in 15 minutes.
          </div>
        `.trim(),
        ctaText: "Confirm recovery request",
        ctaUrl: verificationUrl,
        secondaryText:
          "If you did not initiate this recovery request, ignore this email and notify your administrator.",
      });
      const text =
        `Verify your ${app} MFA recovery request\n\n` +
        `Confirm you initiated the recovery by opening this link:\n${verificationUrl}\n\n` +
        `This only confirms mailbox access. Your administrator must still approve the reset.\n` +
        `If you did not request this, ignore this email and notify your administrator.\n` +
        `Support: ${supportEmail()}\n`;
      return resend.emails.send({
        from,
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

      const html = emailShell({
        title: "You’re invited",
        preheader: `Join ${orgName} on ${brandName()}.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            You have been invited to join <strong>${safeHtml(
              orgName
            )}</strong> on <strong>${safeHtml(brandName())}</strong>.
          </div>
          <div style="margin:0 0 10px 0;">
            Click the button below to review and accept your invitation.
          </div>
        `.trim(),
        ctaText: "Accept invitation",
        ctaUrl: url,
        secondaryText:
          "If you weren’t expecting this invitation, you can ignore this email.",
      });

      const text =
        `You're invited to join ${orgName} on ${brandName()}.\n\n` +
        `Accept invitation:\n${url}\n\n` +
        `If you were not expecting this, you can ignore this email.\n`;

      return resend.emails.send({
        from,
        to: email,
        subject: `You're invited to join ${orgName} on ${brandName()}`,
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
        preheader: `Your batch "${batchName}" has completed.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            <strong>${safeHtml(orgName)}</strong> batch <strong>${safeHtml(
          batchName
        )}</strong> has completed.
          </div>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 0 0; border-collapse:collapse;">
            <tr>
              <td style="padding:4px 10px 4px 0; color:#64748b;">Total</td>
              <td style="padding:4px 0; font-weight:700; color:#0f172a;">${total}</td>
            </tr>
            <tr>
              <td style="padding:4px 10px 4px 0; color:#64748b;">Succeeded</td>
              <td style="padding:4px 0; font-weight:700; color:#0f172a;">${succeeded}</td>
            </tr>
            <tr>
              <td style="padding:4px 10px 4px 0; color:#64748b;">Failed</td>
              <td style="padding:4px 0; font-weight:700; color:#0f172a;">${failed}</td>
            </tr>
          </table>
        `.trim(),
        ctaText: "View results",
        ctaUrl: batchUrl,
      });

      const text =
        `Batch complete: ${batchName}\n` +
        `Org: ${orgName}\n` +
        `Total: ${total}\nSucceeded: ${succeeded}\nFailed: ${failed}\n\n` +
        `View results: ${batchUrl}\n`;

      return resend.emails.send({
        from,
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

      const reasonsHtml =
        qualificationReasons.length > 0
          ? qualificationReasons
              .map(
                (reason) =>
                  `<li style="margin:0 0 6px 0;">${safeHtml(
                    prettyReason(reason)
                  )}</li>`
              )
              .join("")
          : `<li style="margin:0 0 6px 0;">No qualification reasons recorded.</li>`;

      const quickLinks = params.quickLinks;

      const quickLinksHtml = quickLinks
        ? `
          <div style="margin:18px 0 8px 0;"><strong>Quick actions</strong></div>
          <ul style="margin:0; padding-left:18px; color:#334155;">
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.replyToLeadMailto
            )}" style="color:#2563eb; text-decoration:none;">Reply to lead</a></li>
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.sampleReportUrl
            )}" style="color:#2563eb; text-decoration:none;">Open sample report</a></li>
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.verificationDemoUrl
            )}" style="color:#2563eb; text-decoration:none;">Open verification demo</a></li>
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.methodologyUrl
            )}" style="color:#2563eb; text-decoration:none;">Open methodology</a></li>
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.pricingUrl
            )}" style="color:#2563eb; text-decoration:none;">Open pricing</a></li>
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.requestDemoUrl
            )}" style="color:#2563eb; text-decoration:none;">Open request demo page</a></li>
            <li style="margin:0 0 6px 0;"><a href="${safeHtml(
              quickLinks.contactSalesUrl
            )}" style="color:#2563eb; text-decoration:none;">Open contact sales page</a></li>
            ${
              quickLinks.bookingUrl
                ? `<li style="margin:0 0 6px 0;"><a href="${safeHtml(
                    quickLinks.bookingUrl
                  )}" style="color:#2563eb; text-decoration:none;">Open booking</a></li>`
                : ""
            }
          </ul>
        `
        : "";

      const adminConsoleUrl = buildAdminLeadUrl({
        kind: "demo-request",
        id: params.requestId,
      });

      const html = emailShell({
        title: "New demo request",
        preheader: `New demo request from ${params.fullName}.`,
        ctaText: "Open in admin console",
        ctaUrl: adminConsoleUrl,
        bodyHtml: `
          <div style="margin:0 0 10px 0;"><strong>Request ID:</strong> ${safeHtml(
            params.requestId
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Name:</strong> ${safeHtml(
            params.fullName
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Work email:</strong> ${safeHtml(
            params.workEmail
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Organization:</strong> ${safeHtml(
            params.organization ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Job title:</strong> ${safeHtml(
            params.jobTitle ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Country:</strong> ${safeHtml(
            params.country ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Team size:</strong> ${safeHtml(
            params.teamSize ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Source:</strong> ${safeHtml(
            params.source ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Source path:</strong> ${safeHtml(
            params.sourcePath ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Referrer:</strong> ${safeHtml(
            params.referrer ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>UTM source:</strong> ${safeHtml(
            params.utmSource ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>UTM medium:</strong> ${safeHtml(
            params.utmMedium ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>UTM campaign:</strong> ${safeHtml(
            params.utmCampaign ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>UTM term:</strong> ${safeHtml(
            params.utmTerm ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>UTM content:</strong> ${safeHtml(
            params.utmContent ?? "-"
          )}</div>

          <div style="margin:18px 0 8px 0;"><strong>Qualification</strong></div>
          <div style="margin:0 0 10px 0;"><strong>Priority:</strong> ${safeHtml(
            params.priority ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Lead quality:</strong> ${safeHtml(
            params.leadQuality ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Lead track:</strong> ${safeHtml(
            params.leadTrack ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Recommended action:</strong> ${safeHtml(
            params.recommendedAction ?? "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Response SLA:</strong> ${safeHtml(
            params.responseSlaHours != null
              ? `${params.responseSlaHours}h`
              : "-"
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Qualification score:</strong> ${safeHtml(
            params.qualificationScore != null
              ? String(params.qualificationScore)
              : "-"
          )}</div>

          <div style="margin:14px 0 8px 0;"><strong>Qualification reasons</strong></div>
          <ul style="margin:0; padding-left:18px; color:#334155;">
            ${reasonsHtml}
          </ul>

          <div style="margin:18px 0 8px 0;"><strong>Spam assessment</strong></div>
          <div style="margin:0 0 10px 0;"><strong>Spam score:</strong> ${safeHtml(
            String(params.spamScore ?? 0)
          )}</div>
          <div style="margin:0 0 10px 0;"><strong>Flagged as spam:</strong> ${safeHtml(
            params.isSpam ? "yes" : "no"
          )}</div>

          <div style="margin:14px 0 8px 0;"><strong>Use case</strong></div>
          <div style="white-space:pre-wrap; color:#334155;">${safeHtml(
            params.useCase
          )}</div>

          <div style="margin:14px 0 8px 0;"><strong>Message</strong></div>
          <div style="white-space:pre-wrap; color:#334155;">${safeHtml(
            params.message ?? "-"
          )}</div>

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

      return resend.emails.send({
        from,
        to: params.to,
        subject: `New demo request — ${params.fullName}`,
        html,
        text,
      });
    },

    async sendDemoRequestAutoReply(params) {
      const bookingLine = params.bookingUrl
        ? `
          <div style="margin:0 0 10px 0;">
            If you already know you want a walkthrough, you can also use the booking link below.
          </div>
        `
        : "";

      const resourcesHtml = `
        <div style="margin:14px 0 8px 0;"><strong>Helpful resources</strong></div>
        <ul style="margin:0; padding-left:18px; color:#334155;">
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.sampleReportUrl
          )}" style="color:#2563eb; text-decoration:none;">View a sample report</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.verificationDemoUrl
          )}" style="color:#2563eb; text-decoration:none;">Open the verification demo</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.methodologyUrl
          )}" style="color:#2563eb; text-decoration:none;">Review the verification methodology</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.pricingUrl
          )}" style="color:#2563eb; text-decoration:none;">Review pricing</a></li>
          ${
            params.bookingUrl
              ? `<li style="margin:0 0 6px 0;"><a href="${safeHtml(
                  params.bookingUrl
                )}" style="color:#2563eb; text-decoration:none;">Book a walkthrough</a></li>`
              : ""
          }
        </ul>
      `;

      const html = emailShell({
        title: "We received your demo request",
        preheader: "Your PROOVRA demo request has been received.",
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            Hello <strong>${safeHtml(params.fullName)}</strong>,
          </div>
          <div style="margin:0 0 10px 0;">
            We received your request for a PROOVRA demo.
          </div>
          <div style="margin:0 0 10px 0;">
            Our team will review your request and reply ${safeHtml(
              params.responseWindowText
            )} if the workflow looks relevant for a live walkthrough.
          </div>
          <div style="margin:0 0 10px 0;">
            In the meantime, these links provide the clearest picture of how the product works in practice.
          </div>
          ${resourcesHtml}
          ${bookingLine}
        `.trim(),
        ctaText: "Open verification demo",
        ctaUrl: params.verificationDemoUrl,
        secondaryText: `If you have additional context, contact us at ${supportEmail()}.`,
      });

      const text = [
        `Hello ${params.fullName},`,
        "",
        "We received your request for a PROOVRA demo.",
        `Our team will review your request and reply ${params.responseWindowText} if appropriate.`,
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

      return resend.emails.send({
        from,
        to: params.to,
        subject: `We received your demo request — ${brandName()}`,
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

      const resourcesHtml = `
        <div style="margin:14px 0 8px 0;"><strong>Useful next links</strong></div>
        <ul style="margin:0; padding-left:18px; color:#334155;">
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.sampleReportUrl
          )}" style="color:#2563eb; text-decoration:none;">Sample report</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.verificationDemoUrl
          )}" style="color:#2563eb; text-decoration:none;">Verification demo</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.methodologyUrl
          )}" style="color:#2563eb; text-decoration:none;">Verification methodology</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.pricingUrl
          )}" style="color:#2563eb; text-decoration:none;">Pricing</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.requestDemoUrl
          )}" style="color:#2563eb; text-decoration:none;">Request demo</a></li>
          <li style="margin:0 0 6px 0;"><a href="${safeHtml(
            params.contactSalesUrl
          )}" style="color:#2563eb; text-decoration:none;">Contact sales</a></li>
          ${
            params.bookingUrl
              ? `<li style="margin:0 0 6px 0;"><a href="${safeHtml(
                  params.bookingUrl
                )}" style="color:#2563eb; text-decoration:none;">Book a walkthrough</a></li>`
              : ""
          }
        </ul>
      `;

      const html = emailShell({
        title: content.title,
        preheader: content.preheader,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            Hello <strong>${safeHtml(params.fullName)}</strong>,
          </div>
          <div style="margin:0 0 10px 0;">
            ${safeHtml(content.intro)}
          </div>
          ${resourcesHtml}
        `.trim(),
        ctaText: content.ctaText,
        ctaUrl,
        secondaryText: `If the request is no longer relevant, you can simply ignore this email. Support: ${supportEmail()}.`,
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

      return resend.emails.send({
        from,
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
      const subject = `New contact-sales inquiry — ${params.organization}`;
      const escalation =
        params.priority === "HIGH"
          ? `<div style="margin:0 0 10px 0; padding:8px 12px; background:#fef3c7; border-left:3px solid #d97706; font-weight:600; color:#92400e;">High priority — respond within the published SLA window.</div>`
          : "";

      const detail = (label: string, value?: string | null) =>
        value && value.trim()
          ? `<tr><td style="padding:6px 12px 6px 0; color:#475569; font-size:13px; vertical-align:top; white-space:nowrap;">${safeHtml(
              label
            )}</td><td style="padding:6px 0; color:#0f172a; font-size:13px;">${safeHtml(
              value
            )}</td></tr>`
          : "";

      const bodyHtml = `
        ${escalation}
        <div style="margin:0 0 14px 0; color:#0f172a; font-size:14px;">
          <strong>${safeHtml(
            params.fullName
          )}</strong> at <strong>${safeHtml(
            params.organization
          )}</strong> submitted a contact-sales inquiry on ${safeHtml(app)}.
        </div>
        <table style="width:100%; border-collapse:collapse; margin:0 0 14px 0;">
          ${detail("Work email", params.workEmail)}
          ${detail("Job title", params.jobTitle)}
          ${detail("Country", params.country)}
          ${detail("Team size", params.teamSize)}
          ${detail("Topic", params.discussionTopic)}
          ${detail("Stage", params.stage)}
          ${detail("Deployment timeline", params.deploymentTimeline)}
          ${detail("Estimated users", params.estimatedUsers)}
        </table>
        <div style="margin:0 0 8px 0; color:#475569; font-size:13px; font-weight:600;">Current challenge</div>
        <div style="margin:0 0 12px 0; padding:10px 14px; background:#f8fafc; border-left:3px solid #2563eb; color:#0f172a; font-size:13.5px; line-height:1.55; white-space:pre-wrap;">${safeHtml(
          params.currentChallenge
        )}</div>
        ${
          params.additionalDetails
            ? `<div style="margin:0 0 8px 0; color:#475569; font-size:13px; font-weight:600;">Additional details</div>
               <div style="margin:0 0 12px 0; padding:10px 14px; background:#f8fafc; border-left:3px solid #7c3aed; color:#0f172a; font-size:13.5px; line-height:1.55; white-space:pre-wrap;">${safeHtml(
                 params.additionalDetails
               )}</div>`
            : ""
        }
        <div style="margin:14px 0 0 0; color:#64748b; font-size:12px;">
          Record id <code>${safeHtml(
            params.requestId
          )}</code> &nbsp;·&nbsp; source ${safeHtml(
            params.source ?? "website"
          )}${
            params.sourcePath
              ? ` &nbsp;·&nbsp; ${safeHtml(params.sourcePath)}`
              : ""
          }
        </div>
      `.trim();

      const html = emailShell({
        title: "New contact-sales inquiry",
        preheader: `${params.organization} — ${params.discussionTopic} · ${params.stage}`,
        bodyHtml,
        ctaText: "Open in admin console",
        ctaUrl: buildAdminLeadUrl({
          kind: "contact-sales",
          id: params.requestId,
        }),
        secondaryText:
          "Reply directly to the visitor's work email above — do not forward this notification externally.",
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

      return resend.emails.send({
        from,
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

      const html = emailShell({
        title: "Your inquiry has been received",
        preheader: `Thanks for contacting ${app}.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">Hello ${safeHtml(
            params.fullName
          )},</div>
          <div style="margin:0 0 10px 0;">
            Your inquiry has been submitted successfully. A member of the
            ${safeHtml(app)} team will review your request and respond as
            soon as possible.
          </div>
          <div style="margin:16px 0 8px 0; color:#475569; font-size:13px; font-weight:600;">In the meantime, useful resources:</div>
          <ul style="margin:0 0 0 0; padding:0 0 0 18px; color:#0f172a; font-size:13.5px; line-height:1.6;">
            <li><a href="${safeHtml(
              params.sampleReportUrl
            )}" style="color:#2563eb; text-decoration:none;">Sample report</a></li>
            <li><a href="${safeHtml(
              params.verificationDemoUrl
            )}" style="color:#2563eb; text-decoration:none;">Verification demo</a></li>
            <li><a href="${safeHtml(
              params.methodologyUrl
            )}" style="color:#2563eb; text-decoration:none;">Verification methodology</a></li>
            <li><a href="${safeHtml(
              params.pricingUrl
            )}" style="color:#2563eb; text-decoration:none;">Pricing</a></li>
          </ul>
        `.trim(),
        ctaText: "View sample report",
        ctaUrl: params.sampleReportUrl,
        secondaryText:
          "If this wasn't you, you can safely ignore this email.",
      });

      const text = [
        `Hello ${params.fullName},`,
        "",
        `Your inquiry has been submitted successfully. A member of the ${app} team will review your request and respond as soon as possible.`,
        "",
        "Useful resources:",
        `- Sample report: ${params.sampleReportUrl}`,
        `- Verification demo: ${params.verificationDemoUrl}`,
        `- Methodology: ${params.methodologyUrl}`,
        `- Pricing: ${params.pricingUrl}`,
        "",
        `Support: ${supportEmail()}`,
      ].join("\n");

      return resend.emails.send({
        from,
        to: params.to,
        subject,
        html,
        text,
      });
    },
  };

  return singleton;
}