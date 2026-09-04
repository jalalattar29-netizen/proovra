/**
 * `apiFetch` SINGLE-FLIGHT — the behavioural proof, not a source read.
 *
 * The web client shares ONE in-flight request between callers that ask the same
 * question at the same instant. That is a shared authority on the request path
 * of every page in the product, so its boundaries are asserted by driving the
 * real function against a stubbed `fetch` rather than by reading the file.
 *
 * `apps/web/lib/api.ts` imports nothing — no Next, no React, no local modules —
 * so it can be exercised directly here.
 *
 * The invariant this file exists to protect: THIS IS NOT A CACHE. It collapses
 * requests that overlap in time and nothing else. A second read that starts
 * after the first has settled must reach the server, or a caller re-reading
 * after a write would be served the answer from before it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Recorded = { url: string; init: RequestInit };

let calls: Recorded[] = [];
let responder: (url: string, init: RequestInit) => Promise<unknown>;
let apiFetch: (
  path: string,
  init?: RequestInit,
  opts?: { auth?: boolean; retryAuthOnce?: boolean },
) => Promise<unknown>;

const json = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === "content-type" ? "application/json" : null) },
    clone() {
      return this;
    },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  }) as unknown as Response;

const failure = (status: number, code: string) =>
  ({
    ok: false,
    status,
    headers: { get: () => null },
    clone() {
      return this;
    },
    async text() {
      return JSON.stringify({ error: { code, message: "refused" } });
    },
    async json() {
      return { error: { code, message: "refused" } };
    },
  }) as unknown as Response;

/** Resolves when the caller says so, so two reads can be made to overlap. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  calls = [];
  responder = async (url) => ({ url });

  // The module reads `typeof window` at CALL time to decide whether sharing is
  // safe at all, so the browser has to exist before the first call.
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).fetch = (
    input: string | { url?: string },
    init: RequestInit = {},
  ) => {
    const url = typeof input === "string" ? input : (input.url ?? "");
    calls.push({ url, init });
    return responder(url, init) as Promise<Response>;
  };

  vi.resetModules();
  ({ apiFetch } = (await import("../../../apps/web/lib/api.js")) as {
    apiFetch: typeof apiFetch;
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("overlapping identical reads share one request", () => {
  it("two concurrent GETs of the same path produce ONE fetch", async () => {
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    const a = apiFetch("/v1/billing/overview");
    const b = apiFetch("/v1/billing/overview");
    await Promise.resolve();

    expect(calls).toHaveLength(1);

    gate.resolve(json({ plan: "PRO" }));
    expect(await a).toEqual({ plan: "PRO" });
    expect(await b).toEqual({ plan: "PRO" });
    expect(calls).toHaveLength(1);
  });

  it("each caller after the first holds its OWN object", async () => {
    /*
     * Sharing a promise must not become sharing a mutable payload: two
     * components holding one object is a bug that only shows up when one of
     * them writes to it.
     */
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    const a = apiFetch("/v1/me/inbox?pageSize=50");
    const b = apiFetch("/v1/me/inbox?pageSize=50");
    gate.resolve(json({ items: [{ id: "n1" }] }));

    const first = (await a) as { items: { id: string }[] };
    const second = (await b) as { items: { id: string }[] };

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    first.items[0].id = "mutated";
    expect(second.items[0].id).toBe("n1");
  });
});

describe("it is not a cache", () => {
  it("a read that starts after the first has SETTLED goes to the server", async () => {
    responder = async () => json({ n: calls.length });

    expect(await apiFetch("/v1/reports")).toEqual({ n: 1 });
    expect(await apiFetch("/v1/reports")).toEqual({ n: 2 });
    expect(calls).toHaveLength(2);
  });

  it("a failure is not retained — the next read tries again", async () => {
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    const a = apiFetch("/v1/ops/summary?teamId=w1");
    const b = apiFetch("/v1/ops/summary?teamId=w1");
    gate.resolve(failure(503, "UPSTREAM_UNAVAILABLE"));

    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(calls).toHaveLength(1);

    // The entry is dropped in a `finally`, so the failure is not remembered.
    responder = async () => json({ ok: true });
    expect(await apiFetch("/v1/ops/summary?teamId=w1")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe("what may never be shared", () => {
  it("one workspace's answer can never satisfy another's question", async () => {
    /*
     * The key is the composed URL, and every workspace-scoped read carries its
     * own `teamId`. Two workspaces asking the same endpoint at the same instant
     * are two different keys and therefore two different requests.
     */
    const gate = deferred<void>();
    responder = async (url) => {
      await gate.promise;
      return json({ teamId: new URL(url, "http://x").searchParams.get("teamId") });
    };

    const a = apiFetch("/v1/dashboard/command-center?teamId=workspace-a");
    const b = apiFetch("/v1/dashboard/command-center?teamId=workspace-b");
    gate.resolve();

    expect(calls).toHaveLength(2);
    expect(await a).toEqual({ teamId: "workspace-a" });
    expect(await b).toEqual({ teamId: "workspace-b" });
  });

  it("mutations are never merged, however identical", async () => {
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    const a = apiFetch("/v1/evidence/e1/archive", { method: "POST" });
    const b = apiFetch("/v1/evidence/e1/archive", { method: "POST" });
    await Promise.resolve();

    // Two intentions are two requests, even when they look the same.
    expect(calls).toHaveLength(2);
    gate.resolve(json({ archived: true }));
    await Promise.all([a, b]);
  });

  it("a GET carrying a body is treated as a request, not a read", async () => {
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    void apiFetch("/v1/search", { method: "GET", body: JSON.stringify({ q: "a" }) });
    void apiFetch("/v1/search", { method: "GET", body: JSON.stringify({ q: "a" }) });
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    gate.resolve(json({ hits: [] }));
  });

  it("a caller that can abort keeps its own request", async () => {
    /*
     * A shared request aborted by whichever caller unmounted first would fail
     * the others — an intermittent failure with no obvious cause.
     */
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    void apiFetch("/v1/evidence?limit=100", { signal: new AbortController().signal });
    void apiFetch("/v1/evidence?limit=100", { signal: new AbortController().signal });
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    gate.resolve(json({ items: [] }));
  });

  it("an authenticated read and an anonymous one stay separate", async () => {
    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    void apiFetch("/v1/platform/context");
    void apiFetch("/v1/platform/context", {}, { auth: false });
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    gate.resolve(json({}));
  });

  it("nothing is shared where there is no single user to share between", async () => {
    /*
     * A module-level map keyed without a caller identity would be a
     * cross-request leak in a server runtime, so the sharing switches itself
     * off rather than depending on where the module happens to load.
     */
    delete (globalThis as Record<string, unknown>).window;

    const gate = deferred<Response>();
    responder = () => gate.promise as Promise<unknown>;

    void apiFetch("/v1/billing/overview");
    void apiFetch("/v1/billing/overview");
    await Promise.resolve();

    expect(calls).toHaveLength(2);
    gate.resolve(json({}));
  });
});
