/**
 * Team remediation stage F — T-133 (audit REV-06/REV-24/REV-28): the
 * evidence-request review list. The REAL apiFetch over a stubbed `fetch`.
 *
 * On the audited panel: status defaulted to "Any" under an "awaiting review"
 * title; the assignee was an id fragment and the type a raw enum; empty and
 * filtered-empty were one message; a 404 read as a role restriction; and a
 * slow answer for an older filter overwrote the newer one.
 */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { EvidenceRequestReviewQueue } from "../../app/(app)/review/queues/_evidence-request-queue";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ref = { current: TEAM };

function item(id: string, over: Record<string, unknown> = {}) {
  return {
    id, evidenceId: null, caseId: null, requestType: "WITNESS_STATEMENT", status: "UNDER_REVIEW", priority: "NORMAL",
    title: `Request ${id}`, dueAtUtc: null, assignedReviewerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    assignedReviewerDisplayName: "Dana Reviewer", createdAt: "2026-11-20T00:00:00.000Z", ...over,
  };
}

type Handler = (url: string) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
let handler: Handler;
let urls: string[];

beforeEach(() => {
  urls = [];
  handler = () => ({ status: 200, body: { items: [item("r1")] } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, "");
      urls.push(url);
      const a = await handler(url);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};
const mount = async () => {
  const v = render(<EvidenceRequestReviewQueue teamId={TEAM} activeTeamRef={ref} />);
  await flush();
  return v;
};

describe("T-133 — evidence-request review list", () => {
  it("opens on the reviewable statuses and names the assignee and the type", async () => {
    const v = await mount();
    const params = new URL(urls[0]!, "http://x").searchParams;
    expect(params.get("statuses")).toBe("RESPONSE_RECEIVED,UNDER_REVIEW,PARTIALLY_FULFILLED");
    expect(params.get("status")).toBeNull();
    expect(v.container.textContent).toContain("Dana Reviewer");
    expect(v.container.textContent).not.toContain("bbbbbbbb");
    expect(v.container.textContent).toContain("Witness statement");
    expect(v.container.textContent).not.toContain("WITNESS_STATEMENT");
  });

  it("empty and filtered-empty are different messages", async () => {
    handler = () => ({ status: 200, body: { items: [] } });
    const v = await mount();
    expect(v.container.querySelector('[data-evidence-request-queue-empty="none"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(v.container.querySelector("[data-evidence-request-queue-unassigned]") as HTMLElement);
    });
    await flush();
    expect(v.container.querySelector('[data-evidence-request-queue-empty="filtered"]')).not.toBeNull();
  });

  it("a 404 reads 'not available in this workspace', not a role restriction", async () => {
    handler = () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "no" } } });
    const v = await mount();
    expect(v.container.textContent).toContain("not available in this workspace");
    expect(v.container.textContent).not.toContain("restricted for your role");
  });

  it("a slow answer for an older filter never overwrites the newer one", async () => {
    let releaseFirst: () => void = () => {};
    handler = async (url) => {
      if (!url.includes("unassigned=true")) {
        await new Promise<void>((r) => (releaseFirst = r));
        return { status: 200, body: { items: [item("old")] } };
      }
      return { status: 200, body: { items: [item("new", { assignedReviewerUserId: null, assignedReviewerDisplayName: null })] } };
    };
    const v = render(<EvidenceRequestReviewQueue teamId={TEAM} activeTeamRef={ref} />);
    await flush();
    await act(async () => {
      fireEvent.click(v.container.querySelector("[data-evidence-request-queue-unassigned]") as HTMLElement);
    });
    await flush();
    expect(v.container.textContent).toContain("Request new");
    await act(async () => {
      releaseFirst();
    });
    await flush();
    expect(v.container.textContent).toContain("Request new");
    expect(v.container.textContent).not.toContain("Request old");
  });
});
