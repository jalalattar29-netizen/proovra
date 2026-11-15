/**
 * F-P1-16 — the public package page's "Check your copy" hashes the chosen ZIP
 * in slices (lib/uploads/streaming-sha256.ts), never whole in memory, and a
 * file that cannot be read compares nothing (it used to be an unhandled
 * rejection, with the spinner gone and no answer).
 *
 * RED on the pre-remediation tree: `file.arrayBuffer()` read the WHOLE file —
 * a File whose whole read fails (a large package on a phone) never got an
 * answer, and an unreadable file showed nothing at all.
 */
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type { PublicPackageRecord } from "@proovra/shared";

const PACKAGE_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const BYTES = "PK\u0003\u0004 a verification package";
const DIGEST = createHash("sha256").update(BYTES, "utf8").digest("hex");
let answer: () => unknown;

vi.mock("next/navigation", () => ({
  useParams: () => ({ packageId: PACKAGE_ID }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/verify/package/${PACKAGE_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => answer()) }));

import Page from "../../app/verify/package/[packageId]/page";

afterEach(() => cleanup());

function record(): PublicPackageRecord {
  return {
    schema: "PROOVRA_PUBLIC_PACKAGE_RECORD",
    version: 2,
    packageId: PACKAGE_ID,
    packageIdRecordedInPackage: true,
    disclosureProfile: "FULL_FORENSIC",
    issuanceId: "i-1",
    issuedWith: [],
    reportVersion: 2,
    issuedAtUtc: "2026-10-01T00:00:00.000Z",
    packageSha256: DIGEST,
    packageFormatVersion: 5,
    sealSha256: "b".repeat(64),
    sealKeyFingerprintSha256: "c".repeat(64),
    sealKey: null,
    keyBinding: "NOT_SEALED",
    supersedes: null,
    supersededBy: null,
    statement: "statement",
  } as unknown as PublicPackageRecord;
}

async function mount() {
  answer = () => record();
  render(<Page />);
  await screen.findByTestId("package-record-id");
}

function choose(file: File) {
  fireEvent.change(screen.getByTestId("package-record-file"), { target: { files: [file] } });
}

describe("F-P1-16 — Check your copy hashes in slices", () => {
  it("a file whose WHOLE read fails is still hashed (slice by slice) and matches", async () => {
    await mount();
    const file = new File([BYTES], "package.zip", { type: "application/zip" });
    // A whole-file read is what fails on a phone for a large package.
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new Error("NotReadableError: whole-file read")),
    });
    choose(file);
    const result = await screen.findByTestId("package-record-file-result");
    expect(result.getAttribute("data-match")).toBe("true");
    expect(result.textContent).toContain(DIGEST);
  });

  it("an unreadable file compares nothing and says so (never 'Does not match')", async () => {
    await mount();
    const file = new File([BYTES], "package.zip", { type: "application/zip" });
    Object.defineProperty(file, "slice", {
      value: () => {
        throw new Error("NotReadableError");
      },
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new Error("NotReadableError")),
    });
    choose(file);
    const err = await screen.findByTestId("package-record-file-error");
    expect(err.textContent).toMatch(/could not be read/i);
    expect(screen.queryByTestId("package-record-file-result")).toBeNull();
    expect(screen.queryByText(/Does not match/)).toBeNull();
  });
});
