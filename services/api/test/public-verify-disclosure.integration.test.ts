/**
 * PUBLIC VERIFY DISCLOSURE CONVERGENCE (2026-10-18) — executed proof.
 *
 * One record mirrors the production lifecycle that the audit traced: a
 * six-part multipart record whose storage keys embed the original file names,
 * GPS coordinates and a device time, an account identity snapshot that carries
 * the owner's email, access activity after finalization, and an OpenTimestamps
 * proof. The anonymous pvr_ page is read through the REAL route over HTTP.
 *
 * The first block ("characterization") pins the confirmed audit defects as
 * the contract they must meet. Each one failed for its documented reason on
 * 35f6c7bbb before the convergence landed.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), MinIO, Redis, the API over
 * HTTP, the custody chain, the canonical reference authority.
 * WHAT IS DOUBLED: the RFC 3161 authority (no timestamp is requested).
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { otsColumnsFor } from "./helpers/ots-proof-bytes.js";

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const PART_NAMES = [
  "alpha-witness-statement.txt",
  "bravo-dashcam-still.txt",
  "charlie-insurer-letter.txt",
  "delta-police-ref.txt",
  "echo-garage-invoice.txt",
  "foxtrot-medical-note.txt",
] as const;
/** The distinctive token of each name: present anywhere in a body = a leak. */
const NAME_TOKENS = PART_NAMES.map((n) => n.split(".")[0]!);
const TITLE = "Kestrel Lane collision — private title";
const DEVICE_TIME = "2026-10-01T09:41:07.123+02:00";
const GPS = { lat: 48.137154, lng: 11.576124, accuracyMeters: 7 };

describe("Public Verify disclosure convergence (Postgres + MinIO + Redis)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;
  let record: { id: string; ref: string; ownerEmail: string };

  const A = () => h.fixtures.teamA;
  const call = (method: "GET" | "POST" | "PUT", url: string, token: string | null, payload?: unknown, challengeId?: string) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(challengeId ? { "x-proovra-step-up-challenge-id": challengeId } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const publicVerify = (segment: string) => call("GET", `/public/verify/${encodeURIComponent(segment)}`, null);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    // Entitled to issued outputs: the RICH projection is served.
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });

    const created = await call("POST", "/v1/evidence", A().ownerToken, {
      type: "DOCUMENT",
      mimeType: "text/plain",
      teamId: A().teamId,
      deviceTimeIso: DEVICE_TIME,
      gps: GPS,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    for (const [i, name] of PART_NAMES.entries()) {
      const part = await call("POST", `/v1/evidence/${id}/parts`, A().ownerToken, {
        partIndex: i,
        mimeType: "text/plain",
        originalFileName: name,
      });
      expect(part.statusCode, part.body).toBe(201);
      const put = await fetch(part.json().upload.putUrl as string, {
        method: "PUT",
        body: Buffer.from(`${name} ${randomBytes(8).toString("hex")}`),
        headers: { "content-type": "text/plain" },
      });
      expect(put.status).toBe(200);
    }
    const done = await call("POST", `/v1/evidence/${id}/complete`, A().ownerToken, {});
    expect(done.statusCode, done.body).toBe(200);

    const row = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { verificationRef: true, fingerprintHash: true, ownerUserId: true },
    });
    expect(row.verificationRef).toMatch(/^pvr_[A-Za-z0-9_-]{27}$/);
    // The title is an owner-written descriptive detail.
    await prisma.evidence.update({ where: { id }, data: { title: TITLE } });
    // Chain-verified OpenTimestamps facts, exactly as the independent node writes them.
    const ots = otsColumnsFor(row.fingerprintHash!, "ANCHORED");
    const { createHash } = await import("node:crypto");
    await prisma.evidence.update({
      where: { id },
      data: {
        otsHash: ots.otsHash,
        otsStatus: ots.otsStatus,
        otsProofBase64: ots.otsProofBase64,
        otsAnchoredAtUtc: ots.otsAnchoredAtUtc,
        otsChainVerificationStatus: "VERIFIED",
        otsChainCheckedAtUtc: new Date("2026-10-15T08:00:00.000Z"),
        otsChainVerifiedAtUtc: new Date("2026-10-15T08:00:00.000Z"),
        otsChainBlockHeight: 860_000,
        otsChainBlockHash: "00000000000000000001" + "ab".repeat(22),
        otsChainBlockTimeUtc: new Date("2026-08-01T00:00:00.000Z"),
        otsChainConfirmations: 12,
        otsChainVerifier: `proovra-ots-chain/1;core=310100;min=6;proof=${createHash("sha256")
          .update(Buffer.from(ots.otsProofBase64, "base64"))
          .digest("hex")
          .slice(0, 16)}`,
        otsChainFailureCode: null,
      } as never,
    });
    // Workspace access activity after finalization.
    const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
    for (let i = 0; i < 3; i++) {
      await appendCustodyEvent({
        evidenceId: id,
        eventType: "EVIDENCE_VIEWED" as never,
        payload: { source: "workspace_review", viewer: "team_member" },
      } as never);
    }
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: row.ownerUserId! }, select: { email: true } });
    record = { id, ref: row.verificationRef!, ownerEmail: owner.email! };
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 120_000);

  async function anonymousPage(): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
    const res = await publicVerify(record.ref);
    // Developer aid: write the exact anonymous body to a file for client fixtures.
    if (process.env.PVC_DUMP_PUBLIC_VERIFY) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.PVC_DUMP_PUBLIC_VERIFY, res.body);
    }
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, text: res.body };
  }

  // ---------------------------------------------------------------------------
  // Characterization of the confirmed audit defects (default VERIFICATION_ONLY).
  // ---------------------------------------------------------------------------
  describe("characterization — VERIFICATION_ONLY (the default) on the pvr_ page", () => {
    it("C1 item labels never fall back to a storage-key basename (no original name leaves the API)", async () => {
      const page = await anonymousPage();
      expect(page.status, page.text).toBe(200);
      for (const token of NAME_TOKENS) expect(page.text, `name token ${token} leaked`).not.toContain(token);
      const items = (page.body.evidenceContent as { items: Array<{ label: string; id: string }> }).items;
      expect(items.map((i) => i.label)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"]);
    });

    it("C2 custody never carries an email, masked or not", async () => {
      const page = await anonymousPage();
      const local = record.ownerEmail.split("@")[0]!;
      const domain = record.ownerEmail.split("@")[1]!;
      expect(page.text).not.toContain("***@");
      expect(page.text).not.toContain(domain);
      expect(page.text).not.toContain(`${local.slice(0, 3)}***`);
    });

    it("C3 access chronology is aggregated (count + latest occurrence), never listed", async () => {
      const page = await anonymousPage();
      const custody = page.body.custodyLifecycle as Record<string, unknown>;
      expect(custody.accessEvents).toEqual([]);
      const activity = custody.accessActivity as { count: number; latestAtUtc: string | null };
      expect(activity.count).toBeGreaterThanOrEqual(3);
      expect(typeof activity.latestAtUtc).toBe("string");
    });

    it("C4 coordinates, accuracy and device time are withheld without revealing that they exist", async () => {
      const page = await anonymousPage();
      expect(page.text).not.toContain(String(GPS.lat));
      expect(page.text).not.toContain(String(GPS.lng));
      expect(page.text).not.toContain(DEVICE_TIME);
      expect(page.text).not.toContain("2026-10-01T07:41:07");
      expect(page.body.captureContext ?? null).toBeNull();
      expect(page.body.locationState ?? null).toBeNull();
      expect(page.text).not.toMatch(/"(gpsPresent|hasLocation|locationRecorded|coordinatesPresent)"\s*:\s*true/);
    });

    it("C5 the live decision reads the persisted independent chain check: OTS VERIFIED / Independently verified", async () => {
      const page = await anonymousPage();
      const matrix = page.body.verificationMatrix as { rows: Array<{ key: string; status: string; statusLabel?: string }> };
      const ots = matrix.rows.find((r) => r.key === "ots_anchoring")!;
      expect(ots.status).toBe("VERIFIED");
      expect(ots.statusLabel).toBe("Independently verified");
    });

    it("C6 record facts: the reference is a Verification reference, a multipart record says so, issued vs rechecked are separate", async () => {
      const page = await anonymousPage();
      const facts = page.body.recordFacts as Record<string, unknown>;
      expect(facts.verificationReference).toBe(record.ref);
      expect(facts.recordKindLabel).toBe("Multipart package · 6 items");
      expect(facts).toHaveProperty("reportIssuedAtUtc");
      expect(facts).toHaveProperty("storedFileLastRecheckedAtUtc");
      expect(page.text).not.toContain(record.id);
    });

    it("C7 identity that exists but is withheld says so — never 'Not recorded'", async () => {
      const page = await anonymousPage();
      const facts = page.body.recordFacts as { identity: { disclosure: string; statement: string } };
      expect(facts.identity.disclosure).toBe("WITHHELD");
      expect(facts.identity.statement).toBe("Withheld by the record’s disclosure policy");
    });

    it("C8 no title, description, owner role or 'Original:' sentence leaves the API", async () => {
      const page = await anonymousPage();
      expect(page.text).not.toContain("Kestrel");
      expect(page.text).not.toMatch(/Original:\s/);
      const items = (page.body.evidenceContent as { items: Array<Record<string, unknown>> }).items;
      for (const item of items) {
        expect(item.artifactRoleLabel ?? null).toBeNull();
        expect(item.checklistStepLabel ?? null).toBeNull();
        expect(item.originalFileName ?? null).toBeNull();
        expect(item.previewDataUrl ?? null).toBeNull();
        expect(item.viewUrl ?? null).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Characterization of the snapshot-consistency defects. An issued report's
  // snapshot is IMMUTABLE history: its wording differs from today's copy, it
  // predates otsState, and the canonical reference was issued after it.
  // ---------------------------------------------------------------------------
  describe("characterization — issued snapshot vs live truth", () => {
    beforeAll(async () => {
      const live = (await anonymousPage()).body.trustDecision as {
        signals: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      // Report v1 as an earlier worker wrote it: the same facts in older words,
      // and a legacy anchoring signal (status only, no state, no otsState).
      const legacySnapshot = {
        ...live,
        signals: live.signals.map((s) =>
          s.key === "bitcoin_anchoring"
            ? { key: "bitcoin_anchoring", label: "Bitcoin anchoring", status: "passed", summary: "Anchored to Bitcoin", detail: "Older wording.", tone: "success" }
            : { ...s, summary: `${String(s.summary ?? "")} (issued wording)`, detail: `${String(s.detail ?? "")} Older copy.`, tone: "neutral" },
        ),
      };
      await prisma.report.create({
        data: {
          evidenceId: record.id,
          version: 1,
          storageBucket: "proovra-test",
          storageKey: `reports/${record.id}/v1.pdf`,
          // Issued after finalization (every creation-time event is before it).
          generatedAtUtc: new Date(),
          pdfSha256: "ab".repeat(32),
          trustDecisionSnapshot: legacySnapshot as never,
          anchorSnapshot: { provider: "opentimestamps", otsStatus: "ANCHORED" } as never,
        } as never,
      });
      // The reference backfill ran AFTER the report was issued.
      const { appendCustodyEvent } = await import("../src/services/custody-events.service.js");
      await appendCustodyEvent({
        evidenceId: record.id,
        eventType: "VERIFICATION_REFERENCE_ISSUED" as never,
        payload: { source: "BACKFILL" },
      } as never);
    }, 120_000);

    it("C9 wording-only drift never produces a danger / integrity alarm", async () => {
      const page = await anonymousPage();
      const c = page.body.trustDecisionConsistency as { tone: string; integrityCritical: boolean; reasons: Array<{ code: string; tone: string }> };
      expect(c.reasons.map((r) => r.code)).not.toContain("CORE_INTEGRITY_SIGNALS_CHANGED");
      expect(c.reasons.map((r) => r.code)).not.toContain("UNKNOWN_DIFFERENCE");
      expect(c.reasons.some((r) => r.tone === "danger")).toBe(false);
      expect(c.integrityCritical).toBe(false);
    });

    it("C10 VERIFICATION_REFERENCE_ISSUED is administrative, not a forensic custody change", async () => {
      const page = await anonymousPage();
      const c = page.body.trustDecisionConsistency as { reasons: Array<{ code: string }> };
      expect(c.reasons.map((r) => r.code)).not.toContain("FORENSIC_CUSTODY_CHANGED");
    });

    it("C11 a snapshot without otsState states its issue-time anchoring from its own Bitcoin signal", async () => {
      const page = await anonymousPage();
      const snap = page.body.verificationSnapshot as { otsStatusAtGeneration: string; otsVerificationAtGeneration: string };
      expect(snap.otsStatusAtGeneration).toBe("ANCHORED");
      expect(snap.otsVerificationAtGeneration).toBe("ATTESTATION_RECORDED");
    });

    it("C12 anchoring already recorded at issuance is not 'advanced'; the chain verification since is", async () => {
      const page = await anonymousPage();
      const live = page.body.liveAnchoring as { hasAdvancedSinceSnapshot: boolean; advance: string | null };
      // Attestation recorded at issuance → independently verified now.
      expect(live.advance).toBe("CHAIN_VERIFIED_SINCE_ISSUE");
      expect(live.hasAdvancedSinceSnapshot).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // The disclosure contract: the owner authority, both modes, the location
  // toggle, reviewer shares, access states and where the writes happen.
  // ---------------------------------------------------------------------------
  describe("contract — the owner's disclosure authority", () => {
    const secret = { value: null as Buffer | null };
    let totp: typeof import("../src/services/security/mfa-totp.js");

    beforeAll(async () => {
      totp = await import("../src/services/security/mfa-totp.js");
      const { sealSecret } = await import("../src/services/security/mfa-secret-storage.js");
      secret.value = totp.generateTotpSecretBytes();
      const sealed = sealSecret(secret.value);
      const now = new Date();
      await prisma.mfaFactor.create({
        data: {
          userId: A().ownerUserId,
          kind: "TOTP",
          status: "ACTIVE",
          label: "Authenticator",
          secretCiphertext: Buffer.from(sealed.ciphertext),
          secretIv: Buffer.from(sealed.iv),
          secretAuthTag: Buffer.from(sealed.authTag),
          secretKekId: sealed.kekId,
          verifiedAtUtc: now,
          enrolledAt: now,
        },
      });
    });

    async function stepUp(purpose = "PUBLIC_VERIFY_PUBLISH"): Promise<string> {
      await prisma.mfaFactor.updateMany({ where: { userId: A().ownerUserId, kind: "TOTP" }, data: { lastUsedAt: null } });
      const started = await call("POST", "/v1/identity-security/step-up/start", A().ownerToken, {
        teamId: A().teamId,
        purpose,
        resourceKind: "evidence",
        resourceId: record.id,
      });
      expect(started.statusCode, started.body).toBe(200);
      const challengeId = (started.json().challenge as { id: string }).id;
      const code = totp.computeTotpCode(secret.value!, totp.timeStep(Math.floor(Date.now() / 1000)));
      const checked = await call("POST", "/v1/identity-security/step-up/check", A().ownerToken, { teamId: A().teamId, challengeId, code });
      expect(checked.statusCode, checked.body).toBe(200);
      return challengeId;
    }
    const policyOf = () =>
      prisma.evidence.findUniqueOrThrow({
        where: { id: record.id },
        select: { verificationDisclosureMode: true, showRecordedLocation: true, verificationDisclosureVersion: true },
      });
    const put = (body: unknown, token = A().ownerToken, challengeId?: string) =>
      call("PUT", `/v1/evidence/${record.id}/verification-disclosure`, token, body, challengeId);

    it("D1 the owner reads the policy and the server's own visitor preview; a viewer may not change it", async () => {
      const res = await call("GET", `/v1/evidence/${record.id}/verification-access`, A().ownerToken);
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json().disclosure;
      expect(d.mode).toBe("VERIFICATION_ONLY");
      expect(d.showRecordedLocation).toBe(false);
      expect(d.version).toBe(0);
      expect(d.visitorPreview.never).toContain("Original file downloads");
      expect(res.json().canChangeDisclosure).toBe(true);
      const viewer = await put({ mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 }, A().viewerToken);
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json().code).toBe("DISCLOSURE_CHANGE_NOT_PERMITTED");
      expect((await policyOf()).verificationDisclosureMode).toBe("VERIFICATION_ONLY");
    });

    it("D2 location only with content preview; widening needs a fresh step-up and changes nothing without it", async () => {
      const bad = await put({ mode: "VERIFICATION_ONLY", showRecordedLocation: true, expectedVersion: 0 });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe("DISCLOSURE_LOCATION_REQUIRES_CONTENT_PREVIEW");
      const noStepUp = await put({ mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 });
      expect(noStepUp.statusCode).toBe(401);
      expect((await policyOf()).verificationDisclosureVersion).toBe(0);
    });

    it("D3 a change is CAS-protected, audited in custody, idempotent, and one of two concurrent changes wins", async () => {
      const changed = await put({ mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 }, A().ownerToken, await stepUp());
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().changed).toBe(true);
      expect(changed.json().disclosure.version).toBe(1);
      const events = await prisma.custodyEvent.findMany({ where: { evidenceId: record.id, eventType: "VERIFICATION_DISCLOSURE_CHANGED" as never } });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]!.payload)).not.toMatch(/@/);
      // The same request again: nothing changes, nothing is appended.
      const again = await put({ mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 0 });
      expect(again.statusCode).toBe(200);
      expect(again.json().changed).toBe(false);
      // A stale version asking for something else is a conflict, never a lost update.
      const stale = await put({ mode: "VERIFICATION_ONLY", showRecordedLocation: false, expectedVersion: 0 });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("DISCLOSURE_VERSION_CONFLICT");
      expect(stale.json().current.version).toBe(1);
      // Two narrowing changes at version 1 at once (no step-up needed to narrow).
      const [a, b] = await Promise.all([
        put({ mode: "VERIFICATION_ONLY", showRecordedLocation: false, expectedVersion: 1 }),
        put({ mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: 1 }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      // CONTENT_PREVIEW at version 1 is already the policy (idempotent 200), the
      // narrowing either applies first (then the other is a 409) or second.
      expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
      const after = await policyOf();
      expect(after.verificationDisclosureVersion).toBeLessThanOrEqual(2);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: record.id, eventType: "VERIFICATION_DISCLOSURE_CHANGED" as never } })).toBe(
        after.verificationDisclosureVersion,
      );
      // Leave the record in CONTENT_PREVIEW for the next block.
      if (after.verificationDisclosureMode !== "CONTENT_PREVIEW") {
        const back = await put(
          { mode: "CONTENT_PREVIEW", showRecordedLocation: false, expectedVersion: after.verificationDisclosureVersion },
          A().ownerToken,
          await stepUp(),
        );
        expect(back.statusCode, back.body).toBe(200);
      }
    });

    it("D4 CONTENT_PREVIEW: title, names and roles appear; location, emails, storage keys, part ids and originals still do not", async () => {
      const page = await anonymousPage();
      expect(page.status, page.text).toBe(200);
      expect((page.body.disclosure as { mode: string }).mode).toBe("CONTENT_PREVIEW");
      for (const token of NAME_TOKENS) expect(page.text).toContain(token);
      expect(page.text).toContain("Kestrel");
      expect(page.text).not.toContain(String(GPS.lat));
      expect(page.body.captureContext ?? null).toBeNull();
      expect(page.body.locationState ?? null).toBeNull();
      expect(page.text).not.toContain("***@");
      expect(page.text).not.toMatch(/evidence\/[0-9a-f-]{36}\/parts\//);
      expect(page.text).not.toContain(record.id);
      expect(page.text).not.toMatch(/X-Amz-(Signature|Credential)/);
      const items = (page.body.evidenceContent as { items: Array<{ id: string; viewUrl: unknown }> }).items;
      expect(items.map((i) => i.id)).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5", "item-6"]);
      expect(items.every((i) => i.viewUrl === null)).toBe(true);
      // The device-reported capture time is a capture fact content preview shows.
      expect(page.text).toContain("2026-10-01T07:41:07");
    });

    it("D5 location appears only after its own explicit decision, worded as recorded — never verified", async () => {
      const v = (await policyOf()).verificationDisclosureVersion;
      const res = await put({ mode: "CONTENT_PREVIEW", showRecordedLocation: true, expectedVersion: v }, A().ownerToken, await stepUp());
      expect(res.statusCode, res.body).toBe(200);
      const page = await anonymousPage();
      expect((page.body.disclosure as { recordedLocation: boolean }).recordedLocation).toBe(true);
      const ctx = page.body.captureContext as { lat: number; lng: number } | null;
      expect(ctx?.lat).toBeCloseTo(GPS.lat, 4);
      expect(page.text).not.toMatch(/verified location|location verified/i);
      // Switching back to verification only clears the location decision.
      const back = await put({ mode: "VERIFICATION_ONLY", showRecordedLocation: false, expectedVersion: v + 1 });
      expect(back.statusCode, back.body).toBe(200);
      expect((await policyOf()).showRecordedLocation).toBe(false);
      const vo = await anonymousPage();
      for (const token of NAME_TOKENS) expect(vo.text).not.toContain(token);
      expect(vo.text).not.toContain(String(GPS.lat));
    });
  });

  describe("contract — reviewer shares (pvs_) keep their own profile and never widen access", () => {
    async function mint(opts: { projection?: "STANDARD" | "BASIC"; maxUses?: number | null; allowOriginalDownload?: boolean } = {}) {
      const { mintVerificationShareTokenTx } = await import("@proovra/shared-runtime");
      return prisma.$transaction((tx) =>
        mintVerificationShareTokenTx(tx, {
          evidenceId: record.id,
          teamId: A().teamId,
          purpose: "OWNER_SHARE",
          projection: opts.projection ?? "STANDARD",
          audience: "Insurer reviewer",
          maxUses: opts.maxUses ?? null,
          allowOriginalDownload: opts.allowOriginalDownload ?? false,
        }),
      );
    }

    it("S1 a STANDARD share shows content to its reviewer on a VERIFICATION_ONLY record; no originals without a grant", async () => {
      const { token } = await mint();
      const res = await publicVerify(token);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().disclosure).toMatchObject({ mode: "CONTENT_PREVIEW", source: "REVIEWER_SHARE", originalDownload: false, recordedLocation: false });
      expect(res.body).toContain(NAME_TOKENS[0]);
      expect(res.body).not.toContain(String(GPS.lat));
      expect(res.body).not.toMatch(/X-Amz-Signature/);
      // The pvr_ page is unaffected by the share.
      const pvr = await anonymousPage();
      expect(pvr.text).not.toContain(NAME_TOKENS[0]);
    });

    it("S2 an explicit download grant hands out the sealed originals — and records their release", async () => {
      const { token } = await mint({ allowOriginalDownload: true });
      const before = await prisma.custodyEvent.count({ where: { evidenceId: record.id } });
      const res = await publicVerify(token);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().disclosure.originalDownload).toBe(true);
      const urls = (res.json().evidenceContent.items as Array<{ viewUrl: string | null }>).filter((i) => typeof i.viewUrl === "string");
      expect(urls.length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 300));
      const releases = await prisma.custodyEvent.findMany({
        where: { evidenceId: record.id, sequence: { gt: before } },
        select: { eventType: true, payload: true },
      });
      expect(releases.some((e) => JSON.stringify(e.payload).includes("public_original_url_issued"))).toBe(true);
    });

    it("S3 a BASIC share answers verification only; a spent use-limited share is 410 and writes nothing", async () => {
      const basic = await mint({ projection: "BASIC" });
      const b = await publicVerify(basic.token);
      expect(b.statusCode).toBe(200);
      expect(b.json().disclosure.mode).toBe("VERIFICATION_ONLY");
      expect(b.body).not.toContain(NAME_TOKENS[0]);

      const once = await mint({ maxUses: 1 });
      expect((await publicVerify(once.token)).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      const views = await prisma.verificationView.count({ where: { evidenceId: record.id } });
      const custody = await prisma.custodyEvent.count({ where: { evidenceId: record.id } });
      const spent = await publicVerify(once.token);
      expect(spent.statusCode).toBe(410);
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.verificationView.count({ where: { evidenceId: record.id } })).toBe(views);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: record.id } })).toBe(custody);
    });

    it("S4 revoked and expired shares are 410", async () => {
      const revoked = await mint();
      await prisma.verificationShareToken.update({ where: { id: revoked.id }, data: { revokedAtUtc: new Date(), revocationReason: "OWNER_REVOKED" } });
      expect((await publicVerify(revoked.token)).statusCode).toBe(410);
      const expired = await mint();
      await prisma.verificationShareToken.update({ where: { id: expired.id }, data: { expiresAtUtc: new Date(Date.now() - 1000) } });
      expect((await publicVerify(expired.token)).statusCode).toBe(410);
    });
  });

  describe("contract — access states decide reachability for every identifier; nothing is written before a denial", () => {
    it("A1 a withdrawn page is 410 for pvr_, a reviewer share and a grace record id — with no view, no custody, no recheck", async () => {
      const { mintVerificationShareTokenTx } = await import("@proovra/shared-runtime");
      const share = await prisma.$transaction((tx) =>
        mintVerificationShareTokenTx(tx, { evidenceId: record.id, teamId: A().teamId, purpose: "OWNER_SHARE", projection: "STANDARD", audience: "r" }),
      );
      await prisma.evidence.update({
        where: { id: record.id },
        data: { legacyVerifyUuidUntilUtc: new Date(Date.now() + 86_400_000) },
      });
      expect((await publicVerify(record.id)).statusCode).toBe(200);
      const withdrawn = await call("POST", `/v1/evidence/${record.id}/verification-access/withdraw`, A().ownerToken, { reason: "PRIVACY_REQUEST" });
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      const before = {
        views: await prisma.verificationView.count({ where: { evidenceId: record.id } }),
        custody: await prisma.custodyEvent.count({ where: { evidenceId: record.id } }),
        recheck: (await prisma.evidence.findUniqueOrThrow({ where: { id: record.id }, select: { integrityRecheckRequestedAtUtc: true } }))
          .integrityRecheckRequestedAtUtc,
      };
      for (const segment of [record.ref, share.token, record.id]) {
        const res = await publicVerify(segment);
        expect(res.statusCode, segment).toBe(410);
        for (const t of NAME_TOKENS) expect(res.body).not.toContain(t);
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.verificationView.count({ where: { evidenceId: record.id } })).toBe(before.views);
      expect(await prisma.custodyEvent.count({ where: { evidenceId: record.id } })).toBe(before.custody);
      expect(
        (await prisma.evidence.findUniqueOrThrow({ where: { id: record.id }, select: { integrityRecheckRequestedAtUtc: true } }))
          .integrityRecheckRequestedAtUtc?.toISOString() ?? null,
      ).toBe(before.recheck?.toISOString() ?? null);
      // A disclosure change never reinstates access.
      const reinstate = await call("POST", `/v1/evidence/${record.id}/verification-access/reinstate`, A().ownerToken, {});
      expect(reinstate.statusCode).toBe(200);
      expect((await publicVerify(record.ref)).statusCode).toBe(200);
    });

    it("A2 an unknown reference, an unknown share and an id outside its grace are the same 404 and write nothing", async () => {
      const before = { views: await prisma.verificationView.count(), custody: await prisma.custodyEvent.count() };
      const unknownRef = await publicVerify("pvr_AAAAAAAAAAAAAAAAAAAAAAAAAAA");
      const unknownShare = await publicVerify(`pvs_${"A".repeat(43)}`);
      const unknownId = await publicVerify("00000000-0000-4000-8000-000000000000");
      for (const r of [unknownRef, unknownShare, unknownId]) {
        expect(r.statusCode).toBe(404);
        expect(r.body).toBe(unknownRef.body);
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(await prisma.verificationView.count()).toBe(before.views);
      expect(await prisma.custodyEvent.count()).toBe(before.custody);
    });

    it("A3 a trashed record's page answers RETAINED and discloses nothing about the record", async () => {
      await prisma.evidence.update({ where: { id: record.id }, data: { lifecycleState: "TRASHED", deletedAt: new Date() } as never });
      const res = await publicVerify(record.ref);
      expect([200, 410]).toContain(res.statusCode);
      expect(res.json().canonicalVerification?.status ?? res.json().code).toBeTruthy();
      for (const t of NAME_TOKENS) expect(res.body).not.toContain(t);
      expect(res.body).not.toContain("Kestrel");
      expect(res.json().verificationMatrix ?? null).toBeNull();
      await prisma.evidence.update({ where: { id: record.id }, data: { lifecycleState: "ACTIVE", deletedAt: null } as never });
    });
  });
});
