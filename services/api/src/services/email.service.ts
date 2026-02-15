import { Resend } from "resend";

export type EmailService = {
  sendPasswordResetEmail: (email: string, resetUrl: string) => Promise<unknown>;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} not set`);
  return v.trim();
}

function getFromHeader(): string {
  // Prefer explicit EMAIL_FROM (you set: "Proovra <no-reply@proovra.com>")
  const emailFrom = process.env.EMAIL_FROM?.trim();
  if (emailFrom) return emailFrom;

  // Fallback
  const name = (process.env.EMAIL_FROM_NAME ?? "Proovra").trim() || "Proovra";
  return `${name} <no-reply@proovra.com>`;
}

let singleton: EmailService | null = null;

export function getEmailService(): EmailService {
  if (singleton) return singleton;

  const apiKey = requireEnv("RESEND_API_KEY");
  const resend = new Resend(apiKey);
  const from = getFromHeader();

  singleton = {
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
    }
  };

  return singleton;
}
