/**
 * AUD-0021 — an admin read refused because the session never verified a second
 * factor tells the operator the real remedy (sign in again with the second
 * factor), not "ask a platform administrator for the scope". Both refusal
 * shapes the API sends are covered, built through the real ApiError:
 *
 *   requirePlatformAdmin      { error: { code: "FORBIDDEN", details: { reason } } }
 *   requirePlatformOpsActor   { error: { code: "permission_denied", reason } }
 */

import { describe, expect, it } from "vitest";

import { ApiError } from "../../lib/api";
import { classifyAdminReadFailure } from "../../lib/admin/read-state";

const safe = (_e: unknown, o: { message: string }) => ({ message: o.message });

describe("classifyAdminReadFailure — platform session without a second factor", () => {
  it("the admin gate's refusal asks for a sign-in with the second factor", () => {
    const err = new ApiError(
      {
        error: {
          code: "FORBIDDEN",
          message: "Platform administration requires a session verified with a second factor.",
          details: { reason: "PLATFORM_ADMIN_MFA_REQUIRED" },
        },
      } as never,
      403,
    );
    const r = classifyAdminReadFailure(err, "fallback", safe);
    expect(r.kind).toBe("denied");
    expect(r.retryable).toBe(false);
    expect(r.message).toMatch(/second factor/);
    expect(r.message).not.toMatch(/ask a platform administrator/);
  });

  it("the operations gate's refusal reads the same", () => {
    const err = new ApiError(
      { error: { code: "permission_denied", message: "", reason: "PLATFORM_ADMIN_MFA_REQUIRED" } } as never,
      403,
    );
    expect(classifyAdminReadFailure(err, "fallback", safe).message).toMatch(/second factor/);
  });

  it("control: an ordinary 403 still says the scope is missing", () => {
    const err = new ApiError({ error: { code: "FORBIDDEN", message: "Admin access required" } } as never, 403);
    const r = classifyAdminReadFailure(err, "fallback", safe);
    expect(r.kind).toBe("denied");
    expect(r.message).toMatch(/ask a platform administrator/);
  });
});
