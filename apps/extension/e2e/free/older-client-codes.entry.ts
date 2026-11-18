// Test-only probe (not shipped): how THIS build's popup/background would present
// the release's new refusal codes in each wire shape the API uses.
import { denialOf } from "../../src/lib/api-client.js";
import { statusLine } from "../../src/lib/status-copy.js";
import { followUpLink, retryOffered } from "../../src/lib/popup-links.js";
import { denialToMessage, sharedCommercialCopy } from "../../src/lib/denial-copy.js";

const CODES = ["REPORT_REQUIRES_LOCATION_ACCESS", "EXISTING_ACCOUNT_SIGN_IN_REQUIRED", "IDEMPOTENCY_KEY_REUSED", "CASES_NOT_INCLUDED"];
const SHAPES: Record<string, (c: string) => unknown> = {
  "capture {denial}": (c) => ({ denial: c }),
  "flat {code,message}": (c) => ({ code: c, message: "server text" }),
  "nested {error:{code}}": (c) => ({ error: { code: c, message: "server text" } }),
};
const out: unknown[] = [];
for (const code of CODES) {
  for (const [shape, make] of Object.entries(SHAPES)) {
    const denial = denialOf(make(code));
    // preserve-flow.ts: an ApiError with a denial is DENIED, without one ERROR (4xx, nothing sealed).
    const s = { state: "FAILED", outcome: "NOTHING_SAVED", reason: denial ? "DENIED" : "ERROR", denial, evidenceId: null, mode: "VIEWPORT" } as never;
    out.push({
      code,
      shape,
      denialOf: denial,
      denialToMessage: denialToMessage(denial),
      sharedCommercialCopy: sharedCommercialCopy(code),
      popupLine: statusLine(s)?.text,
      retry: retryOffered(s, true),
      followUp: followUpLink(s, "http://localhost:3711"),
    });
  }
}
console.log(JSON.stringify(out, null, 2));
