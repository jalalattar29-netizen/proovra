/**
 * D16 — External review console: bulk invite needs a real scope target.
 *
 *   POST /v1/external-review/invitations/bulk
 *     app/(app)/review/external/page.tsx — the panel used to send
 *     `defaultScope: { kind: "PACKAGE" }` with no id, so every row came back
 *     POLICY_DENIED and no grant was written. The operator now chooses an
 *     evidence record, a matter or a verification package from this
 *     workspace; submit stays disabled (with the reason) until one is chosen;
 *     a failed list read is never shown as "no records"; refused rows are
 *     explained; the banner counts only issued rows after the list reread.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", () => {
  const space = { type: "ORGANIZATION", roleLabel: "ADMIN" };
  return {
    useCan: () => true,
    useActiveSpace: () => space,
    useTeamId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
});
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => fn({}),
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});
vi.mock("../../components/ui", async (orig) => ({
  ...((await orig()) as object),
  useToast: () => ({ addToast: mocks.toast }),
}));

import ExternalInvitationsPage from "../../app/(app)/review/external/page";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";
const PACKAGE = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const BULK = "/v1/external-review/invitations/bulk";
const LIST = "/v1/external-review/invitations";
const SCOPE_REASON = "Choose what these reviewers will see before issuing invitations.";

type Reply = (path: string, init?: RequestInit) => unknown;
let bulkReply: Reply;
let evidenceReply: Reply;

function defaultReply(path: string, init?: RequestInit): unknown {
  if (path === BULK && init?.method === "POST") return bulkReply(path, init);
  if (path === LIST) return { invitations: [] };
  if (path.startsWith("/v1/evidence?")) return evidenceReply(path, init);
  if (path.startsWith("/v1/cases/matter-queue?")) {
    return {
      generatedAt: "2026-01-01T00:00:00.000Z",
      workspace: { teamId: TEAM, role: "ADMIN" },
      items: [{ id: CASE, name: "Harbor fraud matter", referenceNumber: "M-17" }],
      total: 1,
    };
  }
  if (path === `/v1/evidence/${EVIDENCE}/review-workspace`) {
    return {
      artifactVersions: {
        history: {
          reports: [],
          verificationPackages: [
            { id: PACKAGE, version: 2, generatedAtUtc: "2026-01-02T00:00:00.000Z", packageType: null, storageKey: null, sizeBytes: null, immutableRecorded: true, latest: true },
          ],
        },
      },
    };
  }
  throw Object.assign(new Error("unexpected path"), { statusCode: 500 });
}

beforeEach(() => {
  bulkReply = () => ({
    bulkBatchId: "55555555-5555-4555-8555-555555555555",
    summary: { INVITED: 1 },
    rows: [{ inviteEmail: "sue@acme.com", outcome: "INVITED", grantId: GRANT, denial: null }],
  });
  evidenceReply = () => ({
    items: [{ id: EVIDENCE, title: "Dock camera footage", createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.toast.mockReset();
});
afterEach(cleanup);

function submit(): HTMLButtonElement {
  return document.querySelector("[data-bulk-issue-submit]") as HTMLButtonElement;
}
function reasonOf(button: HTMLButtonElement): string {
  const ids = (button.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}
function posts() {
  return mocks.fetch.mock.calls.filter(([path, init]) => path === BULK && init?.method === "POST");
}
async function openBulkTab() {
  render(<ExternalInvitationsPage />);
  fireEvent.click(document.querySelector('[data-tab="bulk"]') as HTMLElement);
  fireEvent.change(document.querySelector("[data-bulk-paste]") as HTMLElement, {
    target: { value: "sue@acme.com,Sue Q.,Acme" },
  });
}
async function chooseKind(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

describe("bulk invite scope", () => {
  it("keeps submit disabled, with the reason, until a scope target is chosen", async () => {
    await openBulkTab();
    expect(submit().disabled).toBe(true);
    expect(reasonOf(submit())).toBe(SCOPE_REASON);

    await chooseKind(/^Evidence record/);
    await screen.findByRole("radio", { name: /Dock camera footage/ });
    expect(submit().disabled).toBe(true);
    expect(reasonOf(submit())).toBe(SCOPE_REASON);

    fireEvent.click(screen.getByRole("radio", { name: /Dock camera footage/ }));
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(posts()).toHaveLength(0);
  });

  it("lists only this workspace's evidence, from the evidence list route", async () => {
    await openBulkTab();
    await chooseKind(/^Evidence record/);
    await screen.findByRole("radio", { name: /Dock camera footage/ });
    const listCall = mocks.fetch.mock.calls.find(([p]) => String(p).startsWith("/v1/evidence?"));
    const query = new URL(String(listCall![0]), "http://localhost").searchParams;
    expect(query.get("teamId")).toBe(TEAM);
    expect(query.get("scope")).toBe("active");
    // The id is secondary detail only.
    expect(document.querySelector(`[data-bulk-scope-option="${EVIDENCE}"] code[data-identifier]`)?.textContent).toBe(EVIDENCE);
  });

  it.each([
    {
      kind: "EVIDENCE",
      radio: /^Evidence record/,
      pick: async () => fireEvent.click(await screen.findByRole("radio", { name: /Dock camera footage/ })),
      expected: { kind: "EVIDENCE", evidenceId: EVIDENCE },
    },
    {
      kind: "CASE",
      radio: /^Matter \(case\)/,
      pick: async () => fireEvent.click(await screen.findByRole("radio", { name: /Harbor fraud matter/ })),
      expected: { kind: "CASE", caseId: CASE },
    },
    {
      kind: "PACKAGE",
      radio: /^Evidence package/,
      pick: async () => {
        fireEvent.click(await screen.findByRole("radio", { name: /Dock camera footage/ }));
        fireEvent.click(await screen.findByRole("radio", { name: /Verification package, version 2/ }));
      },
      expected: { kind: "PACKAGE", packageId: PACKAGE },
    },
  ])("sends the chosen $kind target as defaultScope", async ({ radio, pick, expected }) => {
    await openBulkTab();
    await chooseKind(radio);
    await pick();
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse(String(posts()[0][1].body));
    expect(body.defaultScope).toEqual(expected);
    expect(body.rows).toEqual([{ inviteEmail: "sue@acme.com", displayName: "Sue Q.", organization: "Acme" }]);
  });

  it("does not let a package kind submit with only an evidence record chosen", async () => {
    await openBulkTab();
    await chooseKind(/^Evidence package/);
    fireEvent.click(await screen.findByRole("radio", { name: /Dock camera footage/ }));
    await screen.findByRole("radio", { name: /Verification package, version 2/ });
    expect(submit().disabled).toBe(true);
    expect(reasonOf(submit())).toBe(SCOPE_REASON);
  });

  it.each([
    { label: "failed", error: { statusCode: 500, code: "INTERNAL_ERROR" } },
    { label: "refused", error: { statusCode: 403, code: "NOT_PERMITTED" } },
  ])("never renders a $label evidence list read as empty, and keeps submit blocked", async ({ error }) => {
    evidenceReply = () => {
      throw Object.assign(new Error("raw body must never render"), error);
    };
    await openBulkTab();
    await chooseKind(/^Evidence record/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/evidence records/);
    expect(alert.textContent).not.toMatch(/raw body/);
    expect(document.querySelector("[data-bulk-scope-empty]")).toBeNull();
    expect(screen.queryByText(/has no evidence records/)).toBeNull();
    /*
     * THE BUTTON LEARNS OF THE FAILED READ A RENDER AFTER THE ALERT DOES.
     *
     * The alert is awaited above, so the failure HAS surfaced — but the
     * submit button's described-by reason is separate state, and read on the
     * next line it can still be the generic scope reason. Measured on a CI
     * runner as `expected <scope reason> not to be <scope reason>`: the test
     * was describing a moment, not a behaviour.
     */
    await waitFor(() => expect(submit().disabled).toBe(true));
    await waitFor(() => expect(reasonOf(submit())).not.toBe(SCOPE_REASON));
    const reason = reasonOf(submit());
    expect(alert.textContent).toContain(reason);
  });

  it("explains refused rows and counts only issued rows after rereading the list", async () => {
    bulkReply = () => ({
      bulkBatchId: "55555555-5555-4555-8555-555555555555",
      summary: { INVITED: 1, POLICY_DENIED: 1 },
      rows: [
        { inviteEmail: "sue@acme.com", outcome: "INVITED", grantId: GRANT, denial: null },
        { inviteEmail: "bob@acme.com", outcome: "POLICY_DENIED", grantId: null, denial: "POLICY_REJECTED" },
      ],
    });
    await openBulkTab();
    fireEvent.change(document.querySelector("[data-bulk-paste]") as HTMLElement, {
      target: { value: "sue@acme.com\nbob@acme.com" },
    });
    await chooseKind(/^Evidence record/);
    fireEvent.click(await screen.findByRole("radio", { name: /Dock camera footage/ }));
    await waitFor(() => expect(submit().disabled).toBe(false));
    const listReadsBefore = mocks.fetch.mock.calls.filter(([p]) => p === LIST).length;
    fireEvent.click(submit());

    const banner = await waitFor(() => {
      const el = document.querySelector("[data-console-banner]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(banner.textContent).toMatch(/^Issued 1 of 2 invitations\./);
    expect(banner.textContent).toMatch(/1 was not issued/);
    expect(mocks.fetch.mock.calls.filter(([p]) => p === LIST).length).toBeGreaterThan(listReadsBefore);

    // The refused row stays on screen with a product sentence.
    const refused = document.querySelector('[data-bulk-outcome-row="bob@acme.com"]') as HTMLElement;
    expect(refused).not.toBeNull();
    const reason = refused.querySelector("[data-bulk-outcome-reason]")!.textContent ?? "";
    expect(reason).toMatch(/^Not issued\. The chosen record can't be shared from this workspace/);
    expect(refused.textContent).toContain("Blocked by policy");
    // The code is secondary detail, never the sentence itself.
    expect(refused.querySelector("code[data-identifier]")?.textContent).toBe("POLICY_REJECTED");
  });

  it("announces a fully issued batch after the reread and returns to the list", async () => {
    await openBulkTab();
    await chooseKind(/^Matter \(case\)/);
    fireEvent.click(await screen.findByRole("radio", { name: /Harbor fraud matter/ }));
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await screen.findByText("Issued 1 of 1 invitation.");
    const order = mocks.fetch.mock.calls.map(([p, init]) => (p === BULK && init?.method === "POST" ? "POST" : p));
    expect(order.lastIndexOf(LIST)).toBeGreaterThan(order.indexOf("POST"));
    await waitFor(() => expect(document.querySelector('[data-tab="active"]')?.getAttribute("data-tab-active")).toBe("true"));
  });
});
