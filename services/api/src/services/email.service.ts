import { Resend } from "resend";

function getResendClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }

  return new Resend(apiKey);
}

function getFromEmail(): string {
  const email = process.env.EMAIL_FROM;
  const name = process.env.EMAIL_FROM_NAME ?? "Proovra";

  if (!email) {
    throw new Error("EMAIL_FROM is not set");
  }

  return `${name} <${email}>`;
}

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
) {
  const resend = getResendClient();
  const from = getFromEmail();

  console.log("[Email] Sending password reset email", {
    to: email,
    from,
  });

  const { data, error } = await resend.emails.send({
    from,
    to: email,
    subject: "Reset your Proovra password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto;">
        <h2>Reset your password</h2>

        <p>You requested a password reset for your Proovra account.</p>

        <p>
          <a
            href="${resetUrl}"
            style="
              display: inline-block;
              padding: 12px 20px;
              background-color: #111827;
              color: #ffffff;
              text-decoration: none;
              border-radius: 6px;
              font-weight: bold;
            "
          >
            Reset Password
          </a>
        </p>

        <p>If you did not request this, you can safely ignore this email.</p>

        <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
          © ${new Date().getFullYear()} Proovra
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("[Email] Resend error:", error);
    throw new Error("failed_to_send_email");
  }

  console.log("[Email] Password reset email sent", {
    id: data?.id,
  });

  return data;
}
