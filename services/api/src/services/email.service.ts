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
      }
    };
    return singleton;
  }

  const resend = new Resend(apiKey);

  singleton = {
    isConfigured: () => true,

    async sendPasswordResetEmail(email: string, resetUrl: string) {
      return resend.emails.send({
        from,
        to: email,
        subject: "Reset your Proovra password",
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif">
            <h2 style="margin:0 0 12px 0">Reset your password</h2>
            <p style="margin:0 0 12px 0">Click the link below to reset your password:</p>
            <p style="margin:0 0 16px 0">
              <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;text-decoration:none;border:1px solid #ddd">
                Reset Password
              </a>
            </p>
            <p style="margin:0;color:#666">If you didn't request this, ignore this email.</p>
          </div>
        `
      });
    },

    async sendTeamInvitation(email: string, orgName: string, invitationToken: string) {
      const url = `${webBaseUrl()}/invite/${encodeURIComponent(invitationToken)}`;

      return resend.emails.send({
        from,
        to: email,
        subject: `You're invited to join ${orgName} on Proovra`,
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif">
            <h2 style="margin:0 0 12px 0">Invitation to ${orgName}</h2>
            <p style="margin:0 0 12px 0">You have been invited to join <strong>${orgName}</strong> on Proovra.</p>
            <p style="margin:0 0 16px 0">
              <a href="${url}" style="display:inline-block;padding:10px 14px;border-radius:8px;text-decoration:none;border:1px solid #ddd">
                Accept invitation
              </a>
            </p>
            <p style="margin:0;color:#666">If you weren't expecting this, you can ignore this email.</p>
          </div>
        `
      });
    },

    async sendBatchComplete(email, orgName, batchName, totalItems, failedItems, batchUrl) {
      const failed = Number.isFinite(failedItems) ? failedItems : 0;
      const total = Number.isFinite(totalItems) ? totalItems : 0;
      const succeeded = Math.max(0, total - failed);

      return resend.emails.send({
        from,
        to: email,
        subject: `Batch complete: ${batchName}`,
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif">
            <h2 style="margin:0 0 12px 0">Batch complete</h2>
            <p style="margin:0 0 12px 0"><strong>${orgName}</strong> batch <strong>${batchName}</strong> has completed.</p>
            <ul style="margin:0 0 16px 20px;padding:0">
              <li>Total: ${total}</li>
              <li>Succeeded: ${succeeded}</li>
              <li>Failed: ${failed}</li>
            </ul>
            <p style="margin:0 0 16px 0">
              <a href="${batchUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;text-decoration:none;border:1px solid #ddd">
                View results
              </a>
            </p>
          </div>
        `
      });
    }
  };

  return singleton;
}
