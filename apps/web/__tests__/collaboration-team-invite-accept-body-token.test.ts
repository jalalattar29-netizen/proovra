/**
 * D9 — the collaboration team invite accept page must send the invitation
 * token in the BODY of the canonical `POST /v1/collaboration-team-invites/accept`,
 * never in the URL path of the legacy `/v1/collaboration-team-invites/:token/accept`.
 *
 * Drives the REAL `acceptInvite` (the page's only API call) through the REAL
 * `apiFetch` with `fetch` stubbed, and reads what went on the wire.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { apiBaseUrl } from "../lib/api";
import { acceptInvite } from "../lib/api/collaboration-teams";

const TOKEN = "ctinv_" + "a1B2c3D4".repeat(5);

type Seen = { url: string; method: string; body: unknown; contentType: string | null };

async function capture(run: () => Promise<unknown>): Promise<{ seen: Seen[]; result: unknown }> {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  (globalThis as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null),
      contentType: headers.get("content-type"),
    });
    return new Response(JSON.stringify({ teamId: "team-1", memberId: "member-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await run();
    return { seen, result };
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
}

test("acceptInvite posts the token in the body of the canonical accept route", async () => {
  const { seen, result } = await capture(() => acceptInvite(TOKEN));
  const accepts = seen.filter((s) => s.url.includes("/v1/collaboration-team-invites"));
  assert.equal(accepts.length, 1, JSON.stringify(seen));
  const [call] = accepts;
  assert.equal(call!.url, `${apiBaseUrl()}/v1/collaboration-team-invites/accept`);
  assert.equal(call!.method, "POST");
  assert.deepEqual(call!.body, { token: TOKEN });
  assert.equal(call!.contentType, "application/json");
  assert.ok(!call!.url.includes(TOKEN), "the token must never be in the URL");
  assert.deepEqual(result, { teamId: "team-1", memberId: "member-1" });
});

test("the accept page reaches the API only through acceptInvite", () => {
  const page = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../app/(app)/collaboration-teams/invites/[token]/accept/page.tsx"),
    "utf8",
  );
  assert.match(page, /import \{ acceptInvite \} from "[./]+\/lib\/api\/collaboration-teams"/);
  assert.match(page, /acceptInvite\(/);
  assert.doesNotMatch(page, /\/v1\/collaboration-team-invites/);
  assert.doesNotMatch(page, /\bfetch\(/);
});
