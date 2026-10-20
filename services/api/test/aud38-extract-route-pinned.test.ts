/**
 * AUD-38 (2026-10-20) — THE PROVIDER EXTRACT ROUTE READS THE SEALED ORIGINAL.
 *
 * Characterization (before): POST /v1/internal/media-intelligence/extract read
 * each part "latest at the key" (no version), never compared what it read with
 * the recorded digest, and ran for a record in any lifecycle state — a
 * provider could be sent bytes nobody sealed, from a trashed or destroyed
 * record. The route is mounted for real; the database, the object store and
 * the provider are doubled, and what the route asks of each is the thing under
 * test.
 */
import { createHash } from "node:crypto";

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEAM = "11111111-1111-4111-8111-111111111111";
const EVIDENCE = "22222222-2222-4222-8222-222222222222";
const SEALED = Buffer.from("the sealed original image bytes");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const state = vi.hoisted(() => ({
  evidence: null as null | Record<string, unknown>,
  parts: [] as Array<Record<string, unknown>>,
  stored: null as Buffer | null,
  rangeCalls: [] as Array<Record<string, unknown>>,
  providerCalls: 0,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidence: { findUnique: async () => state.evidence },
    $queryRawUnsafe: async () => state.parts,
  },
}));
vi.mock("../src/storage.js", () => ({
  getObjectRange: async (p: Record<string, unknown>) => {
    state.rangeCalls.push(p);
    return state.stored;
  },
}));
vi.mock("../src/services/intelligence/providers/provider-adapter.js", () => ({
  getAdapter: () => ({ probe: () => ({ state: "READY" }) }),
}));
vi.mock("../src/services/intelligence/media-intelligence.service.js", () => ({
  runProviderOperation: async () => {
    state.providerCalls += 1;
    return { ok: true, result: { text: "x", pages: [] } };
  },
}));
vi.mock("../src/services/intelligence/extraction.service.js", () => ({
  runExtractionInline: async () => ({ recordsCreated: 1, extractedTextChars: 1 }),
}));

process.env.INTERNAL_SERVICE_TOKEN = "aud38-internal-service-token-000";

async function extract() {
  const { internalMediaIntelligenceExtractRoutes } = await import("../src/routes/internal-media-intelligence-extract.routes.js");
  const app = Fastify();
  await app.register(internalMediaIntelligenceExtractRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/media-intelligence/extract",
    headers: { "x-internal-service-token": process.env.INTERNAL_SERVICE_TOKEN!, "content-type": "application/json" },
    payload: JSON.stringify({ teamId: TEAM, evidenceId: EVIDENCE, kind: "ocr_azure" }),
  });
  await app.close();
  return res.json() as { success: boolean; partsProcessed: number; error?: string };
}

describe("internal extract route (AUD-38)", () => {
  beforeEach(() => {
    state.evidence = { id: EVIDENCE, teamId: TEAM, status: "SIGNED", lifecycleState: "ACTIVE", deletedAt: null };
    state.parts = [
      { id: "p1", storage_bucket: "b", storage_key: "k", storage_version_id: "v-sealed", sha256: sha(SEALED), mime_type: "image/png", size_bytes: SEALED.length },
    ];
    state.stored = SEALED;
    state.rangeCalls = [];
    state.providerCalls = 0;
  });

  it("reads the part at its sealed version and sends it on when it is the recorded original", async () => {
    const r = await extract();
    expect(r.success).toBe(true);
    expect(r.partsProcessed).toBe(1);
    expect(state.rangeCalls[0]).toMatchObject({ bucket: "b", key: "k", versionId: "v-sealed" });
    expect(state.providerCalls).toBe(1);
  });

  it("bytes that are not the recorded original are never sent to a provider", async () => {
    state.stored = Buffer.from("something written at the key later");
    const r = await extract();
    expect(r.partsProcessed).toBe(0);
    expect(state.providerCalls).toBe(0);
  });

  it("a trashed or destroyed record is not read at all", async () => {
    for (const lifecycleState of ["TRASHED", "DESTROYED"]) {
      state.evidence = { ...state.evidence!, lifecycleState };
      state.rangeCalls = [];
      const r = await extract();
      expect(r).toMatchObject({ success: false, error: "evidence_not_active" });
      expect(state.rangeCalls).toEqual([]);
    }
    expect(state.providerCalls).toBe(0);
  });
});
