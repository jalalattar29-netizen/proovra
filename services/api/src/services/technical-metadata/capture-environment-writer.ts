/**
 * Capture Environment writer — shared, best-effort persistence used by
 * every evidence ingest path (web, intake-link, citizen/mobile, API).
 *
 * Reuses the canonical `buildCaptureEnvironment` builder from
 * @proovra/shared-runtime — there is exactly ONE implementation of the
 * privacy-safe shape. This writer only adds the DB update + the
 * best-effort/never-throw guarantee so that a capture-environment
 * failure can never block evidence creation.
 *
 * Privacy: raw User-Agent and raw IP are consumed here and reduced to a
 * UA hash + masked IP by `buildCaptureEnvironment`. The raw values are
 * NEVER stored on `Evidence.captureEnvironment`.
 */

import type { Prisma } from "@prisma/client";

import { getTrustedClientIp } from "@proovra/shared-runtime/technical-metadata";
import { prisma as defaultPrisma } from "../../db.js";

/**
/**
 * Resolve the client IP for capture-environment RECORDING (FORENSIC_METADATA).
 *
 * PHASE 13 §1 (NEW-022) — this now uses the SAME resolved identity as the
 * security bounds. `req.ip` is computed by Fastify under the declared
 * proxy-trust policy (see middleware/client-ip.ts + proxy-trust-policy.ts), so
 * the forensic address and the rate-limit key can never disagree about who the
 * caller is. `getTrustedClientIp` here only normalises that resolved value; it
 * no longer walks forwarded headers itself, which is what let a caller forge
 * the recorded address. The result is masked downstream by `maskIp`, so a
 * Docker/LAN address is never surfaced as network metadata.
 */
export function resolveCaptureClientIp(req: {
  ip?: string | null;
  headers?: Record<string, string | string[] | undefined> | null;
}): string | null {
  return getTrustedClientIp({ reqIp: req.ip ?? null });
}

export type RecordCaptureEnvironmentInput = {
  evidenceId: string;
  rawUserAgent?: string | null;
  rawIp?: string | null;
  timezone?: string | null;
  locale?: string | null;
  /** One of the CaptureMethodLabel vocabulary (SECURE_CAPTURE | UPLOAD |
   *  INTAKE_LINK | API | MOBILE | UNKNOWN). Coerced by the builder. */
  captureMethod?: string | null;
  /** WEB_APP | MOBILE_APP | INTAKE_LINK | API | UNKNOWN. */
  uploadSource?: string | null;
  /** Optional Fastify-style headers bag — used to derive locale from
   *  Accept-Language when an explicit locale was not supplied. */
  acceptLanguage?: string | null;
  prisma?: typeof defaultPrisma;
};

/**
 * Build + persist the privacy-safe capture environment for an evidence
 * record. Never throws — a failure is swallowed so evidence creation is
 * never blocked. Returns true on a successful write, false otherwise.
 */
export async function recordCaptureEnvironment(
  input: RecordCaptureEnvironmentInput,
): Promise<boolean> {
  const prisma = input.prisma ?? defaultPrisma;
  try {
    const { buildCaptureEnvironment } = await import(
      "@proovra/shared-runtime/technical-metadata"
    );
    const locale =
      input.locale ??
      (typeof input.acceptLanguage === "string"
        ? input.acceptLanguage.split(",")[0]?.trim() ?? null
        : null);

    // Privacy-safe country lookup from the existing geo service (country
    // code only; HMAC-keyed; ≤100ms timeout; never throws; returns null
    // when no provider is configured). Region is not available from this
    // service, so it stays null — never faked.
    let country: string | null = null;
    if (input.rawIp) {
      try {
        const { lookupCountryCode } = await import(
          "../access-control/geo-intelligence.service.js"
        );
        const geo = await lookupCountryCode({ ip: input.rawIp });
        country = geo.countryCode ?? null;
      } catch {
        country = null;
      }
    }

    const captureEnv = buildCaptureEnvironment({
      rawUserAgent: input.rawUserAgent ?? null,
      rawIp: input.rawIp ?? null,
      timezone: input.timezone ?? null,
      locale,
      captureMethod: input.captureMethod ?? null,
      uploadSource: input.uploadSource ?? null,
      country,
      region: null,
      networkType: null, // not detected → buildCaptureEnvironment defaults to "UNKNOWN"
      ipSourceHeader: input.rawIp ? "req.ip" : null,
    });
    await prisma.evidence.update({
      where: { id: input.evidenceId },
      data: {
        captureEnvironment: captureEnv as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch {
    // capture-environment is advisory; never block the ingest flow.
    return false;
  }
}
