import type { FastifyInstance } from "fastify";
import {
  getLegalDocument,
  listLegalDocuments,
  LEGAL_CORPUS_SHA256,
  LEGAL_LOCALE,
} from "@proovra/shared/legal";
import { REQUIRED_LEGAL_VERSIONS } from "../legal/legal-versioning.js";

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
 * NOTE — these two dates do not currently agree. `REQUIRED_LEGAL_VERSIONS`
 * pins terms/privacy/cookies at `2026-04-06` while those documents state
 * `2026-06-23`/`2026-06-26`. Reconciling them forces every user to re-accept,
 * which is a product and legal decision rather than a delivery detail, so this
 * route reports both honestly instead of hiding the difference behind one field.
 */

type AcceptancePolicyKey = keyof typeof REQUIRED_LEGAL_VERSIONS;

function acceptanceFor(slug: string) {
  if (!Object.prototype.hasOwnProperty.call(REQUIRED_LEGAL_VERSIONS, slug)) {
    return null;
  }
  const key = slug as AcceptancePolicyKey;
  return { policyKey: key, requiredVersion: REQUIRED_LEGAL_VERSIONS[key] };
}

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
