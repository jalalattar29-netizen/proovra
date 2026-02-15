import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY not set");
  }

  const from = process.env.RESEND_FROM_EMAIL ?? "Proovra <no-reply@proovra.com>";

  const result = await resend.emails.send({
    from,
    to: email,
    subject: "Reset your Proovra password",
    html: `
      <div>
        <h2>Reset your password</h2>
        <p>Click the link below to reset your password:</p>
        <p>
          <a href="${resetUrl}">
            Reset Password
          </a>
        </p>
        <p>If you didn't request this, ignore this email.</p>
      </div>
    `
  });

  return result;
}
