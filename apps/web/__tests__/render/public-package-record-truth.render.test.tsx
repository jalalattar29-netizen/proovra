/**
 * PROOVRA'S PUBLIC PACKAGE RECORD PAGE — RECORDED IS NOT VERIFIED (2026-10-20, AUD-34).
 *
 * The REAL package page, mounted with a public package record. Characterization
 * (failed before): the disclosure profile, the recorded package digest and the
 * related packages were drawn in the green "verified" tone — facts PROOVRA
 * merely recorded, presented as checked. And a key revoked BEFORE the package
 * was issued was described as "revoked after this package was issued".
 *
 * Now: recorded facts are neutral; green is the live key binding only; a
 * revoked key states the one revoked-key sentence for what the dates show.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PUBLIC_PACKAGE_KEY_BINDING_TEXT, type PublicPackageRecord } from "@proovra/shared";

const PACKAGE_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
let answer: () => unknown;

vi.mock("next/navigation", () => ({
  useParams: () => ({ packageId: PACKAGE_ID }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/verify/package/${PACKAGE_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => answer()) }));

// Static import: the page's module graph loads once during collection, which
// has no per-test timeout. Re-importing it after vi.resetModules() in every
// test re-evaluated the whole graph inside each test's 5s budget, which the
// full render suite's load overran; the timed-out test's late render then
// leaked a second record into the next test. The page keeps no module-level
// state, and every test sets `answer` before it renders.
import Page from "../../app/verify/package/[packageId]/page";

const GREEN = "rgb(11, 93, 59)";
const NEUTRAL = "rgb(75, 85, 99)";
const RED = "rgb(155, 28, 28)";

function record(over: Partial<PublicPackageRecord> = {}): PublicPackageRecord {
  return {
    schema: "PROOVRA_PUBLIC_PACKAGE_RECORD",
    version: 2,
    packageId: PACKAGE_ID,
    packageIdRecordedInPackage: true,
    disclosureProfile: "FULL_FORENSIC",
    issuanceId: "i-1",
    issuedWith: [{ packageId: "4a2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", disclosureProfile: "EXTERNAL_DISCLOSURE" }],
    reportVersion: 2,
    issuedAtUtc: "2026-10-01T00:00:00.000Z",
    packageSha256: "a".repeat(64),
    packageFormatVersion: 5,
    sealSha256: "b".repeat(64),
    sealKeyFingerprintSha256: "c".repeat(64),
    sealKey: {
      purpose: "PACKAGE_SEAL",
      algorithm: "ED25519",
      keyId: "pkg-seal",
      version: 1,
      fingerprintSha256: "c".repeat(64),
      validFromUtc: "2026-01-01T00:00:00.000Z",
      validUntilUtc: null,
      status: "ACTIVE",
      supersededByVersion: null,
      revokedAtUtc: null,
    },
    keyBinding: "BOUND",
    supersedes: { packageId: "5a2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", reportVersion: 1 },
    supersededBy: null,
    statement: "statement",
    ...over,
  } as PublicPackageRecord;
}

const badge = (label: string) => screen.getByLabelText(new RegExp(`^${label}: `));

async function mount(r: PublicPackageRecord) {
  answer = () => r;
  render(<Page />);
  await screen.findByTestId("package-record-id");
}

describe("public package record page: recorded is not verified", () => {
  it("recorded facts are neutral; only the live key binding is green", async () => {
    await mount(record());
    expect(badge("Disclosure profile").style.color).toBe(NEUTRAL);
    expect(badge("Package file SHA-256").textContent).toBe("Recorded");
    expect(badge("Package file SHA-256").style.color).toBe(NEUTRAL);
    expect(badge("Issued with").style.color).toBe(NEUTRAL);
    expect(badge("Supersedes").style.color).toBe(NEUTRAL);
    expect(badge("Seal key").textContent).toBe("Bound to PROOVRA");
    expect(badge("Seal key").style.color).toBe(GREEN);
    expect(screen.queryByText(/still verifies/)).toBeNull();
  });

  it("a key revoked before issuance states that, never 'after this package was issued'", async () => {
    await mount(
      record({
        keyBinding: "KEY_REVOKED_BEFORE_ISSUE",
        sealKey: { ...record().sealKey!, status: "REVOKED", revokedAtUtc: "2026-09-01T00:00:00.000Z" },
      }),
    );
    expect(badge("Seal key").textContent).toBe("Key revoked");
    expect(badge("Seal key").style.color).toBe(RED);
    const text = screen.getByTestId("package-record-binding-text").textContent!;
    expect(text).toBe(PUBLIC_PACKAGE_KEY_BINDING_TEXT.KEY_REVOKED_BEFORE_ISSUE);
    expect(text).not.toMatch(/after/);
  });

  it("a key revoked after issuance states the one revoked-key sentence", async () => {
    await mount(
      record({
        keyBinding: "BOUND_KEY_REVOKED",
        sealKey: { ...record().sealKey!, status: "REVOKED", revokedAtUtc: "2026-10-10T00:00:00.000Z" },
      }),
    );
    expect(screen.getByTestId("package-record-binding-text").textContent).toBe(PUBLIC_PACKAGE_KEY_BINDING_TEXT.BOUND_KEY_REVOKED);
  });

  // R-1 (closure audit) — a RETAINED record answers 200 with its canonical
  // state, not a package record: the page treated any 2xx as a record and
  // crashed on record.issuedWith. Withdrawn (410) and suspended (503) were a
  // generic "could not be loaded".
  it("R-1: a retained record states its canonical state (200 body), never crashes", async () => {
    answer = () => ({ code: "VERIFICATION_RECORD_RETAINED", message: "retained" });
    render(<Page />);
    expect(await screen.findByRole("heading", { name: "Record retained" })).toBeTruthy();
    expect(screen.queryByTestId("package-record-id")).toBeNull();
  });

  it("R-1: withdrawn (410) and suspended (503) state their canonical state", async () => {
    for (const [code, statusCode, title] of [
      ["VERIFICATION_RECORD_WITHDRAWN", 410, "Verification page withdrawn"],
      ["VERIFICATION_RECORD_TEMPORARILY_UNAVAILABLE", 503, "Temporarily unavailable"],
    ] as const) {
      answer = () => {
        throw Object.assign(new Error(code), { code, statusCode });
      };
      const view = render(<Page />);
      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
      view.unmount();
    }
  });
});
