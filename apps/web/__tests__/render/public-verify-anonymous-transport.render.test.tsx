/**
 * PRO-NB-08 — public verification is requested WITHOUT the reader's session.
 *
 * The web verify page called `apiFetch` like any signed-in page: the request
 * carried the session cookie (`credentials: "include"`), the bearer token and
 * the active-workspace header, so a signed-in person opening someone else's
 * verification link told the public route who they were. The real `apiFetch`
 * runs here against a recording `fetch`; a source pin holds the three public
 * verify callers to the anonymous transport.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, setActiveWorkspaceId, setApiToken, WORKSPACE_HEADER } from "../../lib/api";
import { SESSION_EXPIRED_EVENT } from "../../lib/session-events";

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: () => Response;

beforeEach(() => {
  calls = [];
  reply = () => new Response(JSON.stringify({ tier: "BASIC" }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply();
    }),
  );
  // A signed-in reader with an active workspace.
  setApiToken("reader-session-token");
  setActiveWorkspaceId("11111111-1111-4111-8111-111111111111");
});
afterEach(() => {
  setApiToken(null);
  setActiveWorkspaceId(null);
  vi.unstubAllGlobals();
});

const headersOf = (c: Call) => new Headers(c.init.headers);

describe("PRO-NB-08 anonymous public transport", () => {
  it("sends no cookie, bearer or workspace header, and keeps the view-session header", async () => {
    await apiFetch("/public/verify/ref-anon-1", { headers: { "x-proovra-verify-session": "view-1" } }, { anonymous: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.credentials).toBe("omit");
    const h = headersOf(calls[0]);
    expect(h.get("authorization")).toBeNull();
    expect(h.get(WORKSPACE_HEADER)).toBeNull();
    expect(h.get("x-proovra-verify-session")).toBe("view-1");
  });

  it("the ordinary transport still attaches the session (the control)", async () => {
    await apiFetch("/public/verify/ref-anon-2");
    expect(calls[0].init.credentials).toBe("include");
    const h = headersOf(calls[0]);
    expect(h.get("authorization")).toBe("Bearer reader-session-token");
    expect(h.get(WORKSPACE_HEADER)).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("a 401 is neither replayed nor treated as the end of the reader's session", async () => {
    const ended = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, ended);
    reply = () =>
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    await expect(apiFetch("/public/verify/ref-anon-3", {}, { anonymous: true })).rejects.toMatchObject({ statusCode: 401 });
    expect(calls).toHaveLength(1);
    expect(ended).not.toHaveBeenCalled();
    // The control: the same answer on the ordinary transport does end it.
    await expect(apiFetch("/public/verify/ref-anon-4", {}, { retryAuthOnce: false })).rejects.toMatchObject({ statusCode: 401 });
    expect(ended).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_EXPIRED_EVENT, ended);
  });

  it("every public verification read on the web uses it", () => {
    const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
    for (const [file, path] of [
      ["app/verify/[token]/page.tsx", "/public/verify/"],
      ["app/verify/package/[packageId]/page.tsx", "/public/verification-packages/"],
      ["app/verify/_components/VerifyPackageByFile.tsx", "packageBySha256Path(sha256)"],
    ] as const) {
      const src = read(file);
      const call = src.split("apiFetch(").slice(1).find((c) => c.includes(path));
      expect(call, file).toBeTruthy();
      expect(call!.slice(0, 260), file).toContain("anonymous: true");
    }
  });
});
