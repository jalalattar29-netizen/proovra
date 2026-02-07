import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "../src/services/jwt.js";

describe("jwt", () => {
  it("signs and verifies tokens", () => {
    const token = signJwt(
      { sub: "user-1", provider: "GUEST", email: null },
      "test-secret",
      60
    );
    const payload = verifyJwt(token, "test-secret");
    expect(payload.sub).toBe("user-1");
    expect(payload.provider).toBe("GUEST");
  });
});
