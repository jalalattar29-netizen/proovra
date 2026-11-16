/**
 * B5B-F-102 — a VIEWER's refused FULL_FORENSIC package is explained truthfully.
 *
 * The gate answers 403 FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS (the package
 * embeds originals; VIEWER holds download_package, not download_original).
 * The web read it as "blocked by workspace governance, a hold, or export
 * eligibility", and the history's unpaired packages offered the download
 * regardless of packageAccess.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { describeArtifactDownloadFailure } from "../../lib/evidence/report-download-feedback";
import { MatchedVersionHistory } from "../../components/evidence-outputs/MatchedVersionHistory";

afterEach(() => cleanup());

describe("B5B-F-102", () => {
  it("names the original-access reason and the external package, not governance", () => {
    const out = describeArtifactDownloadFailure("verificationPackage", {
      statusCode: 403,
      code: "FULL_PACKAGE_REQUIRES_ORIGINAL_ACCESS",
      message: "x",
    });
    expect(out.message).toMatch(/original files/);
    expect(out.message).toMatch(/external disclosure package/);
    expect(out.message).not.toMatch(/governance|hold|export eligibility/);
    expect(out.report).toBe(false);
  });

  it("an unpaired package offers no full download to a caller without original access", () => {
    render(
      <MatchedVersionHistory
        history={{
          versions: [],
          unpairedPackages: [{ version: 3, generatedAtUtc: "2026-09-01T00:00:00Z", sizeBytes: "1024" } as never],
        }}
        formatDateTime={(v) => String(v ?? "")}
        formatBytes={(v) => String(v ?? "")}
        onDownloadReportVersion={() => {}}
        onDownloadPackageVersion={() => {}}
        packageAccess={{ fullForensic: false, externalDisclosure: true } as never}
      />,
    );
    expect(screen.queryByRole("button", { name: /Download Verification Package ZIP v3/ })).toBeNull();
    expect(screen.getByTestId("unpaired-3-full-restricted")).toBeTruthy();
  });
});
