/**
 * PRO-078 (UI-07) — a refused upload does not take a FREE record slot
 * (live PostgreSQL, real HTTP; no bytes are written to object storage).
 *
 * Reproduced by the audit: a FREE user at 1 of 3 tried two .exe files; each
 * gave POST /v1/evidence 201 then POST /v1/evidence/:id/parts 415 "File
 * validation blocked". The billing meter went from 1 to 3, the library showed
 * nothing, and a valid PDF then got 409 FREE_LIMIT_REACHED saying a deleted
 * record does not restore a slot. The empty reservations held their slots,
 * invisibly, until the 24-hour sweep.
 *
 * Now the refusal releases an EMPTY reservation at once, through the
 * reservation authority (soft delete + EVIDENCE_DELETED custody event,
 * reason UPLOAD_REFUSED), and the limit message names uploads that were never
 * finished when they are what holds the slots.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

describe("PRO-078: a refused upload gives its FREE slot back (Postgres, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let countHeld: (typeof import("../src/services/billing-enforcement.service.js"))["countPersonalEvidenceRecords"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    ({ countPersonalEvidenceRecords: countHeld } = await import("../src/services/billing-enforcement.service.js"));
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `pro078-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  const call = (method: "POST" | "GET", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function create(t: PersonalTenant): Promise<string> {
    const res = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "application/pdf" });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  const exe = { mimeType: "application/x-msdownload", originalFileName: "invoice.exe" };
  const pdf = { mimeType: "application/pdf", originalFileName: "invoice.pdf" };

  it("an empty record whose file is refused is released at once, with a custody event", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const id = await create(t);
    expect(await countHeld(t.owner.userId)).toBe(1);

    const refused = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, { partIndex: 0, ...exe });
    expect(refused.statusCode, refused.body).toBe(415);
    expect(refused.json()).toMatchObject({ code: "FILE_VALIDATION_BLOCKED", reservationReleased: true });

    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { deletedAt: true, status: true } });
    expect(row.deletedAt).not.toBeNull();
    expect(["CREATED", "UPLOADING"]).toContain(row.status);
    const events = await prisma.custodyEvent.findMany({ where: { evidenceId: id, eventType: "EVIDENCE_DELETED" } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { reason?: string }).reason).toBe("UPLOAD_REFUSED");
    expect(await countHeld(t.owner.userId)).toBe(0);
  }, 240_000);

  it("the audit's sequence: two refused .exe files leave the allowance where it was", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    // At 1 of 3: one live reservation the person is still working on.
    const kept = await create(t);
    expect(await countHeld(t.owner.userId)).toBe(1);

    for (let i = 0; i < 2; i += 1) {
      const id = await create(t);
      const refused = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, { partIndex: 0, ...exe });
      expect(refused.statusCode).toBe(415);
    }
    expect(await countHeld(t.owner.userId), "refused uploads hold no slot").toBe(1);

    // The valid PDF is admitted (it used to be FREE_LIMIT_REACHED here).
    const next = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "application/pdf" });
    expect(next.statusCode, next.body).toBe(201);
    expect(kept).toBeTruthy();
  }, 240_000);

  it("control: a refused SECOND file does not discard the record its first file is in", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const id = await create(t);
    const first = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, { partIndex: 0, ...pdf });
    expect(first.statusCode, first.body).toBe(201);

    const refused = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, { partIndex: 1, ...exe });
    expect(refused.statusCode).toBe(415);
    expect(refused.json()).toMatchObject({ code: "FILE_VALIDATION_BLOCKED", reservationReleased: false });
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } });
    expect(row.deletedAt).toBeNull();
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_DELETED" } })).toBe(0);
    expect(await countHeld(t.owner.userId)).toBe(1);
  }, 240_000);

  it("control: another user cannot release someone else's reservation through a refused part", async () => {
    const owner = await seedPersonalTenant(deps, "FREE");
    const other = await seedPersonalTenant(deps, "FREE");
    const id = await create(owner);
    const res = await call("POST", `/v1/evidence/${id}/parts`, other.owner.token, { partIndex: 0, ...exe });
    expect([403, 404]).toContain(res.statusCode);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } });
    expect(row.deletedAt).toBeNull();
  }, 240_000);

  it("the limit message says when unfinished uploads hold the slots", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 3; i += 1) await create(t);
    const refused = await call("POST", "/v1/evidence", t.owner.token, { type: "DOCUMENT", mimeType: "application/pdf" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("FREE_LIMIT_REACHED");
    const message = String(refused.json().message ?? refused.json().error?.message ?? "");
    // The founder's rule for sealed records stays.
    expect(message).toMatch(/Deleting a record does not restore a slot/);
    expect(message).toMatch(/3 of them are uploads that were never finished: each frees its slot when it is finished or released, or 24 hours after it was last touched/);
  }, 240_000);
});
