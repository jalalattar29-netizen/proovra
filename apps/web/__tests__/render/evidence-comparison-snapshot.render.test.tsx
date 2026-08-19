/**
 * COMPARISON MODE — `trustDecisionSnapshot` is a structure, not a wall of text.
 *
 * WHAT WAS WRONG IN PRODUCTION
 * ---------------------------------------------------------------------------
 * Every value in a comparison card went through:
 *
 *   function renderValue(value: unknown) {
 *     ...
 *     return JSON.stringify(value);        // <- objects landed here
 *   }
 *
 * so the verification package's `trustDecisionSnapshot` — a nested object with
 * signals, anchoring, limitations and version metadata — rendered as one
 * uninterrupted symbolic string, keyed by raw camelCase field names, with
 * anything nested inside it collapsing to `[object Object]`.
 *
 * These tests drive the REAL panel against a mocked transport. They assert the
 * payload is rendered as labelled facts, bounded sections and lists; that the
 * full payload is still reachable verbatim; and that the comparison marks
 * differences STRUCTURALLY — so a snapshot re-serialised with its keys in a
 * different order is not reported as changed.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

let comparison: unknown = null;
let calls: string[] = [];

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string) => {
    calls.push(path);
    return comparison;
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

import { ComparisonPanel } from "../../app/(app)/evidence/components/ComparisonPanel";

const EVIDENCE_ID = "ev-cmp-1";

/** A fictional trust decision, shaped like the one the worker generates. */
function trustDecision(over: Record<string, unknown> = {}) {
  return {
    verdictLabel: "Technically verified",
    scoreLabel: "82 / 100",
    score: 82,
    maxScore: 100,
    confidenceLabel: "High",
    relianceLevel: "supporting",
    generatedAtUtc: "2026-08-11T09:14:22.000Z",
    passedSignals: 6,
    degradedSignals: 1,
    failedSignals: 0,
    reviewerActionRequired: false,
    primaryReason: null,
    anchoring: {
      anchored: true,
      provider: "opentimestamps",
      txId: "5f2c9ab41d6e47c8b0a3e7159d2c8841",
      anchoredAtUtc: "2026-08-11T09:20:03.000Z",
      confirmedAtUtc: null,
    },
    limitations: [
      "Comparison uses recorded metadata only.",
      "Anchoring confirmation was still pending when this snapshot was taken.",
    ],
    signals: [
      {
        key: "hash_integrity",
        label: "Hash integrity",
        status: "passed",
        points: 25,
        maxPoints: 25,
      },
      {
        key: "anchor_confirmation",
        label: "Anchor confirmation",
        status: "partial",
        points: 6,
        maxPoints: 15,
      },
    ],
    version: { schemaVersion: 3, generator: "trust-decision@2.4.1" },
    ...over,
  };
}

function payload(reportSnapshot: unknown, packageSnapshot: unknown) {
  return {
    evidenceId: EVIDENCE_ID,
    original: {
      mimeType: "image/jpeg",
      sizeBytes: "184320",
      originalFileName: "site-photo.jpg",
      displayFileName: null,
      fileSha256: "9c1185a5c5e9fc54612808977ee8f548b2258d31",
      fingerprintHash: null,
    },
    previewRepresentation: { mimeType: "image/jpeg", primaryKind: "image", previewable: true },
    reportArtifact: {
      version: 3,
      generatedAtUtc: "2026-08-11T09:15:00.000Z",
      verificationPackageVersion: 2,
      trustDecisionSnapshot: reportSnapshot,
    },
    verificationPackage: {
      version: 2,
      generatedAtUtc: "2026-08-11T09:22:00.000Z",
      packageType: "STANDARD",
      manifestDigest: null,
      trustDecisionSnapshot: packageSnapshot,
    },
    contentItems: [],
    mismatchFlags: {
      originalVsRecordedHash: null,
      originalVsVerificationPackageManifest: null,
      previewVsOriginal: null,
    },
  };
}

/** Opens the panel's disclosure so the fetch runs, then expands every card. */
async function mountOpen() {
  const view = render(<ComparisonPanel evidenceId={EVIDENCE_ID} />);
  const outer = view.container.querySelector("details") as HTMLDetailsElement;
  await act(async () => {
    outer.open = true;
    outer.dispatchEvent(new Event("toggle"));
  });
  await waitFor(() =>
    expect(view.container.querySelector("[data-comparison-card]")).not.toBeNull(),
  );
  await act(async () => {
    for (const details of Array.from(
      view.container.querySelectorAll("details[data-comparison-technical-details]"),
    )) {
      (details as HTMLDetailsElement).open = true;
      details.dispatchEvent(new Event("toggle"));
    }
  });
  return view;
}

const packageCard = () =>
  document.querySelector('[data-comparison-card="Verification package"]') as HTMLElement;

beforeEach(() => {
  calls = [];
  comparison = payload(trustDecision(), trustDecision());
});

describe("Comparison mode — structured snapshot rendering", () => {
  it("renders the snapshot as labelled facts, not a symbolic dump", async () => {
    await mountOpen();

    const snapshot = packageCard().querySelector(
      '[data-structured-snapshot="Verification package"]',
    ) as HTMLElement;
    expect(snapshot, "the package card renders through the structured renderer").not.toBeNull();

    const structured = snapshot.querySelector(".snap-body") as HTMLElement;
    const text = structured.textContent ?? "";

    // The defect itself: no stringified object, at any depth.
    expect(text).not.toMatch(/\[object Object\]/);
    expect(text).not.toMatch(/\{"/);

    // Readable labels, not raw camelCase field names.
    expect(text).toMatch(/Passed signals/);
    expect(text).toMatch(/Reliance level/);
    expect(text).not.toMatch(/passedSignals/);
    expect(text).not.toMatch(/relianceLevel/);
  });

  it("gives nested objects bounded sections and arrays structured lists", async () => {
    await mountOpen();
    const snapshot = packageCard().querySelector(".snap-body") as HTMLElement;

    const titles = Array.from(snapshot.querySelectorAll(".snap-section__title")).map(
      (node) => node.textContent ?? "",
    );
    expect(titles.some((t) => t.includes("Anchoring"))).toBe(true);
    expect(titles.some((t) => t.includes("Signals") && t.includes("2 entries"))).toBe(true);
    expect(titles.some((t) => t.includes("Limitations") && t.includes("2 entries"))).toBe(true);

    // Every array entry is a list item, and object entries keep their labels.
    const listItems = snapshot.querySelectorAll(".snap-list__item");
    expect(listItems.length).toBe(4);
    expect(snapshot.textContent).toMatch(/Hash integrity/);
    expect(snapshot.textContent).toMatch(/Max points/);
  });

  it("states booleans as Yes/No and missing values as Not recorded", async () => {
    await mountOpen();
    const text = (packageCard().querySelector(".snap-body") as HTMLElement).textContent ?? "";

    // `anchored: true` and `reviewerActionRequired: false`
    expect(text).toMatch(/Yes/);
    expect(text).toMatch(/No/);
    // `confirmedAtUtc: null` and `primaryReason: null` — stated, never invented.
    expect(text).toMatch(/Not recorded/);
    expect(text).not.toMatch(/\bnull\b/);
    expect(text).not.toMatch(/undefined/);
  });

  it("keeps hashes, identifiers and timestamps left-to-right", async () => {
    await mountOpen();
    const ltr = packageCard().querySelectorAll('.snap-fact__value[data-snap-ltr="true"]');
    expect(ltr.length).toBeGreaterThan(0);
    for (const node of Array.from(ltr)) {
      expect(node.getAttribute("dir")).toBe("ltr");
    }
  });

  it("keeps the complete payload verbatim behind View raw snapshot", async () => {
    await mountOpen();
    const raw = packageCard().querySelector("[data-snapshot-raw]") as HTMLDetailsElement;
    expect(raw).not.toBeNull();
    // Collapsed by default — the raw payload is available, not the default view.
    expect(raw.open).toBe(false);
    expect(raw.querySelector("summary")!.textContent).toMatch(/View raw snapshot/);
    expect(raw.querySelector("[data-snapshot-copy]")!.textContent).toMatch(/Copy JSON/);

    const pre = raw.querySelector("pre")!;
    // Formatted, not minified, and complete.
    expect(pre.textContent).toMatch(/\n\s+"verdictLabel": "Technically verified"/);
    expect(pre.textContent).toMatch(/"generator": "trust-decision@2\.4\.1"/);
    expect(pre.getAttribute("dir")).toBe("ltr");
  });
});

describe("Comparison mode — structural difference marking", () => {
  it("marks a changed value, an added field and a removed field", async () => {
    const report = trustDecision({ score: 74, scoreLabel: "74 / 100" });
    // The package recorded a field the report did not, and dropped one the
    // report had.
    const pkg = trustDecision({ reviewerNote: "Anchor confirmed after generation." }) as Record<
      string,
      unknown
    >;
    delete (pkg as { confidenceLabel?: unknown }).confidenceLabel;
    comparison = payload(report, pkg);

    await mountOpen();
    const card = packageCard();

    const marks = Array.from(card.querySelectorAll("[data-snap-mark]")).map((node) => ({
      kind: node.getAttribute("data-snap-mark"),
      row: node.closest(".snap-fact")?.textContent ?? node.textContent ?? "",
    }));

    expect(marks.some((m) => m.kind === "changed" && /Score/.test(m.row))).toBe(true);
    expect(marks.some((m) => m.kind === "added" && /Reviewer note/.test(m.row))).toBe(true);
    expect(marks.some((m) => m.kind === "removed" && /Confidence label/.test(m.row))).toBe(true);

    // The mark is named in words, never colour alone.
    for (const node of Array.from(card.querySelectorAll("[data-snap-mark]"))) {
      expect((node.textContent ?? "").trim().length).toBeGreaterThan(0);
    }

    // And the legend says what the marks mean.
    expect(card.querySelector("[data-snapshot-legend]")!.textContent).toMatch(
      /differ from the report artifact/i,
    );
  });

  it("does not mark a field as changed because the keys arrived in another order", async () => {
    const report = trustDecision();
    // Same facts, different key order — at the top level AND inside the nested
    // objects. `version` and `anchoring` are rebuilt with their keys reversed,
    // and every remaining key is re-inserted after them.
    const { version: _v, anchoring: _a, ...rest } = trustDecision();
    const reordered = {
      version: { generator: "trust-decision@2.4.1", schemaVersion: 3 },
      anchoring: {
        confirmedAtUtc: null,
        anchoredAtUtc: "2026-08-11T09:20:03.000Z",
        txId: "5f2c9ab41d6e47c8b0a3e7159d2c8841",
        provider: "opentimestamps",
        anchored: true,
      },
      ...rest,
    };
    // The fixture must actually differ in ORDER while matching in CONTENT.
    expect(Object.keys(reordered)).not.toEqual(Object.keys(report));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(report));
    comparison = payload(report, reordered);

    await mountOpen();
    const marks = packageCard().querySelectorAll("[data-snap-mark]");
    expect(
      Array.from(marks).map((n) => n.closest(".snap-fact")?.textContent ?? n.textContent),
      "identical facts in a different order are not a difference",
    ).toEqual([]);
  });

  it("marks nothing when the report recorded no trust decision to compare", async () => {
    comparison = payload(null, trustDecision());
    await mountOpen();
    expect(packageCard().querySelectorAll("[data-snap-mark]").length).toBe(0);
    expect(packageCard().querySelector("[data-snapshot-legend]")).toBeNull();
  });
});

describe("Comparison mode — existing behaviour is preserved", () => {
  it("fetches only once opened, and keeps its limitation statement", async () => {
    render(<ComparisonPanel evidenceId={EVIDENCE_ID} />);
    expect(calls.length, "a closed panel must not call the API").toBe(0);

    await mountOpen();
    expect(calls).toEqual([`/v1/evidence/${EVIDENCE_ID}/comparison`]);
    expect(document.body.textContent).toMatch(
      /does not establish factual truth, authorship, or legal outcome/i,
    );
  });

  it("still hides the Mismatch flags card while every flag is null", async () => {
    await mountOpen();
    expect(screen.queryByText("Mismatch flags")).toBeNull();
  });

  it("shows the Mismatch flags card once the backend populates one", async () => {
    const base = payload(trustDecision(), trustDecision());
    comparison = {
      ...base,
      mismatchFlags: { ...base.mismatchFlags, previewVsOriginal: "MIME type differs" },
    };
    await mountOpen();
    expect(screen.queryByText("Mismatch flags")).not.toBeNull();
    expect(document.body.textContent).toMatch(/MIME type differs/);
  });
});
