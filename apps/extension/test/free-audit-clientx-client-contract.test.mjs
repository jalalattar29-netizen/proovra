/**
 * CLIENT-X — B8-F-402 (extension half).
 *
 * The API now sends `x-proovra-min-client-contract` beside
 * `x-proovra-contract`. Before: the extension read neither, so a build the API
 * no longer serves kept capturing with no word to the person. Absent headers
 * (an older API) must change nothing, and a response is never blocked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { apiFetch, lastClientUpdateNotice, resetClientUpdateNoticeForTests } from "./dist/api-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));

async function answerWith(headers) {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", ...headers } });
    return await apiFetch("t", "GET", "/v1/platform/context");
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("B8-F-402: a minimum client contract above this build records UPDATE_REQUIRED without blocking", async () => {
  resetClientUpdateNoticeForTests();
  const body = await answerWith({ "x-proovra-contract": "2", "x-proovra-min-client-contract": "2" });
  assert.deepEqual(body, { ok: true });
  assert.equal(lastClientUpdateNotice(), "UPDATE_REQUIRED");
  // A later answer without the headers clears nothing; a weaker one does not downgrade.
  await answerWith({});
  await answerWith({ "x-proovra-contract": "2", "x-proovra-min-client-contract": "1" });
  assert.equal(lastClientUpdateNotice(), "UPDATE_REQUIRED");
});

test("B8-F-402: an API on a newer contract with the minimum met records UPDATE_AVAILABLE", async () => {
  resetClientUpdateNoticeForTests();
  await answerWith({ "x-proovra-contract": "2", "x-proovra-min-client-contract": "1" });
  assert.equal(lastClientUpdateNotice(), "UPDATE_AVAILABLE");
});

test("B8-F-402: absent, current or malformed headers record nothing", async () => {
  resetClientUpdateNoticeForTests();
  for (const hs of [{}, { "x-proovra-contract": "1" }, { "x-proovra-contract": "1", "x-proovra-min-client-contract": "1" }, { "x-proovra-min-client-contract": "x" }]) {
    await answerWith(hs);
  }
  assert.equal(lastClientUpdateNotice(), null);
});

test("B8-F-402: the popup has an update notice fed by its own reads and the background's record", () => {
  const html = readFileSync(resolve(HERE, "../public/popup.html"), "utf8");
  const popup = readFileSync(resolve(HERE, "../src/popup.ts"), "utf8");
  assert.match(html, /id="update-notice"[^>]*hidden/);
  assert.match(popup, /showUpdateNotice\(clientUpdateVerdict\(res\.headers\)\)/);
  assert.match(popup, /chrome\.storage\.local\.get\(CLIENT_UPDATE_STORAGE_KEY\)/);
});
