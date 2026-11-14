/**
 * AUDIT D-05 (2026-11-14) — an authenticated JSON response that carries a
 * presigned storage URL is not stored by any cache.
 *
 * The URL is a bearer capability for its lifetime (600 s for artifacts and
 * originals): whoever holds it downloads the object, and it keeps working after
 * the minting user's access is revoked. Only the public Verify routes said
 * `no-store`; the authenticated download routes said nothing, so a browser or
 * an intermediary was free to keep the body. Every route that answers with a
 * presigned GET URL calls this before it sends.
 */
import type { FastifyReply } from "fastify";

export const PRESIGNED_RESPONSE_CACHE_CONTROL = "no-store";

export function noStorePresignedResponse(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", PRESIGNED_RESPONSE_CACHE_CONTROL);
}
