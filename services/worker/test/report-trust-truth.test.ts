/**
 * Lane T — report truth (rendered HTML, the production builders).
 *
 *   UC-OUT-001  a record that was private at issuance gets no printed
 *               verification link / QR code; the cover says it is not
 *               published and that the owner can create a link.
 */
import { describe, expect, it } from "vitest";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { reportInputFixture } from "./fixtures/report-v2-input.js";

const TOKEN_URL = "https://app.proovra.com/verify/pvs_" + "k".repeat(43);

describe("UC-OUT-001 — no live-looking verification link for an unpublished record", () => {
  it("unpublished at issuance: no link, no QR, an explicit 'Not published' caveat", async () => {
    const vm = await buildReportViewModel(
      reportInputFixture({ verifyUrl: TOKEN_URL, publicVerificationPublished: false }),
    );
    expect(vm.qr.publicDataUrl).toBeNull();
    const html = renderReportHtml(vm);
    expect(html).toContain('data-public-verification="not-published"');
    expect(html).toContain("Not published — the owner can create a verification link");
    expect(html).not.toContain("pvs_" + "k".repeat(43));
    expect(html).not.toContain("Scan QR code or open verification page");
  });

  it("published at issuance: the link and QR are printed", async () => {
    const vm = await buildReportViewModel(
      reportInputFixture({ verifyUrl: TOKEN_URL, publicVerificationPublished: true }),
    );
    expect(vm.qr.publicDataUrl).toMatch(/^data:image/);
    const html = renderReportHtml(vm);
    expect(html).toContain("pvs_" + "k".repeat(43));
    expect(html).toContain("Scan QR code or open verification page");
  });
});

import { EVIDENCE_ACQUISITION_MODES, resolveEvidenceAcquisition } from "@proovra/shared";
import { buildEvidenceAcquisitionContext, captureMethodDisplayLabel } from "@proovra/shared-runtime/technical-metadata";
import { buildCaseMetadata } from "../src/verification-package.js";

describe("UC-PROV-002 — the capture method names every recorded acquisition mode", () => {
  it("no recorded mode reads 'Not recorded'; only a legacy record does", () => {
    for (const mode of EVIDENCE_ACQUISITION_MODES) {
      expect(captureMethodDisplayLabel({ acquisitionMode: mode }), mode).not.toBe("Not recorded");
      if (mode !== "SECURE_INTAKE_LINK") {
        const ctx = buildEvidenceAcquisitionContext({ acquisitionMode: mode } as never);
        expect(ctx, mode).not.toBeNull();
        expect(ctx!.method, mode).not.toBe("Not recorded");
      }
    }
    expect(captureMethodDisplayLabel({ acquisitionMode: null })).toBe("Not recorded");
  });

  it("package case-metadata names a direct capture the way acquisition.json does", () => {
    const meta = buildCaseMetadata({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS", isIntake: false } as never, "ev-1");
    const text = JSON.stringify(meta);
    expect(text).not.toContain('"Not recorded"');
    expect(text).toContain("Android screen recording");
    expect(resolveEvidenceAcquisition({ acquisitionMode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS" }).label).toContain("Android screen recording");
  });
});

describe("UC-PROV-006 — an intake contributor is never 'Verified' from the link creator's identity", () => {
  it("intake + VERIFIED_EMAIL owner snapshot -> 'Not independently verified'", () => {
    const ctx = buildEvidenceAcquisitionContext({
      acquisitionMode: "SECURE_INTAKE_LINK",
      intakeLinkId: "link-1",
      intakeMode: "AUTHENTICATED_ORGANIZATION",
      identityLevel: "VERIFIED_EMAIL",
    } as never);
    expect(ctx!.identityVerification).toBe("Not independently verified");
    expect(ctx!.submissionType).not.toBe("Organization User");
  });
});

describe("UC-PROV-001 — the report never labels a server time as the capture time", () => {
  it("exec grid: 'Server received & signed', and 'Capture time not available' with no client-declared time", async () => {
    const html = renderReportHtml(await buildReportViewModel(reportInputFixture()));
    expect(html).not.toContain("Captured &amp; Signed");
    expect(html).toContain("Server received &amp; signed (UTC)");
    expect(html).toContain("Capture time not available");
  });

  it("a device-declared time is shown as client-declared, not proven", async () => {
    const input = reportInputFixture();
    const html = renderReportHtml(
      await buildReportViewModel({ ...input, evidence: { ...input.evidence, deviceTimeIso: "2025-12-31T23:59:00.000Z" } }),
    );
    expect(html).toMatch(/Device-declared capture time, not proven/);
  });
});

describe("UC-PROV-003 — the report states the capture client's reported facts, labelled as such", () => {
  it("a PARTIAL web capture with a mutated page and limitations says so", async () => {
    const input = reportInputFixture();
    const html = renderReportHtml(
      await buildReportViewModel({
        ...input,
        evidence: { ...input.evidence, acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION" } as never,
        captureManifest: {
          schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1",
          kind: "WEB",
          reportedBy: "CAPTURE_CLIENT",
          manifestSchemaVersion: "1",
          manifestSha256: "e".repeat(64),
          manifestPartIndex: 1,
          clientCaptureWindow: { startedAtUtc: "2026-09-30T10:00:00.000Z", endedAtUtc: "2026-09-30T10:00:05.000Z" },
          completeness: "PARTIAL",
          reportedComplete: false,
          limitations: ["PAGE_MUTATED_DURING_CAPTURE", "CROSS_ORIGIN_IFRAME_NOT_CAPTURED"],
          client: { kind: "BROWSER_EXTENSION", appVersion: "1.2.3", platform: "win", osVersion: null, model: null, browserName: "Chrome", browserVersion: "140" },
          web: { domain: "example.com", sourceUrlPrivate: "https://example.com/post/1", titlePrivate: "A post", captureMode: "VISIBLE", pageMutatedDuringCapture: true },
          screen: null,
        },
      }),
    );
    expect(html).toContain('data-capture-manifest="partial"');
    expect(html).toContain("Reported by the capture client");
    expect(html).toContain("https://example.com/post/1");
    expect(html).toContain("Page changed during capture");
    expect(html).toContain("Cross origin iframe not captured");
  });
});

describe("UC-TRUST-008 — the report states which stored bytes it certifies", () => {
  it("prints the signed digest, the object version(s) and the re-read time", async () => {
    const html = renderReportHtml(
      await buildReportViewModel(
        reportInputFixture({
          certifiedOriginal: { recordedSha256: "a".repeat(64), objectVersionIds: ["v-777"], rereadAtUtc: "2026-10-01T09:00:00.000Z" },
        }),
      ),
    );
    expect(html).toContain("data-certified-original");
    expect(html).toContain("v-777");
    expect(html).toContain("2026-10-01T09:00:00.000Z");
  });
});

import { VERIFICATION_LIMITATION, findForbiddenCustomerClaims } from "@proovra/shared";

describe("evidence claims (2026-10-08) — the rendered report states a verification matrix, never a score", () => {
  async function render(evidence: Record<string, unknown>) {
    const input = reportInputFixture();
    input.evidence = { ...input.evidence, ...evidence } as typeof input.evidence;
    const vm = await buildReportViewModel(input);
    const html = renderReportHtml(vm);
    return { vm, html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  }

  it("an unchecked OTS proof reads NOT_CHECKED; no score, verdict, reliance or tally anywhere", async () => {
    const { vm, html, text } = await render({
      otsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-01-01T02:00:00.000Z",
      otsBitcoinTxid: "c".repeat(64),
      otsAnchorCheck: "PROOF_STRUCTURE",
      acquisitionMode: "PROOVRA_WEB_UPLOAD",
    });
    expect(vm.verificationMatrix.rows.find((r) => r.key === "ots_anchoring")!.status).toBe("NOT_CHECKED");
    expect(html).toContain('data-matrix-row="ots_anchoring" data-matrix-status="NOT_CHECKED"');
    expect(findForbiddenCustomerClaims(text)).toEqual([]);
    expect(text).not.toMatch(/Technical Confidence|Trust Decision|Overall trust decision|STRONGLY/);
    expect(text).toContain(VERIFICATION_LIMITATION);
    expect(text).toContain("Any signal marked NOT_CHECKED was not independently verified.");
    // Upload is not capture.
    expect(text).toContain("PROOVRA did not observe creation or editing before submission.");
  });

  it("a validated timestamp is stated with the bounded TSA sentence, never as qualified", async () => {
    const { vm, text } = await render({ tsaStatus: "STAMPED", tsaValidatedAtUtc: "2026-01-01T00:02:30.000Z" });
    const tsa = vm.verificationMatrix.rows.find((r) => r.key === "tsa_token")!;
    expect(tsa.status).toBe("VERIFIED");
    expect(text).toContain("Timestamp token and certificate chain validated; qualified-service status was not independently evaluated.");
    expect(text).not.toMatch(/qualified (?:trust service|timestamp) (?:verified|confirmed)/i);
  });
});
