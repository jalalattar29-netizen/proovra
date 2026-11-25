/**
 * Team remediation stage F — the public intake page (T-127, T-128, T-130,
 * T-151, T-152, T-153, T-154; audit JRN-03, JRN-04, JRN-05, JRN-08 o–r).
 *
 * The REAL apiFetch runs over a recording `fetch`; a signed-in visitor with an
 * active workspace opens the link, so the transport assertions are meaningful.
 * Each case failed on the audited page:
 *   - requests carried cookies (`credentials: "include"`) and the workspace header;
 *   - after removing the middle of three files, the next file was posted at
 *     partIndex 2 (occupied), not 3;
 *   - a file over the remaining byte allowance was hashed and posted;
 *   - LINK_REVOKED was classed "generic"; a 429 first load had no Retry;
 *   - a dropped file was ignored; the picker had no `accept`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import ExternalIntakePage from "../../app/intake/[token]/page";
import { setActiveWorkspaceId, setApiToken, WORKSPACE_HEADER } from "../../lib/api";

function resolvedParams<T extends object>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

const SESSION = {
  id: "5e551045-0000-4000-8000-0000000000f1",
  status: "UPLOAD_STARTED",
  consentAcceptedAtUtc: "2026-11-17T09:00:00.000Z",
  expiresAtUtc: "2026-12-17T09:00:00.000Z",
};
const BASE_LINK = {
  workflowTemplateSlug: "general-evidence-record",
  workflowTemplateName: "General evidence record",
  workflowTemplateDescription: "",
  workflowTemplateLocationRequirement: "NONE",
  workflowTemplatePlanMode: "FREEFORM",
  steps: [],
  intakeMode: "EXTERNAL_REUSABLE",
  isAnonymous: false,
  consentPolicyVersion: "v1",
  consentDisclosureText: null,
  allowedAcceptedKinds: [] as string[],
  maxFileCountPerSession: null as number | null,
  maxBytesPerSession: null as string | null,
  maxFileBytes: null,
  expiresAtUtc: "2026-12-17T09:00:00.000Z",
  locationPolicy: "NONE",
};
const part = (id: string, partIndex: number, sizeBytes = 10) => ({
  id, partIndex, originalFileName: `${id}.txt`, mimeType: "text/plain", checklistStepId: null, sizeBytes, stored: true,
});

type Call = { path: string; method: string; init: RequestInit };
let calls: Call[];
let loadAnswers: Array<{ status: number; body: unknown }>;
let link: typeof BASE_LINK;
let resumedParts: ReturnType<typeof part>[];

beforeEach(() => {
  calls = [];
  link = { ...BASE_LINK };
  resumedParts = [];
  loadAnswers = [];
  window.sessionStorage.clear();
  // A signed-in visitor with an active workspace opens the public link.
  setApiToken("visitor-session-token");
  setActiveWorkspaceId("11111111-1111-4111-8111-111111111111");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = init?.method ?? "GET";
      calls.push({ path, method, init: init ?? {} });
      let out: { status: number; body: unknown } = { status: 200, body: {} };
      if (method === "GET" && path.startsWith("/v1/external-intake/")) {
        out = loadAnswers.shift() ?? {
          status: 200,
          body: { link, session: SESSION, request: null, resumed: resumedParts.length > 0, parts: resumedParts },
        };
      } else if (method === "POST" && path.endsWith("/parts")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { partIndex: number };
        out = { status: 201, body: { part: { id: `new-${body.partIndex}`, partIndex: body.partIndex }, upload: { putUrl: `https://store.test/put/${body.partIndex}` } } };
      } else if (method === "PUT") {
        return new Response(null, { status: 200 });
      } else if (method === "DELETE") {
        out = { status: 200, body: { removed: true } };
      }
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  setApiToken(null);
  setActiveWorkspaceId(null);
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

async function open(token = "pwi_v1_stage_f") {
  const view = render(<ExternalIntakePage params={resolvedParams({ token })} />);
  await flush();
  return view;
}

const partPosts = () =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/parts")).map((c) => JSON.parse(String(c.init.body)) as { partIndex: number; sizeBytes: number });

async function pick(view: ReturnType<typeof render>, files: File[]) {
  const input = view.container.querySelector('[data-intake-file-input="true"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
  await flush();
}

describe("public intake page — stage F", () => {
  it("T-130: every intake request is anonymous: no cookies, no bearer, no workspace header", async () => {
    resumedParts = [part("a", 0)];
    const view = await open();
    await pick(view, [new File(["hello"], "note.txt", { type: "text/plain" })]);
    const intakeCalls = calls.filter((c) => c.path.startsWith("/v1/external-intake/"));
    expect(intakeCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of intakeCalls) {
      expect(c.init.credentials, `${c.method} ${c.path}`).toBe("omit");
      const h = new Headers(c.init.headers);
      expect(h.get(WORKSPACE_HEADER)).toBeNull();
      expect(h.get("authorization")).toBeNull();
    }
  });

  it("T-128: after removing the middle of three files, a new file is staged at a fresh index (3)", async () => {
    resumedParts = [part("a", 0), part("b", 1), part("c", 2)];
    const view = await open();
    const remove = view.container.querySelector('[data-intake-part-remove="b"]') as HTMLButtonElement;
    await act(async () => {
      remove.click();
    });
    await flush();
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(2);
    await pick(view, [new File(["new file"], "fresh.txt", { type: "text/plain" })]);
    expect(partPosts().map((p) => p.partIndex)).toEqual([3]);
    // Both remaining files survive, plus the new one.
    expect(view.container.querySelectorAll("[data-intake-part-filename]")).toHaveLength(3);
  });

  it("T-128: a file refused before upload does not consume an index", async () => {
    link = { ...BASE_LINK, allowedAcceptedKinds: ["DOCUMENT"] };
    const view = await open();
    await pick(view, [new File(["img"], "photo.png", { type: "image/png" }), new File(["doc"], "letter.txt", { type: "text/plain" })]);
    expect(partPosts().map((p) => p.partIndex)).toEqual([0]);
  });

  it("T-127: the remaining allowance is shown and a file over it is refused before anything is sent", async () => {
    link = { ...BASE_LINK, maxBytesPerSession: "200" };
    resumedParts = [part("a", 0, 150)];
    const view = await open();
    const allowance = view.container.querySelector("[data-intake-remaining-bytes]") as HTMLElement;
    expect(allowance?.getAttribute("data-intake-remaining-bytes")).toBe("50");
    await pick(view, [new File(["x".repeat(100)], "big.txt", { type: "text/plain" })]);
    expect(partPosts()).toEqual([]);
    expect((view.container.querySelector("#ipk-file-error") as HTMLElement).textContent).toContain("larger than what is left");
    await pick(view, [new File(["x".repeat(40)], "small.txt", { type: "text/plain" })]);
    expect(partPosts().map((p) => p.sizeBytes)).toEqual([40]);
  });

  it("T-151: LINK_REVOKED on load is the revoked state (by code, not by copy), with no Retry", async () => {
    loadAnswers = [{ status: 410, body: { error: { code: "LINK_REVOKED", message: "This upload link was disabled by the sender." } } }];
    const view = await open();
    const main = view.container.querySelector("[data-intake-phase]") as HTMLElement;
    expect(main.getAttribute("data-intake-error-class")).toBe("expired-or-revoked");
    expect(view.container.querySelector("[data-intake-load-retry]")).toBeNull();
  });

  it("T-152: a 429 on first load offers Retry, and Retry loads the link", async () => {
    loadAnswers = [{ status: 429, body: { error: { code: "RATE_LIMITED", message: "Too many requests" } } }];
    const view = await open();
    const main = view.container.querySelector("[data-intake-phase]") as HTMLElement;
    expect(main.getAttribute("data-intake-error-class")).toBe("rate-limited");
    const retry = view.container.querySelector("[data-intake-load-retry]") as HTMLButtonElement;
    expect(retry).not.toBeNull();
    await act(async () => {
      retry.click();
    });
    await flush();
    expect(view.container.querySelector("[data-intake-phase]")?.getAttribute("data-intake-phase")).not.toBe("link_unavailable");
    expect(calls.filter((c) => c.method === "GET").length).toBe(2);
  });

  it("T-152: a network failure on first load offers Retry", async () => {
    const realFetch = globalThis.fetch;
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (first) {
          first = false;
          throw new TypeError("Failed to fetch");
        }
        return (realFetch as typeof fetch)(input, init);
      }),
    );
    const view = await open();
    expect(view.container.querySelector("[data-intake-phase]")?.getAttribute("data-intake-error-class")).toBe("network");
    expect(view.container.querySelector("[data-intake-load-retry]")).not.toBeNull();
  });

  it("T-153: a file dropped on the drop area is staged", async () => {
    const view = await open();
    const zone = view.container.querySelector('[data-intake-add-files-btn="true"]') as HTMLElement;
    const file = new File(["dropped"], "dropped.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.dragOver(zone, { dataTransfer: { files: [file], dropEffect: "none" } });
      fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    });
    await flush();
    expect(partPosts().map((p) => p.partIndex)).toEqual([0]);
  });

  it("T-154: a DOCUMENT-only link filters the picker to document types", async () => {
    link = { ...BASE_LINK, allowedAcceptedKinds: ["DOCUMENT"] };
    const view = await open();
    const input = view.container.querySelector('[data-intake-file-input="true"]') as HTMLInputElement;
    const accept = input.getAttribute("accept") ?? "";
    expect(accept).toContain("application/pdf");
    expect(accept).not.toContain("image/");
  });
});
