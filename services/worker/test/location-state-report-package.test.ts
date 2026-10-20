/**
 * THE CANONICAL LOCATION STATE in the PDF report and the verification package
 * (2026-10-16). Both state the record's location through
 * resolveEvidenceLocation (packages/shared capture-location.ts): one label per
 * state, a map only for valid recorded coordinates, never "Blocked", and the
 * record's integrity signals untouched by any location state.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/capture-location-map.js", () => ({
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async () => null),
  renderCaptureLocationMapPreviewPng: vi.fn(async () => null),
}));

import { deriveCanonicalArtifactFacts } from "@proovra/shared";
import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { buildSignalCards } from "../src/report-v2/signal-cards.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { buildCaptureContext, buildCaseMetadata, buildOriginalLinkage } from "../src/verification-package.js";
import { regressionRecordInput } from "./fixtures/report-layout-variants.js";

const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function withGps(gps: Partial<ReportV2Input["evidence"]["gps"]>): ReportV2Input {
  const input = regressionRecordInput("absent");
  // AUD-19: the location state is stated under the owner's disclosure.
  return { ...input, recordedLocationDisclosed: true, evidence: { ...input.evidence, gps: { ...input.evidence.gps, ...gps } } } as ReportV2Input;
}

async function render(input: ReportV2Input) {
  const vm = await buildReportViewModel(input);
  // The markup without the stylesheet (the CSS names every class).
  const html = renderReportHtml(vm).replace(/<style[\s\S]*?<\/style>/g, "");
  const summary = html.match(/<section class="report-section executive[\s\S]*?<\/section>\s*<\/div>/)?.[0] ?? html;
  return { vm, html, text: text(html), summary, cards: buildSignalCards(vm) };
}

const CASES: Array<{ name: string; gps: Partial<ReportV2Input["evidence"]["gps"]>; state: string; label: string | null; map: boolean }> = [
  { name: "valid recorded coordinates", gps: { lat: "52.521", lng: "13.405", accuracyMeters: "20", locationSource: "CLIENT_APP_DEVICE_LOCATION" }, state: "RECORDED", label: "Location recorded", map: true },
  { name: "legacy record with no location facts", gps: {}, state: "NOT_RECORDED", label: null, map: false },
  { name: "not requested (intake NONE / upload)", gps: { requestOutcome: "NOT_REQUESTED" }, state: "NOT_RECORDED", label: null, map: false },
  { name: "persisted denial", gps: { requestOutcome: "DENIED" }, state: "NOT_SHARED", label: "Location not shared", map: false },
  { name: "technical unavailability", gps: { requestOutcome: "UNAVAILABLE" }, state: "UNAVAILABLE", label: "Location unavailable", map: false },
  { name: "invalid stored coordinates", gps: { lat: "123", lng: "13.4" }, state: "INVALID", label: "Location metadata invalid", map: false },
  { name: "required plan, nothing recorded", gps: { requirement: "required" }, state: "NOT_RECORDED", label: "Location not recorded", map: false },
];

describe("report — the canonical location state", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.state}`, async () => {
      const { vm, html, summary, cards } = await render(withGps(c.gps));
      expect(vm.meta.locationState?.state).toBe(c.state);
      expect(html).not.toMatch(/Location[^<]{0,40}Blocked|Blocked[^<]{0,40}Location/i);
      if (c.map) {
        expect(html).toContain('class="capture-context-map"');
        expect(vm.meta.captureContext?.statusLabel).toBe("Location recorded");
        expect(text(summary)).toContain("Location recorded");
      } else {
        // No coordinates: no map, no coordinates, never an empty map shell.
        expect(html).not.toContain('class="capture-context-map"');
        expect(html).not.toContain("capture-context-map-shell");
        expect(text(html)).not.toMatch(/Latitude|Longitude/);
      }
      if (c.label && !c.map) expect(text(summary)).toContain(c.label);
      if (c.label === null) expect(summary).not.toContain("data-capture-context");
      // No location state touches an integrity signal.
      expect(cards.map((x) => x.key)).not.toContain("location");
    });
  }

  it("a plan that required location states the requirement apart from the recorded truth", async () => {
    const { vm, text: t } = await render(withGps({ requirement: "required" }));
    expect(vm.meta.locationState?.requirement).toEqual({ level: "required", label: "Required by the collection plan", unmet: true });
    expect(t).toContain("Location not recorded · Required by the collection plan");
  });

  it("an optional absent location changes no integrity fact and builds the report", async () => {
    const without = regressionRecordInput("absent");
    const declined = withGps({ requestOutcome: "DENIED" });
    const facts = (i: ReportV2Input) =>
      deriveCanonicalArtifactFacts({ ...i.evidence, tsaTokenPresent: Boolean(i.evidence.tsaTokenBase64) } as never, []);
    expect(facts(declined)).toEqual(facts(without));
    const a = await render(without);
    const b = await render(declined);
    expect(b.cards.map((c) => [c.key, c.status])).toEqual(a.cards.map((c) => [c.key, c.status]));
  });
});

describe("verification package — the canonical location state", () => {
  const meta = (captureLocation: Record<string, unknown> | null) => ({ capturedAtUtc: null, deviceTimeIso: null, captureLocation }) as never;

  it("case metadata states the location state in every package; coordinates only when valid", () => {
    const recorded = buildCaseMetadata(meta({ lat: 52.52, lng: 13.4, accuracyMeters: 9, locationSource: "INTAKE_LINK_GEOLOCATION" }), "ev") as Record<string, unknown>;
    expect(recorded.locationState).toEqual({ state: "RECORDED", label: "Location recorded", detail: null });
    expect(recorded.captureLocation).toMatchObject({ lat: 52.52, lng: 13.4, accuracyMeters: 9 });

    const legacy = buildCaseMetadata(meta(null), "ev") as Record<string, unknown>;
    expect(legacy.locationState).toEqual({ state: "NOT_RECORDED", label: "Location not recorded", detail: null });
    expect(legacy.captureLocation).toBeNull();

    const denied = buildCaseMetadata(meta({ lat: null, lng: null, accuracyMeters: null, requestOutcome: "DENIED" }), "ev") as Record<string, unknown>;
    expect((denied.locationState as { state: string }).state).toBe("NOT_SHARED");

    // Invalid stored coordinates are NEVER shipped.
    const invalid = buildCaseMetadata(meta({ lat: 123, lng: 13.4, accuracyMeters: null }), "ev") as Record<string, unknown>;
    expect((invalid.locationState as { state: string }).state).toBe("INVALID");
    expect(invalid.captureLocation).toBeNull();
    expect(JSON.stringify(invalid)).not.toContain("123");

    const linkage = buildOriginalLinkage([], meta({ lat: 123, lng: 13.4, accuracyMeters: null }));
    expect(linkage.captureLocation).toBeNull();
    expect((linkage.locationState as { state: string }).state).toBe("INVALID");
  });

  it("capture-context.json exists only for valid recorded coordinates, with the canonical label", () => {
    const cc = buildCaptureContext(meta({ lat: 52.52, lng: 13.4, accuracyMeters: 9, locationSource: null }), "ev") as Record<string, unknown>;
    expect(cc.statusLabel).toBe("Location recorded");
    expect(buildCaptureContext(meta({ lat: 123, lng: 13.4 }), "ev")).toBeNull();
    expect(buildCaptureContext(meta({ lat: null, lng: null, requestOutcome: "UNAVAILABLE" }), "ev")).toBeNull();
  });
});

// AUD-37 (2026-10-20) — a fix the device provider reported as MOCKED.
describe("report and package — a mocked location fix", () => {
  const MOCKED = { lat: "52.521", lng: "13.405", accuracyMeters: "20", locationSource: "CLIENT_APP_DEVICE_LOCATION", providerReportedMock: true };

  it("the report states the mock beside the recorded coordinates", async () => {
    const { vm, html } = await render(withGps(MOCKED as never));
    expect(vm.meta.locationState?.providerReportedMock).toBe(true);
    expect(vm.meta.locationState?.tone).toBe("warning");
    expect(vm.meta.captureContext?.statusLabel).toMatch(/^Location recorded · The device marked these coordinates as coming from a mock/);
    expect(text(html)).toContain("mock (simulated) location provider");
  });

  it("an ordinary fix reads exactly as before", async () => {
    const { vm } = await render(withGps({ lat: "52.521", lng: "13.405", accuracyMeters: "20", locationSource: "CLIENT_APP_DEVICE_LOCATION" }));
    expect(vm.meta.captureContext?.statusLabel).toBe("Location recorded");
    expect(vm.meta.locationState?.providerReportedMock).toBe(false);
  });

  it("the package states it in its capture context and case metadata", () => {
    const metadata = { captureLocation: { lat: 52.521, lng: 13.405, accuracyMeters: 20, providerReportedMock: true } } as never;
    const cc = buildCaptureContext(metadata) as { statusLabel?: string } | null;
    expect(cc?.statusLabel ?? "").toMatch(/mock/);
    const cm = buildCaseMetadata(metadata) as unknown as { locationState?: { providerReportedMock?: boolean } };
    const ls = cm.locationState ?? (JSON.parse(JSON.stringify(cm)).captureContext?.locationState as { providerReportedMock?: boolean } | undefined);
    expect(JSON.stringify(cm)).toContain("\"providerReportedMock\":true");
    void ls;
  });
});
