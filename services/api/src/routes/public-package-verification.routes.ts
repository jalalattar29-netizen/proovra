/**
 * PROOVRA'S PUBLIC PACKAGE AND SIGNING-KEY RECORD (2026-10-07).
 *
 * A verification package proves its own internal consistency with its seal,
 * but a key found only inside a package vouches for nothing: anyone can
 * re-seal an altered package with their own key. These reads let a recipient
 * bind a package to PROOVRA from OUTSIDE it — the package README names the
 * Public Verify page (/verify/package/<packageId>) that reads them.
 *
 *   GET /public/signing-keys
 *       Every key in THE signing-key registry (signing_keys, insert-only):
 *       key id, version, SPKI SHA-256 fingerprint, algorithm, validity
 *       interval, status (ACTIVE / SUPERSEDED / REVOKED) and the version that
 *       supersedes it. Public keys only — never private or secret material.
 *       Revoked and superseded keys stay listed so historical packages remain
 *       verifiable after rotation.
 *
 *   GET /public/verification-packages/:packageId
 *   GET /public/verification-packages/by-sha256/:sha256
 *       One package's identity record: package id, disclosure profile, report
 *       version, package SHA-256, seal digest, seal key fingerprint and that
 *       key's registry status, and the predecessor/successor relationship.
 *       By id (UUID, as printed in the package) or by the SHA-256 of the exact
 *       ZIP the recipient holds (knowing the bytes is the authorization),
 *       which also covers legacy packages that carry no id. It returns NO
 *       evidence content and does NOT publish the evidence record: a record's
 *       Public Verify publication is unchanged by this read.
 *
 * TENANT_SCOPE_EXCEPTION: public_verify_token_readonly
 *   Anonymous by design and read-only: a recipient outside any workspace
 *   holds the package, so no session or workspace can be asked. The lookup
 *   key is the package's own id or the SHA-256 of its exact bytes, and the
 *   answer is that package's identity and key record only — no evidence
 *   content, no workspace or owner data, nothing written.
 *
 * Anonymous and bounded: a per-client rate limit shared across replicas, a
 * second per-lookup-key limit against rotating-IP enumeration, the same 404
 * for an unknown and a malformed id, and `Cache-Control: no-store` (a key's
 * status can change).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { publicKeySpkiSha256 } from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import { readExternalDisclosureArtifact } from "../services/reports/external-disclosure-artifact.js";

const NOT_FOUND = { code: "PACKAGE_NOT_FOUND", message: "No PROOVRA package record matches." } as const;

function readPositiveIntEnv(name: string, fallback: number): number {
  const n = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Two buckets, both must allow: per client, and per lookup key. */
async function rateLimited(req: FastifyRequest, reply: FastifyReply, lookupKey: string): Promise<boolean> {
  const max = readPositiveIntEnv("PUBLIC_PACKAGE_RATE_LIMIT_MAX", 30);
  const windowSec = readPositiveIntEnv("PUBLIC_PACKAGE_RATE_LIMIT_WINDOW_SEC", 60);
  for (const key of [
    `ratelimit:public-package:ip:${trustedClientIpKey(req)}`,
    `ratelimit:public-package:key:${lookupKey}`,
  ]) {
    const r = await enforceRateLimit({ key, max, windowSec, bound: "global" });
    if (!r.allowed) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil((r.resetAtMs - Date.now()) / 1000))));
      void reply.code(429).send({ code: "RATE_LIMITED", message: "Too many requests. Try again shortly." });
      return true;
    }
  }
  return false;
}

type KeyRecord = {
  fingerprintSha256: string;
  keyId: string;
  version: number;
  algorithm: "Ed25519";
  status: "ACTIVE" | "SUPERSEDED" | "REVOKED";
  validFromUtc: string;
  validUntilUtc: string | null;
  revokedAtUtc: string | null;
  supersededBy: { keyId: string; version: number } | null;
};

/** THE registry, as a public projection. */
async function loadKeyRecords(): Promise<KeyRecord[]> {
  const rows = await prisma.signingKey.findMany({
    orderBy: [{ keyId: "asc" }, { version: "asc" }],
    select: { keyId: true, version: true, publicKeyPem: true, createdAt: true, revokedAt: true },
  });
  const out: KeyRecord[] = [];
  for (const row of rows) {
    let fingerprint: string;
    try {
      fingerprint = publicKeySpkiSha256(row.publicKeyPem);
    } catch {
      continue; // an unreadable key is not published as if it were one
    }
    const next = rows.find((r) => r.keyId === row.keyId && r.version > row.version) ?? null;
    out.push({
      fingerprintSha256: fingerprint,
      keyId: row.keyId,
      version: row.version,
      algorithm: "Ed25519",
      status: row.revokedAt ? "REVOKED" : next ? "SUPERSEDED" : "ACTIVE",
      validFromUtc: row.createdAt.toISOString(),
      validUntilUtc: row.revokedAt?.toISOString() ?? next?.createdAt.toISOString() ?? null,
      revokedAtUtc: row.revokedAt?.toISOString() ?? null,
      supersededBy: next ? { keyId: next.keyId, version: next.version } : null,
    });
  }
  return out;
}

type PackageRow = {
  id: string;
  evidenceId: string;
  version: number;
  reportVersion: number | null;
  packageSha256: string | null;
  sealSha256: string | null;
  sealSigningKeySha256: string | null;
  packageFormatVersion: number | null;
  disclosureProfile: string | null;
  externalDisclosureArtifact: unknown;
  generatedAtUtc: Date;
};

const PACKAGE_SELECT = {
  id: true,
  evidenceId: true,
  version: true,
  reportVersion: true,
  packageSha256: true,
  sealSha256: true,
  sealSigningKeySha256: true,
  packageFormatVersion: true,
  disclosureProfile: true,
  externalDisclosureArtifact: true,
  generatedAtUtc: true,
} as const;

async function projectPackage(row: PackageRow, which: "FULL" | "EXTERNAL") {
  const ext = readExternalDisclosureArtifact(row.externalDisclosureArtifact);
  const isExternal = which === "EXTERNAL" && ext;
  const sealKey = isExternal ? ext.sealSigningKeySha256 : row.sealSigningKeySha256;
  const keys = sealKey ? await loadKeyRecords() : [];
  const key = sealKey ? keys.find((k) => k.fingerprintSha256 === sealKey.toLowerCase()) ?? null : null;
  const [previous, next] = await Promise.all([
    prisma.verificationPackage.findFirst({
      where: { evidenceId: row.evidenceId, version: { lt: row.version } },
      orderBy: { version: "desc" },
      select: { id: true, version: true },
    }),
    prisma.verificationPackage.findFirst({
      where: { evidenceId: row.evidenceId, version: { gt: row.version } },
      orderBy: { version: "asc" },
      select: { id: true, version: true },
    }),
  ]);
  const profile = isExternal ? "EXTERNAL_DISCLOSURE" : row.disclosureProfile ?? "LEGACY";
  return {
    schema: "PROOVRA_PUBLIC_PACKAGE_RECORD",
    version: 1,
    packageId: isExternal ? ext.packageId : row.id,
    /** Legacy packages carry no id inside the ZIP; this is their row id. */
    packageIdRecordedInPackage: isExternal ? true : row.disclosureProfile != null,
    disclosureProfile: profile,
    completeForensicPackage: profile !== "EXTERNAL_DISCLOSURE",
    sourceFullPackageId: isExternal ? row.id : null,
    externalDisclosurePackageId: !isExternal && ext ? ext.packageId : null,
    reportVersion: row.reportVersion ?? row.version,
    issuedAtUtc: row.generatedAtUtc.toISOString(),
    packageSha256: isExternal ? ext.packageSha256 : row.packageSha256,
    packageFormatVersion: isExternal ? 5 : row.packageFormatVersion,
    sealSha256: isExternal ? ext.sealSha256 : row.sealSha256,
    sealKeyFingerprintSha256: sealKey,
    sealKey: key,
    keyBinding: !sealKey ? "NOT_SEALED" : key ? (key.status === "REVOKED" ? "BOUND_KEY_REVOKED" : "BOUND") : "KEY_NOT_PUBLISHED",
    supersedes: previous ? { packageId: previous.id, reportVersion: previous.version } : null,
    supersededBy: next ? { packageId: next.id, reportVersion: next.version } : null,
    statement:
      "This record states what PROOVRA issued. It does not publish the evidence record or its content, and it describes the package as issued, not the record's current state.",
  };
}

export async function publicPackageVerificationRoutes(app: FastifyInstance) {
  app.get("/public/signing-keys", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (await rateLimited(req, reply, "signing-keys")) return reply;
    return reply.code(200).send({
      schema: "PROOVRA_PUBLIC_SIGNING_KEYS",
      version: 1,
      generatedAtUtc: new Date().toISOString(),
      fingerprintMethod: "SHA-256 of the DER-encoded SubjectPublicKeyInfo of the public key",
      keys: await loadKeyRecords(),
    });
  });

  app.get("/public/verification-packages/by-sha256/:sha256", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z.object({ sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).safeParse(req.params);
    const lookup = parsed.success ? parsed.data.sha256.toLowerCase() : "invalid";
    if (await rateLimited(req, reply, `sha:${lookup}`)) return reply;
    if (!parsed.success) return reply.code(404).send(NOT_FOUND);
    const full = await prisma.verificationPackage.findFirst({ where: { packageSha256: lookup }, select: PACKAGE_SELECT });
    if (full) return reply.code(200).send(await projectPackage(full, "FULL"));
    const ext = await prisma.verificationPackage.findFirst({
      where: { externalDisclosureArtifact: { path: ["packageSha256"], equals: lookup } },
      select: PACKAGE_SELECT,
    });
    if (ext) return reply.code(200).send(await projectPackage(ext, "EXTERNAL"));
    return reply.code(404).send(NOT_FOUND);
  });

  app.get("/public/verification-packages/:packageId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z.object({ packageId: z.string().uuid() }).safeParse(req.params);
    const lookup = parsed.success ? parsed.data.packageId.toLowerCase() : "invalid";
    if (await rateLimited(req, reply, `id:${lookup}`)) return reply;
    if (!parsed.success) return reply.code(404).send(NOT_FOUND);
    const full = await prisma.verificationPackage.findUnique({ where: { id: lookup }, select: PACKAGE_SELECT });
    if (full) return reply.code(200).send(await projectPackage(full, "FULL"));
    const ext = await prisma.verificationPackage.findFirst({
      where: { externalDisclosureArtifact: { path: ["packageId"], equals: lookup } },
      select: PACKAGE_SELECT,
    });
    if (ext) return reply.code(200).send(await projectPackage(ext, "EXTERNAL"));
    return reply.code(404).send(NOT_FOUND);
  });
}
