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
});
