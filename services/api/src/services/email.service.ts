import { Resend } from "resend";

export type EmailService = {
  isConfigured: () => boolean;

  sendPasswordResetEmail: (email: string, resetUrl: string) => Promise<unknown>;

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
};

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

function fromHeader(): string {
  return env("EMAIL_FROM") ?? `${env("EMAIL_FROM_NAME") ?? "Proovra"} <no-reply@proovra.com>`;
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

/**
 * Example:
 * https://www.proovra.com/brand/logo-dark.png
 */
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
  const secondaryText = params.secondaryText ? safeHtml(params.secondaryText) : "";

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
              <a href="${ctaUrl}" style="color:#2563eb; text-decoration:none;">${safeHtml(ctaUrl)}</a>
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
          <a href="${base}" style="color:#0f172a; text-decoration:none;">${safeHtml(appName)}</a>
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
                  <a href="mailto:${safeHtml(supportEmail())}" style="color:#2563eb; text-decoration:none;">
                    ${safeHtml(supportEmail())}
                  </a>
                </div>
                <div>
                  © ${year} ${safeHtml(appName)} ·
                  <a href="${base}" style="color:#2563eb; text-decoration:none;">${safeHtml(base)}</a>
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
            We received a request to reset the password for your <strong>${safeHtml(app)}</strong> account.
          </div>
          <div style="margin:0 0 10px 0;">
            Click the button below to choose a new password.
          </div>
        `.trim(),
        ctaText: "Reset password",
        ctaUrl: resetUrl,
        secondaryText: "If you didn’t request this, you can safely ignore this email.",
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

    async sendTeamInvitation(email: string, orgName: string, invitationToken: string) {
      const url = inviteAcceptUrl(invitationToken);

      const html = emailShell({
        title: "You’re invited",
        preheader: `Join ${orgName} on ${brandName()}.`,
        bodyHtml: `
          <div style="margin:0 0 10px 0;">
            You have been invited to join <strong>${safeHtml(orgName)}</strong> on <strong>${safeHtml(brandName())}</strong>.
          </div>
          <div style="margin:0 0 10px 0;">
            Click the button below to review and accept your invitation.
          </div>
        `.trim(),
        ctaText: "Accept invitation",
        ctaUrl: url,
        secondaryText: "If you weren’t expecting this invitation, you can ignore this email.",
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
            <strong>${safeHtml(orgName)}</strong> batch <strong>${safeHtml(batchName)}</strong> has completed.
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
  };

  return singleton;
}
