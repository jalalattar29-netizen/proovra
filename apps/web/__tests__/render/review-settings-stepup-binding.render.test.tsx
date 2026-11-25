/**
 * Stage B — Review settings (`ReviewerSlaPolicyPanel`) with the real apiFetch
 * over a stubbed network: T-031, T-033, T-034 (flag toggles), T-035, T-041.
 *
 * On e4e908e88:
 *   - the copy promised "MFA or a trusted device" and never said Archive,
 *     Close, Reopen or Suppress were governed, nor what always applies;
 *   - an owner without a second factor saw an enabled Save that could only end
 *     in the enrolment dead end;
 *   - after a workspace switch the previous workspace's values stayed on
 *     screen until (or, on a failed read, after) the new read, Save stayed
 *     enabled, and Save sent no expectedVersion.
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { ReviewerSlaPolicyPanel } from "../../components/reviewer-experience/ReviewerSlaPolicyPanel";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

type Call = { path: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let hasMfa = true;
let pendingB: ((r: Response) => void) | null = null;
let failB = false;

function policy(teamId: string, version: number, assignmentHours: number) {
  return {
    policy: {
      policy: { assignmentHours, firstReviewHours: 24, completionHours: 72, escalationHours: 48, dueSoonHours: 8 },
      sources: { template: {}, workspace: { assignmentHours }, env: {} },
    },
    flags: {
      requireStepUpForApprove: false,
      requireStepUpForReject: false,
      requireStepUpForEscalationResolve: false,
      requireStepUpForBulk: false,
      reviewerInactivityHours: null,
    },
    version,
    teamId,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  hasMfa = true;
  pendingB = null;
  failB = false;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ path, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/v1/identity/mfa/factors") return json(200, { hasMfa });
    if (path === `/v1/reviewer-ops/sla-policy?teamId=${A}`) return json(200, policy(A, 3, 2));
    if (path === `/v1/reviewer-ops/sla-policy?teamId=${B}`) {
      if (failB) return json(503, { error: { code: "SERVER_BUSY", message: "busy" } });
      return new Promise<Response>((resolve) => {
        pendingB = resolve;
      });
    }
    if (path === "/v1/reviewer-ops/sla-policy" && init?.method === "POST") return json(200, policy(A, 4, 2));
    return json(404, { error: { code: "not_found" } });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

describe("T-031 / T-035 the settings copy names every governed action and the always-on layers", () => {
  it("lists Close, Reopen, Archive and Suppress under their checkboxes, states what always applies, and drops 'trusted device'", async () => {
    render(<ReviewerSlaPolicyPanel teamId={A} canEdit />);
    await settle();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/trusted device/i);
    const reject = document.querySelector('[data-review-sla-policy-governs="requireStepUpForReject"]')!.textContent!;
    expect(reject).toMatch(/Close a review from the Evidence page/);
    expect(reject).toMatch(/Reopen a review from the Evidence page/);
    expect(reject).toMatch(/Archive one review/);
    expect(document.querySelector('[data-review-sla-policy-governs="requireStepUpForEscalationResolve"]')!.textContent).toMatch(
      /Suppress an escalation/,
    );
    const always = document.querySelector("[data-review-sla-policy-always-on]")!.textContent!;
    expect(always).toMatch(/elevated sign-in risk/);
    expect(always).toMatch(/8 hours/);
    expect(always).toMatch(/Saving these settings always needs a second factor/);
    expect(document.querySelector("[data-review-sla-policy-never]")!.textContent).toMatch(/Assign or reassign/);
  });
});

describe("T-033 / T-034 an owner without a second factor is told before acting", () => {
  it("Save is disabled with the reason, links to enrolment with a way back, and step-up rules cannot be switched on", async () => {
    hasMfa = false;
    render(<ReviewerSlaPolicyPanel teamId={A} canEdit />);
    await settle();
    const note = document.querySelector("[data-review-sla-policy-needs-factor]")!;
    expect(note.textContent).toMatch(/needs a second factor/);
    const link = document.querySelector("[data-review-sla-policy-enroll-link]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/settings?returnTo=%2Freview%2Fsettings#security");
    const save = document.querySelector("[data-review-sla-policy-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("data-disabled-reason")).toMatch(/second factor/);
    expect(save.getAttribute("aria-describedby")).toBe("review-sla-needs-factor");
    const flag = document.querySelector('[data-review-sla-policy-flag-input="requireStepUpForApprove"]') as HTMLInputElement;
    expect(flag.disabled).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("an owner with a factor keeps an enabled Save and sends the version it read", async () => {
    render(<ReviewerSlaPolicyPanel teamId={A} canEdit />);
    await settle();
    const save = document.querySelector("[data-review-sla-policy-save]") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
    });
    await settle();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ teamId: A, expectedVersion: 3 });
    expect(post.headers["x-proovra-workspace-id"]).toBe(A);
  });
});

describe("T-041 a workspace switch never shows or saves the previous workspace's policy", () => {
  it("A's values are gone at once, Save is unavailable until B arrives, and a late answer belongs to B only", async () => {
    const view = render(<ReviewerSlaPolicyPanel teamId={A} canEdit />);
    await settle();
    expect((document.querySelector('[data-review-sla-policy-field="assignmentHours"]') as HTMLInputElement).value).toBe("2");
    view.rerender(<ReviewerSlaPolicyPanel teamId={B} canEdit />);
    // Synchronously: no A value, no Save.
    expect(document.querySelector('[data-review-sla-policy-field="assignmentHours"]')).toBeNull();
    expect(document.querySelector("[data-review-sla-policy-save]")).toBeNull();
    expect(document.querySelector("[data-review-sla-policy-loading]")).not.toBeNull();
    await settle();
    await act(async () => {
      pendingB!(json(200, policy(B, 7, 9)));
    });
    await settle();
    expect((document.querySelector('[data-review-sla-policy-field="assignmentHours"]') as HTMLInputElement).value).toBe("9");
  });

  it("a failed read for B shows the error and never A's values", async () => {
    failB = true;
    const view = render(<ReviewerSlaPolicyPanel teamId={A} canEdit />);
    await settle();
    view.rerender(<ReviewerSlaPolicyPanel teamId={B} canEdit />);
    await settle();
    expect(document.querySelector("[data-review-sla-policy-error]")).not.toBeNull();
    expect(document.querySelector('[data-review-sla-policy-field="assignmentHours"]')).toBeNull();
    expect(document.querySelector("[data-review-sla-policy-save]")).toBeNull();
  });
});
