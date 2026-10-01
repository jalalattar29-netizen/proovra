/**
 * UC-ARCH-004 — the API-key resumable-upload channel is RETIRED (410 Gone).
 *
 * Phase 30.6 / 30.8 mounted nine routes under /v1/integrations/api/uploads/*
 * for service-account callers. They could never work: the byte-write authority
 * (ET-UPL-01) admits only an OWNER principal (the record's owning user) or an
 * INTAKE_SESSION principal, and these routes passed the API CREDENTIAL id as
 * the owner, which never equals Evidence.ownerUserId — every session create
 * answered 404. No API route can create an Evidence record for an integration
 * either, so there is no record an integration could own, and no client, SDK
 * or customer document calls these routes (their only references were
 * source-regex tests and generated inventories).
 *
 * Decision: retire rather than invent a new service-account write principal.
 * Each path answers 410 with a stable code so a caller learns the channel is
 * gone instead of receiving a misleading 404. Machine ingest uses the
 * canonical channels: signed-in upload (POST /v1/evidence + parts) or a
 * secure intake link.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const RETIRED_INTEGRATION_UPLOAD_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
  { method: "POST", url: "/v1/integrations/api/uploads/sessions" },
  { method: "GET", url: "/v1/integrations/api/uploads/sessions/:sessionId" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/uploaded" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/complete" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/abort" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/multipart/initiate" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/parts/:partIndex/presign" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/multipart/complete" },
  { method: "POST", url: "/v1/integrations/api/uploads/sessions/:sessionId/multipart/abort" },
];

const RETIRED_BODY = {
  error: {
    code: "INTEGRATION_UPLOADS_RETIRED",
    message:
      "The API-key upload channel has been retired. Upload evidence through the signed-in upload API or a secure intake link.",
  },
} as const;

export async function integrationsUploadsRoutes(app: FastifyInstance) {
  for (const route of RETIRED_INTEGRATION_UPLOAD_ROUTES) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (req: FastifyRequest, reply: FastifyReply) =>
        reply.code(410).send({ ...RETIRED_BODY, requestId: req.id ?? null }),
    });
  }
}
