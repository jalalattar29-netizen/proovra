/**
 * Intake-links final forensic E2E audit — regression pins for the P0
 * fixes shipped after the production audit:
 *
 *   1) Submit Evidence failure must return a SUBMIT_FAILED envelope
 *      with a requestId, and log the real error server-side. Pre-fix
 *      the 500 was a bare `{error:{code:"INTERNAL_ERROR"}}` with no
 *      diagnostic for support.
 *
 *   2) Sender-display resolver must NEVER lead with a personal-
 *      workspace name like "X's personal workspace". Those collapse
 *      to "Personal Space via PROOVRA" so external recipients see a
 *      brand-first identity.
 *
 *   3) The token-redaction backfill script exists and uses the
 *      shared sanitizer.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const PUBLIC_ROUTES = resolve(
  REPO_ROOT,
  "services/api/src/routes/external-intake.routes.ts",
);
const SHARED_MSG = resolve(
  REPO_ROOT,
  "packages/shared/src/intake-link-messaging.ts",
);
const REDACT_SCRIPT = resolve(
  REPO_ROOT,
  "services/api/src/scripts/redact-leaked-intake-tokens.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Submit Evidence — error visibility + requestId", () => {
  it("the 500 path now ships a SUBMIT_FAILED code (not a bare INTERNAL_ERROR)", () => {
    const src = read(PUBLIC_ROUTES);
    // The submit handler's catch must build a structured envelope
    // with SUBMIT_FAILED + a friendly message + the requestId.
    assert.match(src, /code: "SUBMIT_FAILED",\s*\n?\s*message: friendlyPublicIntakeMessage\("SUBMIT_FAILED"\)/);
    assert.match(src, /requestId,/);
  });

  it("friendlyPublicIntakeMessage covers SUBMIT_FAILED with copy that mentions retry + support ID", () => {
    const src = read(PUBLIC_ROUTES);
    assert.match(src, /case "SUBMIT_FAILED":/);
    assert.match(
      src,
      /We couldn't submit these files\. Your uploads are still here — try Submit again, or contact the sender with the support ID below\./,
    );
  });

  it("the catch block logs the real error server-side with the requestId (operator-diagnostic)", () => {
    const src = read(PUBLIC_ROUTES);
    // Logger must capture the err + requestId + route + sessionId,
    // and the log line must include the error message. Token is
    // intentionally absent from the structured-log fields.
    assert.match(
      src,
      /req\.log\?\.error\(\s*\n?\s*\{[\s\S]{0,400}requestId,[\s\S]{0,400}route: "external-intake\.submit"/,
    );
    // Negative pin: no `token:` field in the structured log.
    const submitIdx = src.indexOf(`"/v1/external-intake/:token/sessions/:sid/submit"`);
    const endIdx = src.indexOf(`POST /v1/external-intake/:token/sessions/:sid/transition`, submitIdx);
    assert.ok(submitIdx > 0 && endIdx > submitIdx);
    const slice = src.slice(submitIdx, endIdx);
    assert.ok(
      !/\btoken: params\.token\b/.test(slice),
      "raw token must never appear in the structured log",
    );
  });
});

describe("Sender display — no personal workspace name in messages", () => {
  it("resolver collapses 'X's personal workspace' patterns to 'Personal Space via PROOVRA'", () => {
    const src = read(SHARED_MSG);
    assert.match(src, /isPersonalSpace =/);
    // Each of the four pattern endings must be listed.
    for (const pattern of [
      `lowered === "personal space"`,
      `lowered === "personal workspace"`,
      `lowered.endsWith("'s personal workspace")`,
      `lowered.endsWith("'s personal space")`,
    ]) {
      assert.ok(
        src.includes(pattern),
        `sender resolver missing personal-space pattern: ${pattern}`,
      );
    }
    // The fallback display value is the brand-first form.
    assert.match(src, /const name = isPersonalSpace \? "Personal Space" : rawName;/);
  });
});

describe("Backfill redaction script — present, idempotent, sanitizer-driven", () => {
  it("redact-leaked-intake-tokens.ts exists in the scripts directory", () => {
    assert.ok(existsSync(REDACT_SCRIPT), "redaction script not found");
  });

  it("script imports the canonical sanitizeIntakeMessagePreview from @proovra/shared", () => {
    const src = read(REDACT_SCRIPT);
    assert.match(
      src,
      /import \{ sanitizeIntakeMessagePreview \} from "@proovra\/shared";/,
    );
  });

  it("script is idempotent — skips rows whose sanitized form matches the stored value", () => {
    const src = read(REDACT_SCRIPT);
    // The `if (after === before) continue` branch is the idempotency
    // guarantee. Pin it so a refactor can't quietly drop it.
    assert.match(src, /if \(after === before\) \{\s*\n?\s*alreadySafe \+= 1;\s*\n?\s*continue;\s*\n?\s*\}/);
  });

  it("script outputs counts only — no tokens, no row IDs, no body previews", () => {
    const src = read(REDACT_SCRIPT);
    // The `console.log(JSON.stringify({...}))` payload must only
    // contain the count fields enumerated below.
    assert.match(src, /scanned,\s*\n?\s*leaked,\s*\n?\s*redacted,\s*\n?\s*alreadySafe,/);
    // Defense in depth — no `row.bodyPreview` or `tokens:` keys make
    // it into the log line.
    assert.ok(
      !/console\.log\([\s\S]{0,200}bodyPreview/.test(src),
      "script must not log bodyPreview content",
    );
  });
});
