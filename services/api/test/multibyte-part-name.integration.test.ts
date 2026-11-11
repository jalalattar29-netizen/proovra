/**
 * AUD-0054 — a long multi-byte file name no longer fails at the storage PUT.
 *
 * The audit created evidence with a 180-character Arabic + Hebrew name: the API
 * accepted it (the limit was in characters), the presigned PUT was refused by
 * the object store (`XMinioInvalidObjectName`: the key segment exceeded 255
 * bytes), and the record stayed UPLOADING. The key now carries a byte-bounded
 * fragment of the name; the part row keeps the full name.
 *
 * Real routes, PostgreSQL and the local object store.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("AUD-0054 multi-byte part names reach storage (live PostgreSQL + object store)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 300_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("a 180-character Arabic + Hebrew name uploads, completes, and is kept whole on the part", async () => {
    const A = h.fixtures.teamA;
    const auth = { authorization: `Bearer ${A.ownerToken}` };
    const name = `${"ع".repeat(90)}${"ש".repeat(86)}.txt`;
    expect(name.length).toBe(180);
    const bytes = Buffer.from(`aud-0054 ${Date.now()}`);

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: auth,
      payload: {
        type: "DOCUMENT",
        mimeType: "text/plain",
        originalFileName: name,
        checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
        teamId: A.teamId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const part = await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${id}/parts`,
      headers: auth,
      payload: { partIndex: 0, mimeType: "text/plain", sizeBytes: bytes.length, originalFileName: name },
    });
    expect(part.statusCode, part.body).toBeLessThan(300);
    const up = (part.json() as { upload: { putUrl: string; headers?: Record<string, string> } }).upload;
    const put = await fetch(up.putUrl, { method: "PUT", body: bytes, headers: { "content-type": "text/plain", ...(up.headers ?? {}) } });
    expect(put.status, await put.text()).toBe(200);

    const row = await prisma.evidencePart.findFirstOrThrow({
      where: { evidenceId: id, partIndex: 0 },
      select: { originalFileName: true, storageKey: true },
    });
    expect(row.originalFileName).toBe(name);
    for (const segment of row.storageKey!.split("/")) {
      expect(Buffer.byteLength(segment, "utf8")).toBeLessThanOrEqual(255);
    }

    const done = await h.app.inject({ method: "POST", url: `/v1/evidence/${id}/complete`, headers: auth, payload: {} });
    expect(done.statusCode, done.body).toBe(200);
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true } });
    expect(["SIGNED", "REPORTED"]).toContain(ev.status);
  }, 120_000);

  // AUD-0035 — the Android capture screen now sends a picked file's own name
  // when it reserves the record; the reservation keeps it as the record's
  // original and display name instead of PROOVRA-CAPTURE-<timestamp>.bin.
  it("a direct-capture reservation that names the picked file keeps that name on the record", async () => {
    const A = h.fixtures.teamA;
    const post = (url: string, payload: unknown) =>
      h.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${A.ownerToken}`, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    const open = await post("/v1/capture/direct-sessions", { mode: "PROOVRA_MOBILE_APP", teamId: A.teamId, deviceId: null });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = (open.json() as { session: { captureSessionId: string } }).session.captureSessionId;
    const reserve = await post(`/v1/capture/direct-sessions/${sessionId}/evidence`, {
      type: "DOCUMENT",
      mimeType: "text/plain",
      originalFileName: "audit-capture.txt",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = (reserve.json() as { evidence: { evidenceId: string } }).evidence.evidenceId;
    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { originalFileName: true, displayFileName: true },
    });
    expect(row.originalFileName).toBe("audit-capture.txt");
    expect(row.displayFileName).toBe("audit-capture.txt");
  }, 120_000);
});
