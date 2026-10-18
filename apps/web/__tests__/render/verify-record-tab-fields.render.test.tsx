/**
 * The public Verify Record tab shows the acquisition statement (its label
 * list once said "Capture Method" after the field was renamed "Acquisition",
 * so the row was filtered out).
 *
 * Converged 2026-10-18: the tab carries record metadata only. "Evidence ID",
 * a MIME "File Type", client-derived statuses and identity fields are not
 * record-tab fields: the verification reference, report issuance, stored-file
 * recheck and identity are recordFacts, and every status is a matrix row.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RECORD_TAB_FIELD_LABELS, selectRecordTabFields } from "../../app/verify/[token]/_verify-record-tab";

const page = readFileSync(resolve(__dirname, "../../app/verify/[token]/page.tsx"), "utf8");

function RecordTab({ fields }: { fields: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl>
      {selectRecordTabFields(fields).map((f) => (
        <div key={f.label} data-testid={`record-field-${f.label}`}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

afterEach(cleanup);

describe("Verify Record tab", () => {
  it("renders Acquisition; never an Evidence ID, a File Type or an identity field", () => {
    const { getByTestId, queryByTestId } = render(
      <RecordTab
        fields={[
          { label: "Evidence ID", value: "ev-1" },
          { label: "Acquisition", value: "Reported by the client as Android screen capture (PROOVRA app)" },
          { label: "File Type", value: "text/plain" },
          { label: "Identity Level", value: "Shared-workspace member account" },
          { label: "Integrity Scope", value: "not a record-tab field" },
        ]}
      />,
    );
    expect(getByTestId("record-field-Acquisition").textContent).toContain("Reported by the client as Android screen capture");
    expect(queryByTestId("record-field-Evidence ID")).toBeNull();
    expect(queryByTestId("record-field-File Type")).toBeNull();
    expect(queryByTestId("record-field-Identity Level")).toBeNull();
    expect(queryByTestId("record-field-Integrity Scope")).toBeNull();
  });

  it("the page uses the list, and every listed label is one the page produces", () => {
    expect(page).toContain("selectRecordTabFields(summaryFields)");
    expect(RECORD_TAB_FIELD_LABELS).not.toContain("Capture Method");
    for (const label of ["Evidence ID", "File Type", "Verification Status", "Integrity Status", "Submitted By"]) {
      expect(RECORD_TAB_FIELD_LABELS).not.toContain(label);
    }
    for (const label of RECORD_TAB_FIELD_LABELS) {
      expect(page).toContain(`label: "${label}"`);
    }
  });
});
