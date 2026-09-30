/**
 * AUDIT-ONLY probe (UC-SEC-001). Real PostgreSQL 16 + real local MinIO (loopback),
 * real routes via the canonical integration harness. Records what happens when a
 * SECOND member of the same workspace drives the owner's in-flight upload session.
 * Asserts nothing about the desired outcome; writes observations to runtime/probes.
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../../../../../../services/api/test/integration-harness.js";

const OUT = "D:/pv-uca/docs/evidence/audits/universal-evidence-capture/runtime/probes/upload-session-member.json";

describe("UCA probe — same-workspace member drives another member's upload session", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../../../../../../services/api/src/db.js"))["prisma"];
  const out: Record<string, unknown> = {};

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../../../../../../services/api/test/integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../../../../../../services/api/src/db.js"));
    await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  afterAll(async () => {
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    await harness?.cleanup();
  });

  async function call(token: string, method: string, url: string, body?: unknown) {
    const r = await harness.app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try {
      json = r.json();
    } catch {
      /* non-json */
    }
    return { status: r.statusCode, json, body: r.body.slice(0, 500) };
  }

  it("member presigns, uploads and completes into the owner's session", async () => {
    const A = harness.fixtures.teamA;
    const teamId = A.teamId;
    const ownerBytes = Buffer.concat([Buffer.from("OWNER-ORIGINAL-"), randomBytes(64)]);
    const injected = Buffer.concat([Buffer.from("MEMBER-INJECTED-"), randomBytes(64)]);

    const ev = await call(A.ownerToken, "POST", "/v1/evidence", {
      type: "DOCUMENT",
      teamId,
      mimeType: "application/pdf",
      originalFileName: "owner.pdf",
    });
    out.createEvidence = ev.status;
    const evidenceId = ev.json?.id;
    const sess = await call(A.ownerToken, "POST", "/v1/uploads/sessions", {
      teamId,
      evidenceId,
      expectedPartCount: 1,
      idempotencyKey: `uca:${evidenceId}:0`,
      targetPartIndex: 0,
      originalFileName: "owner.pdf",
      expectedMimeType: "application/pdf",
    });
    out.createSession = { status: sess.status, body: sess.body };
    const sessionId = sess.json?.session?.id;
    const init = await call(A.ownerToken, "POST", `/v1/uploads/sessions/${sessionId}/multipart/initiate`, {
      teamId,
      contentType: "application/pdf",
    });
    out.initiate = { status: init.status, body: init.body };

    // The MEMBER (not the session owner) now drives the session.
    const presign = await call(A.memberToken, "POST", `/v1/uploads/sessions/${sessionId}/parts/0/presign`, { teamId });
    out.memberPresign = { status: presign.status, keys: presign.json ? Object.keys(presign.json) : null };
    const url = presign.json?.uploadUrl ?? presign.json?.url;
    if (url) {
      const put = await fetch(url, { method: "PUT", body: injected, signal: AbortSignal.timeout(20_000) });
      out.memberPut = { status: put.status, etag: put.headers.get("etag") };
      const marked = await call(A.memberToken, "POST", `/v1/uploads/sessions/${sessionId}/parts/0/uploaded`, {
        teamId,
        etag: put.headers.get("etag") ?? undefined,
        sizeBytes: injected.length,
        clientSha256: createHash("sha256").update(injected).digest("hex"),
      });
      out.memberMarkUploaded = { status: marked.status, body: marked.body };
      const mc = await call(A.memberToken, "POST", `/v1/uploads/sessions/${sessionId}/multipart/complete`, {
        teamId,
        verifyHash: true,
      });
      out.memberMultipartComplete = { status: mc.status, body: mc.body };
      const sc = await call(A.memberToken, "POST", `/v1/uploads/sessions/${sessionId}/complete`, { teamId });
      out.memberSessionComplete = { status: sc.status, body: sc.body };
      const fin = await call(A.ownerToken, "POST", `/v1/evidence/${evidenceId}/complete`, {});
      out.ownerFinalize = { status: fin.status, body: fin.body };
      const row = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { status: true, ownerUserId: true, fileSha256: true } as never,
      });
      out.evidenceAfter = row;
      out.injectedSha256 = createHash("sha256").update(injected).digest("hex");
      out.ownerIntendedSha256 = createHash("sha256").update(ownerBytes).digest("hex");
      out.ownerUserId = A.ownerUserId;
      out.memberUserId = A.memberUserId;
    }
    expect(true).toBe(true);
  }, 120_000);
});
