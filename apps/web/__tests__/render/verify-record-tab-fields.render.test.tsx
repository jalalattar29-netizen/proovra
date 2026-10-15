/**
 * The public Verify Record tab shows the acquisition statement and the
 * workspace. Its label list said "Capture Method" after the summary field was
 * renamed "Acquisition", so the row was filtered out, and "Workspace" was
 * never listed.
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
  it("renders Acquisition and Workspace", () => {
    const { getByTestId, queryByTestId } = render(
      <RecordTab
        fields={[
          { label: "Evidence ID", value: "ev-1" },
          { label: "Acquisition", value: "Reported by the client as Android screen capture (PROOVRA app)" },
          { label: "Workspace", value: "Investigations" },
          { label: "Integrity Scope", value: "not a record-tab field" },
        ]}
      />,
    );
    expect(getByTestId("record-field-Acquisition").textContent).toContain("Reported by the client as Android screen capture");
    expect(getByTestId("record-field-Workspace").textContent).toContain("Investigations");
    expect(queryByTestId("record-field-Integrity Scope")).toBeNull();
  });

  it("the page uses the list, and every listed identity/acquisition label is one the summary produces", () => {
    expect(page).toContain("selectRecordTabFields(summaryFields)");
    expect(RECORD_TAB_FIELD_LABELS).not.toContain("Capture Method");
    for (const label of ["Acquisition", "Workspace", "Identity Level", "Organization", "Organization Verified"]) {
      expect(RECORD_TAB_FIELD_LABELS).toContain(label);
      expect(page).toContain(`label: "${label}"`);
    }
  });
});
