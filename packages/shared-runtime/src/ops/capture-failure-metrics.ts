/**
 * UC-LCH-002 — THE capture-failure metric authority.
 *
 * One counter per acquisition channel, bumped where a capture of that channel
 * FAILS (an integrity or server failure), never for an outcome the user can fix
 * themselves (plan or storage limit, consent declined, an expired link or session,
 * a busy session that asks for a retry). The capture alert rules
 * (infra/grafana/alerts/proovra-capture-alerts.yaml) read exactly these names.
 */
import { bump, type CounterName } from "./metrics.service.js";

export const CAPTURE_FAILURE_COUNTER_BY_MODE: Readonly<Record<string, CounterName>> = {
  PROOVRA_WEB_UPLOAD: "capture_failed_proovra_web_upload_total",
  SECURE_INTAKE_LINK: "capture_failed_secure_intake_link_total",
  PROOVRA_MOBILE_APP: "capture_failed_proovra_mobile_app_total",
  DIRECT_WEB_CAPTURE_EXTENSION: "capture_failed_direct_web_capture_extension_total",
  DIRECT_SCREEN_CAPTURE_ANDROID: "capture_failed_direct_screen_capture_android_total",
  DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS: "capture_failed_direct_screen_capture_android_continuous_total",
  DIRECT_SCREEN_CAPTURE_IOS: "capture_failed_direct_screen_capture_ios_total",
};

/**
 * Denials that mean the capture itself failed (bytes, digests, declarations or the
 * manifest do not hold up). Everything else a capture route answers is either the
 * caller's to fix or a retryable contention, and is not a capture failure.
 */
export const CAPTURE_FAILURE_DENIALS: ReadonlySet<string> = new Set([
  "SIGNATURE_INVALID",
  "NONCE_MISMATCH",
  "PAYLOAD_SESSION_MISMATCH",
  "PAYLOAD_DIGEST_MISMATCH",
  "PAYLOAD_MODE_MISMATCH",
  "CAPTURE_DIGEST_MISMATCH",
  "CAPTURE_PART_UNDECLARED",
  "CAPTURE_PART_DECLARATION_MISMATCH",
  "CAPTURE_PARTS_REQUIRED",
  "WEB_MANIFEST_INVALID",
  "WEB_MANIFEST_DIGEST_UNDECLARED",
  "WEB_MANIFEST_ARTIFACT_MISMATCH",
  "SCREEN_MANIFEST_INVALID",
  "SCREEN_MANIFEST_DIGEST_UNDECLARED",
  "SCREEN_MANIFEST_ARTIFACT_MISMATCH",
  "CONTINUOUS_MANIFEST_INVALID",
  "CONTINUOUS_MANIFEST_DIGEST_UNDECLARED",
  "CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH",
]);

/** Is this outcome a capture failure? A 5xx always is; a 4xx only for the denials above. */
export function isCaptureFailure(input: { statusCode: number; code?: string | null }): boolean {
  if (input.statusCode >= 500) return true;
  return typeof input.code === "string" && CAPTURE_FAILURE_DENIALS.has(input.code);
}

/** Bump the channel counter (and the manifest-validator counters) for one failed capture. */
export function bumpCaptureFailure(mode: string | null | undefined, code?: string | null): void {
  const counter = mode ? CAPTURE_FAILURE_COUNTER_BY_MODE[mode] : undefined;
  if (counter) bump(counter);
  if (code === "CONTINUOUS_MANIFEST_INVALID") bump("capture_continuous_manifest_invalid_total");
  if (code === "SCREEN_MANIFEST_INVALID") bump("capture_screen_manifest_invalid_total");
}
