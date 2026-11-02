/**
 * `apiFetch` raises ApiError only for a nested code. These go through the real
 * `apiFetch` over a stubbed fetch, with the bodies flat routes really send.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch, isApiResponseError } from "../../lib/api";
import { buildStorageLimitMessage } from "../../app/(app)/capture/_lib/capture-errors";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

async function failure(path = "/v1/orgs/x"): Promise<unknown> {
  try {
    await apiFetch(path, undefined, { retryAuthOnce: false });
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

afterEach(() => vi.unstubAllGlobals());

describe("isApiResponseError", () => {
  it("recognises a flat refusal, with its status and message", async () => {
    respond(403, { message: "Only ORG_OWNER can act on an ORG_OWNER." });
    const err = await failure();
    expect(err instanceof ApiError).toBe(false);
    expect(isApiResponseError(err)).toBe(true);
    expect((err as { statusCode: number }).statusCode).toBe(403);
    expect((err as Error).message).toBe("Only ORG_OWNER can act on an ORG_OWNER.");
  });

  it("keeps recognising a nested refusal", async () => {
    respond(404, { error: { code: "not_found", message: "Not found" } });
    const err = await failure();
    expect(err instanceof ApiError).toBe(true);
    expect(isApiResponseError(err)).toBe(true);
  });

  it("a network failure is not a server answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(isApiResponseError(await failure())).toBe(false);
  });

  it("a flat body with no message does not become a JSON sentence", async () => {
    respond(409, { code: "ORIGINAL_IS_MULTIPART" });
    const err = (await failure()) as Error & { code: string };
    expect(err.code).toBe("ORIGINAL_IS_MULTIPART");
    expect(err.message).toBe("HTTP 409: API error");
  });
});

describe("the capture storage wall", () => {
  it("reads the flat STORAGE_LIMIT_REACHED body the API sends", async () => {
    respond(402, {
      code: "STORAGE_LIMIT_REACHED",
      message: "Storage limit reached",
      billingWall: { workspace: { storage: { usedLabel: "9 GB", limitLabel: "10 GB" } } },
    });
    expect(buildStorageLimitMessage(await failure("/v1/evidence"))).toContain("9 GB / 10 GB");
  });
});
