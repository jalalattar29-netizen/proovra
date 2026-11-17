/**
 * B5B-F-503 — /verify offers "Check a package by file": a legacy package ZIP
 * (issued before package IDs were sealed inside packages, so it has no ID to
 * type) is hashed in the browser and ONLY its SHA-256 reaches the existing
 * public lookup `GET /public/verification-packages/by-sha256/:sha256`.
 *
 * The fixture is a real ZIP shaped like a legacy package
 * (fixtures/legacy-verification-package.zip — README "Package ID: Not
 * recorded (issued before package identities)", package-manifest.json without
 * an id). Driven through the REAL apiFetch over a stubbed fetch, so the exact
 * request (method, path, body, auth header) is asserted.
 *
 * RED on the unfixed tree: /verify had no package-by-file entry at all.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/verify",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../components/marketing/MarketingHeader", () => ({ MarketingHeader: () => null }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { VerifyHero } from "../../app/verify/_components/VerifyHero";
import { PACKAGE_FILE_CHECK_MAX_BYTES } from "../../app/verify/_components/VerifyPackageByFile";

const HERE = dirname(fileURLToPath(import.meta.url));
const ZIP = readFileSync(join(HERE, "fixtures", "legacy-verification-package.zip"));
const DIGEST = createHash("sha256").update(ZIP).digest("hex");
const PACKAGE_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

type Call = { url: string; method: string; body: unknown; authorization: string | null };
let calls: Call[] = [];
let answer: (path: string) => { status: number; body: unknown };

function legacyRecord() {
  return {
    schema: "PROOVRA_PUBLIC_PACKAGE_RECORD",
    version: 2,
    packageId: PACKAGE_ID,
    packageIdRecordedInPackage: false,
    disclosureProfile: "FULL_FORENSIC",
    issuanceId: null,
    issuedWith: [],
    reportVersion: null,
    packageVersion: 1,
    issuedAtUtc: "2026-01-15T12:00:00.000Z",
    packageSha256: DIGEST,
    packageFormatVersion: 3,
    sealSha256: null,
    sealKeyFingerprintSha256: null,
    sealKey: null,
    keyBinding: "NOT_SEALED",
    supersedes: null,
    supersededBy: null,
    statement: "statement",
  };
}

beforeEach(() => {
  calls = [];
  answer = () => ({ status: 200, body: legacyRecord() });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body, authorization: headers.get("authorization") });
      const out = answer(url.replace(/^https?:\/\/[^/]+/, ""));
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function choose(file: File) {
  render(<VerifyHero />);
  const input = screen.getByTestId("verify-package-file");
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await waitFor(() => {
    const kind = screen.getByTestId("verify-package-by-file-result").getAttribute("data-outcome");
    expect(kind === "hashing" || kind === "looking_up" || kind === "idle").toBe(false);
  });
  return screen.getByTestId("verify-package-by-file-result");
}

const legacyZip = () => new File([ZIP], "legacy-package.zip", { type: "application/zip" });

describe("B5B-F-503 — Check a package by file (legacy package, hash only)", () => {
  it("/verify offers the entry, distinct from the token form", () => {
    render(<VerifyHero />);
    const section = screen.getByTestId("verify-package-by-file");
    expect(section.textContent).toContain("Check a package by file");
    expect(section.textContent).toMatch(/only its SHA-256 is sent/i);
  });

  it("sends ONLY the SHA-256 in the path of one anonymous GET — no body, no bytes — and states a registered package, not an evidence verification", async () => {
    const result = await choose(legacyZip());
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.authorization).toBeNull();
    expect(new URL(call.url).pathname).toBe(`/public/verification-packages/by-sha256/${DIGEST}`);
    expect(new URL(call.url).search).toBe("");
    // None of the archive's bytes travel: the README text inside the ZIP is nowhere in the request.
    expect(call.url).not.toContain("Not recorded");
    expect(call.url.length).toBeLessThan(200);

    expect(result.getAttribute("data-outcome")).toBe("registered");
    expect(result.textContent).toContain("Registered PROOVRA package");
    expect(screen.getByTestId("verify-package-registered-id").textContent).toBe(PACKAGE_ID);
    expect(result.textContent).toMatch(/not a verification of the evidence/i);
    expect(screen.getByTestId("verify-package-record-link").getAttribute("href")).toBe(`/verify/package/${PACKAGE_ID}`);
  });

  it("an unknown digest is the route's 404: no match, no package facts", async () => {
    answer = () => ({ status: 404, body: { code: "PACKAGE_NOT_FOUND", message: "No PROOVRA package record matches." } });
    const result = await choose(legacyZip());
    expect(result.getAttribute("data-outcome")).toBe("not_found");
    expect(result.textContent).toContain("No PROOVRA package record matches this file.");
    expect(result.textContent).toContain(DIGEST);
    expect(screen.queryByTestId("verify-package-registered")).toBeNull();
  });

  it("a withdrawn record (410) states the withdrawal only — never the package's issuance facts", async () => {
    answer = () => ({ status: 410, body: { code: "VERIFICATION_RECORD_WITHDRAWN", message: "withdrawn" } });
    const result = await choose(legacyZip());
    expect(result.getAttribute("data-outcome")).toBe("state");
    expect(result.textContent).toContain("Verification page withdrawn");
    expect(result.textContent).not.toContain(PACKAGE_ID);
  });

  it("a retained record answers 200 with its state, which is stated (not read as a package record)", async () => {
    answer = () => ({ status: 200, body: { code: "VERIFICATION_RECORD_RETAINED", message: "retained" } });
    const result = await choose(legacyZip());
    expect(result.getAttribute("data-outcome")).toBe("state");
    expect(result.textContent).toContain("Record retained");
    expect(screen.queryByTestId("verify-package-registered")).toBeNull();
  });

  it("a rate-limited lookup (429) is said, with no match claimed", async () => {
    answer = () => ({ status: 429, body: { error: { code: "RATE_LIMITED", message: "Too many requests" } } });
    const result = await choose(legacyZip());
    expect(result.getAttribute("data-outcome")).toBe("error");
    expect(screen.queryByTestId("verify-package-registered")).toBeNull();
  });

  it("a file that is not a ZIP is refused locally — nothing is sent", async () => {
    const result = await choose(new File(["just some text"], "notes.txt", { type: "text/plain" }));
    expect(result.getAttribute("data-outcome")).toBe("invalid");
    expect(result.textContent).toMatch(/not a ZIP archive/);
    expect(calls).toHaveLength(0);
  });

  it("an empty file is refused locally — nothing is sent", async () => {
    const result = await choose(new File([], "empty.zip", { type: "application/zip" }));
    expect(result.getAttribute("data-outcome")).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  it("a file over the product's single-file cap is refused before it is read — nothing is sent", async () => {
    const big = legacyZip();
    Object.defineProperty(big, "size", { value: PACKAGE_FILE_CHECK_MAX_BYTES + 1 });
    const slice = vi.spyOn(big, "slice");
    const result = await choose(big);
    expect(result.getAttribute("data-outcome")).toBe("oversized");
    expect(slice).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
