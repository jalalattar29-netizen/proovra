/**
 * PHASE 4 — every terminal reason is a bounded CODE (2026-10-20, AUD-54).
 *
 * Production stored the reason "Error" for 8 terminal report requests: a plain
 * Error's class name, which names nothing. A code-shaped message is the code;
 * anything else is UNCLASSIFIED_<class> — never the bare class name.
 */
import { describe, expect, it } from "vitest";

import { boundedReasonCodeForTest as reason } from "../src/processor.js";

describe("the bounded terminal reason", () => {
  it("an error's own code wins", () => {
    expect(reason(Object.assign(new Error("anything"), { code: "REPORT_PDF_VERIFICATION_FAILED" }))).toBe("REPORT_PDF_VERIFICATION_FAILED");
  });

  it("a plain Error whose message IS a code records that code", () => {
    expect(reason(new Error("ZIP_EOCD_NOT_FOUND"))).toBe("ZIP_EOCD_NOT_FOUND");
    expect(reason(new Error("PACKAGE_SEAL_REQUIRES_REPORT"))).toBe("PACKAGE_SEAL_REQUIRES_REPORT");
    expect(reason(new Error("ZIP_UNSUPPORTED_METHOD:12"))).toBe("ZIP_UNSUPPORTED_METHOD");
    expect(reason(new Error("PACKAGE_ENTRY_NAME_FORBIDDEN_PHRASE: x (y)"))).toBe("PACKAGE_ENTRY_NAME_FORBIDDEN_PHRASE");
  });

  it("anything else is UNCLASSIFIED_<class>, never the bare class name 'Error'", () => {
    expect(reason(new Error("evidence part 'x' has neither storage coordinates nor buffer bytes"))).toBe("UNCLASSIFIED_ERROR");
    expect(reason(new TypeError("Cannot read properties of undefined"))).toBe("UNCLASSIFIED_TYPEERROR");
    expect(reason("a string")).toBe("UNCLASSIFIED_ERROR");
    for (const e of [new Error("x"), new TypeError("y"), new RangeError("z")]) {
      expect(reason(e)).not.toMatch(/^(Error|TypeError|RangeError)$/);
    }
  });
});
