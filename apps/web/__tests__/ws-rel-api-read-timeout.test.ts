/**
 * WS-REL / PRO-S1-05 — the web client gives a READ a default deadline.
 *
 * apiFetch had no default AbortSignal: under API saturation a page spinner ran
 * for as long as the server held the request. A GET now carries a timeout
 * signal (a lost answer surfaces as NETWORK_ERROR, the existing contract);
 * writes never do (a retry could repeat a committed write), and a caller's
 * own signal wins. Drives the REAL apiFetch against a stubbed fetch.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { API_READ_TIMEOUT_MS, apiFetch } from "../lib/api";

function captureInit(): { calls: RequestInit[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    calls,
    restore: () => {
      (globalThis as { fetch: unknown }).fetch = original;
    },
  };
}

test("a GET carries a default timeout signal above the API's own read deadline", async () => {
  assert.ok(API_READ_TIMEOUT_MS > 45_000);
  const c = captureInit();
  try {
    await apiFetch("/v1/ws-rel-read-timeout-a");
    assert.equal(c.calls.length, 1);
    assert.ok(c.calls[0]!.signal instanceof AbortSignal);
  } finally {
    c.restore();
  }
});

test("a write is never given a timeout", async () => {
  const c = captureInit();
  try {
    await apiFetch("/v1/ws-rel-read-timeout-b", { method: "POST", body: "{}" });
    assert.equal(c.calls[0]!.signal ?? null, null);
  } finally {
    c.restore();
  }
});

test("a caller's own signal wins", async () => {
  const c = captureInit();
  const mine = new AbortController();
  try {
    await apiFetch("/v1/ws-rel-read-timeout-c", { signal: mine.signal });
    assert.equal(c.calls[0]!.signal, mine.signal);
  } finally {
    c.restore();
  }
});
