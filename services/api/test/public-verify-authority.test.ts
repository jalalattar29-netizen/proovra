/**
 * THE PUBLIC VERIFY AUTHORITIES (2026-10-18) — unit proof.
 *
 *   - resolvePublicVerifyDisclosure: the record policy for every canonical
 *     identifier, the link's own profile for a reviewer share; originals only
 *     with an explicit grant; location only by the record's explicit decision;
 *   - projectPublicVerification: an ALLOWLIST — forbidden values never leave,
 *     whatever the fact set carries;
 *   - buildTrustDecisionConsistency: canonical states, never words;
 *   - buildPublicVerifyConsistencySections: issue-time anchoring from the
 *     report's own snapshot; "advanced" only when it truly advanced;
 *   - source pins: no code writes or reads the retired publication state, and
 *     the anonymous route sends nothing but the projected body.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildEvidenceTrustDecision, resolveOtsAnchoring, type TrustDecision } from "@proovra/shared";

import {
  projectBasicPublicVerification,
  projectPublicVerification,
  resolvePublicVerifyDisclosure,
} from "../src/services/public-verify/public-verify-projection.js";
import { buildTrustDecisionConsistency } from "../src/services/trust-decision-consistency.service.js";
import { buildPublicVerifyConsistencySections } from "../src/services/public-verify-consistency.service.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VO = { mode: "VERIFICATION_ONLY" as const, showRecordedLocation: false };
const CP = { mode: "CONTENT_PREVIEW" as const, showRecordedLocation: false };
const CPL = { mode: "CONTENT_PREVIEW" as const, showRecordedLocation: true };

describe("resolvePublicVerifyDisclosure", () => {
  it("canonical identifiers apply the record policy and never offer originals", () => {
    for (const identifierKind of ["CANONICAL_REFERENCE", "LEGACY_ARTIFACT_LINK", "LEGACY_RECORD_ID"] as const) {
      expect(resolvePublicVerifyDisclosure({ identifierKind, recordPolicy: VO, share: null })).toMatchObject({
        mode: "VERIFICATION_ONLY",
        recordedLocation: false,
        originalDownload: false,
        source: "RECORD_POLICY",
      });
      expect(resolvePublicVerifyDisclosure({ identifierKind, recordPolicy: CPL, share: null })).toMatchObject({
        mode: "CONTENT_PREVIEW",
        recordedLocation: true,
        originalDownload: false,
      });
    }
  });
  it("a reviewer share applies its own profile; originals only with its grant; location only by the record's decision", () => {
    const std = (allowOriginalDownload: boolean) => ({ projection: "STANDARD", allowOriginalDownload });
    expect(resolvePublicVerifyDisclosure({ identifierKind: "REVIEWER_SHARE", recordPolicy: VO, share: std(false) })).toMatchObject({
      mode: "CONTENT_PREVIEW",
      recordedLocation: false,
      originalDownload: false,
      source: "REVIEWER_SHARE",
    });
    expect(resolvePublicVerifyDisclosure({ identifierKind: "REVIEWER_SHARE", recordPolicy: CPL, share: std(true) })).toMatchObject({
      recordedLocation: true,
      originalDownload: true,
    });
    expect(
      resolvePublicVerifyDisclosure({ identifierKind: "REVIEWER_SHARE", recordPolicy: CPL, share: { projection: "BASIC", allowOriginalDownload: true } }),
    ).toMatchObject({ mode: "VERIFICATION_ONLY", recordedLocation: false, originalDownload: false });
  });
});

/** A fact set carrying every forbidden value the projection must withhold. */
function facts(): Record<string, unknown> {
  return {
    tier: "RICH",
    evidenceId: "9b3e0c55-0000-4000-8000-00000000abcd",
    internalNotes: "do not leak",
    storageBucket: "prod-bucket",
    recordFacts: { verificationReference: "pvr_x", recordKindLabel: "Multipart package · 2 items", identity: { disclosure: "WITHHELD" } },
    verificationMatrix: { rows: [] },
    canonicalVerification: { reference: "pvr_x", status: "AVAILABLE" },
    overview: {
      evidenceId: "9b3e0c55-0000-4000-8000-00000000abcd",
      evidenceTitle: "Secret title",
      submittedByEmail: "owner@example.test",
      workspaceName: "Acme Legal",
      lastPublicVerifyViewAtUtc: "2026-10-18T00:00:00Z",
      deviceTimeIso: "2026-10-01T09:41:07+02:00",
    },
    humanSummary: { evidenceId: "9b3e0c55-0000-4000-8000-00000000abcd", evidenceTitle: "Secret title" },
    display: { displayTitle: "Secret title" },
    basicVerification: { original: { deviceDeclaredCaptureAtUtc: "2026-10-01T07:41:07Z", captureTimeStatement: "Device-declared …07:41:07" } },
    provenanceTime: {
      entries: [{ kind: "DEVICE_OBSERVED", atUtc: "2026-10-01T07:41:07Z" }, { kind: "SERVER_RECEIVED", atUtc: "2026-10-18T00:00:00Z" }],
      captureTime: { kind: "DEVICE_OBSERVED" },
      captureTimeStatement: "Device-declared capture time: 2026-10-01T07:41:07Z",
    },
    captureContext: { lat: 48.137154, lng: 11.576124 },
    locationState: { state: "RECORDED" },
    technicalMetadata: { gpsPresent: true, camera: "X" },
    captureManifest: { domain: "example.test" },
    redaction: { applied: true },
    mediaIntelligenceAdvisory: { signals: 1 },
    certifications: { custodian: { attestorName: "Jane Roe", attestorTitle: "Counsel", status: "ATTESTED" }, qualifiedPerson: null },
    storageAndTimestamping: { storage: { bucket: "prod-bucket", key: "evidence/x", versionId: "v1", region: "eu" } },
    custodyLifecycle: {
      forensicEventCount: 1,
      accessEventCount: 2,
      forensicEvents: [{ sequence: 1, atUtc: "t", eventType: "IDENTITY_SNAPSHOT_RECORDED", payloadSummary: "Identity snapshot • Email: own***@example.test", payload: { email: "owner@example.test" } }],
      accessEvents: [
        { sequence: 2, atUtc: "2026-10-17T00:00:00Z", eventType: "EVIDENCE_VIEWED" },
        { sequence: 3, atUtc: "2026-10-18T00:00:00Z", eventType: "EVIDENCE_VIEWED" },
      ],
    },
    evidenceContent: {
      summary: { itemCount: 2, previewableItemCount: 2, downloadableItemCount: 2, totalSizeBytes: "99" },
      items: [
        {
          id: "part-uuid-1",
          index: 0,
          label: "000-witness-statement.pdf",
          originalFileName: "witness-statement.pdf",
          artifactRoleLabel: "Primary evidence",
          kind: "document",
          sha256: "a".repeat(64),
          displaySizeLabel: "10 B",
          previewDataUrl: "data:image/png;base64,AAAA",
          viewUrl: "https://s3.example/?X-Amz-Signature=abc",
          downloadable: true,
        },
        { id: "part-uuid-2", index: 1, label: "Item 2", originalFileName: null, kind: "image", sha256: "b".repeat(64), viewUrl: null },
      ],
      primaryItem: { index: 0 },
    },
  };
}
const disclosure = (identifierKind: "CANONICAL_REFERENCE" | "REVIEWER_SHARE", recordPolicy = VO, share: { projection: string; allowOriginalDownload: boolean } | null = null) =>
  resolvePublicVerifyDisclosure({ identifierKind, recordPolicy, share });
const project = (d: ReturnType<typeof disclosure>) => projectPublicVerification(facts(), d, { attributionExposed: false });
const FORBIDDEN_EVERYWHERE = [/@example\.test/, /\*\*\*@/, /9b3e0c55-0000/, /part-uuid/, /prod-bucket/, /X-Amz-Signature/, /do not leak/, /lastPublicVerifyViewAtUtc/];

describe("projectPublicVerification — the allowlist", () => {
  it("VERIFICATION_ONLY: generic items, no title, names, roles, previews, device time, location or attestor names", () => {
    const body = project(disclosure("CANONICAL_REFERENCE"));
    const text = JSON.stringify(body);
    for (const re of [...FORBIDDEN_EVERYWHERE, /Secret title/, /witness-statement/, /Primary evidence/, /data:image/, /07:41:07/, /48\.137154/, /gpsPresent/, /Jane Roe/, /example\.test/]) {
      expect(text, String(re)).not.toMatch(re);
    }
    const items = (body.evidenceContent as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => [i.id, i.label])).toEqual([
      ["item-1", "Item 1"],
      ["item-2", "Item 2"],
    ]);
    expect(body.captureContext).toBeNull();
    expect(body.locationState).toBeNull();
    expect(body.technicalMetadata).toBeNull();
    expect((body.custodyLifecycle as Record<string, unknown>).accessEvents).toEqual([]);
    expect((body.custodyLifecycle as Record<string, unknown>).accessActivity).toEqual({ count: 2, latestAtUtc: "2026-10-18T00:00:00Z" });
    expect((body.disclosure as Record<string, unknown>).withheldStatement).toBe("Withheld by the record’s disclosure policy");
  });

  it("CONTENT_PREVIEW: names, roles, previews and device time; still no location, email, ids, storage or originals", () => {
    const body = project(disclosure("CANONICAL_REFERENCE", CP));
    const text = JSON.stringify(body);
    for (const re of [...FORBIDDEN_EVERYWHERE, /48\.137154/, /gpsPresent/]) expect(text, String(re)).not.toMatch(re);
    expect(text).toContain("witness-statement.pdf");
    expect(text).toContain("Primary evidence");
    expect(text).toContain("Secret title");
    expect(text).toContain("07:41:07");
    const items = (body.evidenceContent as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.label).toBe("000-witness-statement.pdf");
    expect(items[1]!.label).toBe("Item 2");
    expect(items.every((i) => i.viewUrl === null && i.downloadable === false)).toBe(true);
  });

  it("CONTENT_PREVIEW + location: the location facts and only them", () => {
    const body = project(disclosure("CANONICAL_REFERENCE", CPL));
    expect(body.captureContext).toEqual({ lat: 48.137154, lng: 11.576124 });
    expect(body.locationState).toEqual({ state: "RECORDED" });
    expect(JSON.stringify(body)).toContain("gpsPresent");
  });

  it("only a reviewer link's explicit grant hands out the original URL", () => {
    const granted = project(disclosure("REVIEWER_SHARE", VO, { projection: "STANDARD", allowOriginalDownload: true }));
    const items = (granted.evidenceContent as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]!.viewUrl).toBe("https://s3.example/?X-Amz-Signature=abc");
    const plain = project(disclosure("CANONICAL_REFERENCE", CPL));
    expect(JSON.stringify(plain)).not.toMatch(/X-Amz-Signature/);
  });

  it("an unknown fact is withheld by default; the BASIC tier is minimal", () => {
    const f = { ...facts(), brandNewInternalField: "secret" };
    expect(JSON.stringify(projectPublicVerification(f, disclosure("CANONICAL_REFERENCE", CPL), { attributionExposed: false }))).not.toContain("secret");
    const basic = projectBasicPublicVerification(facts(), disclosure("CANONICAL_REFERENCE"));
    expect(Object.keys(basic).sort()).toEqual(["basicVerification", "canonicalVerification", "disclosure", "recordFacts", "tier", "verificationMatrix"]);
    expect(JSON.stringify(basic)).not.toMatch(/07:41:07|9b3e0c55/);
  });
});

const BASE_EVIDENCE = {
  verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
  recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
  fileSha256: "a".repeat(64),
  fingerprintHash: "b".repeat(64),
  signatureBase64: "c2ln",
  signingKeyId: "k",
  publicKeyPem: "pem",
  otsProofBase64: null,
  signatureVerified: true,
  custodyChainValid: true,
};
const decision = (over: Record<string, unknown> = {}) => buildEvidenceTrustDecision({ evidence: { ...BASE_EVIDENCE, ...over }, custodyEvents: [] });
const reword = (d: TrustDecision): TrustDecision => ({
  ...d,
  signals: d.signals.map((s) => ({ ...s, summary: `${s.summary} (older words)`, detail: "Older detail.", tone: "neutral" as const })),
});

describe("buildTrustDecisionConsistency — states, never words", () => {
  const consistency = (snapshot: TrustDecision, live: TrustDecision, counts: { atSnapshot?: number; now?: number } = {}) =>
    buildTrustDecisionConsistency({
      snapshotTrustDecision: snapshot,
      liveTrustDecision: live,
      source: "REPORT_SNAPSHOT",
      forensicEventsAtSnapshot: counts.atSnapshot ?? 5,
      currentForensicEvents: counts.now ?? 5,
    });
  it("wording-only drift is consistent", () => {
    const live = decision({ tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-10-01T00:00:00Z", tsaTokenPresent: true });
    const r = consistency(reword(live), live);
    expect(r.reasons).toEqual([]);
    expect(r.tone).toBe("neutral");
    expect(r.consistentWithSnapshot).toBe(true);
  });
  it("a kept token validated later is an informational advance, never an alarm", () => {
    const issued = decision({ tsaStatus: "FAILED", tsaTokenPresent: true });
    const now = decision({ tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-10-12T00:00:00Z", tsaTokenPresent: true, tsaValidatedFromRetainedToken: true });
    const r = consistency(issued, now);
    expect(r.reasons.map((x) => x.code)).toEqual(["VERIFICATION_ADVANCED"]);
    expect(r.integrityCritical).toBe(false);
    expect(r.tone).toBe("info");
  });
  it("only a failure since issue is danger", () => {
    const issued = decision();
    const now = decision({ signatureVerified: false });
    const r = consistency(issued, now);
    expect(r.reasons.find((x) => x.code === "CORE_INTEGRITY_SIGNALS_CHANGED")?.tone).toBe("danger");
    expect(r.integrityCritical).toBe(true);
  });
});

describe("buildPublicVerifyConsistencySections — issue-time anchoring", () => {
  const anchoring = (verification: "ATTESTATION_RECORDED" | "CHAIN_VERIFIED") =>
    ({ ...resolveOtsAnchoring({ status: "ANCHORED", proofBase64: null, fingerprintHash: null }), state: "ANCHORED", verification }) as never;
  const sections = (report: Record<string, unknown>, current: "ATTESTATION_RECORDED" | "CHAIN_VERIFIED") =>
    buildPublicVerifyConsistencySections({
      source: "REPORT_SNAPSHOT",
      trustDecisionSnapshot: null,
      latestReport: { version: 1, generatedAtUtc: new Date("2026-10-01T00:00:00Z"), pdfSignatureStatus: null, pdfSignedAtUtc: null, ...report },
      latestVerificationPackage: null,
      verificationPackageIntegrity: null,
      currentOts: anchoring(current),
      otsUpgradedAtUtc: null,
    });
  it("a legacy report without otsState reads its own Bitcoin signal: Attestation recorded, not Unavailable", () => {
    const s = sections({ anchorSnapshot: { provider: "opentimestamps" }, trustDecisionSnapshot: { signals: [{ key: "bitcoin_anchoring", status: "passed" }] } }, "ATTESTATION_RECORDED");
    expect(s.verificationSnapshot.otsStatusAtGeneration).toBe("ANCHORED");
    expect(s.verificationSnapshot.otsVerificationAtGeneration).toBe("ATTESTATION_RECORDED");
    expect(s.liveAnchoring.hasAdvancedSinceSnapshot).toBe(false);
    expect(s.liveAnchoring.advance).toBe("NONE");
  });
  it("an attestation recorded at issue that is chain-verified now did advance", () => {
    const s = sections({ anchorSnapshot: { otsState: "ANCHORED", otsVerification: "ATTESTATION_RECORDED" } }, "CHAIN_VERIFIED");
    expect(s.liveAnchoring.advance).toBe("CHAIN_VERIFIED_SINCE_ISSUE");
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("source pins — one authority, no way back", () => {
  it("no product source writes or reads the retired publication state", () => {
    const roots = ["services/api/src", "services/worker/src", "packages/shared/src", "packages/shared-runtime/src", "apps/web/app", "apps/web/components", "apps/web/lib", "apps/mobile/src", "apps/mobile/app"];
    const offenders: string[] = [];
    for (const r of roots) {
      for (const f of sourceFiles(join(ROOT, r))) {
        const text = readFileSync(f, "utf8");
        // Comments may name the retired column; code may not use it.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
        if (/\bpublicVerifyState\b|\bpublic_verify_state\b/.test(code)) offenders.push(f.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual(["services/api/src/scripts/verification-disclosure-fleet.ts"]);
  });

  it("the anonymous route sends a 200 only from the projection", () => {
    const routes = readFileSync(join(ROOT, "services/api/src/routes/evidence.routes.ts"), "utf8");
    const start = routes.indexOf('app.get("/public/verify/:id"');
    const handler = routes.slice(start, routes.indexOf("\n  });\n}", start));
    const sends200 = handler.match(/reply\.code\(200\)\.send\([^)]*\)/g) ?? [];
    expect(sends200).toEqual(["reply.code(200).send(body)"]);
    expect(handler).toMatch(/projectPublicVerification\(/);
    // The writes happen after the projection.
    expect(handler.indexOf("recordOriginalRelease(")).toBeGreaterThan(handler.indexOf("projectPublicVerification("));
    expect(handler.indexOf("verificationView.create")).toBeGreaterThan(handler.indexOf("projectPublicVerification("));
    expect(handler.indexOf("recordVerificationShareUse(")).toBeLessThan(handler.indexOf("const allCustodyEvents"));
  });
});
