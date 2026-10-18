/**
 * PUBLIC VERIFY CONVERGENCE (2026-10-18) — the REAL Public Verify page,
 * mounted with the anonymous pvr_ response of a six-part VERIFICATION_ONLY
 * record (fixtures/public-verify-pvr.json, captured from the API route).
 *
 * Characterization (failed on 35f6c7bbb):
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

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "public-verify-pvr.json"), "utf8")) as Record<string, unknown>;
const REF = (fixture.recordFacts as { verificationReference: string }).verificationReference;

let answer: () => unknown = () => fixture;

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
  const { default: VerifyPage } = await import("../../app/verify/[token]/page");
  const { ToastProvider } = await import("../../components/ui");
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
  const tab = screen.queryAllByRole("tab").find((t) => name.test(t.textContent ?? ""))
    ?? screen.queryAllByRole("button").find((t) => name.test(t.textContent ?? ""));
  if (tab) fireEvent.click(tab);
}

describe("Public Verify page — pvr_ VERIFICATION_ONLY record", () => {
  beforeEach(() => {
    answer = () => fixture;
  });

  it("P1 the package card states the server's seal check, exactly as the matrix does", async () => {
    await mountPage();
    openTab(/package/i);
    expect(document.body.textContent).toContain("Sealed — seal not checked against a published PROOVRA key.");
    expect(document.body.textContent).not.toContain("Package Integrity Complete");
  });

  it("P2 a pvr_ value is a Verification reference — never an 'Evidence ID'", async () => {
    await mountPage();
    expect(document.body.textContent).not.toMatch(/Evidence ID/i);
    expect(document.body.textContent).toContain("Verification reference");
    expect(document.body.textContent).toContain(REF);
  });

  it("P3 a multipart record says 'Multipart package · 6 items', not its first part's MIME type", async () => {
    await mountPage();
    expect(document.body.textContent).toContain("Multipart package · 6 items");
    expect(document.body.textContent).not.toMatch(/File Type\s*text\/plain/);
  });

  it("P4 the signal summary carries no REPORTED pill", async () => {
    // A record whose report was issued (the production record).
    const reported = structuredClone(fixture) as { overview: Record<string, unknown> };
    reported.overview.recordStatus = "REPORTED";
    reported.overview.recordLifecycleStatus = "REPORTED";
    answer = () => reported;
    await mountPage();
    expect(screen.queryAllByText(/^REPORTED$/)).toHaveLength(0);
  });

  it("P5 report issuance and the stored-file recheck are stated apart", async () => {
    await mountPage();
    expect(document.body.textContent).toContain("Report issued");
    expect(document.body.textContent).toContain("Stored file last rechecked");
  });

  it("P6 withheld identity says it is withheld — never 'Not recorded'", async () => {
    await mountPage();
    expect(document.body.textContent).toContain("Withheld by the record’s disclosure policy");
  });

  it("P7 the matrix is stated once: no 'Supporting Technical Signals' repetition, one legal boundary", async () => {
    await mountPage();
    expect(document.body.textContent).not.toContain("Supporting Technical Signals");
    const boundaries = document.body.textContent?.match(/does not by itself establish authorship/g) ?? [];
    expect(boundaries.length).toBeLessThanOrEqual(1);
  });

  it("P8 a print stylesheet keeps package-integrity labels from overlapping", async () => {
    await mountPage();
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/\[data-print-avoid-break\]|break-inside:\s*avoid/);
  });

  it("P9 no 'no mismatches' sentence while a danger reason is listed", async () => {
    const withDanger = structuredClone(fixture) as Record<string, unknown>;
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
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/No explicit digest, signature, custody, timestamp, or OTS mismatches/);
    expect(text).not.toMatch(/Mismatch review:\s*none/i);
    void within;
  });
});
