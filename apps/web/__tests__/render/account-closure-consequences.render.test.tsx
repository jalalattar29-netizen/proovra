/**
 * MEMBERS AUDIT LIFE-13 — other members of a workspace the person owns are a
 * CONSEQUENCE of account closure, shown before confirming, never a blocker.
 *
 * The real Privacy section against the real closure response shape: with only
 * a consequence, the person sees what will happen to the other members AND can
 * still open the closure form; a real blocker still disables it.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../app/providers", () => ({ useAuth: () => ({ user: { id: "u1", email: "owner@example.test" } }) }));
vi.mock("../../app/(app)/settings/_sections/LegalAcceptanceStatusCard", () => ({
  LegalAcceptanceStatusCard: () => null,
}));

import { PrivacySection } from "../../app/(app)/settings/_sections/PrivacySection";

function serve(closure: Record<string, unknown>) {
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === "/v1/identity/account-closure") return closure;
    if (path === "/v1/identity/data-export") return { requests: [] };
    if (path === "/v1/users/legal-acceptance") return { acceptances: [] };
    if (path === "/v1/users/cookie-consent/latest") return { consent: null };
    throw new Error("unexpected request " + String(path));
  });
}

const base = { request: null, confirmationPhrase: "close my account", coolingOffDays: 7 };
const consequence = {
  code: "WORKSPACE_MEMBERS_LOSE_ACCESS",
  message: "Workspaces you own close with your account. Their other members lose access and are notified.",
  count: 2,
};

describe("account closure — LIFE-13 consequences", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("other members are shown as a consequence and closure stays available", async () => {
    serve({ ...base, blockers: [], consequences: [consequence] });
    const { container } = render(<PrivacySection />);
    await screen.findByText(/Closing your account also:/);
    const item = container.querySelector('[data-cc-closure-consequence="WORKSPACE_MEMBERS_LOSE_ACCESS"]');
    expect(item?.textContent).toContain("lose access and are notified");
    expect(item?.textContent).toContain("(2 people)");
    expect(container.querySelector("[data-cc-closure-open]")).not.toBeNull();
    expect(container.querySelector("[data-cc-closure-open-blocked]")).toBeNull();
  });

  it("a real blocker still disables closure (positive control)", async () => {
    serve({
      ...base,
      blockers: [{ code: "LEGAL_HOLD_ACTIVE", message: "Evidence is under an active legal hold.", count: 1 }],
      consequences: [consequence],
    });
    const { container } = render(<PrivacySection />);
    await screen.findByText(/These must be resolved/);
    expect(container.querySelector("[data-cc-closure-open-blocked]")).not.toBeNull();
    expect(container.querySelector("[data-cc-closure-open]")).toBeNull();
  });

  it("no consequence, no list", async () => {
    serve({ ...base, blockers: [], consequences: [] });
    const { container } = render(<PrivacySection />);
    await screen.findByText("Close account");
    await vi.waitFor(() => expect(container.querySelector("[data-cc-closure-open]")).not.toBeNull());
    expect(container.querySelector("[data-cc-closure-consequences]")).toBeNull();
  });
});

/**
 * B-07 (Free-user audit, 2026-11-14) — the closure copy states what closure
 * actually clears. The columns are read from the closure service's own
 * anonymisation write (account-closure.service.ts phase B), so a column added
 * there without a word here, or a promise here broader than that write, fails.
 */
describe("account closure — B-07 the copy names what is cleared", () => {
  const SERVICE = resolve(__dirname, "../../../../services/api/src/services/identity/account-closure.service.ts");
  const LABEL: Record<string, string> = {
    email: "email address",
    displayName: "display name",
    firstName: "first and last name",
    lastName: "first and last name",
    avatarUrl: "photo",
    bio: "bio",
    country: "country",
  };

  function clearedColumns(): string[] {
    const src = readFileSync(SERVICE, "utf8");
    const at = src.indexOf("// Anonymize the account");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("});", at));
    return [...block.matchAll(/(\w+): null,/g)].map((m) => m[1]!);
  }

  beforeEach(() => {
    mocks.fetch.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("every column phase B clears is named, and nothing is called anonymized", async () => {
    serve({ ...base, blockers: [], consequences: [] });
    const { container } = render(<PrivacySection />);
    await screen.findByText("Close account");
    const copy = container.querySelector("[data-cc-closure-cleared]")?.textContent?.replace(/\s+/g, " ") ?? "";
    const columns = clearedColumns();
    expect(columns.length).toBeGreaterThanOrEqual(7);
    for (const column of columns) {
      expect(LABEL[column], `no wording for cleared column ${column}`).toBeDefined();
      expect(copy).toContain(LABEL[column]!);
    }
    expect(copy).not.toMatch(/anonymi[sz]/i);
    expect(copy).toContain("7-day cancellation window");
    // What stays is said too, rather than implied away.
    expect(copy).toMatch(/are not cleared/);
  });
});
