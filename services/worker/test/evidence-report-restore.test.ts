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

import {
  ACCOUNT_AUTHENTICATION_VERIFIED,
  checkRenderedReportText,
  deriveCanonicalArtifactFacts,
  RETIRED_REPORT_CARDS,
  VERIFICATION_LIMITATION,
} from "@proovra/shared";

import { buildReportViewModel } from "../src/report-v2/build-view-model.js";
import { renderReportHtml } from "../src/report-v2/render-html.js";
import { buildHeaderTemplate } from "../src/report-v2/render-pdf.js";
import { buildSignalCards, SIGNAL_CARD_MARK, SIGNAL_CARD_ORDER } from "../src/report-v2/signal-cards.js";
import { getReportCss } from "../src/report-v2/templates/report.css.js";
import { keepEndsTogether } from "../src/report-v2/sections/custody.js";
import type { ReportV2Input } from "../src/report-v2/types.js";
import { ANCHORED_PROOF, canonicalFactsOf, layoutVariant, regressionRecordInput } from "./fixtures/report-layout-variants.js";
import { chainColumnsFor } from "./fixtures/ots-chain-fixtures.js";

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
      "Account authentication",
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
    // (2026-10-15) An upgraded proof that executes to a Bitcoin attestation
    // only NAMES a block. Not checked against the chain, it is "Bitcoin
    // anchoring — Attestation recorded", neutral, NO ✓, never "Verified"
    // (was: "Anchored", green ✓).
    expect(by.bitcoin_anchoring).toMatchObject({
      label: "Bitcoin anchoring",
      status: "Attestation recorded",
      title: "Bitcoin attestation recorded",
      sentence: "The proof names Bitcoin block 860000; PROOVRA has not checked it against the Bitcoin main chain.",
      tone: "neutral",
    });
    expect(by.bitcoin_anchoring.mark).not.toBe("✓");
    // AUD-014 — the regression record carries the sealing-time Object Lock
    // snapshot only: RECORDED, never "verified" without a read of the object.
    expect(by.immutable_storage).toMatchObject({ status: "Recorded", title: "Immutable retention recorded" });
    expect(by.immutable_storage.mark).not.toBe("✓");
    expect(by.custody_chain).toMatchObject({ status: "Verified", title: "23 forensic events recorded; hash chain verified" });
    // A personal email account whose submission-time snapshot recorded the
    // verified email: the account context is verified — never an
    // organization, OAuth or a verified person.
    expect(by.identity).toMatchObject({
      label: "Account authentication",
      status: "Verified",
      title: "Authenticated email account recorded at submission",
      sentence: "This verifies the account context, not the person's real-world identity.",
      mark: "✓",
      tone: "success",
    });
    // The package of this version is sealed after the report: paired, neutral, never verified.
    expect(by.verification_package).toMatchObject({
      status: "Paired",
      mark: "i",
      tone: "neutral",
      title: "Verification package v2 is produced after this report",
    });
    expect(by.verification_package.title).not.toMatch(/verified/i);
    for (const c of cards) expect(c.sentence.split(/(?<=\.)\s/).length, c.key).toBe(1);
  });

  it("Verified is printed only for a passed state", async () => {
    const base = regressionRecordInput();
    const failed = await render({ ...base, evidence: { ...base.evidence, signatureVerified: false } as ReportV2Input["evidence"] });
    expect(failed.cards.find((c) => c.key === "signature")).toMatchObject({ status: "Failed", mark: "×", tone: "danger" });
    const unchecked = await render({
      ...base,
      evidence: { ...base.evidence, signatureVerified: null, custodyChainValid: null, storageImmutable: false, storageObjectLockMode: null } as ReportV2Input["evidence"],
    });
    for (const key of ["signature", "custody_chain", "immutable_storage"] as const) {
      expect(unchecked.cards.find((c) => c.key === key)!.status, key).not.toBe("Verified");
    }
  });

  it("AUD-014 / AUD-013 — storage is verified only by a confirmed read; a revoked key's signature is never verified", async () => {
    const base = regressionRecordInput();
    const confirmed = await render({
      ...base,
      evidence: { ...base.evidence, storageProtectionVerification: "STORAGE_CONFIRMED" } as ReportV2Input["evidence"],
    });
    expect(confirmed.cards.find((c) => c.key === "immutable_storage")).toMatchObject({ status: "Verified", title: "Immutable retention verified" });
    for (const state of ["RECORDED", "UNAVAILABLE", "FAILED", "CONFIGURED"] as const) {
      const r = await render({ ...base, evidence: { ...base.evidence, storageProtectionVerification: state } as ReportV2Input["evidence"] });
      const card = r.cards.find((c) => c.key === "immutable_storage")!;
      expect(card.status, state).not.toBe("Verified");
      expect(card.title, state).not.toBe("Immutable retention verified");
    }
    const revoked = await render({
      ...base,
      evidence: {
        ...base.evidence,
        signatureVerified: false,
        signatureValidity: { state: "REVOKED_KEY", revokedAtUtc: "2026-10-10T00:00:00.000Z" },
      } as ReportV2Input["evidence"],
    });
    const sigCard = revoked.cards.find((c) => c.key === "signature")!;
    expect(sigCard.status).not.toBe("Verified");
    expect(sigCard.title).toMatch(/revoked/);
    expect(revoked.text).not.toContain("Record signature verified");
    const rotated = await render({
      ...base,
      evidence: { ...base.evidence, signatureValidity: { state: "VALID_SUPERSEDED_KEY", revokedAtUtc: null } } as ReportV2Input["evidence"],
    });
    expect(rotated.cards.find((c) => c.key === "signature")).toMatchObject({ status: "Verified", title: "Record signature verified" });
  });

  it("identity and capture wording follow the record: no OAuth, organization or direct-capture claim", async () => {
    const { text: t, html } = await render(regressionRecordInput());
    const grid = text(signalGrid(html));
    expect(grid).not.toMatch(/OAuth|Organization account|organization verified|verified human/i);
    expect(t).not.toMatch(/OAuth-backed|captured by PROOVRA|direct capture/i);
    // (2026-10-14) The observation-boundary sentence is no longer printed.
    expect(t).not.toContain("PROOVRA observed the files from upload onward; creation and editing before upload were not observed.");
  });
});

describe("OpenTimestamps: one canonical state on every card", () => {
  // 2026-10-15: an upgraded proof never checked against the chain is
  // "Attestation recorded" (was "Anchored"); the pending sentence is the new one.
  const cases = [
    ["pending", "Pending", "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet."],
    ["anchored", "Attestation recorded", "The proof names Bitcoin block 860000; PROOVRA has not checked it against the Bitcoin main chain."],
    ["anchored_no_txid", "Attestation recorded", "The proof names Bitcoin block 860000; PROOVRA has not checked it against the Bitcoin main chain."],
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
      expect(card.mark, ots).not.toBe("✓");
      // The attestation sentence and the boundary appear only for an attested proof.
      expect(t.includes("The proof names Bitcoin block"), ots).toBe(status === "Attestation recorded");
      expect(t.includes("The stored OpenTimestamps proof names a Bitcoin block for the recorded evidence digest."), ots).toBe(status === "Attestation recorded");
      // The PENDING sentence appears only for a pending proof — never beside a txid or block.
      expect(t.includes("Submitted to OpenTimestamps calendars; no Bitcoin attestation yet."), ots).toBe(ots === "pending");
      expect(t).not.toMatch(/independently verified|anchored in Bitcoin|chain-verified|proof (?:is )?still being prepared/i);
    });
  }

  it("the regression record's appendix states the derived txid and block, never a PENDING sentence (the v2 defect)", async () => {
    const input = regressionRecordInput();
    const { text: t } = await render(input);
    expect(t).toContain(ANCHORED_PROOF.txid!);
    expect(t).toMatch(/Bitcoin block height[\s\S]{0,80}860000/i);
    expect(t).not.toContain("Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.");
    expect(t).not.toMatch(/Anchor Mode/i);
    // Mutation proof: the gate refuses the PENDING sentence beside an anchored proof.
    const e = input.evidence;
    const facts = deriveCanonicalArtifactFacts({ ...e, tsaTokenPresent: Boolean(e.tsaTokenBase64) } as never, []);
    expect(facts.otsState).toBe("ANCHORED");
    const findings = checkRenderedReportText(`${t} Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.`, facts, { reportVersion: input.version });
    expect(findings.map((f) => f.check)).toContain("OTS_CONTRADICTION");
    // …and a verified label for an attestation never checked against the chain.
    const overclaim = checkRenderedReportText(`${t} Independently verified against the Bitcoin main chain`, facts, { reportVersion: input.version });
    expect(overclaim.map((f) => f.check)).toContain("OTS_OVERCLAIM");
  });

  it("the positive counterpart: a proof independently verified against the Bitcoin main chain is the only ✓", async () => {
    const base = layoutVariant({ name: "chain verified", ots: "anchored" }).input;
    const input = { ...base, evidence: { ...base.evidence, ...chainColumnsFor(ANCHORED_PROOF) } as ReportV2Input["evidence"] };
    const { cards, text: t } = await render(input);
    const card = cards.find((c) => c.key === "bitcoin_anchoring")!;
    expect(card).toMatchObject({
      status: "Independently verified",
      title: "Independently verified against the Bitcoin main chain",
      mark: "✓",
      tone: "success",
    });
    expect(card.sentence).toMatch(/^Merkle root matches Bitcoin block 860000; 120 confirmations at /);
    expect(t).not.toContain("PROOVRA has not checked it against the Bitcoin main chain");
  });
});

describe("Capture location: the stored location, or nothing at all (2026-10-14)", () => {
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

  it("the recorded location keeps its own heading; the retired Capture Context heading is gone", async () => {
    const { html, text: t } = await render(regressionRecordInput("recorded"));
    const summary = executiveSummary(html);
    expect(summary).toContain('<div class="executive-confirmation-kicker">Capture location</div>');
    expect(text(summary)).not.toMatch(/Capture Context/i);
    expect(t).not.toContain("Location metadata was not recorded for this evidence.");
  });

  for (const location of ["absent", "incomplete"] as const) {
    it(`location ${location}: no map, no heading, no retired statement, no invented coordinates — and the facts are unchanged`, async () => {
      const input = regressionRecordInput(location);
      const before = structuredClone(input);
      const { vm, html, text: t } = await render(input);
      const summary = executiveSummary(html);
      expect(summary).not.toBe("");
      if (location === "absent") {
        // Plain absence is silent: the whole capture-context block is gone.
        expect(summary).not.toContain("data-capture-context");
        expect(summary).not.toContain("capture-context-panel");
      } else {
        // (2026-10-16) Stored coordinates that fail validation are the
        // canonical INVALID location state: ONE row with the canonical label,
        // a warning for the location metadata only — never the coordinates.
        expect(summary).toContain('data-capture-location="invalid"');
        expect(text(summary)).toContain("Location metadata invalid");
        expect(vm.meta.locationState?.state).toBe("INVALID");
        expect(vm.meta.locationState?.tone).toBe("warning");
      }
      expect(text(summary)).not.toMatch(/Capture Context|Capture location/i);
      for (const line of [
        "Location metadata was not recorded for this evidence.",
        "Location metadata was recorded incompletely and is not shown.",
        "PROOVRA observed the files from upload onward; creation and editing before upload were not observed.",
      ]) {
        expect(t, line).not.toContain(line);
      }
      expect(html).not.toContain('class="capture-context-map"');
      expect(t).not.toMatch(/Latitude|Longitude/);
      // …while the record's facts are exactly what they were: the location
      // state the view model resolved, the input it was built from and the
      // canonical facts derived from it.
      expect(vm.meta.captureLocationState).toBe(location);
      expect(input).toEqual(before);
      const facts = (i: ReportV2Input) =>
        deriveCanonicalArtifactFacts({ ...i.evidence, tsaTokenPresent: Boolean(i.evidence.tsaTokenBase64) } as never, []);
      expect(facts(input)).toEqual(facts(before));
    });
  }
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

// ---------------------------------------------------------------------------
// 2026-10-14 — the report's removed sections and its two corrected rows.
// ---------------------------------------------------------------------------

/** One report page section, by its class, up to the next page section. */
function pageSection(html: string, className: string): string {
  const start = html.search(new RegExp(`<section class="report-section[^"]*\\b${className}\\b`));
  if (start < 0) return "";
  const next = html.indexOf('<section class="report-section', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}
function executiveSummary(html: string): string {
  return pageSection(html, "executive-summary-section");
}

const REMOVED_BOUNDARY = [
  "Report boundary",
  "What this report is",
  "A technical record of the preserved evidence's integrity, signature, timestamps, storage and custody.",
  "What it does not establish",
  "Factual truth, authorship, intent, context, completeness, admissibility or evidentiary weight",
  "Previews",
  "Embedded previews are reviewer aids; rely on the preserved originals and the verification package.",
];

describe("Court & Technical Review Index: the Report boundary block is removed", () => {
  for (const [name, input] of [
    ["regression record (heavy)", () => regressionRecordInput()],
    ["single-part upload", () => layoutVariant({ name: "single" }).input],
  ] as const) {
    it(`${name}: no heading, no child block, no element and no style of it`, async () => {
      const { html, text: t } = await render(input());
      const index = pageSection(html, "court-review-index-section");
      expect(index).toContain("Court &amp; Technical Review Index");
      // The page keeps its review map…
      expect(index).toContain("executive-trust-decision-panel");
      // …and nothing of the block.
      for (const phrase of REMOVED_BOUNDARY) expect(text(index), phrase).not.toContain(phrase);
      expect(index).not.toMatch(/data-report-boundary|legal-interpretation/);
      for (const phrase of REMOVED_BOUNDARY.slice(1)) expect(t, phrase).not.toContain(phrase);
      // No dead style of the block survives.
      expect(getReportCss()).not.toMatch(/legal-interpretation|executive-outcome-title/);
      // The cover's single concise limitation is kept, once.
      expect(t.split("Report boundary.").length - 1).toBe(1);
      expect(t).toContain(VERIFICATION_LIMITATION);
    });
  }

  it("the text gate refuses a restored paragraph of a removed section", async () => {
    const input = regressionRecordInput();
    const { text: t } = await render(input);
    const facts = factsOf(input);
    expect(checkRenderedReportText(t, facts, { reportVersion: input.version }).map((f) => f.check)).not.toContain("RETIRED_SECTION");
    for (const restored of [
      "What it does not establish",
      "Embedded previews are reviewer aids; rely on the preserved originals and the verification package.",
      "Location metadata was not recorded for this evidence.",
      "Workspace identity",
    ]) {
      const checks = checkRenderedReportText(`${t} ${restored}`, facts, { reportVersion: input.version }).map((f) => f.check);
      expect(checks, restored).toContain("RETIRED_SECTION");
    }
  });
});

/** The capture-time identity snapshot as the canonical writer records it. */
type Snapshot = NonNullable<ReportV2Input["evidence"]["acquisitionIdentity"]>;
const VERIFIED_EMAIL_PERSONAL: Snapshot = {
  basis: "OBSERVED_AT_CAPTURE",
  recordedAtUtc: "2026-10-08T15:09:52.000Z",
  identityLevel: "VERIFIED_EMAIL",
  authProvider: "EMAIL",
  emailVerified: true,
  workspaceKind: "PERSONAL",
  workspaceName: null,
  organizationName: null,
  organizationVerified: null,
  submittedByEmail: "submitter@example.test",
  submittedByUserId: "user-1",
  actorKind: "ACCOUNT_USER",
  accountRole: "SUBMITTER",
  contributorEmailProvided: null,
};

function withIdentity(identity: Partial<Snapshot> | null, evidence: Partial<ReportV2Input["evidence"]> = {}): ReportV2Input {
  const base = regressionRecordInput();
  return {
    ...base,
    evidence: {
      ...base.evidence,
      ...evidence,
      acquisitionIdentity: identity === null ? null : { ...VERIFIED_EMAIL_PERSONAL, ...identity },
    } as ReportV2Input["evidence"],
  };
}

const factsOf = canonicalFactsOf;

async function identityCardOf(input: ReportV2Input) {
  const r = await render(input);
  return { ...r, card: r.cards.find((c) => c.key === "identity")!, grid: text(signalGrid(r.html)) };
}

describe("Account authentication: exactly what the submission-time snapshot proves", () => {
  it("a verified email account in a personal workspace: green Verified, account context only", async () => {
    const input = withIdentity({});
    const { card, grid, text: t } = await identityCardOf(input);
    expect(card).toEqual({
      key: "identity",
      label: "Account authentication",
      status: "Verified",
      mark: "✓",
      tone: "success",
      title: "Authenticated email account recorded at submission",
      sentence: "This verifies the account context, not the person's real-world identity.",
    });
    // Never a real-world, government, organization or OAuth claim.
    expect(grid).not.toMatch(/OAuth|organi[sz]ation|government|real-world identity (?:was|is) (?:verified|established)|verified (?:person|human)/i);
    expect(t).not.toMatch(/OAuth/);
    expect(grid).not.toContain("Workspace identity");
    // The canonical gate agrees: the facts verify, the text says so.
    expect(checkRenderedReportText(t, factsOf(input), { reportVersion: input.version }).map((f) => f.check)).not.toContain("IDENTITY_STATUS");
  });

  const notVerified: Array<[string, Partial<Snapshot> | null, string, string]> = [
    ["an unverified email", { emailVerified: false, identityLevel: "BASIC_ACCOUNT" }, "Recorded", "Email account recorded at submission"],
    ["an unknown verification state (shared workspace)", { emailVerified: null, identityLevel: "ORGANIZATION_ACCOUNT", workspaceKind: "SHARED" }, "Recorded", "Email account recorded at submission"],
    ["an inconsistent snapshot (EMAIL with an OAuth level)", { identityLevel: "OAUTH_BACKED_IDENTITY" }, "Recorded", "Email account recorded at submission"],
    ["a legacy record's own columns (not capture-bound)", { basis: "RECORDED_ON_RECORD", recordedAtUtc: null }, "Recorded", "Email account recorded on the record"],
    ["an intake contributor", { actorKind: "INTAKE_CONTRIBUTOR", accountRole: "INTAKE_LINK_ISSUER" }, "Recorded", "Submitted through a secure intake link"],
    ["a guest session", { actorKind: "GUEST_SESSION", authProvider: "GUEST", identityLevel: "BASIC_ACCOUNT", emailVerified: false }, "Recorded", "Guest session recorded at submission"],
    ["no snapshot", null, "Not recorded", "Account context not recorded"],
  ];
  for (const [name, identity, status, title] of notVerified) {
    it(`${name}: neutral "${status}", never green`, async () => {
      const input = withIdentity(identity);
      const { card, text: t } = await identityCardOf(input);
      expect(card).toMatchObject({ status, title, mark: "i", tone: "neutral" });
      expect(card.status).not.toBe("Verified");
      expect(t).not.toContain(ACCOUNT_AUTHENTICATION_VERIFIED);
      // Mutation proof: the gate refuses a Verified this snapshot does not support.
      expect(
        checkRenderedReportText(`${t} ${ACCOUNT_AUTHENTICATION_VERIFIED}`, factsOf(input), { reportVersion: input.version }).map((f) => f.check),
        name,
      ).toContain("IDENTITY_STATUS");
    });
  }

  it("the gate refuses a verified account the report does not state as verified", async () => {
    const input = withIdentity({});
    const { text: t } = await render(input);
    const demoted = t.replace(ACCOUNT_AUTHENTICATION_VERIFIED, "Account authentication Recorded");
    expect(checkRenderedReportText(demoted, factsOf(input), { reportVersion: input.version }).map((f) => f.check)).toContain("IDENTITY_STATUS");
  });

  it("a personal workspace is never called an organization account", async () => {
    const { grid, text: t } = await identityCardOf(withIdentity({}));
    expect(grid).not.toMatch(/organi[sz]ation/i);
    expect(t).not.toMatch(/Organization account/i);
  });

  it("an EMAIL provider is never called OAuth — and the gate catches it", async () => {
    const input = withIdentity({});
    const { text: t } = await render(input);
    expect(t).not.toMatch(/OAuth/);
    expect(checkRenderedReportText(`${t} OAuth-backed identity`, factsOf(input), { reportVersion: input.version }).map((f) => f.check)).toContain(
      "IDENTITY_WORDING",
    );
  });

  it("a Google account names Google, never OAuth", async () => {
    const { card } = await identityCardOf(withIdentity({ authProvider: "GOOGLE", identityLevel: "OAUTH_BACKED_IDENTITY" }));
    expect(card).toMatchObject({ status: "Verified", tone: "success", title: "Authenticated Google account recorded at submission" });
    expect(`${card.title} ${card.sentence}`).not.toMatch(/OAuth/);
  });

  it("an organization workspace verified at submission states both, and still not the person", async () => {
    const input = withIdentity(
      { workspaceKind: "SHARED", organizationVerified: true, identityLevel: "VERIFIED_ORGANIZATION", organizationName: "Example Org" },
      { identityLevelSnapshot: "VERIFIED_ORGANIZATION", organizationNameSnapshot: "Example Org", organizationVerifiedSnapshot: true },
    );
    const { card } = await identityCardOf(input);
    expect(card).toMatchObject({ status: "Verified", tone: "success", mark: "✓" });
    expect(card.sentence).toBe(
      "Organization verification was also recorded at submission; this verifies the account and organization context, not the person's real-world identity.",
    );
  });
});

describe("Verification package: the pairing, never a check of a package sealed after the report", () => {
  const packageCard = async (input: ReportV2Input) => (await render(input)).cards.find((c) => c.key === "verification_package")!;
  const withPackage = (version: number | null, reportVersion = 3) => {
    const { input } = layoutVariant({ name: "pkg", version: reportVersion });
    return {
      ...input,
      evidence: {
        ...input.evidence,
        verificationPackageVersion: version,
        verificationPackageGeneratedAtUtc: version == null ? null : "2026-10-01T09:15:00.000Z",
      } as ReportV2Input["evidence"],
    };
  };

  it("this report version's package: Paired, neutral, produced after this report", async () => {
    expect(await packageCard(withPackage(3))).toEqual({
      key: "verification_package",
      label: "Verification package",
      status: "Paired",
      mark: "i",
      tone: "neutral",
      title: "Verification package v3 is produced after this report",
      sentence: "This report cannot verify a package sealed after it; check the package's seal with the commands in its README.",
    });
  });

  it("an earlier version's package is not paired with this report", async () => {
    const card = await packageCard(withPackage(2));
    expect(card).toMatchObject({ status: "Not included", tone: "neutral", mark: "i", title: "No verification package is issued with report v3" });
    expect(card.sentence).toBe("An earlier verification package does not cover this report version.");
  });

  it("no package: not included, neutral — never a warning or a failure look", async () => {
    const card = await packageCard(withPackage(null));
    expect(card).toMatchObject({ status: "Not included", tone: "neutral", mark: "i" });
    expect(card.sentence).toBe("The integrity materials are assessed individually in this report.");
  });

  it("no input makes the report verify its own package; the gate refuses a report that does", async () => {
    for (const v of [3, 2, 4, null]) {
      const card = await packageCard(withPackage(v));
      expect(card.status, String(v)).not.toBe("Verified");
      expect(card.tone, String(v)).not.toBe("success");
      expect(`${card.title} ${card.sentence}`, String(v)).not.toMatch(/\bverified\b|\bcomplete\b/i);
    }
    const input = withPackage(3);
    const { text: t } = await render(input);
    const facts = deriveCanonicalArtifactFacts({ ...input.evidence, tsaTokenPresent: Boolean(input.evidence.tsaTokenBase64) } as never, []);
    expect(checkRenderedReportText(`${t} Verification package Verified`, facts, { reportVersion: 3 }).map((f) => f.check)).toContain(
      "PACKAGE_SELF_ATTESTATION",
    );
  });
});

describe("one visual vocabulary for every card", () => {
  it("the mark follows the tone: ✓ verified, i neutral, ! warning, × failed", async () => {
    const cases = [regressionRecordInput(), layoutVariant({ name: "pending", ots: "pending" }).input, withIdentity(null)];
    for (const input of cases) {
      for (const c of (await render(input)).cards) {
        expect(c.mark, `${c.key} ${c.tone}`).toBe(SIGNAL_CARD_MARK[c.tone]);
        if (c.status === "Verified") expect(c.tone, c.key).toBe("success");
        if (c.tone === "success") expect(["Verified", "Anchored"], c.key).toContain(c.status);
      }
    }
  });
});
