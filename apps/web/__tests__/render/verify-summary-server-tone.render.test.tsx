/**
 * AUD-27 (2026-10-20) — THE VERIFICATION SUMMARY RAIL IS THE SERVER'S TONE.
 *
 * Characterization (before): the card recomputed its tone from the trust
 * decision, which does not see the package rows, so a record whose package
 * seal FAILED could read green. The rail now states matrix.tone, decided by
 * the server from every row.
 */
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildVerificationMatrix } from "@proovra/shared";

import { VerificationSummaryCard } from "../../app/verify/[token]/VerifyMatrixPanels";

const card = () => document.querySelector('[data-testid="verify-matrix-summary-card"]') as HTMLElement;

describe("Verification Summary rail (AUD-27)", () => {
  it("a FAILED package seal reads danger even when the decision's own tone is success", () => {
    const matrix = buildVerificationMatrix({ signals: [], identity: null, acquisitionMode: null, packageSeal: { kind: "FAILED" }, publication: { kind: "DOCUMENT" } });
    render(<VerificationSummaryCard matrix={matrix} decision={{ presentationTone: "success", tone: "success", signals: [] } as never} />);
    expect(card().getAttribute("data-summary-tone")).toBe("danger");
  });

  it("without a matrix the card states no tone of its own", () => {
    render(<VerificationSummaryCard matrix={null} decision={{ presentationTone: "success", tone: "success", signals: [] } as never} />);
    expect(card().getAttribute("data-summary-tone")).toBe("none");
  });
});
