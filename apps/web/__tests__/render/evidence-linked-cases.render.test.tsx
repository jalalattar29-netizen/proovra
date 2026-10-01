import { describe, it, expect, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const render = (ui: ReactElement) => rtlRender(<ConfirmActionProvider>{ui}</ConfirmActionProvider>);

import { EvidenceRelationshipsSection } from "../../app/(app)/evidence/[id]/components/EvidenceRelationshipsSection";

/**
 * UC-CASE-005 (web render half) — Evidence Detail lists EVERY linked case the
 * viewer may open (lane A projects `relationships.cases`, access-filtered) and
 * offers per-case unlink. A case the viewer cannot open is never in the
 * projection, so it never renders; an older API without `cases` falls back to
 * the single-case alias.
 */
const base = {
  caseName: "Alpha matter",
  relatedEvidenceCount: 0,
  multipart: false,
  itemCount: 1,
  note: null,
  items: [],
  actionBusy: false,
  onAssignCase: () => {},
  onRemoveCase: () => {},
  onOpenRelationshipEditor: () => {},
  onOpenLinkedEvidence: () => {},
};

describe("EvidenceRelationshipsSection — linked cases", () => {
  it("renders every linked case with its own unlink (two-case record)", () => {
    const onRemoveLinkedCase = vi.fn();
    render(
      <EvidenceRelationshipsSection
        {...base}
        cases={[
          { caseId: "case-a", caseName: "Alpha matter", role: "PRIMARY", linkedAtUtc: "2026-09-01T00:00:00Z" },
          { caseId: "case-b", caseName: "Beta matter", role: "SUPPORTING", linkedAtUtc: "2026-09-02T00:00:00Z" },
        ]}
        onRemoveLinkedCase={onRemoveLinkedCase}
      />,
    );
    const rows = document.querySelectorAll("[data-evidence-linked-case]");
    expect([...rows].map((r) => r.getAttribute("data-evidence-linked-case"))).toEqual(["case-a", "case-b"]);
    expect(screen.getByText("Linked cases (2)")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove from case Beta matter"));
    expect(onRemoveLinkedCase).toHaveBeenCalledWith("case-b");
    // The single-alias "Remove case" header action is replaced by per-case unlink.
    expect(document.querySelectorAll("[data-evidence-action='remove-case']")).toHaveLength(2);
  });

  it("a case the viewer cannot open is not projected, so it is not rendered", () => {
    render(
      <EvidenceRelationshipsSection
        {...base}
        cases={[{ caseId: "case-a", caseName: "Alpha matter", role: "PRIMARY", linkedAtUtc: "2026-09-01T00:00:00Z" }]}
        onRemoveLinkedCase={() => {}}
      />,
    );
    expect(document.querySelectorAll("[data-evidence-linked-case]")).toHaveLength(1);
    expect(screen.queryByText(/Restricted/)).toBeNull();
  });

  it("an empty projection reads Unassigned", () => {
    render(<EvidenceRelationshipsSection {...base} caseName={null} cases={[]} onRemoveLinkedCase={() => {}} />);
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect(screen.getByText("Assign case")).toBeTruthy();
  });

  it("older API (no cases) falls back to the single-case alias", () => {
    render(<EvidenceRelationshipsSection {...base} />);
    expect(screen.getByText("Alpha matter")).toBeTruthy();
    expect(screen.getByText("Remove case")).toBeTruthy();
  });
});
