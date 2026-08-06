/**
 * PHASE 12 POINT 4 (Pass H) — evidence certification ATTEST is reachable.
 *
 * The certification lifecycle is request -> attest -> revoke. The attest step
 * had a service (`attestEvidenceCertification`), a request schema
 * (`AttestEvidenceCertificationBody`), a custody event
 * (`CustodyEventType.CERTIFICATION_ATTESTED`) and a report-renderer label
 * ("Certification attested") — but NO route reached any of it, so no
 * certification could ever be signed and the CERTIFICATION_ATTESTED custody
 * event was unproducible.
 *
 * This suite proves:
 *   1. the service behaviour on all three arms (missing / revoked / success);
 *   2. the route exists and composes the SAME auth + capability + custody +
 *      audit chain as its request/revoke siblings.
 *
 * No database: the Prisma client is mocked at the module boundary.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

type CertRow = Record<string, unknown> & {
  id: string;
  evidenceId: string;
  declarationType: string;
  status: string;
  version: number;
};

const H = vi.hoisted(() => ({
  latest: null as CertRow | null,
  updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceCertification: {
      findFirst: async () => H.latest,
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        H.updates.push(args);
        return { ...(H.latest as CertRow), ...args.data };
      },
    },
  },
}));

import { attestEvidenceCertification } from "../src/services/evidence-certification.service.js";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const ROUTES = readApi("../src/routes/evidence.routes.ts");

const ATTEST_INPUT = {
  evidenceId: "11111111-1111-4111-8111-111111111111",
  declarationType: "AUTHENTICITY" as never,
  attestedByUserId: "22222222-2222-4222-8222-222222222222",
  attestorName: "Dana Reyes",
  attestorTitle: "Records Custodian",
  attestorEmail: "dana@example.test",
  attestorOrganization: "Example County",
  statementMarkdown: "I attest that this record is what it claims to be.",
  statementSnapshot: null,
  signatureText: "Dana Reyes",
};

function baseRow(overrides: Partial<CertRow> = {}): CertRow {
  return {
    id: "cert-1",
    evidenceId: ATTEST_INPUT.evidenceId,
    declarationType: "AUTHENTICITY",
    status: "REQUESTED",
    version: 1,
    requestedByUserId: "requester-1",
    requestedAtUtc: new Date("2026-01-01T00:00:00Z"),
    attestedByUserId: null,
    attestedAtUtc: null,
    attestorName: null,
    attestorTitle: null,
    attestorEmail: null,
    attestorOrganization: null,
    statementMarkdown: null,
    statementSnapshot: null,
    signatureText: null,
    certificationHash: null,
    revokedByUserId: null,
    revokedAtUtc: null,
    revokeReason: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  H.latest = null;
  H.updates = [];
});

describe("attestEvidenceCertification — service behaviour", () => {
  it("refuses with 404 when no certification was ever requested", async () => {
    H.latest = null;
    await expect(attestEvidenceCertification(ATTEST_INPUT)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(H.updates).toHaveLength(0);
  });

  it("refuses with 409 when the certification was revoked", async () => {
    H.latest = baseRow({ status: "REVOKED" });
    await expect(attestEvidenceCertification(ATTEST_INPUT)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(H.updates).toHaveLength(0);
  });

  it("attests the requested certification and persists a certification hash", async () => {
    H.latest = baseRow();
    const result = await attestEvidenceCertification(ATTEST_INPUT);

    expect(H.updates).toHaveLength(1);
    const written = H.updates[0]!.data;
    expect(written.status).toBe("ATTESTED");
    expect(written.attestedByUserId).toBe(ATTEST_INPUT.attestedByUserId);
    expect(written.attestorName).toBe("Dana Reyes");
    expect(typeof written.certificationHash).toBe("string");
    expect(String(written.certificationHash)).toMatch(/^[0-9a-f]{64}$/);

    // The projection hands back exactly what was persisted.
    expect(result.status).toBe("ATTESTED");
    expect(result.certificationHash).toBe(written.certificationHash);
    expect(result.attestorName).toBe("Dana Reyes");
  });
});

describe("POST /v1/evidence/:id/certifications/attest — route wiring", () => {
  function attestHandler(): string {
    const idx = ROUTES.indexOf('"/v1/evidence/:id/certifications/attest"');
    expect(idx).toBeGreaterThan(-1);
    const end = ROUTES.indexOf(
      '"/v1/evidence/:id/certifications/revoke"',
      idx,
    );
    expect(end).toBeGreaterThan(idx);
    return ROUTES.slice(idx, end);
  }

  it("is registered as a POST route", () => {
    expect(ROUTES).toMatch(
      /app\.post\(\s*\n?\s*"\/v1\/evidence\/:id\/certifications\/attest"/,
    );
  });

  it("uses the same auth preHandler and record-access capability as its siblings", () => {
    const body = attestHandler();
    expect(body).toMatch(/preHandler:\s*requireAuth/);
    expect(body).toMatch(
      /getEvidenceWithRecordAccess\([^)]*"evidence\.generate_report"/,
    );
  });

  it("validates the request body with the canonical attest schema", () => {
    expect(attestHandler()).toMatch(
      /AttestEvidenceCertificationBody\.parse\(req\.body\)/,
    );
  });

  it("emits the CERTIFICATION_ATTESTED custody event and the attest audit action", () => {
    const body = attestHandler();
    expect(body).toMatch(
      /eventType:\s*prismaPkg\.CustodyEventType\.CERTIFICATION_ATTESTED/,
    );
    expect(body).toMatch(/action:\s*"evidence\.certification_attested"/);
    expect(body).toMatch(/\.catch\(noteCustodyFailure\)/);
  });

  it("projects service errors through the shared statusCode arm (no generic 500)", () => {
    expect(attestHandler()).toMatch(
      /statusCode\s*\?\?\s*500[\s\S]{0,200}reply\.code\(statusCode\)/,
    );
  });
});
