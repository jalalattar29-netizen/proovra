/**
 * saml-cert.service.ts
 *
 * Phase R8.2.2 — SAML Pilot Readiness & Compliance Closure
 *
 * Certificate lifecycle helpers for SAML IdP certificates:
 *   - Parse the X.509 NotAfter (expiry) date from a base64-only DER cert.
 *   - Classify expiry status (ok / expiring_90d / expiring_60d / expiring_30d / expired).
 *   - Emit saml_certificate_expiring security events when expiry is within thresholds.
 *
 * Security notes:
 *  - Raw certificate contents (PEM, DER) are NEVER logged.
 *  - Only the parsed NotAfter date and the fingerprint are surfaced in events.
 *  - Uses Node.js built-in X509Certificate (Node 16+) — no third-party crypto dep.
 */

import { X509Certificate } from "node:crypto";

import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "./security-event.service.js";

// ---------------------------------------------------------------------------
// Expiry thresholds (days)
// ---------------------------------------------------------------------------

const EXPIRY_30D_MS = 30 * 24 * 60 * 60 * 1000;
const EXPIRY_60D_MS = 60 * 24 * 60 * 60 * 1000;
const EXPIRY_90D_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CertExpiryStatus =
  | "ok"
  | "expiring_90d"
  | "expiring_60d"
  | "expiring_30d"
  | "expired";

// ---------------------------------------------------------------------------
// parseCertExpiry
// ---------------------------------------------------------------------------

/**
 * Parses the X.509 NotAfter (expiry) date from a base64-only DER certificate.
 *
 * @param base64Cert - Base64-only string (no PEM headers, no whitespace).
 * @returns The NotAfter Date, or null if parsing fails (e.g. non-standard cert).
 *
 * Does NOT log raw cert content.
 */
export function parseCertExpiry(base64Cert: string): Date | null {
  try {
    const cleaned = base64Cert.replace(/\s+/g, "");
    const pem = [
      "-----BEGIN CERTIFICATE-----",
      ...(cleaned.match(/.{1,64}/g) ?? [cleaned]),
      "-----END CERTIFICATE-----",
    ].join("\n");
    const cert = new X509Certificate(pem);
    const validTo = cert.validTo; // e.g. "Dec 31 23:59:59 2025 GMT"
    const parsed = new Date(validTo);
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    // Could not parse — not a fatal error; we just won't show expiry.
    return null;
  }
}

// ---------------------------------------------------------------------------
// getCertExpiryStatus
// ---------------------------------------------------------------------------

/**
 * Returns the expiry status of a certificate given its NotAfter date.
 * Returns "ok" if the date is null (unknown) or more than 90 days away.
 */
export function getCertExpiryStatus(
  notAfter: Date | null,
  nowMs: number = Date.now(),
): CertExpiryStatus {
  if (!notAfter) return "ok";
  const msUntilExpiry = notAfter.getTime() - nowMs;
  if (msUntilExpiry <= 0) return "expired";
  if (msUntilExpiry <= EXPIRY_30D_MS) return "expiring_30d";
  if (msUntilExpiry <= EXPIRY_60D_MS) return "expiring_60d";
  if (msUntilExpiry <= EXPIRY_90D_MS) return "expiring_90d";
  return "ok";
}

// ---------------------------------------------------------------------------
// emitCertExpiryWarningIfNeeded
// ---------------------------------------------------------------------------

export type CertExpiryWarningInput = {
  teamId: string;
  connectionId: string;
  certFingerprint: string | null;
  certNotAfter: Date | null;
  /** If true, this is the rotation (next) cert rather than the primary. */
  isNextCert?: boolean;
};

/**
 * Checks cert expiry and emits saml_certificate_expiring if within a
 * warning threshold. Bumps the appropriate metric counter.
 *
 * Safe to call on every test-connection or ingest — it's idempotent
 * (the same event fires each time until expiry passes, which is fine
 * because SIEM deduplication handles the repetition).
 */
export function emitCertExpiryWarningIfNeeded(
  input: CertExpiryWarningInput,
): void {
  bump("saml_cert_expiry_checked_total");
  const status = getCertExpiryStatus(input.certNotAfter);
  if (status === "ok") return;

  const metricMap: Record<CertExpiryStatus, () => void> = {
    ok: () => {},
    expired: () => bump("saml_cert_expiring_30d_total"),
    expiring_30d: () => bump("saml_cert_expiring_30d_total"),
    expiring_60d: () => bump("saml_cert_expiring_60d_total"),
    expiring_90d: () => bump("saml_cert_expiring_90d_total"),
  };
  metricMap[status]();

  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "saml_certificate_expiring",
    severity: status === "expiring_30d" || status === "expired" ? "HIGH" : "WARNING",
    details: {
      connectionId: input.connectionId,
      certFingerprint: input.certFingerprint,
      expiryStatus: status,
      notAfter: input.certNotAfter?.toISOString() ?? null,
      isNextCert: !!input.isNextCert,
    },
  });
}
