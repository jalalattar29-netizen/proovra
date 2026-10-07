/**
 * PROOVRA'S PUBLIC PACKAGE RECORD — a Public Verify read (2026-10-07).
 *
 * A verification package proves its own internal consistency with its seal,
 * but a key found only inside a package vouches for nothing: anyone can
 * re-seal an altered package with their own key. This read lets a recipient
 * bind a package to PROOVRA from OUTSIDE it — the package README names the
 * Public Verify package page (/verify/package/<packageId>) that reads it.
 *
 *   GET /public/verification-packages/:packageId
 *   GET /public/verification-packages/by-sha256/:sha256
 *       ONE published package's record (`PublicPackageRecord`, @proovra/shared):
 *       its id, profile, issuance, report version, SHA-256, seal digest, and
 *       the binding of its seal key — the key's exact registry identity with
 *       purpose PACKAGE_SEAL, its validity, rotation and revocation — plus the
 *       adjacent packages of the same profile. By id (as printed in the
 *       package) or by the SHA-256 of the exact ZIP the recipient holds
 *       (knowing the bytes is the authorization; it also covers legacy
 *       packages that carry no id). No evidence content; it does not publish
 *       the evidence record.
 *
 * There is NO key-inventory endpoint: a key is described only as the seal key
 * of a package the caller identified (services/public-verify).
 *
 * TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
 *   Anonymous by design and read-only: a recipient outside any workspace
 *   holds the package, so no session or workspace can be asked. The lookup
 *   key is the package's own id or the SHA-256 of its exact bytes, and the
 *   answer is that package's identity and key record only — no evidence
 *   content, no workspace or owner data, nothing written.
 *
 * THE PUBLIC VERIFY GATE (services/public-verify/public-verify-gate.ts): the
 * same per-client budget as the record page — before the identifier is parsed
 * — and a per-package distinct-client limit after it; one 404 for unknown and
 * malformed alike; `Cache-Control: no-store` (a key's status can change); the
 * Public Verify span, never the client address.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { PROOVRA_SPAN_NAMES, withProovraSpan } from "../observability/otel.js";
import { admitPublicVerifyClient, admitPublicVerifyTarget } from "../services/public-verify/public-verify-gate.js";
import {
  findPublishedPackageById,
  findPublishedPackageBySha256,
  projectPublicPackageRecord,
} from "../services/public-verify/public-package-record.service.js";

const NOT_FOUND = { code: "PACKAGE_NOT_FOUND", message: "No PROOVRA package record matches." } as const;

async function begin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  reply.header("Cache-Control", "no-store");
  await withProovraSpan(
    PROOVRA_SPAN_NAMES.EVIDENCE_VERIFY_PUBLIC,
    { "proovra.operation": "verification_package_public" },
    () => undefined,
  );
  return admitPublicVerifyClient(req, reply);
}

export async function publicPackageVerificationRoutes(app: FastifyInstance) {
  app.get("/public/verification-packages/by-sha256/:sha256", async (req, reply) => {
    if (!(await begin(req, reply))) return reply;
    const parsed = z.string().regex(/^[a-fA-F0-9]{64}$/).safeParse((req.params as { sha256?: string }).sha256);
    if (!parsed.success) return reply.code(404).send(NOT_FOUND);
    const sha = parsed.data.toLowerCase();
    if (!(await admitPublicVerifyTarget(req, reply, { kind: "package", id: sha }))) return reply;
    const row = await findPublishedPackageBySha256(sha);
    if (!row) return reply.code(404).send(NOT_FOUND);
    return reply.code(200).send(await projectPublicPackageRecord(row));
  });

  app.get("/public/verification-packages/:packageId", async (req, reply) => {
    if (!(await begin(req, reply))) return reply;
    const parsed = z.string().uuid().safeParse((req.params as { packageId?: string }).packageId);
    if (!parsed.success) return reply.code(404).send(NOT_FOUND);
    if (!(await admitPublicVerifyTarget(req, reply, { kind: "package", id: parsed.data }))) return reply;
    const row = await findPublishedPackageById(parsed.data);
    if (!row) return reply.code(404).send(NOT_FOUND);
    return reply.code(200).send(await projectPublicPackageRecord(row));
  });
}
