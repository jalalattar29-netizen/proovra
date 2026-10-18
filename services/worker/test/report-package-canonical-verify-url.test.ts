/**
 * THE CANONICAL VERIFICATION URL (2026-10-18). The report QR code / printed
 * link and the package README carry the record's permanent `pvr_` page —
 * buildVerifyUrl(verificationRef) — never a record id and never a `pvs_`
 * reviewer link.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateVerificationRef, isVerificationRefShape } from "@proovra/shared-runtime";

import { buildVerifyUrl } from "../src/processor.js";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { reportInputFixture } from "./fixtures/report-v2-input.js";

const PROCESSOR = readFileSync(fileURLToPath(new URL("../src/processor.ts", import.meta.url)), "utf8");
const PACKAGE = readFileSync(fileURLToPath(new URL("../src/verification-package.ts", import.meta.url)), "utf8");

describe("the report and the package README carry the pvr_ canonical URL", () => {
  it("buildVerifyUrl is the verify base plus the pvr_ reference", () => {
    const ref = generateVerificationRef();
    expect(isVerificationRefShape(ref)).toBe(true);
    const url = buildVerifyUrl(ref);
    expect(url).toMatch(/\/verify\/pvr_[A-Za-z0-9_-]{27}$/);
    expect(url.endsWith(`/verify/${ref}`)).toBe(true);
  });

  it("the run builds ONE verify URL from the ensured reference, and both the report and the package README print it", () => {
    expect(PROCESSOR).toContain("const verificationRef = ensured.ref;");
    expect(PROCESSOR).toContain("const verifyUrl = buildVerifyUrl(verificationRef);");
    // The report's QR / printed link and the package README's record line.
    expect(PROCESSOR).toContain("recordVerificationUrl: prepared.verifyUrl,");
    expect(PACKAGE).toContain("The record's verification page (the same link as the report's QR code):\n   ${params.recordVerificationUrl}");
    // Never the record id as the public link.
    expect(PROCESSOR).not.toMatch(/buildVerifyUrl\(\s*evidence(Id|\.id)\s*\)/);
  });

  it("the rendered report prints the pvr_ link and encodes it in the QR code", async () => {
    const ref = generateVerificationRef();
    const vm = await buildReportViewModel(
      reportInputFixture({ verifyUrl: buildVerifyUrl(ref), publicVerificationPublished: true }),
    );
    expect(vm.qr.publicDataUrl).toMatch(/^data:image/);
    const html = renderReportHtml(vm);
    expect(html).toContain(ref);
    expect(html).not.toMatch(/\/verify\/pvs_/);
  });
});
