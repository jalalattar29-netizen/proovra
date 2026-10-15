/**
 * LEGACY LIFECYCLE RECONCILIATION (2026-10-15) — the ONE population
 * classification, row by row. Every shape the Production inspection found
 * maps to exactly one class; incomplete uploads never become Trash.
 */
import { describe, expect, it } from "vitest";

import {
  activeEvidenceWhere,
  classifyEvidencePopulation,
  EVIDENCE_POPULATION_CLASSES,
  unlinkedActiveEvidenceWhere,
  workingEvidenceWhere,
  type EvidencePopulationFacts,
} from "@proovra/shared-runtime";

const T = new Date("2026-10-01T00:00:00Z");
const base: EvidencePopulationFacts = {
  status: "REPORTED",
  lifecycleState: "ACTIVE",
  deletedAt: null,
  deletedAtUtc: null,
  archivedAt: null,
  destroyedAtUtc: null,
  signedAtUtc: T,
};
const c = (over: Partial<EvidencePopulationFacts>) => classifyEvidencePopulation({ ...base, ...over });

describe("classifyEvidencePopulation", () => {
  it("a consistent completed record is ACTIVE (governance postures included)", () => {
    expect(c({})).toBe("ACTIVE");
    for (const s of ["UNDER_REVIEW", "ON_HOLD", "RETENTION_LOCKED"]) expect(c({ lifecycleState: s })).toBe("ACTIVE");
  });

  it("a completed record ACTIVE with EITHER deletion marker belongs in TRASH (the legacy 17)", () => {
    expect(c({ deletedAt: T })).toBe("TRASH");
    expect(c({ deletedAtUtc: T })).toBe("TRASH");
  });

  it("incomplete uploads are never Trash: released, trashed or expired → ABANDONED_UPLOAD; live → IN_PROGRESS", () => {
    const up = { status: "UPLOADING", signedAtUtc: null };
    expect(c({ ...up, deletedAt: T })).toBe("ABANDONED_UPLOAD");
    expect(c({ ...up, lifecycleState: "TRASHED", deletedAt: T })).toBe("ABANDONED_UPLOAD");
    expect(c({ ...up, lifecycleState: "TRASHED" })).toBe("ABANDONED_UPLOAD");
    expect(c({ ...up, reservationLive: false })).toBe("ABANDONED_UPLOAD");
    expect(c({ ...up, reservationLive: true })).toBe("IN_PROGRESS");
    expect(c({ ...up, status: "CREATED", reservationLive: true })).toBe("IN_PROGRESS");
  });

  it("Trash, Retention Archive, owner archive and purge", () => {
    expect(c({ lifecycleState: "TRASHED", deletedAt: T })).toBe("TRASH");
    expect(c({ lifecycleState: "RETENTION_ARCHIVED", deletedAt: T })).toBe("RETENTION_ARCHIVE");
    expect(c({ lifecycleState: "ARCHIVED", archivedAt: T })).toBe("ARCHIVED");
    expect(c({ lifecycleState: "PENDING_DESTRUCTION", deletedAt: T })).toBe("PURGE");
    expect(c({ lifecycleState: "DESTROYED", deletedAt: T, destroyedAtUtc: T })).toBe("PURGE");
  });

  it("contradictions are MANUAL_REVIEW — never guessed", () => {
    expect(c({ lifecycleState: "TRASHED" })).toBe("MANUAL_REVIEW"); // trashed with no deletion date
    expect(c({ archivedAt: T })).toBe("MANUAL_REVIEW"); // active with an archive marker
    expect(c({ lifecycleState: "ARCHIVED", deletedAt: T })).toBe("MANUAL_REVIEW");
    expect(c({ status: "UPLOADING" })).toBe("MANUAL_REVIEW"); // unsealed yet signed
  });

  it("every class is reachable and the list is closed", () => {
    expect([...EVIDENCE_POPULATION_CLASSES].sort()).toEqual(
      ["ABANDONED_UPLOAD", "ACTIVE", "ARCHIVED", "IN_PROGRESS", "MANUAL_REVIEW", "PURGE", "RETENTION_ARCHIVE", "TRASH"].sort(),
    );
  });
});

describe("the population predicates read BOTH deletion columns and every exit marker", () => {
  it("active = sealed + active lifecycle + no deletion / archive / destroy marker", () => {
    expect(activeEvidenceWhere()).toEqual({
      status: { notIn: ["CREATED", "UPLOADING"] },
      lifecycleState: { in: ["ACTIVE", "UNDER_REVIEW", "ON_HOLD", "RETENTION_LOCKED"] },
      deletedAt: null,
      deletedAtUtc: null,
      archivedAt: null,
      destroyedAtUtc: null,
    });
    const working = workingEvidenceWhere() as Record<string, unknown>;
    expect(working).toMatchObject({ deletedAt: null, deletedAtUtc: null, archivedAt: null, destroyedAtUtc: null });
    expect("status" in working).toBe(false);
  });

  it("unlinked = active and in no ACTIVE matter", () => {
    expect(unlinkedActiveEvidenceWhere()).toEqual({
      AND: [activeEvidenceWhere(), { caseLinks: { none: { case: { status: { notIn: ["CLOSED", "ARCHIVED"] } } } } }],
    });
  });
});
