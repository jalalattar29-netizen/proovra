/**
 * EXACT CAPTURE LOCATION — the one disclosure decision (free-audit 0ea0
 * B5A-F-13).
 *
 * `Evidence.lat` / `lng` / `accuracyMeters` are where the capturing device or
 * browser said it was. They are personal data about the person who captured
 * the record (and often about the people at that place), and before this
 * module every authenticated reader of the record received them at full
 * precision with an external map link — a Viewer included.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *
 *   REVEALED   the stored coordinates, accuracy and the external map link.
 *   WITHHELD   no coordinate, no accuracy, no map link. The canonical
 *              location state reads WITHHELD (capture-location.ts), never
 *              NOT_RECORDED: the record holds a location; this reader is not
 *              shown it.
 *
 * Public Verify is NOT decided here. It keeps its own explicit owner decision
 * (CONTENT_PREVIEW + showRecordedLocation, public-verify-projection.ts), and
 * the minimal Verify page (D-07) states no location at all. Issued reports and
 * packages are not touched: they are immutable artifacts with their own
 * disclosure profiles.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUTHORITY IS `evidence.download_original`
 * ---------------------------------------------------------------------------
 *
 * No permission names location. The least-privilege EXISTING authority that
 * already discloses the same fact is the one that hands out the original
 * capture: the original file a device produced carries its own capture
 * context (a photo's EXIF GPS block), so whoever may download the original
 * already receives the exact location. Gating the projection on it neither
 * widens anybody (every holder already reaches the coordinates through the
 * file) nor invents a parallel entitlement. `evidence.read` alone — the
 * Viewer's authority — is not enough.
 *
 * Holders today (permissions.ts): OWNER, ADMIN, REVIEWER (DB MEMBER) and
 * CONTRIBUTOR. Not VIEWER.
 */

import type { FastifyRequest } from "fastify";

import { evaluateAuthorize } from "../../middleware/authorize.js";

export type CaptureLocationDisclosure = "REVEALED" | "WITHHELD";

/**
 * The disclosure this request is entitled to for one record.
 *
 * `teamId` null is a Personal-scope record with no workspace binding: record
 * reach keeps it owner-only, so the reader is the person who captured it.
 * Anything else asks the canonical primitive, which fails closed.
 */
export async function resolveCaptureLocationDisclosure(
  req: FastifyRequest,
  options: { teamId: string | null | undefined; evidenceId: string },
): Promise<CaptureLocationDisclosure> {
  if (!options.teamId) return "REVEALED";
  const outcome = await evaluateAuthorize(req, {
    teamId: options.teamId,
    permission: "evidence.download_original",
    resourceKind: "evidence",
    resourceId: options.evidenceId,
    antiEnumeration: true,
  });
  return outcome.allowed ? "REVEALED" : "WITHHELD";
}

/**
 * A record projection with its coordinates removed for a WITHHELD reader.
 * Null, not omitted, so a client reading the field gets an absence rather
 * than an undefined it might render.
 */
export function projectCaptureCoordinates<
  T extends { lat: number | null; lng: number | null; accuracyMeters: number | null },
>(projection: T, disclosure: CaptureLocationDisclosure): T {
  if (disclosure === "REVEALED") return projection;
  return { ...projection, lat: null, lng: null, accuracyMeters: null };
}
