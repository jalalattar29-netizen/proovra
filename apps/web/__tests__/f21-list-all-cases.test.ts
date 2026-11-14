/**
 * F-21 — pickers follow GET /v1/cases's keyset cursor to the end instead of
 * stopping at the first 200 cases.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CASE_LIST_MAX_PAGES, listAllCases } from "../lib/cases/listAllCases";

test("follows nextCursor until it is null; the caller appends the encoded cursor to its own query", async () => {
  const urls: string[] = [];
  const pages: Record<string, { items: Array<{ id: string }>; nextCursor: string | null }> = {
    "/v1/cases?eligibleForEvidenceId=e1": { items: [{ id: "a" }, { id: "b" }], nextCursor: "c1" },
    "/v1/cases?eligibleForEvidenceId=e1&cursor=c1": { items: [{ id: "c" }], nextCursor: "c/2" },
    "/v1/cases?eligibleForEvidenceId=e1&cursor=c%2F2": { items: [{ id: "d" }], nextCursor: null },
  };
  const { items } = await listAllCases<{ id: string }>(async (cursorParam) => {
    const url = `/v1/cases?eligibleForEvidenceId=e1${cursorParam ? `&${cursorParam}` : ""}`;
    urls.push(url);
    return pages[url] ?? null;
  });
  assert.deepEqual(items.map((i) => i.id), ["a", "b", "c", "d"]);
  assert.equal(urls.length, 3);
});

test("a reply from an API without cursors is one page, exactly as before", async () => {
  let calls = 0;
  const { items } = await listAllCases<{ id: string }>(async () => {
    calls += 1;
    return { items: [{ id: "x" }] };
  });
  assert.deepEqual(items, [{ id: "x" }]);
  assert.equal(calls, 1);
});

test("a cursor that never ends stops at the runaway bound", async () => {
  let calls = 0;
  await listAllCases(async () => {
    calls += 1;
    return { items: [], nextCursor: "again" };
  });
  assert.equal(calls, CASE_LIST_MAX_PAGES);
});
