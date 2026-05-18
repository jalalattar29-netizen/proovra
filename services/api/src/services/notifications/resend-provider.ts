/**
 * Phase 8 — Resend provider adapter.
 *
 * Reuses the existing project-wide email.service.ts singleton — DO NOT
 * instantiate another Resend client here. We extend EmailService with one
 * generic "sendCustom" capability and route Phase 8 notifications through
 * it so token authentication / from-header / brand resolution / no-key
 * fallback all stay centralized.
 *
 * Contract:
 *   - Returns a typed result; never throws to the orchestrator.
 *   - When the underlying EmailService is not configured (no
 *     RESEND_API_KEY), returns { ok: false, errorCode: "not_configured" }
 *     so the orchestrator can downgrade the delivery to FAILED without
 *     attempting a retry-loop on a structural misconfiguration.
 */

import {
  getEmailFromHeader,
  sendCustomEmailViaResend,
} from "../email.service.js";

export type ResendSendInput = {
  to: string;
  recipientName?: string | null;
  subject: string;
  html: string;
  text: string;
};

export type ResendSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; errorCode: string; errorMessage: string };

export async function sendViaResend(
  input: ResendSendInput,
): Promise<ResendSendResult> {
  try {
    const res = await sendCustomEmailViaResend({
      from: getEmailFromHeader(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (!res.ok) {
      return {
        ok: false,
        errorCode: res.errorCode,
        errorMessage: res.errorMessage,
      };
    }
    return { ok: true, providerMessageId: res.providerMessageId ?? null };
  } catch (err) {
    return {
      ok: false,
      errorCode: "exception",
      errorMessage: err instanceof Error ? err.message : "unknown_error",
    };
  }
}
