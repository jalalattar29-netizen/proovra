/**
 * A read that starts after a write gets its own request, through the real
 * `apiFetch`: it must not join a read of the same URL still in flight from
 * before the write (the setup wizard's MFA notice depended on it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../lib/api";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("in-flight read sharing across a write", () => {
  it("overlapping identical reads still share one request (control)", async () => {
    const fetchMock = vi.fn(async () => json({ level: "OFF" }));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([apiFetch("/v1/policy"), apiFetch("/v1/policy")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("a read started after a write does not join the read started before it", async () => {
    let policy = "OFF";
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "PUT") {
          policy = "ALL_MEMBERS";
          return json({ ok: true });
        }
        gets += 1;
        const answer = policy;
        if (gets === 1) await firstGate;
        return json({ level: answer });
      }),
    );
    const before = apiFetch("/v1/policy");
    await apiFetch("/v1/policy", { method: "PUT", body: JSON.stringify({ level: "ALL_MEMBERS" }) });
    const after = apiFetch("/v1/policy");
    releaseFirst();
    expect(await before).toEqual({ level: "OFF" });
    expect(await after).toEqual({ level: "ALL_MEMBERS" });
    expect(gets).toBe(2);
  });
});
