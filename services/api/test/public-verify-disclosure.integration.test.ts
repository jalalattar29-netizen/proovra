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
  const call = (method: "GET" | "POST" | "PUT", url: string, token: string | null, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
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
          generatedAtUtc: new Date(Date.now() - 60_000),
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
});
