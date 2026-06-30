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

import { prisma as defaultPrisma } from "../../db.js";

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
    const captureEnv = buildCaptureEnvironment({
      rawUserAgent: input.rawUserAgent ?? null,
      rawIp: input.rawIp ?? null,
      timezone: input.timezone ?? null,
      locale,
      captureMethod: input.captureMethod ?? null,
      uploadSource: input.uploadSource ?? null,
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
