/**
 * Twilio message-recheck CLI source-contract.
 *
 * The CLI is an operator-facing diagnostic that closes the loop when
 * the StatusCallback webhook silently fails (no callback URL set,
 * unreachable host, etc.). Pins ensure:
 *
 *   1) CLI exists at the documented path and is runnable via
 *      `node dist/scripts/twilio-message-recheck.js` (lives under
 *      src/scripts so the API build emits it).
 *   2) Reads Twilio config from the same env-derived path as the
 *      provider, so the SIDs used here match the ones used by send.
 *   3) Uses the API key + secret (NOT the master auth token) so
 *      leaked CLI logs can be rotated independently.
 *   4) Persists the result via the exact-match (provider, providerMessageId)
 *      lookup the StatusCallback webhook uses, so a CLI update is
 *      indistinguishable from a real webhook update.
 *   5) Masks phone numbers by default (--no-redact for authorized
 *      incident response only).
 *   6) Surfaces diagnostic checks for the common WhatsApp stuck-status
 *      causes (no callback URL, sandbox opt-in, 24h window, errorCode).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const CLI = resolve(
  REPO_ROOT,
  "services/api/src/scripts/twilio-message-recheck.ts",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Pin 1 — CLI exists under src/scripts (production-runnable)", () => {
  it("file exists at the documented path", () => {
    assert.ok(existsSync(CLI), "twilio-message-recheck CLI missing");
  });

  it("has a shebang so `node dist/...` works after build", () => {
    const src = read(CLI);
    assert.match(src, /^#!\/usr\/bin\/env node/);
  });
});

describe("Pin 2 — config sourced from the same env path as the provider", () => {
  it("imports readTwilioConfigFromEnv from the canonical provider module", () => {
    const src = read(CLI);
    assert.match(
      src,
      /import\s*\{[\s\S]{0,200}readTwilioConfigFromEnv[\s\S]{0,200}\}\s*from\s*"\.\.\/services\/communications\/twilio-provider\.js"/,
    );
  });

  it("fails fast with a non-zero exit when config is missing", () => {
    const src = read(CLI);
    assert.match(src, /if \(!config\)/);
    assert.match(src, /process\.exit\(1\)/);
  });
});

describe("Pin 3 — Auth uses apiKey:apiSecret, NEVER the master auth token", () => {
  it("Basic auth header is built from apiKey + apiSecret only", () => {
    const src = read(CLI);
    assert.match(
      src,
      /Buffer\.from\(`\$\{config\.apiKey\}:\$\{config\.apiSecret\}`\)\.toString\(\s*"base64"\s*,?\s*\)/,
    );
    // The CLI must not use authToken — leaked CLI logs would
    // otherwise grant master-level access. Comment-mentions are
    // fine; actual reads of config.authToken are not.
    const codeOnly = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("*") && !t.startsWith("//");
      })
      .join("\n");
    assert.ok(
      !/config\.authToken/.test(codeOnly),
      "CLI must use apiKey:apiSecret only, never config.authToken",
    );
  });
});

describe("Pin 4 — DB write path mirrors the StatusCallback webhook", () => {
  it("findFirst by (provider: TWILIO, providerMessageId: sid) — same key the webhook uses", () => {
    const src = read(CLI);
    assert.match(
      src,
      /communicationMessage\.findFirst\(\{\s*\n?\s*where:\s*\{\s*\n?\s*provider:\s*"TWILIO",\s*\n?\s*providerMessageId:\s*sid,/,
    );
  });

  it("update writes status / errorCode / errorMessage and stamps deliveredAt / failedAt", () => {
    const src = read(CLI);
    assert.match(src, /status: mapped,/);
    assert.match(src, /errorCode: data\.errorCode/);
    assert.match(src, /errorMessage:/);
    assert.match(src, /deliveredAtUtc:[\s\S]{0,200}mapped === "DELIVERED"/);
    assert.match(
      src,
      /failedAtUtc:[\s\S]{0,200}mapped === "FAILED" \|\| mapped === "UNDELIVERED"/,
    );
  });

  it("DB write is opt-in via --write (default is read-only)", () => {
    const src = read(CLI);
    assert.match(src, /} else if \(a === "--write"\) \{/);
    assert.match(src, /args\.write \? new PrismaClient\(\) : null/);
  });
});

describe("Pin 5 — phone numbers masked by default", () => {
  it("redaction is on by default; --no-redact is the explicit override", () => {
    const src = read(CLI);
    assert.match(src, /let redact = true;/);
    assert.match(src, /} else if \(a === "--no-redact"\) \{/);
    assert.match(src, /args\.redact \? maskNumber\(data\.from\) : data\.from/);
    assert.match(src, /args\.redact \? maskNumber\(data\.to\) : data\.to/);
  });

  it("mask preserves the whatsapp: prefix so the operator can still see channel context", () => {
    const src = read(CLI);
    assert.match(src, /n\.startsWith\("whatsapp:"\) \? "whatsapp:" : ""/);
  });
});

describe("Pin 6 — diagnosis surfaces the common WhatsApp stuck-status causes", () => {
  it("flags missing TWILIO_STATUS_CALLBACK_URL as the prime suspect for stuck QUEUED", () => {
    const src = read(CLI);
    assert.match(src, /TWILIO_STATUS_CALLBACK_URL was NOT set/);
  });

  it("flags WhatsApp sandbox opt-in + 24h window + HSM-template requirements", () => {
    const src = read(CLI);
    assert.match(src, /WhatsApp pre-flight/);
    assert.match(src, /24-hour customer window/);
    assert.match(src, /errorCode 63016/);
  });

  it("links Twilio's per-errorCode docs page for unknown codes", () => {
    const src = read(CLI);
    assert.match(
      src,
      /twilio\.com\/docs\/api\/errors\/\$\{data\.errorCode\}/,
    );
  });
});
