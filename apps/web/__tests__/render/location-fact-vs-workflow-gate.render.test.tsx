/**
 * REGRESSION — "Location: Blocked" (reported from Production, 2026-10-16).
 *
 * The exact cases: a legacy record with no location facts, and a record whose
 * collection plan REQUIRED location but recorded none. On every evidence
 * surface the location FACT is the neutral "Location not recorded" (in the
 * reader's language), the plan's requirement is a separate, labelled line,
 * and nothing about location reads "Blocked". The one place "Blocked" may
 * appear is the capture session's WORKFLOW status, when a plan requires
 * location and the session has none — beside its own reason, never as the
 * value of a Location row.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { resolveEvidenceLocation } from "@proovra/shared";

let activeLocale = "en";
vi.mock("../../app/providers", () => ({ useOptionalLocale: () => activeLocale }));
vi.mock("../../components/ai/CaptureAiAssistant", () => ({ CaptureAiAssistant: () => null }));
vi.mock("../../app/(app)/capture/_lib/CaptureReadinessSignals", () => ({ CaptureReadinessSignals: () => null }));

import LocationStateNote, { readLocationState } from "../../components/capture-location/LocationStateNote";
import { CaptureTemplateCard } from "../../app/(app)/evidence/[id]/_tabs/_lib";
import { buildSessionReadiness } from "../../app/(app)/capture/_lib/session-readiness";
import { CaptureSessionPanel } from "../../components/capture-v2/CaptureSessionPanel";
import type { CollectionPlanTemplate, SessionItem } from "../../app/(app)/capture/_lib/types";

const BLOCKED = /blocked|gesperrt|blockiert|محظور|محجوب/i;

function served(facts: Parameters<typeof resolveEvidenceLocation>[0]) {
  const r = resolveEvidenceLocation(facts);
  return { state: r.state, label: r.label, tone: r.tone, detail: r.detail, requirement: r.requirement };
}

const CASES = {
  legacy: { state: served({}), plan: { templateName: "Legacy upload" } },
  required: { state: served({ requirement: "required" }), plan: { templateName: "Site visit", locationRequirement: "required" } },
} as const;

const NOT_RECORDED = { en: "Location not recorded", de: "Standort nicht erfasst", ar: "لم يُسجَّل الموقع" } as const;

afterEach(() => {
  cleanup();
  activeLocale = "en";
});

describe("the evidence location FACT is neutral for the exact legacy and required-location cases", () => {
  for (const locale of ["en", "de", "ar"] as const) {
    for (const [name, c] of Object.entries(CASES)) {
      it(`${name} (${locale}) → ${NOT_RECORDED[locale]}, neutral, never Blocked`, () => {
        activeLocale = locale;
        const view = readLocationState(c.state, null, locale);
        const { container } = render(<LocationStateNote location={view} />);
        const note = container.querySelector("[data-location-state]")!;
        expect(note.getAttribute("data-location-state")).toBe("NOT_RECORDED");
        expect(container.querySelector("[data-location-state-label]")!.textContent).toBe(NOT_RECORDED[locale]);
        expect(view.tone).toBe("neutral");
        expect(container.textContent).not.toMatch(BLOCKED);
        // The requirement is its OWN line, and only when the plan required location.
        const req = container.querySelector('[data-location-requirement="unmet"]');
        if (name === "required") expect(req?.textContent?.length).toBeGreaterThan(0);
        else expect(req).toBeNull();
      });
    }
  }

  it("the plan summary labels the PLAN's requirement, apart from the fact — in every locale", () => {
    const expect3 = {
      en: ["Location requirement", "Required", "Not specified by the plan"],
      de: ["Standortanforderung", "Erforderlich", "Vom Plan nicht festgelegt"],
      ar: ["متطلب الموقع", "مطلوب", "لم تحدده الخطة"],
    } as const;
    for (const locale of ["en", "de", "ar"] as const) {
      activeLocale = locale;
      const [label, required, none] = expect3[locale];
      const req = render(<CaptureTemplateCard intakePlanJson={CASES.required.plan} contentItems={[]} />);
      expect(req.container.textContent).toContain(label);
      expect(req.container.textContent).toContain(required);
      expect(req.container.textContent).not.toMatch(BLOCKED);
      req.unmount();
      const legacy = render(<CaptureTemplateCard intakePlanJson={CASES.legacy.plan} contentItems={[]} />);
      expect(legacy.container.textContent).toContain(none);
      // A requirement row never borrows the fact's words.
      expect(legacy.container.textContent).not.toContain(NOT_RECORDED[locale]);
      legacy.unmount();
    }
  });
});

describe("the separate WORKFLOW gate may block — and only the workflow", () => {
  const plan = (locationRequirement: CollectionPlanTemplate["locationRequirement"]): CollectionPlanTemplate => ({
    id: "site",
    name: "Site visit",
    description: "",
    locationRequirement,
    steps: [],
  });
  const item = {
    id: "i1",
    file: new File(["x"], "a.txt", { type: "text/plain" }),
    previewUrl: null,
    mimeType: "text/plain",
    relativePath: null,
    uploadProgress: 0,
    uploading: false,
  } as SessionItem;

  it("a required plan without location blocks the SESSION with its reason; an optional / legacy one does not", () => {
    const required = buildSessionReadiness({ items: [item], selectedPlan: plan("required"), planMode: "FLEXIBLE", useLocation: false });
    expect(required.status).toBe("blocked");
    expect(required.blockers.map((b) => b.code)).toContain("capture_required_location_missing");
    for (const p of [plan("optional"), undefined]) {
      const r = buildSessionReadiness({ items: [item], selectedPlan: p, planMode: "FLEXIBLE", useLocation: false });
      expect(r.blockers.map((b) => b.code)).not.toContain("capture_required_location_missing");
      expect(r.status).not.toBe("blocked");
    }
  });

  it("the capture panel says Blocked as the SESSION status, while its Location row states the fact", () => {
    const readiness = buildSessionReadiness({ items: [item], selectedPlan: plan("required"), planMode: "FLEXIBLE", useLocation: false });
    const { container } = render(
      <CaptureSessionPanel
        busy={false}
        error={null}
        locationPermissionDenied={false}
        sessionItems={[item]}
        sessionCountLabel="1 item"
        sessionStatus={null}
        currentSessionId="CAP-2026-10-16"
        selectedCollectionPlan={plan("required")}
        totalStagedBytes={1}
        internalNotes=""
        setInternalNotes={() => {}}
        aiPanelOpen={false}
        setAiPanelOpen={() => {}}
        captureAiSummary={{
          totalItems: 1,
          totalSizeBytes: 1,
          requiredStepsCompleted: 0,
          requiredStepsTotal: 0,
          planMode: "FLEXIBLE",
          useLocation: false,
          locationRequirement: "required",
        }}
        sessionReadiness={readiness}
        useLocation={false}
        planMode="FLEXIBLE"
        requiredProgressPercent={0}
        formatFileSize={() => "1 B"}
      />,
    );
    expect(container.textContent).toMatch(/Blocked/);
    const locationRow = [...container.querySelectorAll(".capture-integrity-list > div")].find(
      (row) => row.querySelector("span")?.textContent === "Location",
    )!;
    expect(locationRow, "the Location row").toBeTruthy();
    expect(within(locationRow as HTMLElement).getByText("Not included")).toBeTruthy();
    expect(locationRow.textContent).not.toMatch(/Blocked/);
  });
});
