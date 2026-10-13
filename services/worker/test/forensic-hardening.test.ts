/**
 * Phase C #17 — worker-side forensic-semantics tests.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROOVRA_FORBIDDEN_SURFACE_PATTERNS,
} from "@proovra/shared-evidence-presentation";
import * as prismaPkg from "@prisma/client";
import { custodyLabelHints } from "@proovra/shared";
import {
  mapTimestampStatusPublicLabel,
  mapCustodyEventLabel,
} from "../src/report-v2/normalizers.js";
import { otsStatusLineFor, otsStatusWordFor, reportOtsAnchoring } from "../src/report-v2/ots-presentation.js";
import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { shouldExpireCaptureDraft } from "../src/capture-draft-governance.js";

/**
 * The repository root, resolved from THIS FILE rather than hardcoded.
 *
 * This read `resolve("D:/digital-witness", ...segments)` — one developer's
 * absolute Windows path. It resolved on exactly one machine and nowhere else:
 * on the Linux CI runner it produced
 * `/work/services/<pkg>/D:/digital-witness/...` and every case using it failed
 * ENOENT, which is why the "Test" step was red in `ci` while passing locally.
 *
 * `import.meta.url` is the only anchor that is correct on every host, and it
 * needs no knowledge of where the checkout happens to live.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function readRepoFile(...segments: string[]): string {
  return readFileSync(resolve(REPO_ROOT, ...segments), "utf8");
}

describe("OTS labels (2026-10-13: the canonical state, from the proof)", () => {
  it("the report says Anchored only for a proof that executes to a Bitcoin attestation", () => {
    const anchored = reportOtsAnchoring({ otsStatus: "PENDING", otsProofBase64: upgradedProof().base64, otsHash: REAL.boundFingerprintHash, fingerprintHash: REAL.boundFingerprintHash });
    expect(anchored.state).toBe("ANCHORED");
    expect(otsStatusWordFor(anchored.state)).toBe("Anchored");
    expect(otsStatusLineFor(anchored.state)).toBe("Bitcoin anchored");
  });

  it("a status, a valid txid and a time never make a pending proof anchored", () => {
    const a = reportOtsAnchoring({
      otsStatus: "ANCHORED",
      otsBitcoinTxid: "f".repeat(64),
      otsAnchoredAtUtc: "2026-09-20T10:00:00.000Z",
      otsProofBase64: REAL.boundProofBase64,
      otsHash: REAL.boundFingerprintHash,
      fingerprintHash: REAL.boundFingerprintHash,
    } as never);
    expect(a.state).toBe("PENDING");
    expect(otsStatusWordFor(a.state)).toBe("Pending");
  });

  it("never says verified, attestation recorded or chain-verified for any state", () => {
    for (const state of ["NOT_REQUESTED", "PENDING", "ANCHORED", "FAILED", "UNAVAILABLE"] as const) {
      const text = `${otsStatusWordFor(state)} ${otsStatusLineFor(state)}`;
      expect(text).not.toMatch(/verified|attestation recorded|chain/i);
    }
  });
});

describe("Custody event labels (Phase A/B/C wording sweep)", () => {
  it("renders new event types with their truthful labels", () => {
    expect(mapCustodyEventLabel("UPLOAD_AUTHORIZED")).toContain("authorization");
    expect(mapCustodyEventLabel("STORAGE_PROTECTION_UNAVAILABLE")).toContain(
      "Storage protection"
    );
    expect(mapCustodyEventLabel("OTS_ATTEMPT_ERROR")).toContain("attempt");
    expect(mapCustodyEventLabel("REPORT_IDENTITY_CONTEXT_RECORDED")).toContain(
      "report generation"
    );
  });

  it("re-labels legacy UPLOAD_STARTED honestly without rewriting history", () => {
    const label = mapCustodyEventLabel("UPLOAD_STARTED");
    // We do NOT say "Upload started" any more — that was the misleading
    // wording. The label now reads as an authorization signal.
    expect(label.toLowerCase()).not.toBe("upload started");
    expect(label.toLowerCase()).toContain("upload");
  });

  it("EVIDENCE_LOCKED label is gated on actual lock — wording hints retention applied", () => {
    // ET-CUS-08/13: EVIDENCE_LOCKED carries two meanings; the payload decides.
    // Only the storage-retention event may claim Object Lock.
    expect(mapCustodyEventLabel("EVIDENCE_LOCKED", custodyLabelHints({ retentionApplied: true, mode: "COMPLIANCE" }))).toContain("Object Lock");
    expect(mapCustodyEventLabel("EVIDENCE_LOCKED", custodyLabelHints({ lockedByUserId: "u-1" }))).toBe("Evidence record locked");
    expect(mapCustodyEventLabel("EVIDENCE_LOCKED")).not.toContain("Object Lock");
  });
});

describe("TSA labels (Phase A / Phase C)", () => {
  it("never claims 'verified' in TSA labels", () => {
    for (const status of ["STAMPED", "PENDING", "UNAVAILABLE", "FAILED", null]) {
      const label = mapTimestampStatusPublicLabel(status as string | null);
      expect(label.toLowerCase()).not.toContain("verified");
    }
  });
});

describe("claims governance across worker-facing reviewer materials (Governance Items 3/4)", () => {
  it("keeps report-v2 and verification-package templates free of positive overclaim phrases", () => {
    const surfaces = [
      readRepoFile("services", "worker", "src", "report-v2", "build-view-model.ts"),
      readRepoFile(
        "services",
        "worker",
        "src",
        "report-v2",
        "sections",
        "cover.ts"
      ),
      readRepoFile(
        "services",
        "worker",
        "src",
        "report-v2",
        "sections",
        "executive-summary.ts"
      ),
      readRepoFile(
        "services",
        "worker",
        "src",
        "report-v2",
        "sections",
        "technical-appendix.ts"
      ),
      readRepoFile("services", "worker", "src", "verification-package.ts"),
    ];

    for (const surface of surfaces) {
      for (const pattern of PROOVRA_FORBIDDEN_SURFACE_PATTERNS) {
        expect(surface).not.toMatch(pattern);
      }
    }
  });

  it("uses the shared multipart reviewer explanation in report/package surfaces", () => {
    const appendixSource = readRepoFile(
      "services",
      "worker",
      "src",
      "report-v2",
      "sections",
      "technical-appendix.ts"
    );
    const packageSource = readRepoFile(
      "services",
      "worker",
      "src",
      "verification-package.ts"
    );

    expect(appendixSource).toContain("PROOVRA_MULTIPART_REVIEWER_EXPLANATION");
    expect(appendixSource).toContain("PROOVRA_MULTIPART_RECOMPUTATION_NOTE");
    expect(appendixSource).toContain("PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE");
    expect(packageSource).toContain("PROOVRA_MULTIPART_REVIEWER_EXPLANATION");
    expect(packageSource).toContain("PROOVRA_MULTIPART_RECOMPUTATION_NOTE");
    expect(packageSource).toContain("PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE");
  });

  it("exports artifact-role metadata into verification-package manifests", () => {
    const packageSource = readRepoFile(
      "services",
      "worker",
      "src",
      "verification-package.ts"
    );

    expect(packageSource).toContain("artifactRole: file.artifactRole ?? null");
    expect(packageSource).toContain("artifactRoleLabel:");
    expect(packageSource).toContain("artifactRoleSource: file.artifactRoleSource ?? null");
    expect(packageSource).toContain("checklistStepId: file.checklistStepId ?? null");
    expect(packageSource).toContain("checklistStepLabel: file.checklistStepLabel ?? null");
    expect(packageSource).toContain("sourceLabel: file.sourceLabel ?? null");
  });
});

describe("capture draft reaper governance (Governance Item 2)", () => {
  it("expires only past-due drafts", () => {
    const now = new Date("2026-05-10T12:00:00.000Z");

    expect(
      shouldExpireCaptureDraft({
        status: prismaPkg.CaptureSessionStatus.DRAFT,
        expiresAtUtc: new Date("2026-05-10T11:59:59.000Z"),
        now,
      })
    ).toBe(true);

    expect(
      shouldExpireCaptureDraft({
        status: prismaPkg.CaptureSessionStatus.DRAFT,
        expiresAtUtc: new Date("2026-05-10T12:00:01.000Z"),
        now,
      })
    ).toBe(false);

    expect(
      shouldExpireCaptureDraft({
        status: prismaPkg.CaptureSessionStatus.FINALIZED,
        expiresAtUtc: new Date("2026-05-10T11:59:59.000Z"),
        now,
      })
    ).toBe(false);
  });
});
