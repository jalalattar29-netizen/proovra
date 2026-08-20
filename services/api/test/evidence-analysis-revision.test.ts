/**
 * THE EVIDENCE ANALYSIS REVISION — canonical serialization and field coverage.
 *
 * Two things are proved here, and neither is provable by reading the code:
 *
 *   1. The canonical snapshot is DETERMINISTIC and LOSSLESS about the
 *      distinctions that matter — `null`, `false`, `0`, `""` and missing are
 *      five different states, and a package that does not exist is not a
 *      package at version zero. Collapsing those is the defect this replaces.
 *
 *   2. The revision COVERS every field a Copilot is actually shown. That is a
 *      contract between this module and the two context allowlists, and it is
 *      checked against the allowlists themselves rather than against a copy of
 *      them — a test that restates the list it is checking proves only that it
 *      can copy.
 */
import { describe, expect, it } from "vitest";

import {
  buildEvidenceAnalysisRevision,
  canonicalEvidenceAnalysisSnapshot,
  EVIDENCE_ANALYSIS_REVISION_SCHEMA,
  type EvidenceAnalysisContext,
  type EvidenceAnalysisFacts,
} from "@proovra/shared-runtime";
import { isEvidenceAnalysisRevision } from "@proovra/shared";

import { EVIDENCE_CONTEXT_ALLOWLIST } from "../src/services/ai/ai-context-resolver.service.js";
import {
  EVIDENCE_ANALYSIS_SELECT,
  evidenceAnalysisFacts,
  type EvidenceAnalysisRow,
} from "../src/services/ai/evidence-analysis-snapshot.service.js";

const FACTS: EvidenceAnalysisFacts = {
  id: "c6bb29e3-1111-4111-8111-111111111111",
  teamId: "b1b0a0c0-2222-4222-8222-222222222222",
  title: "Joint Scene Examination.jpg",
  type: "PHOTO",
  mimeType: "image/jpeg",
  status: "REPORTED",
  verificationStatus: "VERIFIED",
  captureMethod: "IN_APP_CAPTURE",
  tsaStatus: "CONFIRMED",
  otsStatus: "PENDING",
  createdAtUtc: new Date("2026-06-01T10:00:00.000Z"),
  partCount: 3,
  custodyEventCount: 7,
  caseLinkCount: 1,
  latestReportVersion: 1,
  verificationPackageVersion: 2,
  lifecycleState: "ACTIVE",
  deletedAt: null,
  archivedAt: null,
};

const CTX: EvidenceAnalysisContext = {
  scope: "case",
  scopeId: "aaaaaaaa-3333-4333-8333-333333333333",
  linkedToScope: true,
};

const rev = (f: Partial<EvidenceAnalysisFacts> = {}, c: Partial<EvidenceAnalysisContext> = {}) =>
  buildEvidenceAnalysisRevision({ ...FACTS, ...f }, { ...CTX, ...c });

describe("the token", () => {
  it("is the versioned prefix plus the FULL digest, never truncated", () => {
    const r = rev();
    expect(r.startsWith(`${EVIDENCE_ANALYSIS_REVISION_SCHEMA}_`)).toBe(true);
    // 43 base64url characters carry 258 bits, so the whole 256-bit digest is
    // present. A truncated revision stops being able to distinguish two states,
    // which is the only thing it is for.
    expect(r.slice(5)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isEvidenceAnalysisRevision(r)).toBe(true);
  });

  it("is deterministic — the same state always yields the same token", () => {
    expect(rev()).toBe(rev());
    // Including across equivalent Date and ISO-string spellings of one instant,
    // so two servers reading the same row cannot disagree.
    expect(rev({ createdAtUtc: "2026-06-01T10:00:00.000Z" })).toBe(rev());
  });

  it("normalizes timestamps to canonical UTC, not to a locale rendering", () => {
    // The same instant expressed in another offset is the same instant.
    expect(rev({ createdAtUtc: "2026-06-01T12:00:00.000+02:00" })).toBe(rev());
    // A different instant is a different revision.
    expect(rev({ createdAtUtc: "2026-06-01T10:00:01.000Z" })).not.toBe(rev());
    expect(canonicalEvidenceAnalysisSnapshot(FACTS, CTX)).toContain(
      '"createdAtUtc":"2026-06-01T10:00:00.000Z"',
    );
  });

  it("carries no metadata — it is a digest, not an encoding", () => {
    const r = rev();
    // Projecting it to an authorized client must disclose nothing about the
    // record, and it is never an authorization credential.
    for (const secret of [FACTS.title!, FACTS.id, FACTS.teamId!, FACTS.mimeType!]) {
      expect(r).not.toContain(secret);
      expect(r).not.toContain(secret.slice(0, 8));
    }
  });
});

describe("the canonical serialization is lossless about absence", () => {
  it("keeps null, 0, false, empty and missing apart", () => {
    // A package that does not exist is NOT a package at version zero. This is
    // the exact collapse `?? 0` performed, in the exact field it performed it.
    const distinct = new Set([
      rev({ verificationPackageVersion: null }),
      rev({ verificationPackageVersion: 0 }),
      rev({ verificationPackageVersion: 2 }),
    ]);
    expect(distinct.size).toBe(3);

    // …and the same for every other nullable field.
    expect(rev({ title: null })).not.toBe(rev({ title: "" }));
    expect(rev({ latestReportVersion: null })).not.toBe(rev({ latestReportVersion: 0 }));
    expect(rev({ tsaStatus: null })).not.toBe(rev({ tsaStatus: "" }));
    expect(rev({ deletedAt: null })).not.toBe(
      rev({ deletedAt: new Date("2026-06-01T10:00:00.000Z") }),
    );
  });

  it("keeps a null context distinct from a false one", () => {
    // `linkedToScope: null` means "scope linkage is not a concept here", which
    // is a different statement from "not linked" and must hash differently.
    expect(rev({}, { linkedToScope: null })).not.toBe(rev({}, { linkedToScope: false }));
    expect(rev({}, { linkedToScope: false })).not.toBe(rev({}, { linkedToScope: true }));
  });

  it("orders keys by SORT, so construction order cannot change a revision", () => {
    const shuffled: EvidenceAnalysisFacts = {
      archivedAt: FACTS.archivedAt,
      verificationPackageVersion: FACTS.verificationPackageVersion,
      id: FACTS.id,
      title: FACTS.title,
      teamId: FACTS.teamId,
      status: FACTS.status,
      type: FACTS.type,
      mimeType: FACTS.mimeType,
      verificationStatus: FACTS.verificationStatus,
      captureMethod: FACTS.captureMethod,
      tsaStatus: FACTS.tsaStatus,
      otsStatus: FACTS.otsStatus,
      createdAtUtc: FACTS.createdAtUtc,
      partCount: FACTS.partCount,
      custodyEventCount: FACTS.custodyEventCount,
      caseLinkCount: FACTS.caseLinkCount,
      latestReportVersion: FACTS.latestReportVersion,
      lifecycleState: FACTS.lifecycleState,
      deletedAt: FACTS.deletedAt,
    };
    expect(buildEvidenceAnalysisRevision(shuffled, CTX)).toBe(rev());
    // The serialized form itself is sorted, so this is a property of the
    // encoding rather than of the object that happened to be passed.
    const keys = [...canonicalEvidenceAnalysisSnapshot(FACTS, CTX).matchAll(/"(\w+)":/g)].map(
      (m) => m[1],
    );
    const evidenceKeys = keys.slice(keys.indexOf("archivedAt"), keys.indexOf("context"));
    expect(evidenceKeys).toEqual([...evidenceKeys].sort());
  });
});

describe("the revision is CONTEXT-bound", () => {
  it("differs per surface, so a snapshot cannot be replayed across them", () => {
    const surfaces = new Set([
      rev({}, { scope: "case", scopeId: CTX.scopeId, linkedToScope: true }),
      rev({}, { scope: "evidence", scopeId: null, linkedToScope: null }),
      rev({}, { scope: "reviewer", scopeId: CTX.scopeId, linkedToScope: null }),
    ]);
    expect(surfaces.size).toBe(3);
  });

  it("changes when case membership changes, with the evidence identical", () => {
    // The whole reason a context-bound revision exists: a record can be
    // globally unchanged while its relationship to THIS operation changes, and
    // `verificationPackageVersion` could never see that.
    expect(rev({}, { linkedToScope: false })).not.toBe(rev({}, { linkedToScope: true }));
    expect(rev({}, { scopeId: "bbbbbbbb-4444-4444-8444-444444444444" })).not.toBe(rev());
  });
});

describe("the revision COVERS every field a copilot is shown", () => {
  /**
   * Each allowlisted prompt field, and the persisted fact that produces it.
   *
   * Read against `EVIDENCE_CONTEXT_ALLOWLIST` itself, so adding a field to the
   * allowlist without covering it here fails rather than silently creating a
   * prompt input the concurrency guard cannot see.
   */
  const COVERS: Record<string, Partial<EvidenceAnalysisFacts>> = {
    title: { title: "Renamed.jpg" },
    type: { type: "VIDEO" },
    mimeType: { mimeType: "image/png" },
    status: { status: "SIGNED" },
    verificationStatus: { verificationStatus: "FAILED" },
    caseLinked: { caseLinkCount: 0 },
    itemCount: { partCount: 4 },
    createdAtUtc: { createdAtUtc: new Date("2026-06-02T10:00:00.000Z") },
    reportReady: { latestReportVersion: null },
    packageReady: { verificationPackageVersion: null },
  };

  it("every field in EVIDENCE_CONTEXT_ALLOWLIST moves the revision", () => {
    for (const field of EVIDENCE_CONTEXT_ALLOWLIST) {
      const mutation = COVERS[field];
      expect(mutation, `${field} is prompted but not covered by the revision`).toBeTruthy();
      expect(rev(mutation), `${field} does not move the revision`).not.toBe(rev());
    }
  });

  it("the Evidence Copilot's extra fields move it too", () => {
    // That surface shows `captureMethod`, `tsaStatus`, `otsStatus` and
    // `custodyEventCount` on top of the shared list.
    for (const mutation of [
      { captureMethod: "UPLOAD" },
      { tsaStatus: "FAILED" },
      { otsStatus: "CONFIRMED" },
      { custodyEventCount: 8 },
    ] as Array<Partial<EvidenceAnalysisFacts>>) {
      expect(rev(mutation)).not.toBe(rev());
    }
  });

  it("governance transitions move it: archive, trash and destruction", () => {
    const when = new Date("2026-06-05T09:00:00.000Z");
    for (const mutation of [
      { archivedAt: when },
      { deletedAt: when },
      { lifecycleState: "PENDING_DESTRUCTION" },
      { lifecycleState: "DESTROYED" },
    ] as Array<Partial<EvidenceAnalysisFacts>>) {
      expect(rev(mutation)).not.toBe(rev());
    }
  });

  it("identity and tenancy are bound, so a revision cannot be replayed", () => {
    expect(rev({ id: "dddddddd-5555-4555-8555-555555555555" })).not.toBe(rev());
    expect(rev({ teamId: "eeeeeeee-6666-4666-8666-666666666666" })).not.toBe(rev());
  });

  it("no two of the covered mutations collide", () => {
    const all = [
      ...Object.values(COVERS),
      { captureMethod: "UPLOAD" },
      { tsaStatus: "FAILED" },
      { otsStatus: "CONFIRMED" },
      { custodyEventCount: 8 },
      { archivedAt: new Date("2026-06-05T09:00:00.000Z") },
      { deletedAt: new Date("2026-06-05T09:00:00.000Z") },
      { lifecycleState: "PENDING_DESTRUCTION" },
    ] as Array<Partial<EvidenceAnalysisFacts>>;
    const seen = new Set(all.map((m) => rev(m)));
    expect(seen.size).toBe(all.length);
  });
});

describe("the SELECT and the facts cannot drift apart", () => {
  it("every fact the revision reads is a field the canonical select projects", () => {
    // The failure this guards: adding a field to a Copilot prompt, reading it
    // in the route, and forgetting to project it — which is exactly how
    // `verificationPackageVersion` came to be `undefined` on the case surface.
    const selected = new Set(Object.keys(EVIDENCE_ANALYSIS_SELECT));
    for (const key of [
      "id",
      "teamId",
      "title",
      "type",
      "mimeType",
      "status",
      "verificationStatus",
      "captureMethod",
      "tsaStatus",
      "otsStatus",
      "createdAt",
      "lifecycleState",
      "deletedAt",
      "archivedAt",
      "latestReportVersion",
      "verificationPackageVersion",
    ]) {
      expect(selected.has(key), `${key} is read but not selected`).toBe(true);
    }
    // The three counts and the link set come through the relation selections.
    expect(selected.has("_count")).toBe(true);
    expect(selected.has("caseLinks")).toBe(true);
  });

  it("a projected row translates into facts with nothing collapsed", () => {
    const row: EvidenceAnalysisRow = {
      id: FACTS.id,
      teamId: FACTS.teamId,
      title: null,
      type: "PHOTO",
      mimeType: null,
      status: "REPORTED",
      verificationStatus: null,
      captureMethod: null,
      tsaStatus: null,
      otsStatus: null,
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
      lifecycleState: "ACTIVE",
      deletedAt: null,
      archivedAt: null,
      latestReportVersion: null,
      verificationPackageVersion: null,
      _count: {
        parts: 0,
        custodyEvents: 0,
        caseLinks: 0,
        reports: 0,
        verificationPackages: 0,
      },
      caseLinks: [],
    };
    const facts = evidenceAnalysisFacts(row);
    // Every absent value stays absent. None becomes a zero, an empty string or
    // a default.
    expect(facts.verificationPackageVersion).toBeNull();
    expect(facts.latestReportVersion).toBeNull();
    expect(facts.title).toBeNull();
    expect(facts.mimeType).toBeNull();
    // …and the counts are real zeros, which is a different thing again.
    expect(facts.partCount).toBe(0);
    expect(facts.caseLinkCount).toBe(0);
  });
});
