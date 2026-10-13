/**
 * THE EVIDENCE REPORT RESTORED (2026-10-13).
 *
 * Trust Signal Analysis states the evidence record's eight original
 * verification layers — never the expanded matrix's product-mechanics cards;
 * every status is the canonical state (Verified only for a pass); Capture
 * Context prints the stored location (map and coordinates from the same stored
 * values) or says plainly that none was recorded; the OTS card follows the truth
 * model and the PENDING sentence never accompanies an upgraded proof.
 *
 * Fixture: `regressionRecordInput` — shaped like evidence
 * ce465a9e-43c2-4702-87e5-32fcb2dc52fc's report v2.
 */
import { describe, expect, it, vi } from "vitest";

const mapCalls: Array<{ lat: unknown; lng: unknown; accuracyMeters: unknown }> = [];
vi.mock("../src/capture-location-map.js", () => ({
  // The map tile render fails (no network in tests): the textual coordinates
  // must survive on the fallback map.
  renderCaptureLocationMapPreviewDataUrl: vi.fn(async (input: { lat: unknown; lng: unknown; accuracyMeters: unknown }) => {
    mapCalls.push({ lat: input.lat, lng: input.lng, accuracyMeters: input.accuracyMeters });
    return null;
  }),
}));

import { checkRenderedReportText, deriveCanonicalArtifactFacts, RETIRED_REPORT_CARDS } from "@proovra/shared";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { buildHeaderTemplate } from "../src/report-v2/render-pdf.js";
import { buildSignalCards, SIGNAL_CARD_ORDER } from "../src/report-v2/signal-cards.js";
import { getReportCss } from "../src/report-v2/templates/report.css.js";
import { keepEndsTogether } from "../src/report-v2/sections/custody.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { ANCHORED_PROOF, layoutVariant, regressionRecordInput } from "./fixtures/report-layout-variants.js";

const text = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function render(input: ReportV2Input) {
  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  return { vm, html, text: text(html), cards: buildSignalCards(vm) };
}

/** The Trust Signal Analysis grid, by its own element. */
function signalGrid(html: string): string {
  const m = html.match(/<div class="trust-signal-grid" data-evidence-signals="\d+">[\s\S]*?<\/article>\s*<\/div>/);
  return m ? m[0] : "";
}

/** Labels of the expanded matrix that must never be a card again. */
const UNWANTED = [
  "File integrity",
  "Record signature",
  "PROOVRA custody chain",
  "Package signature",
  "Package completeness",
  "Trusted timestamp (RFC 3161)",
  "Storage protection",
  "Account identity",
  "Organization verification",
  "Capture method",
  "Pre-PROOVRA provenance",
  "Public Verify publication",
];

function unwantedCards(html: string): string[] {
  const grid = signalGrid(html);
  return UNWANTED.filter((label) => new RegExp(`trust-signal-label">${label.replace(/[()]/g, "\\$&")}<`).test(grid));
}

describe("the eight evidence signals", () => {
  it("states exactly the original eight, in order, in a two-column grid", async () => {
    const { html, cards } = await render(regressionRecordInput());
    expect(cards.map((c) => c.key)).toEqual(SIGNAL_CARD_ORDER);
    expect(cards.map((c) => c.label)).toEqual([
      "Core integrity",
      "Digital signature",
      "Trusted timestamp",
      "Bitcoin anchoring",
      "Immutable storage",
      "Custody chain",
      "Workspace identity",
      "Verification package",
    ]);
    expect(html).toContain('data-evidence-signals="8"');
    expect(signalGrid(html).match(/<article class="trust-signal-card/g)).toHaveLength(8);
  });

  it("prints none of the expanded matrix's cards — and the check catches one that returns", async () => {
    const { html, text: t } = await render(regressionRecordInput());
    expect(unwantedCards(html)).toEqual([]);
    for (const card of RETIRED_REPORT_CARDS) expect(t).not.toContain(card);
    expect(html).not.toContain("data-verification-matrix");
    // Mutation proof: a card injected back into the grid is found.
    const mutated = html.replace(
      '<div class="trust-signal-grid" data-evidence-signals="8">',
      '<div class="trust-signal-grid" data-evidence-signals="8"><article class="trust-signal-card"><div class="trust-signal-label">Pre-PROOVRA provenance</div></article>',
    );
    expect(unwantedCards(mutated)).toEqual(["Pre-PROOVRA provenance"]);
  });

  it("the regression record: truthful statuses, one concise sentence each", async () => {
    const { cards } = await render(regressionRecordInput());
    const by = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(by.core_integrity).toMatchObject({ status: "Verified", title: "Core integrity verified", mark: "✓" });
    expect(by.signature).toMatchObject({ status: "Verified", title: "Record signature verified", mark: "✓" });
    expect(by.trusted_timestamp).toMatchObject({ status: "Verified", title: "RFC 3161 timestamp verified", mark: "✓" });
    // (2026-10-13) An upgraded proof that executes to a Bitcoin attestation:
    // "Bitcoin anchoring — Anchored", green ✓, never "Verified".
    expect(by.bitcoin_anchoring).toMatchObject({
      label: "Bitcoin anchoring",
      status: "Anchored",
      title: "Bitcoin anchored",
      sentence: "OpenTimestamps proof anchored in Bitcoin.",
      mark: "✓",
      tone: "success",
    });
    expect(by.immutable_storage).toMatchObject({ status: "Verified", title: "Immutable retention verified" });
    expect(by.custody_chain).toMatchObject({ status: "Verified", title: "23 forensic events recorded; hash chain verified" });
    // A personal email account: never an organization, OAuth or a verified person.
    expect(by.identity).toMatchObject({ status: "Recorded", title: "Authenticated email account recorded", mark: "i" });
    expect(by.identity.sentence).toMatch(/personal workspace; the person's real-world identity was not established\.$/);
    // The report never claims its own package verifies.
    expect(by.verification_package).toMatchObject({ status: "Paired", mark: "i" });
    expect(by.verification_package.title).not.toMatch(/verified/i);
    for (const c of cards) expect(c.sentence.split(/(?<=\.)\s/).length, c.key).toBe(1);
  });

  it("Verified is printed only for a passed state", async () => {
    const base = regressionRecordInput();
    const failed = await render({ ...base, evidence: { ...base.evidence, signatureVerified: false } as ReportV2Input["evidence"] });
    expect(failed.cards.find((c) => c.key === "signature")).toMatchObject({ status: "Failed", mark: "!", tone: "danger" });
    const unchecked = await render({
      ...base,
      evidence: { ...base.evidence, signatureVerified: null, custodyChainValid: null, storageImmutable: false, storageObjectLockMode: null } as ReportV2Input["evidence"],
    });
    for (const key of ["signature", "custody_chain", "immutable_storage"] as const) {
      expect(unchecked.cards.find((c) => c.key === key)!.status, key).not.toBe("Verified");
    }
  });

  it("identity and capture wording follow the record: no OAuth, organization or direct-capture claim", async () => {
    const { text: t, html } = await render(regressionRecordInput());
    const grid = text(signalGrid(html));
    expect(grid).not.toMatch(/OAuth|Organization account|organization verified|verified human/i);
    expect(t).not.toMatch(/OAuth-backed|captured by PROOVRA|direct capture/i);
    const boundary = "PROOVRA observed the files from upload onward; creation and editing before upload were not observed.";
    expect(t.split(boundary).length - 1).toBe(1);
  });
});

describe("OpenTimestamps: one canonical state on every card", () => {
  const cases = [
    ["pending", "Pending", "OpenTimestamps proof is awaiting Bitcoin anchoring."],
    ["anchored", "Anchored", "OpenTimestamps proof anchored in Bitcoin."],
    ["anchored_no_txid", "Anchored", "OpenTimestamps proof anchored in Bitcoin."],
    ["budget_failed", "Failed", "Bitcoin anchoring did not complete for this record."],
    ["unavailable", "Unavailable", "The OpenTimestamps proof material cannot currently be read."],
    ["none", "Not requested", "No OpenTimestamps anchoring was requested for this record."],
  ] as const;
  for (const [ots, status, sentence] of cases) {
    it(`${ots} → ${status}`, async () => {
      const { cards, text: t } = await render(layoutVariant({ name: ots, ots }).input);
      const card = cards.find((c) => c.key === "bitcoin_anchoring")!;
      expect(card.status).toBe(status);
      expect(card.sentence).toBe(sentence);
      expect(card.status).not.toBe("Verified");
      // The anchored sentence and the boundary appear only for an anchored proof.
      expect(t.includes("OpenTimestamps proof anchored in Bitcoin"), ots).toBe(status === "Anchored");
      expect(t.includes("PROOVRA does not claim independent canonical-chain verification"), ots).toBe(status === "Anchored");
      // The PENDING sentence appears only for a pending proof — never beside a txid or block.
      expect(t.includes("OpenTimestamps proof is awaiting Bitcoin anchoring."), ots).toBe(ots === "pending");
      expect(t).not.toMatch(/Attestation recorded|independently verified against|chain-verified|proof (?:is )?still being prepared/i);
    });
  }

  it("the regression record's appendix states the derived txid and block, never a PENDING sentence (the v2 defect)", async () => {
    const input = regressionRecordInput();
    const { text: t } = await render(input);
    expect(t).toContain(ANCHORED_PROOF.txid!);
    expect(t).toMatch(/Bitcoin block height[\s\S]{0,80}860000/i);
    expect(t).not.toContain("OpenTimestamps proof is awaiting Bitcoin anchoring.");
    expect(t).not.toMatch(/Anchor Mode/i);
    // Mutation proof: the gate refuses the PENDING sentence beside an anchored proof.
    const e = input.evidence;
    const facts = deriveCanonicalArtifactFacts({ ...e, tsaTokenPresent: Boolean(e.tsaTokenBase64) } as never, []);
    expect(facts.otsState).toBe("ANCHORED");
    const findings = checkRenderedReportText(`${t} OpenTimestamps proof is awaiting Bitcoin anchoring.`, facts, { reportVersion: input.version });
    expect(findings.map((f) => f.check)).toContain("OTS_CONTRADICTION");
  });
});

describe("Capture Context: the stored location, or a plain statement", () => {
  it("location present: map and coordinates come from the same stored values; a failed map keeps the text", async () => {
    mapCalls.length = 0;
    const { vm, html, text: t } = await render(regressionRecordInput("recorded"));
    expect(vm.meta.captureLocationState).toBe("recorded");
    expect(html).toContain('data-capture-location="recorded"');
    // The map renderer received exactly the stored coordinates…
    expect(mapCalls).toEqual([{ lat: "52.521", lng: "13.405", accuracyMeters: "102" }]);
    // …and the printed coordinates are the same values (privacy-rounded at
    // capture to 3 decimals; never padded or re-rounded here).
    expect(html).toMatch(/data-capture-field="Latitude">52\.521</);
    expect(html).toMatch(/data-capture-field="Longitude">13\.405</);
    expect(t).toContain("± 102 meters");
    // The tile map failed: the fallback map is drawn and the text survives.
    expect(html).toMatch(/class="capture-context-map" src="data:image\/svg\+xml/);
    expect(t).toMatch(/Location metadata is device\/browser-reported/);
  });

  it("location absent or permission denied: a plain statement, no map, no invented coordinates", async () => {
    const { vm, html, text: t } = await render(regressionRecordInput("absent"));
    expect(vm.meta.captureLocationState).toBe("absent");
    expect(t).toContain("Location metadata was not recorded for this evidence.");
    expect(html).not.toContain('class="capture-context-map"');
    expect(t).not.toMatch(/Latitude|Longitude/);
    // Mutation proof: a dropped location (stored but not rendered) is caught.
    const recorded = await render(regressionRecordInput("recorded"));
    expect(recorded.text).not.toContain("Location metadata was not recorded for this evidence.");
  });

  it("partial or invalid location: never printed as coordinates", async () => {
    const { vm, html, text: t } = await render(regressionRecordInput("incomplete"));
    expect(vm.meta.captureLocationState).toBe("incomplete");
    expect(t).toContain("Location metadata was recorded incompletely and is not shown.");
    expect(html).not.toContain('class="capture-context-map"');
  });
});

describe("page and pagination", () => {
  it("the paper background is one page-level background; the margins are painted by the header and footer templates", () => {
    const css = getReportCss();
    const last = css.slice(css.lastIndexOf("THE PAGE, THE CARDS AND THE BREAKS"));
    expect(last).toMatch(/html \{[^}]*background-image: url\("data:image\/png;base64,/);
    expect(last).toMatch(/\.report-section,\s*\.report-page \{\s*background: transparent !important;/);
    const header = buildHeaderTemplate("data:image/jpeg;base64,AAAA");
    // Chromium pads the template container; unpadded, the band fills the margin exactly.
    expect(header).toMatch(/#header,#footer\{padding:0 !important;margin:0 !important\}/);
    expect(header).toContain("height:10mm");
  });

  it("the two rows at either end of a list travel together", () => {
    const items = ["a", "b", "c", "d", "e"].map((x) => `<i>${x}</i>`);
    const html = keepEndsTogether(items, "g");
    expect(html).toBe(
      '<div class="g report-keep-together"><i>a</i><i>b</i></div><i>c</i><div class="g report-keep-together"><i>d</i><i>e</i></div>',
    );
  });

  it("the custody timeline is one flowing list, introduced by one sentence — no summary boxes", async () => {
    const { html, text: t } = await render(regressionRecordInput());
    expect(html.match(/Chain of Custody — Continued/g)).toBeNull();
    expect(t).toContain(
      "This PDF shows a curated forensic subset in chain order. The verification package contains the complete custody chain, hashes and access records.",
    );
    expect(t).not.toMatch(/Forensic Events \(Report Snapshot\)|Package Access Snapshot/);
    expect(html.replace(/<style[\s\S]*?<\/style>/g, "")).not.toContain("custody-stat-card");
    expect(t).toContain("This version supersedes report v1. Reissued on request; no verification facts changed.");
    expect(t).not.toContain("Reason recorded");
  });
});
