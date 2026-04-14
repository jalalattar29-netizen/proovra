import { Resend } from "resend";

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
};

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

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
          "If you didn’t request this, you can safely ignore this email.",
      });

      const text =
        `Reset your ${app} password\n\n` +
        `Open this link to reset your password:\n${resetUrl}\n\n` +
        `If you didn't request this, ignore this email.\n` +
        `Support: ${supportEmail()}\n`;

      return resend.emails.send({
        from,
        to: email,
        subject: `Reset your ${app} password`,
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

      const html = emailShell({
        title: "New demo request",
        preheader: `New demo request from ${params.fullName}.`,
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
  };

  return singleton;
}