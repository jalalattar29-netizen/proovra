/**
 * AUD-37 (2026-10-20) — a served location the device provider reported as
 * MOCKED shows its warning on the web, in the reader's language.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import LocationStateNote, { readLocationState } from "../../components/capture-location/LocationStateNote";

const MOCKED = {
  state: "RECORDED",
  label: "Location recorded",
  tone: "warning" as const,
  detail: "The device marked these coordinates as coming from a mock (simulated) location provider. They are not an independent observation of where the capture happened.",
  providerReportedMock: true,
};

describe("AUD-37 mocked location on the web", () => {
  afterEach(() => cleanup());

  it("states the mock warning (English and German)", () => {
    render(<LocationStateNote location={readLocationState(MOCKED, null, "en")} />);
    expect(screen.getByText(/mock \(simulated\) location provider/)).toBeTruthy();
    cleanup();
    render(<LocationStateNote location={readLocationState(MOCKED, null, "de")} />);
    expect(document.querySelector("[data-location-state-detail]")?.textContent ?? "").toMatch(/Mock/);
  });

  it("an ordinary recorded location shows no warning detail", () => {
    render(<LocationStateNote location={readLocationState({ state: "RECORDED", label: "Location recorded", tone: "info", detail: null }, null, "de")} />);
    expect(document.querySelector("[data-location-state-detail]")).toBeNull();
  });
});
