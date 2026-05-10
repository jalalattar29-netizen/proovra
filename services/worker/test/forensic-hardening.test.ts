/**
 * Phase C #17 — worker-side forensic-semantics tests.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROOVRA_FORBIDDEN_SURFACE_PATTERNS,
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import * as prismaPkg from "@prisma/client";
import {
  mapOtsStatusPublicLabel,
  mapOtsStatusPublicLabelWithTxid,
  mapTimestampStatusPublicLabel,
  mapCustodyEventLabel,
} from "../src/report-v2/normalizers.js";
import { normalizeBitcoinAnchorTone } from "../src/report-v2/truth-model.js";
import { shouldExpireCaptureDraft } from "../src/capture-draft-governance.js";

function readRepoFile(...segments: string[]): string {
  return readFileSync(resolve("D:/digital-witness", ...segments), "utf8");
}

describe("OTS labels (Phase B #9 / Phase C #4)", () => {
  it("never returns 'Public anchoring verified' from the base label", () => {
    for (const status of ["ANCHORED", "PENDING", "FAILED", "DISABLED", null, "UNKNOWN"]) {
      const label = mapOtsStatusPublicLabel(status as string | null);
      expect(label.toLowerCase()).not.toContain("public anchoring verified");
    }
  });

  it("only returns 'Bitcoin anchoring verified' when both ANCHORED + valid txid", () => {
    const validTxid = "f".repeat(64);
    expect(
      mapOtsStatusPublicLabelWithTxid({ status: "ANCHORED", bitcoinTxid: validTxid })
    ).toBe("Bitcoin anchoring verified");
    expect(
      mapOtsStatusPublicLabelWithTxid({ status: "ANCHORED", bitcoinTxid: null })
    ).toContain("public anchoring pending");
    expect(
      mapOtsStatusPublicLabelWithTxid({ status: "PENDING", bitcoinTxid: validTxid })
    ).toContain("pending");
  });

  it("downgrades anchor tone to warning without a valid Bitcoin txid", () => {
    const tone = normalizeBitcoinAnchorTone({
      status: "ANCHORED",
      bitcoinTxid: null,
    });
    expect(tone).toBe("warning");
  });

  it("escalates anchor tone to success when valid Bitcoin txid is recorded", () => {
    const tone = normalizeBitcoinAnchorTone({
      status: "ANCHORED",
      bitcoinTxid: "a".repeat(64),
    });
    expect(tone).toBe("success");
  });

  it("rejects malformed Bitcoin txids (not 64 hex)", () => {
    const tone = normalizeBitcoinAnchorTone({
      status: "ANCHORED",
      bitcoinTxid: "not-hex",
    });
    expect(tone).toBe("warning");
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
    expect(mapCustodyEventLabel("EVIDENCE_LOCKED")).toContain("Object Lock");
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
