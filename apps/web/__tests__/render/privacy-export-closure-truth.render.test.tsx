/**
 * F-25 / F-17 — the Privacy & data cards say what is true.
 *
 * The real PrivacySection over the REAL apiFetch and a stubbed network:
 *   - a failed export list is "could not load" with Try again — not "No
 *     exports requested yet" with a request button the server would refuse
 *   - the downloaded file is the server's bytes, so its SHA-256 is the one
 *     shown (in full) on the row
 *   - a failed closure read is "could not load" — an open, cancellable
 *     closure is not replaced by a fresh request form
 *   - the closure card says public verification stays up and how to withdraw
 *     a record's page first
 */
import React from "react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/providers", () => ({ useAuth: () => ({ user: { id: "u1", email: "owner@example.test" } }) }));
vi.mock("../../app/(app)/settings/_sections/LegalAcceptanceStatusCard", () => ({
  LegalAcceptanceStatusCard: () => null,
}));

import { PrivacySection } from "../../app/(app)/settings/_sections/PrivacySection";

// Deliberately formatted so a parse + re-stringify would NOT reproduce it.
const PACKAGE_BYTES = '{"schemaVersion":1,  "profile":{"email":"owner@example.test"},"n":1.50}';
const PACKAGE_SHA = createHash("sha256").update(PACKAGE_BYTES, "utf8").digest("hex");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = (path: string, method: string) => Response | Promise<Response>;
let answer: Answer;
let exportsUp = true;
let closureUp = true;

const readyRow = {
  id: "exp-1",
  status: "READY",
  requestedAtUtc: "2026-11-01T00:00:00.000Z",
  completedAtUtc: "2026-11-01T00:05:00.000Z",
  expiresAtUtc: "2026-11-08T00:05:00.000Z",
  failureCode: null,
  packageSha256: PACKAGE_SHA,
  downloadCount: 0,
};

const coolingOff = {
  request: {
    id: "cl-1",
    status: "COOLING_OFF",
    reason: null,
    blockersJson: null,
    requestedAtUtc: "2026-11-10T00:00:00.000Z",
    coolingOffEndsAtUtc: "2026-11-17T00:00:00.000Z",
    cancelledAtUtc: null,
    completedAtUtc: null,
    failureCode: null,
  },
  blockers: [],
  consequences: [],
  confirmationPhrase: "close my account",
  coolingOffDays: 7,
};

beforeEach(() => {
  exportsUp = true;
  closureUp = true;
  answer = (path, method) => {
    if (path === "/v1/identity/data-export" && method === "GET") {
      return exportsUp ? json(200, { requests: [readyRow] }) : json(500, { message: "boom" });
    }
    if (path === "/v1/identity/data-export/exp-1/download") {
      return new Response(PACKAGE_BYTES, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "x-package-sha256": PACKAGE_SHA },
      });
    }
    if (path === "/v1/identity/account-closure") {
      return closureUp ? json(200, coolingOff) : json(503, { message: "unavailable" });
    }
    if (path === "/v1/users/legal-acceptance") return json(200, { acceptances: [] });
    if (path === "/v1/users/cookie-consent/latest") return json(200, { consent: null });
    return json(200, {});
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      answer(String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string, (init?.method ?? "GET").toUpperCase()),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("F-25 — data export card", () => {
  it("a failed list is 'could not load' with Try again, not 'no exports' with a request button", async () => {
    exportsUp = false;
    const { container } = render(<PrivacySection />);
    await settle();
    expect(container.querySelector("[data-cc-export-load-failed]")).not.toBeNull();
    expect(screen.queryByText("No exports requested yet.")).toBeNull();
    expect(container.querySelector("[data-cc-export-request]")).toBeNull();

    exportsUp = true;
    fireEvent.click(container.querySelector("[data-cc-export-retry]") as HTMLButtonElement);
    await settle();
    expect(container.querySelector("[data-cc-export-load-failed]")).toBeNull();
    expect(container.querySelector('[data-cc-export-row="READY"]')).not.toBeNull();
  });

  it("the saved file is the server's bytes, and the full SHA-256 shown is theirs", async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:export";
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const { container } = render(<PrivacySection />);
    await settle();
    expect(container.querySelector("[data-cc-export-checksum]")?.textContent).toContain(PACKAGE_SHA);

    fireEvent.click(container.querySelector('[data-cc-export-download="exp-1"]') as HTMLButtonElement);
    await settle();
    expect(blobs).toHaveLength(1);
    const saved = await blobs[0]!.text();
    expect(saved).toBe(PACKAGE_BYTES);
    expect(createHash("sha256").update(saved, "utf8").digest("hex")).toBe(PACKAGE_SHA);
  });
});

describe("F-25 / F-17 — account closure card", () => {
  it("a failed read is 'could not load', not a fresh request form; Try again shows the open closure and its Cancel", async () => {
    closureUp = false;
    const { container } = render(<PrivacySection />);
    await settle();
    expect(container.querySelector("[data-cc-closure-load-failed]")).not.toBeNull();
    expect(container.querySelector("[data-cc-closure-open]")).toBeNull();
    expect(container.querySelector("[data-cc-closure-cancel]")).toBeNull();

    closureUp = true;
    fireEvent.click(container.querySelector("[data-cc-closure-retry]") as HTMLButtonElement);
    await settle();
    expect(container.querySelector('[data-cc-closure-status="COOLING_OFF"]')).not.toBeNull();
    expect(container.querySelector("[data-cc-closure-cancel]")).not.toBeNull();
  });

  it("says public verification stays up and names the control that takes a page down", async () => {
    const { container } = render(<PrivacySection />);
    await settle();
    const note = container.querySelector("[data-cc-closure-public-verification]")?.textContent ?? "";
    expect(note).toContain("does not take down public verification");
    expect(note).toContain("Withdraw");
  });
});
