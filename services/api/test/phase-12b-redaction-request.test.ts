/**
 * PHASE 12B WAVE 2A — redaction derivative REQUEST matrix (production entry).
 *
 * Drives the REAL requestRedactionDerivative authority (mocked prisma/queue
 * TRANSPORT only): QUEUED-first durability, FUTURE_NOT_SHIPPING media denial
 * BEFORE any row/enqueue, idempotent re-request, enqueue-failure recoverability.
 *
 * MACRO-WAVE A1 extension — drives the REAL download-url route
 * (GET /v1/redaction/derivatives/:id/download-url) via Fastify inject with
 * auth/authorize/rbac/signing TRANSPORT mocked: READY-only issuance through
 * the canonical presign primitive, bounded DERIVATIVE_NOT_READY denial for
 * every non-READY state, capability denial, and the NO-STORAGE-KEY response
 * invariant on BOTH derivative read endpoints.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  version: null as Record<string, unknown> | null,
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  activities: [] as Array<Record<string, unknown>>,
  enqueues: [] as Array<Record<string, unknown>>,
  enqueueOk: true,
  // A1 route-level fixtures
  derivativeRow: null as Record<string, unknown> | null,
  presigns: [] as Array<Record<string, unknown>>,
  gateOk: true,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ currentWorkspaceId: "t1" }),
    },
    redactionVersion: { findFirst: async () => H.version },
    redactionDerivative: {
      findFirst: async () => H.derivativeRow,
      create: async (args: { data: Record<string, unknown> }) => {
        H.created.push(args.data);
        return { id: "d-new" };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        H.updated.push(args.data);
        return {};
      },
    },
  },
}));
// A1 — transport mocks so the REAL route handlers run under inject.
vi.mock("../src/auth.js", () => ({
  getAuthUserId: () => "u1",
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => undefined,
}));
vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (
    _req: unknown,
    _reply: unknown,
    opts: { teamId: string },
  ) => ({ teamId: opts.teamId, actorUserId: "u1" }),
}));
vi.mock("../src/services/redaction/redaction-rbac.service.js", () => ({
  assertRedactionCapability: async () =>
    H.gateOk ? { ok: true } : { ok: false, denial: "ROLE_FORBIDDEN" },
}));
vi.mock("../src/storage.js", () => ({
  presignGetObject: async (p: Record<string, unknown>) => {
    H.presigns.push(p);
    return "https://signed.example/derivative?X-Amz-Signature=test";
  },
}));
vi.mock("../src/services/identity-security/step-up-middleware.js", () => ({
  requireStepUpForSensitiveAction: async () => ({ ok: true }),
}));
vi.mock("../src/services/packaging/entitlement.service.js", () => ({
  assertFeatureEntitlement: async () => ({ ok: true }),
}));
vi.mock("../src/queue/redaction-derivative-queue.js", () => ({
  enqueueRedactionDerivativeRender: async (p: Record<string, unknown>) => {
    H.enqueues.push(p);
    return H.enqueueOk ? { enqueued: true, jobId: `rd-${p.derivativeId}` } : { enqueued: false, reason: "queue_unavailable" };
  },
}));
vi.mock("../src/services/redaction/redaction-activity.service.js", () => ({
  emitRedactionActivity: async (a: Record<string, unknown>) => {
    H.activities.push(a);
  },
}));

import { requestRedactionDerivative } from "../src/services/redaction/redaction-derivative.service.js";
import { redactionRoutes } from "../src/routes/redaction.routes.js";

function seedVersion(artifactKind: string, derivative: Record<string, unknown> | null = null) {
  H.version = {
    id: "v-1",
    state: "APPROVED",
    projectId: "proj-1",
    project: { artifactKind, evidenceId: "ev-1" },
    derivative,
  };
}

beforeEach(() => {
  H.version = null;
  H.created = [];
  H.updated = [];
  H.activities = [];
  H.enqueues = [];
  H.enqueueOk = true;
  H.derivativeRow = null;
  H.presigns = [];
  H.gateOk = true;
});

describe("PHASE 12B — QUEUED-first request durability", () => {
  it("IMAGE: commits QUEUED, then enqueues { derivativeId } only", async () => {
    seedVersion("IMAGE");
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res).toEqual({ ok: true, derivativeId: "d-new", state: "QUEUED" });
    expect(H.created[0].state).toBe("QUEUED"); // committed BEFORE enqueue
    expect(H.enqueues).toEqual([{ derivativeId: "d-new" }]); // no tenant/policy/storage in payload
    // NEVER RENDERING from the API — only the worker claims.
    expect(H.created.some((c) => c.state === "RENDERING")).toBe(false);
    expect(H.updated.some((u) => u.state === "RENDERING")).toBe(false);
  });

  it("PDF is in shipping scope", async () => {
    seedVersion("PDF");
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res.ok).toBe(true);
  });

  it("VIDEO/AUDIO: UNSUPPORTED_REDACTION_MEDIA BEFORE any row or job exists", async () => {
    for (const kind of ["VIDEO", "AUDIO"]) {
      seedVersion(kind);
      const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
      expect(res).toEqual({ ok: false, denial: "UNSUPPORTED_REDACTION_MEDIA" });
    }
    expect(H.created).toEqual([]); // zero derivative records
    expect(H.enqueues).toEqual([]); // zero enqueue
    expect(H.activities).toEqual([]); // zero activity — nothing happened
  });

  it("re-request while READY is idempotent (no new job, no reset)", async () => {
    seedVersion("IMAGE", { id: "d-1", state: "READY" });
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res).toEqual({ ok: true, derivativeId: "d-1", state: "READY" });
    expect(H.enqueues).toEqual([]);
    expect(H.updated).toEqual([]);
  });

  it("re-request after FAILED resets to QUEUED and re-enqueues (no second derivative)", async () => {
    seedVersion("IMAGE", { id: "d-1", state: "FAILED" });
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res).toEqual({ ok: true, derivativeId: "d-1", state: "QUEUED" });
    expect(H.updated[0].state).toBe("QUEUED");
    expect(H.created).toEqual([]); // reuse, never a second row
    expect(H.enqueues).toEqual([{ derivativeId: "d-1" }]);
  });

  it("enqueue failure leaves a recoverable QUEUED row (honest state, no throw)", async () => {
    seedVersion("IMAGE");
    H.enqueueOk = false;
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res).toEqual({ ok: true, derivativeId: "d-new", state: "QUEUED" });
    expect(H.created[0].state).toBe("QUEUED"); // reconciler will pick it up
  });

  it("quarantined derivative refuses re-request", async () => {
    seedVersion("IMAGE", { id: "d-1", state: "QUARANTINED" });
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res).toEqual({ ok: false, denial: "DERIVATIVE_QUARANTINED" });
  });

  it("unapproved version refuses (INVALID_TRANSITION) with zero side effects", async () => {
    seedVersion("IMAGE");
    (H.version as Record<string, unknown>).state = "DRAFT";
    const res = await requestRedactionDerivative({ teamId: "t1", versionId: "v-1", requestedByUserId: "u1" });
    expect(res).toEqual({ ok: false, denial: "INVALID_TRANSITION" });
    expect(H.created).toEqual([]);
    expect(H.enqueues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MACRO-WAVE A1 — authorized download-url endpoint (REAL route via inject)
// ---------------------------------------------------------------------------

const DERIVATIVE_ID = "3f8e9a52-4b1c-4a5b-8c6d-9e0f12345678";

function seedDerivative(state: string, overrides: Record<string, unknown> = {}) {
  H.derivativeRow = {
    id: DERIVATIVE_ID,
    versionId: "v-1",
    teamId: "t1",
    kind: "IMAGE_REDACTED",
    state,
    storageBucket: "derivatives-bucket",
    storageKey: "redaction/t1/v-1/redacted.png",
    storageRegion: "eu-central-1",
    byteSize: 1024n,
    fileSha256: "abc123",
    contentType: "image/png",
    renderedAtUtc: state === "READY" ? new Date("2026-07-01T00:00:00Z") : null,
    downloadCount: 0,
    // The project travels WITH the derivative (one query), so the access
    // record can never be skipped for want of a second lookup.
    version: { projectId: "p-1" },
    ...overrides,
  };
}

describe("MACRO-WAVE A1 — GET /v1/redaction/derivatives/:id/download-url", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(redactionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const inject = (path = `/v1/redaction/derivatives/${DERIVATIVE_ID}/download-url`) =>
    app.inject({ method: "GET", url: path });

  // ONE table — READY-only issuance; every non-READY state answers the
  // bounded DERIVATIVE_NOT_READY denial WITHOUT minting a signed URL.
  const STATE_TABLE: ReadonlyArray<{
    state: string | null;
    expectStatus: number;
    expectUrl: boolean;
  }> = [
    { state: "READY", expectStatus: 200, expectUrl: true },
    { state: "QUEUED", expectStatus: 409, expectUrl: false },
    { state: "RENDERING", expectStatus: 409, expectUrl: false },
    { state: "FAILED", expectStatus: 409, expectUrl: false },
    { state: "QUARANTINED", expectStatus: 409, expectUrl: false },
    { state: null, expectStatus: 404, expectUrl: false }, // no row at all
  ];

  for (const row of STATE_TABLE) {
    it(`state ${row.state ?? "(missing)"} → ${row.expectStatus}${row.expectUrl ? " + signed URL" : " denial, no presign"}`, async () => {
      if (row.state) seedDerivative(row.state);
      const res = await inject();
      expect(res.statusCode).toBe(row.expectStatus);
      const body = res.json() as Record<string, unknown>;
      if (row.expectUrl) {
        expect(body.downloadUrl).toBe(
          "https://signed.example/derivative?X-Amz-Signature=test",
        );
        expect(typeof body.expiresAtUtc).toBe("string");
        // Signed via the CANONICAL presign primitive with the row's coordinates.
        expect(H.presigns).toEqual([
          {
            bucket: "derivatives-bucket",
            key: "redaction/t1/v-1/redacted.png",
            expiresInSeconds: 300,
          },
        ]);
        // Audit — download counter bumped + DERIVATIVE_DOWNLOADED emitted.
        expect(H.updated).toEqual([{ downloadCount: { increment: 1 } }]);
      } else {
        expect(body.denial).toBe("DERIVATIVE_NOT_READY");
        expect(H.presigns).toEqual([]); // never mint a URL for a non-READY row
        expect(body.downloadUrl).toBeUndefined();
      }
      // NO-STORAGE-KEY invariant — raw storage coordinates never reach the client.
      const raw = res.body;
      expect(raw).not.toContain("storageKey");
      expect(raw).not.toContain("storageBucket");
      expect(raw).not.toContain("derivatives-bucket");
      expect(raw).not.toContain("redaction/t1/v-1/redacted.png");
    });
  }

  it("READY but storage coordinates missing → 409 (never presign empty keys)", async () => {
    seedDerivative("READY", { storageBucket: null, storageKey: null });
    const res = await inject();
    expect(res.statusCode).toBe(409);
    expect((res.json() as Record<string, unknown>).denial).toBe(
      "DERIVATIVE_NOT_READY",
    );
    expect(H.presigns).toEqual([]);
  });

  it("capability denial → 403, no presign, no counter bump", async () => {
    seedDerivative("READY");
    H.gateOk = false;
    const res = await inject();
    expect(res.statusCode).toBe(403);
    expect(H.presigns).toEqual([]);
    expect(H.updated).toEqual([]);
  });

  it("metadata endpoint GET /v1/redaction/derivatives/:id no longer leaks storage coordinates", async () => {
    seedDerivative("READY");
    const res = await app.inject({
      method: "GET",
      url: `/v1/redaction/derivatives/${DERIVATIVE_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { derivative: Record<string, unknown> };
    expect(body.derivative.fileSha256).toBe("abc123");
    expect(body.derivative.state).toBe("READY");
    expect(res.body).not.toContain("storageKey");
    expect(res.body).not.toContain("storageBucket");
    expect(res.body).not.toContain("storageRegion");
    expect(res.body).not.toContain("derivatives-bucket");
  });

  // PHASE 12 POINT 4 PASS C2 — the state read is not an access record.
  //
  // The redaction UI polls this endpoint every few seconds while a render is
  // in flight. It used to increment `downloadCount` and append a
  // DERIVATIVE_DOWNLOADED activity row on every poll, so the operator
  // timeline filled with access records for bytes nobody received.
  it("polling the metadata endpoint records NO download and NO access event", async () => {
    seedDerivative("RENDERING");
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/redaction/derivatives/${DERIVATIVE_ID}`,
      });
      expect(res.statusCode).toBe(200);
    }
    expect(H.updated).toEqual([]);
    expect(
      H.activities.filter((a) => a.code === "DERIVATIVE_DOWNLOADED"),
    ).toEqual([]);
  });

  it("issuing a signed URL — the moment access is granted — IS recorded once", async () => {
    seedDerivative("READY");
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(H.updated).toEqual([{ downloadCount: { increment: 1 } }]);
    expect(
      H.activities.filter((a) => a.code === "DERIVATIVE_DOWNLOADED"),
    ).toHaveLength(1);
  });
});
