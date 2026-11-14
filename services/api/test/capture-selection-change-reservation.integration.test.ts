/**
 * F-03 / F-04 / F-27c (Free-user audit 2026-11-13) — a web capture's reserved
 * record is resumed only for the files it was made for, a discarded draft gives
 * its slot back, and the direct-capture refusal says why (live PostgreSQL 16,
 * real HTTP; only the object store, the signer and the TSA are doubled, as in
 * completion-cross-channel.integration.test.ts).
 *
 * F-03 — after a failed finalize, a retry with a CHANGED staged set used to be
 * uploaded into the old unsealed record: POST /v1/evidence (same draft) returned
 * it, POST /parts returned the row already issued for each index and signed the
 * new file's checksum into that row's URL, and the seal hashed every row the
 * record held. One file's bytes were sealed under another's name, note, role
 * and checklist step, and a removed file's row was sealed at the tail.
 * Proven here: the same files resume (idempotent); a removal, reorder or
 * replacement (same name and size, other bytes included) releases the old
 * reservation and reserves a fresh record in one transaction (no extra slot);
 * the old record can never be completed or written afterwards; a presign never
 * re-binds an index; and at the seal, stored bytes that are not the bound file
 * are refused before anything is signed.
 *
 * F-04 — DELETE /v1/capture/sessions/:id only marked the draft DISCARDED; the
 * record it reserved held a FREE slot for ~24 h. Proven here: discard releases
 * it (once), the slot is reusable, a sealed record is never released, and no
 * one can release another person's reservation.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://selection-change-store.invalid/${encodeURIComponent(id(p))}?n=${randomBytes(4).toString("hex")}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "image/jpeg",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`selection-change-sig:${hex}`).toString("base64"),
        keyId: "selection-change-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

process.env.S3_BUCKET = "selection-change-test-bucket";

type StagedFile = { name: string; bytes: Buffer; note?: string };
const file = (name: string, content: string, note?: string): StagedFile => ({ name, bytes: Buffer.from(content), note });
const b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");
const hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function storeFromPutUrl(putUrl: string, bytes: Buffer) {
  objects.set(decodeURIComponent(new URL(putUrl).pathname.slice(1)), bytes);
}

describe("F-03/F-04: a web reservation fits its files; discard releases it (Postgres, real HTTP)", () => {
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
      tag: `f03-${Date.now().toString(36)}`,
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

  const call = (method: "POST" | "GET" | "DELETE", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  const newDraft = (t: PersonalTenant) =>
    prisma.captureSession.create({
      data: { ownerUserId: t.owner.userId, teamId: t.personalTeamId, status: "DRAFT" },
      select: { id: true },
    });

  /** Finish & Sign's create, as the web client sends it (with the file manifest). */
  const finish = (t: PersonalTenant, draftId: string | null, files: StagedFile[]) =>
    call("POST", "/v1/evidence", t.owner.token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: t.personalTeamId,
      originalFileName: files[0]!.name,
      ...(draftId ? { captureSessionId: draftId } : {}),
      parts: files.map((f) => ({ originalFileName: f.name, mimeType: "image/jpeg", sha256Base64: b64(f.bytes) })),
    });

  const presign = (t: PersonalTenant, id: string, index: number, f: StagedFile) =>
    call("POST", `/v1/evidence/${id}/parts`, t.owner.token, {
      partIndex: index,
      mimeType: "image/jpeg",
      originalFileName: f.name,
      sizeBytes: f.bytes.length,
      checksumSha256Base64: b64(f.bytes),
      ...(f.note ? { privateNote: f.note } : {}),
      clientSignals: { clientHintSha256Base64: b64(f.bytes), duplicateStatus: "unique" },
    });

  async function upload(t: PersonalTenant, id: string, index: number, f: StagedFile) {
    const res = await presign(t, id, index, f);
    expect([200, 201], res.body).toContain(res.statusCode);
    storeFromPutUrl(res.json().upload.putUrl as string, f.bytes);
  }

  const complete = (t: PersonalTenant, id: string) => call("POST", `/v1/evidence/${id}/complete`, t.owner.token, {});

  async function record(id: string) {
    const [ev, parts, deleted, completed] = await Promise.all([
      prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true, deletedAt: true, signatureBase64: true } }),
      prisma.evidencePart.findMany({
        where: { evidenceId: id },
        orderBy: { partIndex: "asc" },
        select: { partIndex: true, originalFileName: true, sha256: true, privateNote: true },
      }),
      prisma.custodyEvent.findMany({ where: { evidenceId: id, eventType: "EVIDENCE_DELETED" }, select: { payload: true } }),
      prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_COMPLETED" } }),
    ]);
    return { ev, parts, deleted, completed };
  }

  // --- F-03 -----------------------------------------------------------------

  it("the same files: a retry resumes the same record and seals it (idempotent)", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const b = file("b.jpg", `B-${randomBytes(6).toString("hex")}`);
    const first = await finish(t, draft.id, [a, b]);
    expect(first.statusCode, first.body).toBe(201);
    const id = first.json().id as string;
    await upload(t, id, 0, a);
    const bPresign = await presign(t, id, 1, b); // its PUT "failed"
    expect(bPresign.statusCode, bPresign.body).toBe(201);

    const retry = await finish(t, draft.id, [a, b]);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ id, resumed: true });
    await upload(t, id, 0, a); // re-presign of an issued index for the SAME file
    await upload(t, id, 1, b);
    const done = await complete(t, id);
    expect(done.statusCode, done.body).toBe(200);

    const r = await record(id);
    expect(r.ev.status).toBe("SIGNED");
    expect(r.parts.map((p) => [p.originalFileName, p.sha256])).toEqual([
      ["a.jpg", hex(a.bytes)],
      ["b.jpg", hex(b.bytes)],
    ]);
    expect(await countHeld(t.owner.userId)).toBe(1);
  }, 240_000);

  it("a removed file: a fresh record is reserved, the old reservation is released and can never be sealed or written", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`, "note for A");
    const b = file("b.jpg", `B-${randomBytes(6).toString("hex")}`, "note for B");
    const first = await finish(t, draft.id, [a, b]);
    expect(first.statusCode, first.body).toBe(201);
    const oldId = first.json().id as string;
    await upload(t, oldId, 0, a);
    await upload(t, oldId, 1, b);
    // /complete was refused (e.g. storage); the person removes a.jpg and finishes again.

    const retry = await finish(t, draft.id, [b]);
    expect(retry.statusCode, retry.body).toBe(201);
    const newId = retry.json().id as string;
    expect(newId).not.toBe(oldId);
    expect(retry.json().resumed).toBeUndefined();

    const old = await record(oldId);
    expect(old.ev.deletedAt, "old reservation released").not.toBeNull();
    expect(["CREATED", "UPLOADING"]).toContain(old.ev.status);
    expect(old.deleted).toHaveLength(1);
    expect(old.deleted[0]!.payload).toMatchObject({ reason: "CAPTURE_SELECTION_CHANGED", captureSessionId: draft.id });
    const bound = await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true, finalizedEvidenceId: true } });
    expect(bound).toEqual({ status: "DRAFT", finalizedEvidenceId: newId });
    expect(await countHeld(t.owner.userId), "one live reservation, not two").toBe(1);

    // A late retry of the OLD attempt can neither write to nor seal the old record.
    const latePresign = await presign(t, oldId, 0, b);
    expect(latePresign.statusCode).toBe(404);
    const lateComplete = await complete(t, oldId);
    expect(lateComplete.statusCode).toBe(404);
    const oldAfter = await record(oldId);
    expect(oldAfter.ev.status).not.toBe("SIGNED");
    expect(oldAfter.ev.signatureBase64).toBeNull();
    expect(oldAfter.completed).toBe(0);

    // The new selection seals under ITS OWN file's metadata.
    await upload(t, newId, 0, b);
    const done = await complete(t, newId);
    expect(done.statusCode, done.body).toBe(200);
    const sealed = await record(newId);
    expect(sealed.ev.status).toBe("SIGNED");
    expect(sealed.parts).toEqual([{ partIndex: 0, originalFileName: "b.jpg", sha256: hex(b.bytes), privateNote: "note for B" }]);
    expect((await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true } })).status).toBe("FINALIZED");
  }, 240_000);

  it("a changed selection that loses the race with the earlier attempt's seal is refused, not reserved twice", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const b = file("b.jpg", `B-${randomBytes(6).toString("hex")}`);
    const first = await finish(t, draft.id, [a, b]);
    expect(first.statusCode, first.body).toBe(201);
    const oldId = first.json().id as string;
    await upload(t, oldId, 0, a);
    await upload(t, oldId, 1, b);

    // The stale decision reads the record's parts outside the creating
    // transaction; the earlier attempt's seal lands right after that read.
    const delegate = prisma.evidencePart as unknown as Record<string, unknown>;
    const hadOwn = Object.prototype.hasOwnProperty.call(delegate, "findMany");
    const original = delegate.findMany as (...args: unknown[]) => Promise<unknown>;
    let fired = false;
    delegate.findMany = async (...args: unknown[]) => {
      const rows = await original.apply(prisma.evidencePart, args);
      if (!fired) {
        fired = true;
        await prisma.evidence.update({ where: { id: oldId }, data: { status: "SIGNED" } });
      }
      return rows;
    };
    let retry;
    try {
      retry = await finish(t, draft.id, [b]);
    } finally {
      if (hadOwn) delegate.findMany = original;
      else delete delegate.findMany;
    }
    expect(fired).toBe(true);
    expect(retry.statusCode, retry.body).toBe(409);
    const refusal = retry.json() as { code?: string; error?: { code?: string } };
    expect(refusal.error?.code ?? refusal.code).toBe("CAPTURE_ALREADY_FINISHED");
    const old = await record(oldId);
    expect(old.ev.deletedAt, "the sealed record is not released").toBeNull();
    expect(old.deleted).toHaveLength(0);
    expect(await countHeld(t.owner.userId), "no second reservation behind the user's back").toBe(1);
    const bound = await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id }, select: { finalizedEvidenceId: true } });
    expect(bound.finalizedEvidenceId).toBe(oldId);
  }, 240_000);

  it("a reorder, or the same name and size with other bytes, is a changed selection too", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(t);
    const a = file("a.jpg", "AAAAAAAA-1");
    const b = file("b.jpg", "BBBBBBBB-1");
    const first = await finish(t, draft.id, [a, b]);
    const id1 = first.json().id as string;
    await upload(t, id1, 0, a);
    await upload(t, id1, 1, b);

    const reordered = await finish(t, draft.id, [b, a]);
    expect(reordered.statusCode, reordered.body).toBe(201);
    const id2 = reordered.json().id as string;
    expect((await record(id1)).ev.deletedAt).not.toBeNull();
    await upload(t, id2, 0, b);

    const edited = file("b.jpg", "BBBBBBBB-2"); // same name, same size, other bytes
    expect(edited.bytes.length).toBe(b.bytes.length);
    const replaced = await finish(t, draft.id, [edited]);
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json().id).not.toBe(id2);
    expect((await record(id2)).ev.deletedAt).not.toBeNull();
    expect(await countHeld(t.owner.userId)).toBe(1);
  }, 240_000);

  it("a presign never re-binds an issued index to another file", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`, "note for A");
    const created = await finish(t, null, [a]);
    const id = created.json().id as string;
    await upload(t, id, 0, a);

    const otherName = await presign(t, id, 0, file("b.jpg", `B-${randomBytes(6).toString("hex")}`));
    expect(otherName.statusCode, otherName.body).toBe(409);
    expect(otherName.json().code).toBe("PART_INDEX_TAKEN");
    const otherBytes = await presign(t, id, 0, file("a.jpg", `A2-${randomBytes(6).toString("hex")}`));
    expect(otherBytes.statusCode, otherBytes.body).toBe(409);
    expect(otherBytes.json().code).toBe("PART_INDEX_TAKEN");

    const r = await record(id);
    expect(r.parts).toEqual([{ partIndex: 0, originalFileName: "a.jpg", sha256: null, privateNote: "note for A" }]);
  }, 240_000);

  it("at the seal, stored bytes that are not the bound file are refused before anything is signed", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const created = await finish(t, null, [a]);
    const id = created.json().id as string;
    const res = await presign(t, id, 0, a);
    // A store that did not enforce the signed checksum accepted other bytes.
    storeFromPutUrl(res.json().upload.putUrl as string, Buffer.from(`not-A-${randomBytes(6).toString("hex")}`));

    const refused = await complete(t, id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe("PART_DIGEST_MISMATCH");
    await h.handlersSettled();
    const r = await record(id);
    expect(["CREATED", "UPLOADING"]).toContain(r.ev.status);
    expect(r.ev.signatureBase64).toBeNull();
    expect(r.completed).toBe(0);
    expect(r.parts[0]!.sha256).toBeNull();
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: { in: ["SIGNATURE_APPLIED", "UPLOAD_COMPLETED"] } } })).toBe(0);
  }, 240_000);

  it("FREE at 3 of 3: a changed selection reserves its fresh record without a fourth slot", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 2; i += 1) {
      const other = await finish(t, null, [file(`o${i}.jpg`, `O${i}`)]);
      expect(other.statusCode, other.body).toBe(201);
    }
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const first = await finish(t, draft.id, [a]);
    expect(first.statusCode, first.body).toBe(201);
    await upload(t, first.json().id as string, 0, a);
    expect(await countHeld(t.owner.userId)).toBe(3);

    // Control: an unrelated fourth capture is refused.
    const fourth = await finish(t, null, [file("x.jpg", "X")]);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().code).toBe("FREE_LIMIT_REACHED");

    const replaced = await finish(t, draft.id, [file("c.jpg", `C-${randomBytes(6).toString("hex")}`)]);
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(await countHeld(t.owner.userId)).toBe(3);
  }, 240_000);

  it("F-12: a part whose declared size alone exceeds the remaining storage is refused before any byte moves", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const created = await finish(t, null, [file("big.mp4", "B")]);
    const id = created.json().id as string;
    const refused = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, {
      partIndex: 0,
      mimeType: "video/mp4",
      originalFileName: "big.mp4",
      sizeBytes: 300 * 1024 * 1024, // FREE includes 250 MiB
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: "STORAGE_LIMIT_REACHED", billingWall: { reason: "part_presign_blocked" } });
    expect(await prisma.evidencePart.count({ where: { evidenceId: id } })).toBe(0);

    // Control: a size that fits is presigned as before.
    const fits = await presign(t, id, 0, file("small.jpg", "S"));
    expect(fits.statusCode, fits.body).toBe(201);
  }, 240_000);

  // --- F-04 -----------------------------------------------------------------

  it("discarding a draft releases its unsealed reservation once, and the slot is reusable", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 2; i += 1) await finish(t, null, [file(`o${i}.jpg`, `O${i}`)]);
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const created = await finish(t, draft.id, [a]);
    const id = created.json().id as string;
    await upload(t, id, 0, a);
    expect(await countHeld(t.owner.userId)).toBe(3);

    const discarded = await call("DELETE", `/v1/capture/sessions/${draft.id}`, t.owner.token);
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json()).toMatchObject({ session: { status: "DISCARDED" }, reservationReleased: true });
    const r = await record(id);
    expect(r.ev.deletedAt).not.toBeNull();
    expect(r.deleted).toHaveLength(1);
    expect(r.deleted[0]!.payload).toMatchObject({ reason: "CAPTURE_SESSION_DISCARDED", captureSessionId: draft.id });
    expect(await countHeld(t.owner.userId)).toBe(2);

    // Duplicate discard: a no-op, no second custody event.
    const again = await call("DELETE", `/v1/capture/sessions/${draft.id}`, t.owner.token);
    expect(again.statusCode).toBe(200);
    expect(again.json().reservationReleased).toBeUndefined();
    expect((await record(id)).deleted).toHaveLength(1);

    // The discarded record cannot be finished; the slot is reusable.
    expect((await complete(t, id)).statusCode).toBe(404);
    const next = await finish(t, null, [file("n.jpg", "N")]);
    expect(next.statusCode, next.body).toBe(201);
  }, 240_000);

  it("a sealed record is never released by a discard", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const created = await finish(t, draft.id, [a]);
    const id = created.json().id as string;
    await upload(t, id, 0, a);
    expect((await complete(t, id)).statusCode).toBe(200);

    // Finalized draft: idempotent no-op.
    const res = await call("DELETE", `/v1/capture/sessions/${draft.id}`, t.owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("FINALIZED");

    // Even a DRAFT that still points at a sealed record releases nothing.
    const stray = await prisma.captureSession.update({
      where: { id: draft.id },
      data: { status: "DRAFT", finalizedAtUtc: null },
      select: { id: true },
    });
    const strayRes = await call("DELETE", `/v1/capture/sessions/${stray.id}`, t.owner.token);
    expect(strayRes.statusCode).toBe(200);
    expect(strayRes.json()).toMatchObject({ session: { status: "DISCARDED" }, reservationReleased: false });
    const r = await record(id);
    expect(r.ev.status).toBe("SIGNED");
    expect(r.ev.deletedAt).toBeNull();
    expect(r.deleted).toHaveLength(0);
    expect(await countHeld(t.owner.userId)).toBe(1);
  }, 240_000);

  it("no one can release another person's reservation through a draft", async () => {
    const owner = await seedPersonalTenant(deps, "FREE");
    const other = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(owner);
    const created = await finish(owner, draft.id, [file("a.jpg", "A")]);
    const id = created.json().id as string;

    const foreign = await call("DELETE", `/v1/capture/sessions/${draft.id}`, other.owner.token);
    expect(foreign.statusCode).toBe(404);

    // A draft of `other` forged to point at an owner's record releases nothing.
    const unbound = await finish(owner, null, [file("u.jpg", "U")]);
    const unboundId = unbound.json().id as string;
    const forged = await prisma.captureSession.create({
      data: { ownerUserId: other.owner.userId, teamId: other.personalTeamId, status: "DRAFT", finalizedEvidenceId: unboundId },
      select: { id: true },
    });
    const forgedRes = await call("DELETE", `/v1/capture/sessions/${forged.id}`, other.owner.token);
    expect(forgedRes.statusCode).toBe(200);
    expect(forgedRes.json().reservationReleased).toBe(false);

    for (const evidenceId of [id, unboundId]) {
      const r = await record(evidenceId);
      expect(r.ev.deletedAt).toBeNull();
      expect(r.deleted).toHaveLength(0);
    }
    expect((await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true } })).status).toBe("DRAFT");
  }, 240_000);

  it("discard racing finalize: exactly one wins, never a signed record that was released", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    const draft = await newDraft(t);
    const a = file("a.jpg", `A-${randomBytes(6).toString("hex")}`);
    const created = await finish(t, draft.id, [a]);
    const id = created.json().id as string;
    await upload(t, id, 0, a);

    const [done, discarded] = await Promise.all([
      complete(t, id),
      call("DELETE", `/v1/capture/sessions/${draft.id}`, t.owner.token),
    ]);
    expect(discarded.statusCode, discarded.body).toBe(200);
    await h.handlersSettled();
    const r = await record(id);
    const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true } });
    if (r.ev.status === "SIGNED") {
      expect(done.statusCode).toBe(200);
      expect(r.ev.deletedAt).toBeNull();
      expect(session.status).toBe("FINALIZED");
      expect(discarded.json().reservationReleased).toBeUndefined();
    } else {
      expect(done.statusCode).toBe(404);
      expect(r.ev.deletedAt).not.toBeNull();
      expect(session.status).toBe("DISCARDED");
      expect(r.completed).toBe(0);
    }
  }, 240_000);

  // --- F-27c ----------------------------------------------------------------

  it("a direct-capture refusal at the FREE limit keeps `denial` and says why", async () => {
    const t = await seedPersonalTenant(deps, "FREE");
    for (let i = 0; i < 3; i += 1) await finish(t, null, [file(`o${i}.jpg`, `O${i}`)]);
    const open = await call("POST", "/v1/capture/direct-sessions", t.owner.token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: t.personalTeamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sid = open.json().session.captureSessionId as string;
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sid}/evidence`, t.owner.token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
    });
    expect(reserve.statusCode, reserve.body).toBe(409);
    const body = reserve.json() as { denial: string; code?: string; message?: string };
    expect(body.denial).toBe("FREE_LIMIT_REACHED");
    expect(body.code).toBe("FREE_LIMIT_REACHED");
    expect(body.message).toMatch(/Free plan/);
    expect(body.message).toMatch(/uploads that were never finished/);
  }, 240_000);
});
