/**
 * AUD-0050 — a Free user's "Create case" refusal names the plan.
 *
 * POST /v1/cases answers a Free workspace 409 { code: "CASES_NOT_INCLUDED",
 * message }. The modal classifies the error with `classifyAccessError`, which
 * read `status` (apiFetch errors carry `statusCode`) and recognised a 409 only
 * when the code contained "PLAN", so the person saw "Please review your input
 * and try again." The error here is produced by the REAL apiFetch from a stubbed
 * HTTP response, so the test cannot pass on an error shape apiFetch never makes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../lib/api";
import { classifyAccessError } from "../../components/access/AccessGate";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

async function errorFrom(status: number, body: unknown): Promise<unknown> {
  respond(status, body);
  try {
    await apiFetch("/v1/cases", { method: "POST", body: "{}" });
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyAccessError on real apiFetch refusals", () => {
  it("CASES_NOT_INCLUDED (409, flat body) is the plan gate", async () => {
    const err = await errorFrom(409, { code: "CASES_NOT_INCLUDED", message: "Cases and matters are not included in the current plan" });
    expect(classifyAccessError(err)).toBe("PLAN_UPGRADE");
  });

  it("other <FEATURE>_NOT_INCLUDED refusals are the plan gate too", async () => {
    const err = await errorFrom(409, { code: "INTAKE_NOT_INCLUDED", message: "Intake is not included." });
    expect(classifyAccessError(err)).toBe("PLAN_UPGRADE");
  });

  it("a 403 from apiFetch is a permission gate (statusCode is read)", async () => {
    const err = await errorFrom(403, { error: { code: "FORBIDDEN", message: "Access denied" } });
    expect(classifyAccessError(err)).toBe("PERMISSION_REQUIRED");
  });

  it("control: an ordinary validation conflict is not a gate", async () => {
    const err = await errorFrom(409, { code: "CASE_NAME_TAKEN", message: "A case with this name exists." });
    expect(classifyAccessError(err)).toBeNull();
  });
});
