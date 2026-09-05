/**
 * PLATFORM ERROR COVERAGE GUARD.
 *
 * A bounded error code that reaches the frontend without copy does not break
 * anything. It renders as the HTTP-status bucket — "we couldn't complete that
 * action, please review your input" — and looks like an ordinary generic
 * failure, so nobody finds out until a customer describes a screen that cannot
 * be reproduced. That is exactly how the sign-in page came to tell people
 * their session had expired when they had simply mistyped a password: the 401
 * bucket was answering a question it had not been asked.
 *
 * This guard makes the silence audible. Every bounded code the API emits must
 * appear in `lib/feedback/error-code-registry.ts` with one of three
 * dispositions, and a new code fails this suite until somebody chooses.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - It does not demand customer copy for every code. Most should stay
 *     generic and several MUST: an anti-enumeration 404 that explained itself
 *     would stop being an anti-enumeration 404.
 *   - It does not compare copy strings. Wording is a product decision and
 *     pinning it here would make every edit a test failure.
 *   - It does not trust the registry. A `customer` claim is checked against
 *     the actual source — the global map really has the entry, or the named
 *     surface really handles the code — so the registry cannot drift into
 *     describing a coverage that was deleted.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const ROUTES_DIR = resolve(REPO_ROOT, "services/api/src/routes");
const REGISTRY_SRC = read("apps/web/lib/feedback/error-code-registry.ts");
const SAFE_ERROR_SRC = read("apps/web/lib/feedback/toSafeUserError.ts");

/**
 * Every bounded code the API's route layer emits.
 *
 * Read from source rather than imported, because the registry lives in the web
 * app and the routes live in the API: this test is the seam between them, and
 * it must see what is actually written on the wire.
 */
function emittedErrorCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of readdirSync(ROUTES_DIR).filter((n) => n.endsWith(".routes.ts"))) {
    const src = readFileSync(resolve(ROUTES_DIR, file), "utf8");
    for (const match of src.matchAll(/code:\s*"([A-Z][A-Z0-9_]{2,})"/g)) {
      codes.add(match[1]);
    }
  }
  return codes;
}

/** The dispositions the registry declares, parsed from its source. */
function declaredDispositions(): Map<
  string,
  { disposition: string; where?: string }
> {
  const out = new Map<string, { disposition: string; where?: string }>();
  const body = REGISTRY_SRC.slice(
    REGISTRY_SRC.indexOf("ERROR_CODE_DISPOSITIONS"),
  );
  // Each entry is `CODE: { disposition: "...", where: X }` — `where` may be a
  // string literal or one of the surface constants declared above the map.
  for (const match of body.matchAll(
    /^\s{2}([A-Z][A-Z0-9_]{2,}):\s*\{\s*disposition:\s*"(customer|generic|internal)"(?:,\s*where:\s*([A-Za-z_]+|"[^"]*"))?/gm,
  )) {
    out.set(match[1], { disposition: match[2], where: match[3] });
  }
  return out;
}

/** Resolve a `where` token to a repo path, following the surface constants. */
function resolveSurface(where: string): string {
  if (where.startsWith('"')) return where.slice(1, -1);
  const constant = REGISTRY_SRC.match(
    new RegExp(`const ${where} = "([^"]+)"`),
  );
  assert.ok(constant, `registry constant ${where} has no value`);
  return constant![1];
}

const EMITTED = emittedErrorCodes();
const DECLARED = declaredDispositions();

// ===========================================================================
test("every bounded error code the API emits has an explicit disposition", () => {
  const unclassified = [...EMITTED].filter((c) => !DECLARED.has(c)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `These bounded error codes reach the frontend with no recorded decision, so ` +
      `they silently render as the HTTP-status bucket. Add each to ` +
      `apps/web/lib/feedback/error-code-registry.ts as "customer" (with copy), ` +
      `"generic" (with the security or server reason it must stay vague), or ` +
      `"internal" (with why a customer never sees it):\n  ` +
      unclassified.join("\n  "),
  );
});

test("a code classified as customer-facing really has copy somewhere", () => {
  const broken: string[] = [];
  for (const [code, entry] of DECLARED) {
    if (entry.disposition !== "customer") continue;
    assert.ok(entry.where, `${code} is customer-facing but names no surface`);

    if (entry.where === '"global"') {
      // The global map must actually contain the key.
      if (!new RegExp(`^\\s{2}${code}:\\s*\\{`, "m").test(SAFE_ERROR_SRC)) {
        broken.push(`${code} claims global copy, but CODE_MAP has no entry`);
      }
      continue;
    }

    const surface = resolveSurface(entry.where!);
    const src = read(surface);
    if (!new RegExp(`\\b${code}\\b`).test(src)) {
      broken.push(`${code} claims copy in ${surface}, which never mentions it`);
    }
  }
  assert.deepEqual(broken, [], broken.join("\n"));
});

test("the registry does not describe codes the API no longer emits", () => {
  /*
   * A stale entry is not dangerous, but it makes the registry read as a
   * description of the system when it has become a description of its past.
   * Codes emitted from services rather than routes are exempt — the scan
   * above only reads the route layer.
   */
  const known = new Set(EMITTED);
  /*
   * THE COMMERCIAL AUTHORITY EMITS ON THE WIRE TOO.
   *
   * `assertWorkspaceAllowsEvidenceCreation` throws `DomainError`s that the
   * central handler answers verbatim — httpStatus, publicCode and public
   * message straight onto the response — so these codes reach a customer
   * exactly as a route-emitted one does. The scan above only reads the route
   * layer, which is why the record-allowance family looked like registry
   * cruft while being the single most common commercial refusal in the
   * product.
   *
   * Exempting them from the staleness check would be enough to make the
   * suite pass, and would also let the exemption outlive the code. So each
   * is checked against the authority that raises it: delete the throw and
   * this fails, which is the same guarantee the registry's own `customer`
   * claims already get.
   */
  const COMMERCIAL_AUTHORITY =
    "services/api/src/services/billing-enforcement.service.ts";
  const authoritySrc = read(COMMERCIAL_AUTHORITY);
  for (const c of [
    "EVIDENCE_RECORD_LIMIT_REACHED",
    "FREE_LIMIT_REACHED",
    "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
    "INSUFFICIENT_EVIDENCE_CREDITS",
  ]) {
    assert.ok(
      authoritySrc.includes('"' + c + '"'),
      c +
        " is exempted from the staleness check as a commercially-emitted " +
        "code, but " +
        COMMERCIAL_AUTHORITY +
        " no longer emits it. Remove the exemption and the registry entry, " +
        "or restore the throw.",
    );
    known.add(c);
  }
  // Codes that reach the client from the API's global error handler or from
  // the web client's own normalization rather than from a route file.
  for (const c of [
    "INVALID_INPUT",
    "UNAUTHORIZED",
    "SESSION_EXPIRED",
    "ACCESS_DENIED",
    "NETWORK_ERROR",
    "STEP_UP_REQUIRED",
    "GOVERNANCE_BLOCKED",
    "HIGH_RISK_ACTION_BLOCKED",
    "EVIDENCE_LOCKED",
    "ENTITLEMENT_REQUIRED",
    "SUBSCRIPTION_INACTIVE",
    "TEAM_LIMIT_REACHED",
    "TEAM_MEMBER_LIMIT_REACHED",
    "TEAM_INVITE_LIMIT_REACHED",
    "TEAM_INVITES_NOT_INCLUDED",
  ]) {
    known.add(c);
  }
  const stale = [...DECLARED.keys()].filter((c) => !known.has(c)).sort();
  assert.deepEqual(
    stale,
    [],
    `The registry classifies codes no route emits any more:\n  ${stale.join("\n  ")}`,
  );
});

// ===========================================================================
// The specific regression this audit closed.
// ===========================================================================
test("a failed sign-in is not described as an expired session", () => {
  const registry = DECLARED.get("INVALID_CREDENTIALS");
  assert.ok(registry, "INVALID_CREDENTIALS must be classified");
  assert.equal(registry!.disposition, "customer");

  // The entry exists, and it does not reuse the session-expiry sentence.
  const entry = SAFE_ERROR_SRC.slice(
    SAFE_ERROR_SRC.indexOf("  INVALID_CREDENTIALS: {"),
    SAFE_ERROR_SRC.indexOf("  UNAUTHORIZED: {"),
  );
  assert.ok(entry.includes("Email or password is incorrect"));
  assert.ok(
    !/session/i.test(entry),
    "the credential failure must not mention sessions — that is the defect",
  );

  // And it must not name which of the two was wrong: the API answers unknown
  // email and wrong password identically, and the UI must not undo that.
  assert.ok(
    !/not registered|no account|unknown email|doesn't exist/i.test(entry),
    "the credential copy must not imply whether the address exists",
  );
});
