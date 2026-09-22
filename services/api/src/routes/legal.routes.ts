import type { FastifyInstance } from "fastify";
import {
  getLegalDocument,
  listLegalDocuments,
  requiredAcceptanceFor,
  LEGAL_CORPUS_SHA256,
  LEGAL_LOCALE,
} from "@proovra/shared/legal";

/**
 * CANONICAL LEGAL DOCUMENT DELIVERY.
 *
 * `GET /v1/legal` and `GET /v1/legal/:slug` serve the SAME text the web renders
 * at `/legal/[slug]` and `/settings/legal/[slug]`, from the same module
 * (`@proovra/shared/legal`, generated from `apps/web/content/legal/en/*.md`).
 * There is no second corpus, no legal service, no legal table and no sync.
 *
 * WHY THIS IS UNAUTHENTICATED
 * ---------------------------
 * The corpus is already world-readable at `https://proovra.com/legal/<slug>`;
 * this route discloses nothing new. It must also work before a session exists,
 * because the sign-up and sign-in screens link Terms and Privacy, and the 428
 * re-acceptance gate asks a user to accept a document the client has to be able
 * to display. Gating it on auth would recreate the web handoff it replaces.
 *
 * WHY THERE IS NO `version` FIELD
 * -------------------------------
 * The documents carry `Last Updated:` and nothing else, so `lastUpdated` is
 * reported and no document version is invented. Separately,
 * `REQUIRED_LEGAL_VERSIONS` governs which policy version a user must have
 * ACCEPTED; it covers three policies and is a property of the acceptance gate,
 * not of a document. Where it applies it is reported as `acceptance`, so a
 * client can state which version it displayed when it records acceptance.
 *
 * RECONCILED (2026-09-22). These two once disagreed: the acceptance table
 * pinned terms/privacy/cookies at `2026-04-06` while the documents said
 * `2026-06-23`/`2026-06-26`, so a user was recorded as accepting a revision
 * that was not the one on screen. The requirement is now DERIVED from each
 * document's own date, in `@proovra/shared/legal`, and cannot drift again.
 */

/**
 * The acceptance requirement, from the ONE place that computes it.
 *
 * `requiredAcceptanceFor` derives the version from the document's own
 * `Last Updated:` line, so this route reports the version a user is actually
 * shown rather than a hand-maintained date that had drifted two months behind
 * the text.
 */
const acceptanceFor = requiredAcceptanceFor;

// The corpus is immutable for the lifetime of a deployed build, so it is safe
// to let clients cache it and to answer a conditional request from the digest.
// `must-revalidate` keeps a client from serving a stale policy indefinitely
// after a release.
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

export async function legalRoutes(app: FastifyInstance) {
  app.get("/v1/legal", async (_req, reply) => {
    return reply
      .header("cache-control", CACHE_CONTROL)
      .header("etag", `"legal-index-${LEGAL_CORPUS_SHA256.slice(0, 16)}"`)
      .send({
        locale: LEGAL_LOCALE,
        documents: listLegalDocuments().map((d) => ({
          ...d,
          acceptance: acceptanceFor(d.slug),
        })),
      });
  });

  app.get<{ Params: { slug: string } }>("/v1/legal/:slug", async (req, reply) => {
    const doc = getLegalDocument(req.params.slug);

    if (!doc) {
      return reply.code(404).send({
        error: {
          code: "LEGAL_DOCUMENT_NOT_FOUND",
          message: "No such legal document.",
          requestId: req.id,
        },
      });
    }

    return reply
      .header("cache-control", CACHE_CONTROL)
      .header("etag", `"legal-${doc.slug}-${LEGAL_CORPUS_SHA256.slice(0, 16)}"`)
      .send({ ...doc, acceptance: acceptanceFor(doc.slug) });
  });
}
