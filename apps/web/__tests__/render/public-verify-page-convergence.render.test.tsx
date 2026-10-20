/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the REAL Public Verify page,
 * mounted with real anonymous answers of the converged API:
 *
 *   fixtures/public-verify-verification-only.json            a six-part VERIFICATION_ONLY record
 *   fixtures/public-verify-verification-only-report-v1.json  the same with report v1 issued on a legacy
 *                                                            snapshot; OTS chain-verified after; reference
 *                                                            issued after the report
 *   fixtures/public-verify-content-preview.json              CONTENT_PREVIEW, no recorded location
 *   fixtures/public-verify-content-preview-location.json     CONTENT_PREVIEW with the owner's location decision
 *
 * Characterization (failed before the convergence):
 *   - the package card dropped the server's sealCheck and read "Complete"
 *     for a legacy seal the matrix states "Not checked";
 *   - a pvr_ value was labelled "Evidence ID";
 *   - a multipart record was described by its first part's MIME type;
 *   - the signal summary carried a green "REPORTED" pill;
 *   - "Report issued" and "Stored file last rechecked" were not stated apart;
 *   - identity that exists but is withheld was not stated as withheld;
 *   - the matrix was repeated as "Supporting Technical Signals";
 *   - no print stylesheet kept the package-integrity labels from overlapping.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Loaded once at collection (vi.mock above is hoisted, so the mocks apply).
// It was imported inside mountPage, so the FIRST test paid the cold transform
// of the whole Verify page and, under a full parallel run, timed out (5.19 s
// against the 5 s test budget) while passing alone (2026-10-20).
import VerifyPage from "../../app/verify/[token]/page";
import { ToastProvider } from "../../components/ui";

type Json = Record<string, unknown>;
const load = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as Json;

const verificationOnly = load("public-verify-verification-only.json");
const reportV1 = load("public-verify-verification-only-report-v1.json");
const contentPreview = load("public-verify-content-preview.json");
const contentPreviewLocation = load("public-verify-content-preview-location.json");
const REF = (verificationOnly.recordFacts as { verificationReference: string }).verificationReference;

let answer: () => unknown = () => verificationOnly;

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: REF }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/verify/${REF}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../app/providers", () => ({
  useLocale: () => ({ locale: "en", setLocale: () => undefined, t: (k: string) => k }),
  useOptionalLocale: () => "en",
}));
vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(async () => answer()),
}));
vi.mock("../../lib/sentry", () => ({ captureException: vi.fn() }));

async function mountPage() {
  const utils = render(
    <ToastProvider>
      <VerifyPage />
    </ToastProvider>,
  );
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return utils;
}

function openTab(name: RegExp) {
  const tab = screen.queryAllByRole("tab").find((t) => name.test(t.textContent ?? ""));
  expect(tab, `tab ${name}`).toBeTruthy();
  fireEvent.click(tab!);
}

const text = () => document.body.textContent ?? "";

/**
 * A package issued with a legacy (unbound) seal: the server states the seal
 * "Not checked" with the LEGACY_SEAL qualifier — on the package card AND on
 * the matrix rows (one authority: resolvePackageSealCheck).
 */
function withLegacyUnboundPackage(source: Json): Json {
  const clone = structuredClone(source) as Json & {
    verificationMatrix: { rows: Array<Record<string, unknown>> };
  };
  const sealStatement = "Sealed — seal not checked against a published PROOVRA key.";
  clone.verificationPackageIntegrity = {
    available: true,
    version: 2,
    generatedAtUtc: "2026-10-18T14:20:00.000Z",
    packageType: "VERIFICATION_PACKAGE",
    packageFormatVersion: 5,
    sealed: true,
    manifestPresent: true,
    signedManifestPresent: true,
    manifestDigestPresent: true,
    checksumIndexPresent: true,
    auditExportIncluded: true,
    custodyExportIncluded: true,
    accessExportIncluded: true,
    sealCheck: "NOT_CHECKED",
    sealStatement,
    sealQualifiers: ["LEGACY_SEAL"],
    completenessCheck: "NOT_CHECKED",
    completenessStatement: "Package contents not checked against a verified seal.",
  };
  clone.verificationMatrix.rows = clone.verificationMatrix.rows.map((row) =>
    row.key === "package_signature"
      ? { ...row, status: "NOT_CHECKED", statement: sealStatement, qualifiers: ["LEGACY_SEAL"] }
      : row.key === "package_completeness"
        ? { ...row, status: "NOT_CHECKED", statement: "Package contents not checked against a verified seal." }
        : row,
  );
  return clone;
}

describe("Public Verify page — pvr_ VERIFICATION_ONLY record", () => {
  beforeEach(() => {
    answer = () => verificationOnly;
  });

  it("P1 the package card states the server's seal check, exactly as the matrix does", async () => {
    answer = () => withLegacyUnboundPackage(verificationOnly);
    await mountPage();
    // The matrix row, on the page before any tab is opened.
    const sealRow = screen.getByTestId("verify-matrix-row-package_signature");
    expect(sealRow.getAttribute("data-status")).toBe("NOT_CHECKED");
    expect(sealRow.textContent).toContain("Sealed — seal not checked against a published PROOVRA key.");
    openTab(/package/i);
    const card = screen.getByTestId("verify-package-integrity");
    expect(card.textContent).toContain("Sealed — seal not checked against a published PROOVRA key.");
    expect(within(card).getByTestId("verify-package-seal-status").getAttribute("data-status")).toBe("NOT_CHECKED");
    expect(within(card).getByTestId("verify-package-seal-status").textContent).toContain("Not checked");
    expect(card.textContent).toContain("Legacy seal");
    expect(card.hasAttribute("data-print-avoid-break")).toBe(true);
    expect(text()).not.toContain("Package Integrity Complete");
    expect(text()).not.toContain("Independent Review Enabled");
  });

  it("P2 a pvr_ value is a Verification reference — never an 'Evidence ID', never a token pill", async () => {
    await mountPage();
    expect(text()).not.toMatch(/Evidence ID/i);
    expect(text()).toContain("Verification reference");
    expect(text()).toContain(REF);
    expect(text()).not.toMatch(/Token:\s*pv[rs]_/);
    expect(document.querySelector("[data-verify-canonical-reference]")?.textContent).toBe(REF);
  });

  it("P3 a multipart record says 'Multipart package · 6 items', not its first part's MIME type", async () => {
    await mountPage();
    expect(text()).toContain("Multipart package · 6 items");
    expect(text()).not.toMatch(/File Type\s*text\/plain/);
  });

  it("P4 the signal summary carries no REPORTED pill", async () => {
    const reported = structuredClone(verificationOnly) as { overview: Record<string, unknown> };
    reported.overview.recordStatus = "REPORTED";
    reported.overview.recordLifecycleStatus = "REPORTED";
    answer = () => reported;
    await mountPage();
    expect(screen.queryAllByText(/^REPORTED$/)).toHaveLength(0);
  });

  it("P5 report issuance and the stored-file recheck are stated apart", async () => {
    await mountPage();
    expect(screen.getByTestId("verify-report-issued").textContent).toMatch(/Report issued\s*No report issued/);
    expect(screen.getByTestId("verify-stored-file-rechecked").textContent).toContain("Stored file last rechecked");
    expect(screen.getByTestId("verify-stored-file-rechecked").textContent).toContain("Verified");
  });

  it("P6 withheld identity says it is withheld — never 'Not recorded'", async () => {
    await mountPage();
    const identity = document.querySelector("[data-verify-identity]") as HTMLElement;
    expect(identity.getAttribute("data-verify-identity")).toBe("WITHHELD");
    expect(identity.textContent).toContain("Withheld by the record’s disclosure policy");
    expect(identity.textContent).not.toContain("Not recorded");
    // Capture-time identity is stated separately, as the API sent it.
    expect(identity.textContent).toContain("Identity at capture");
    expect(identity.textContent).toContain("Email account (email address not verified)");
  });

  it("P7 the matrix is stated once: no 'Supporting Technical Signals' repetition, one legal boundary", async () => {
    await mountPage();
    expect(text()).not.toContain("Supporting Technical Signals");
    const boundaries = text().match(/does not by itself establish authorship/g) ?? [];
    expect(boundaries.length).toBeLessThanOrEqual(1);
    expect(document.querySelectorAll("[data-verify-legal-boundary]")).toHaveLength(1);
    // ONE Bitcoin/OpenTimestamps card.
    expect(screen.getAllByTestId("verify-ots-card")).toHaveLength(1);
  });

  it("P8 a print stylesheet keeps package-integrity labels from overlapping", async () => {
    await mountPage();
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/\[data-print-avoid-break\]/);
    expect(css).toMatch(/break-inside:\s*avoid/);
  });

  it("P9 no 'no mismatches' sentence while a danger reason is listed", async () => {
    const withDanger = structuredClone(verificationOnly) as Json;
    withDanger.trustDecisionConsistency = {
      source: "REPORT_SNAPSHOT",
      consistentWithSnapshot: false,
      tone: "danger",
      accessOnly: false,
      integrityCritical: true,
      reasons: [{ code: "CORE_INTEGRITY_SIGNALS_CHANGED", label: "File integrity failed since issuance", detail: "x", tone: "danger", integrityCritical: true }],
    };
    answer = () => withDanger;
    await mountPage();
    expect(text()).not.toMatch(/No explicit digest, signature, custody, timestamp, or OTS mismatches/);
    expect(text()).not.toMatch(/Mismatch review:\s*none/i);
    expect(text()).not.toMatch(/No integrity mismatch detected/i);
    const reason = document.querySelector("[data-reason-code='CORE_INTEGRITY_SIGNALS_CHANGED']") as HTMLElement;
    expect(reason.getAttribute("data-tone")).toBe("danger");
    expect(reason.textContent).toContain("File integrity failed since issuance");
  });

  it("states the disclosure mode and replaces content review with a safe item inventory — no downloads", async () => {
    await mountPage();
    const notice = document.querySelector("[data-verify-disclosure='VERIFICATION_ONLY']") as HTMLElement;
    expect(notice.textContent).toContain("Verification only");
    expect(notice.querySelector("[data-verify-disclosure-notice]")?.textContent).toContain("Withheld by the record’s disclosure policy");
    const inventory = screen.getByTestId("verify-item-inventory");
    const rows = inventory.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(6);
    expect(rows[0]!.textContent).toContain("Item 1");
    expect(rows[0]!.textContent).toContain("Text");
    expect(rows[0]!.textContent).toContain("44 B");
    expect(within(inventory).getAllByRole("button", { name: /Copy SHA-256/ })).toHaveLength(6);
    expect(screen.queryByTestId("verify-content-preview")).toBeNull();
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(text()).not.toMatch(/Download evidence|Open preserved evidence/);
  });

  it("the technical tabs are an accessible tablist (roles, aria-selected, keyboard)", async () => {
    await mountPage();
    const tablist = screen.getByRole("tablist");
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Record", "Integrity", "Package Integrity", "Forensic Chain", "Access Activity"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(within(tablist).getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(within(tablist).getAllByRole("tab")[1]!, { key: "End" });
    expect(within(tablist).getAllByRole("tab")[4]!.getAttribute("aria-selected")).toBe("true");
  });

  it("separates the forensic chain (grouped, paginated) from aggregated access activity", async () => {
    // A long chain: 45 evidence events page by 20.
    const long = structuredClone(verificationOnly) as Json & { custodyLifecycle: { forensicEvents: Array<Record<string, unknown>> } };
    const base = long.custodyLifecycle.forensicEvents[0]!;
    long.custodyLifecycle.forensicEvents = Array.from({ length: 45 }, (_, i) => ({
      ...base,
      sequence: i + 1,
      eventType: i === 44 ? "VERIFICATION_REFERENCE_ISSUED" : "UPLOAD_COMPLETED",
      payloadSummary: `event ${i + 1}`,
    }));
    answer = () => long;
    await mountPage();
    openTab(/forensic chain/i);
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain("Forensic chain — evidence events");
    expect(panel.textContent).toContain("Forensic chain — administrative events");
    expect(panel.textContent).toContain("Page 1 of 3 (44 events)");
    expect(panel.textContent).toContain("event 20");
    expect(panel.textContent).not.toContain("event 21");
    fireEvent.click(within(panel).getAllByRole("button", { name: "Next" })[0]!);
    expect(screen.getByRole("tabpanel").textContent).toContain("event 21");
    openTab(/access activity/i);
    const access = screen.getByTestId("verify-access-activity");
    expect(within(access).getByTestId("verify-access-count").textContent).toContain("4");
    expect(within(access).getByTestId("verify-access-latest").textContent).not.toContain("Not recorded");
  });

  it("copies the canonical /verify/<reference> URL, not the address the visitor holds", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mountPage();
    fireEvent.click(document.querySelector("[data-verify-copy-link]")!);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/verify/${REF}`);
  });

  it("a response without a matrix says 'Verification matrix unavailable' — no client rebuild", async () => {
    const noMatrix = structuredClone(verificationOnly) as Json;
    delete noMatrix.verificationMatrix;
    answer = () => noMatrix;
    await mountPage();
    expect(screen.getByTestId("verify-matrix-unavailable").textContent).toBe("Verification matrix unavailable");
    expect(document.querySelectorAll("[data-testid^='verify-matrix-row-']")).toHaveLength(0);
  });

  it("375 px: no fixed width wider than the phone viewport, every grid collapses to one column", async () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await mountPage();
    const PHONE_CONTENT = 375 - 2 * 16;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[style]"))) {
      for (const prop of ["width", "minWidth"] as const) {
        const m = /^(\d+(?:\.\d+)?)px$/.exec(el.style[prop]);
        if (m && Number(m[1]) > PHONE_CONTENT) offenders.push(`${el.tagName} ${prop}=${el.style[prop]}`);
      }
      const grid = el.style.gridTemplateColumns;
      const fixedMin = /minmax\((\d+)px/.exec(grid);
      if (fixedMin && Number(fixedMin[1]) > 200) offenders.push(`${el.tagName} grid=${grid}`);
      if (el.style.whiteSpace === "nowrap" && (el.textContent ?? "").length > 40) offenders.push(`${el.tagName} nowrap "${el.textContent}"`);
    }
    expect(offenders).toEqual([]);
    // Long hashes and references wrap (or truncate with a copy action).
    for (const code of Array.from(document.querySelectorAll<HTMLElement>("code"))) {
      expect(code.style.overflowWrap || code.style.wordBreak).toBeTruthy();
    }
  });
});

describe("Public Verify page — report v1 issued on a legacy snapshot", () => {
  beforeEach(() => {
    answer = () => reportV1;
  });

  it("states the OTS advance once, the at-issue statement, and no danger reason", async () => {
    await mountPage();
    const ots = screen.getByTestId("verify-ots-card");
    expect(ots.querySelector("[data-verify-ots-now]")?.textContent).toContain("Independently verified");
    expect(ots.querySelector("[data-verify-ots-at-issue]")?.textContent).toContain("Attestation recorded");
    expect(ots.querySelector("[data-verify-ots-advance='CHAIN_VERIFIED_SINCE_ISSUE']")?.textContent).toContain(
      "Independently verified since the report was issued",
    );
    expect(text().match(/Independently verified since the report was issued/g)).toHaveLength(1);
    // VERIFICATION_ADVANCED is informational — never a danger reason.
    const reason = document.querySelector("[data-reason-code='VERIFICATION_ADVANCED']") as HTMLElement;
    expect(reason.getAttribute("data-tone")).toBe("info");
    expect(document.querySelectorAll("[data-tone='danger']")).toHaveLength(0);
    expect(document.querySelector("[data-verify-consistency]")?.getAttribute("data-verify-consistency")).toBe("info");
  });

  it("states report v1 as an issue-time snapshot; the later reference issuance is administrative; no TSA annotation without the qualifier", async () => {
    await mountPage();
    expect(screen.getByTestId("verify-report-issued").textContent).toMatch(/\(v1\)/);
    const history = screen.getByTestId("verify-artifact-history");
    const v1 = history.querySelector("[data-verify-artifact='report-v1']") as HTMLElement;
    expect(v1.textContent).toContain("Report v1");
    expect(v1.textContent).toContain("Stated at issue — Bitcoin anchoring: Attestation recorded.");
    expect(v1.textContent).toContain("checked against the Bitcoin main chain after this artifact was issued");
    expect(v1.textContent).toContain("The verification reference was issued after this artifact. That is an administrative event");
    // The tsa_token row carries no VALIDATED_FROM_RETAINED_TOKEN qualifier here.
    expect(text()).not.toMatch(/validated from the timestamp token retained at intake/i);
    expect(document.querySelector("[data-verify-tsa-validated-at]")).toBeNull();
  });

  it("annotates a timestamp validated later from the retained token (when the row carries the qualifier)", async () => {
    const validated = structuredClone(reportV1) as Json & { verificationMatrix: { rows: Array<Record<string, unknown>> } };
    validated.verificationMatrix.rows = validated.verificationMatrix.rows.map((row) =>
      row.key === "tsa_token"
        ? {
            ...row,
            status: "VERIFIED",
            statusLabel: "Verified — validated from the timestamp token retained at intake",
            qualifiers: ["VALIDATED_FROM_RETAINED_TOKEN"],
            measuredAtUtc: "2026-10-18T15:00:00.000Z",
          }
        : row,
    );
    answer = () => validated;
    await mountPage();
    const row = screen.getByTestId("verify-matrix-row-tsa_token");
    expect(row.textContent).toContain("Verified — validated from the timestamp token retained at intake");
    expect(row.querySelector("[data-verify-tsa-validated-at]")).toBeTruthy();
    const v1 = document.querySelector("[data-verify-artifact='report-v1']") as HTMLElement;
    // AUD-48 (2026-10-20) — said only because the report's OWN stored decision
    // did not state the timestamp as verified (read, never inferred from times).
    expect(v1.textContent).toMatch(/Report v1 states the trusted timestamp as not validated; it was validated on /);
  });

  it("AUD-48: no 'stated as not validated' note when the issued report itself stated the timestamp as verified", async () => {
    const validated = structuredClone(reportV1) as Json & {
      verificationMatrix: { rows: Array<Record<string, unknown>> };
      verificationSnapshot: { trustDecisionSnapshot?: { signals?: Array<Record<string, unknown>> } };
    };
    validated.verificationMatrix.rows = validated.verificationMatrix.rows.map((row) =>
      row.key === "tsa_token" ? { ...row, status: "VERIFIED", qualifiers: ["VALIDATED_FROM_RETAINED_TOKEN"], measuredAtUtc: "2026-10-18T15:00:00.000Z" } : row,
    );
    const signals = validated.verificationSnapshot.trustDecisionSnapshot?.signals ?? [];
    validated.verificationSnapshot.trustDecisionSnapshot = {
      ...(validated.verificationSnapshot.trustDecisionSnapshot ?? {}),
      signals: [...signals.filter((x) => x.key !== "trusted_timestamp"), { key: "trusted_timestamp", label: "Trusted timestamp", state: "PASSED", status: "passed" }],
    };
    answer = () => validated;
    await mountPage();
    const v1 = document.querySelector("[data-verify-artifact='report-v1']") as HTMLElement;
    expect(v1.textContent).not.toMatch(/states the trusted timestamp as not validated/);
  });

  it("AUD-48: every issued report and package is listed, and a regression since issue is noted beside the snapshot", async () => {
    const withHistory = structuredClone(reportV1) as Json & { versioning: Record<string, unknown>; trustDecisionConsistency: Record<string, unknown> };
    withHistory.versioning = {
      ...withHistory.versioning,
      history: [
        { kind: "report", version: 1, reportVersion: 1, issuedAtUtc: "2026-10-18T14:20:00.000Z" },
        { kind: "package", version: 1, reportVersion: 1, issuedAtUtc: "2026-10-18T14:21:00.000Z" },
        { kind: "report", version: 2, reportVersion: 2, issuedAtUtc: "2026-10-19T09:00:00.000Z" },
      ],
    };
    withHistory.trustDecisionConsistency = {
      ...(withHistory.trustDecisionConsistency ?? {}),
      reasons: [{ code: "VERIFICATION_REGRESSED", label: "Reads worse than when the artifact was issued: Chain of custody", detail: "x", tone: "warning", integrityCritical: false }],
    };
    answer = () => withHistory;
    await mountPage();
    const history = screen.getByTestId("verify-artifact-history");
    expect(history.querySelector("[data-verify-artifact='report-v1']")).toBeTruthy();
    expect(history.querySelector("[data-verify-artifact='package-v1']")).toBeTruthy();
    expect(history.querySelector("[data-verify-artifact='report-v2']")).toBeTruthy();
    const v1 = history.querySelector("[data-verify-artifact='report-v1']") as HTMLElement;
    expect(v1.textContent).toContain("Reads worse than when the artifact was issued: Chain of custody.");
  });

  it("AUD-48: printing mounts every technical tab, not only the open one", async () => {
    await mountPage();
    const panels = () => Array.from(document.querySelectorAll("[role='tabpanel'][id^='verify-tabpanel-']")).map((p) => p.id);
    expect(panels()).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(panels().sort()).toEqual(
      ["verify-tabpanel-access", "verify-tabpanel-full-custody", "verify-tabpanel-integrity", "verify-tabpanel-package", "verify-tabpanel-record"].sort(),
    );
    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(panels()).toHaveLength(1);
  });

  it("aggregates access activity: a count and its latest occurrence, no list", async () => {
    await mountPage();
    openTab(/access activity/i);
    const access = screen.getByTestId("verify-access-activity");
    expect(within(access).getByTestId("verify-access-count").textContent).toContain("5");
    expect(access.querySelectorAll("li")).toHaveLength(0);
  });

  it("shows report-time identity separately, withheld values stated as withheld", async () => {
    await mountPage();
    const identity = document.querySelector("[data-verify-identity]") as HTMLElement;
    expect(identity.textContent).toContain("Identity at report time (v1)");
    expect(identity.textContent).not.toContain("Not recorded");
  });
});

describe("Public Verify page — CONTENT_PREVIEW", () => {
  it("shows item names, roles and previews; no location card; no downloads", async () => {
    answer = () => contentPreview;
    await mountPage();
    expect(document.querySelector("[data-verify-disclosure='CONTENT_PREVIEW']")?.textContent).toContain("Content preview");
    expect(document.querySelector("[data-verify-disclosure-notice]")).toBeNull();
    const surface = screen.getByTestId("verify-content-preview");
    expect(surface.textContent).toContain("alpha-witness-statement.txt");
    expect(surface.textContent).toContain("bravo-dashcam-still.txt");
    expect(surface.textContent).toContain("Primary evidence");
    expect(screen.queryByTestId("verify-item-inventory")).toBeNull();
    expect(screen.queryByTestId("verify-recorded-location")).toBeNull();
    expect(document.querySelector("[data-capture-location-map]")).toBeNull();
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });

  it("with the owner's location decision: the Recorded Location card, consent before any tile", async () => {
    answer = () => contentPreviewLocation;
    await mountPage();
    const card = screen.getByTestId("verify-recorded-location");
    expect(card.textContent).toContain("Recorded Location");
    expect(card.textContent).toMatch(/device-reported/i);
    expect(card.textContent).not.toMatch(/\bverified\b/i);
    const map = card.querySelector("[data-capture-location-map]") as HTMLElement;
    expect(map.getAttribute("data-capture-location-map")).toBe("consent");
    expect(card.querySelectorAll("img[data-map-tile]")).toHaveLength(0);
    expect(card.innerHTML).not.toMatch(/tile\.openstreetmap\.org/);
    fireEvent.click(card.querySelector("[data-map-action='load-interactive-map']")!);
    expect(card.querySelectorAll("img[data-map-tile]").length).toBeGreaterThan(0);
  });
});
