/**
 * Session-inventory parity invariant (2026-07-16).
 *
 * DEFECT FIXED: the Google, Apple, and MFA-verify login handlers set the
 * canonical session cookie WITHOUT writing an `AuthenticatedSession` row.
 * Only the guest + email-password paths called the recorder. Result:
 * `/settings/security` showed "No active sessions found" to OAuth and
 * MFA-enrolled users while they were signed in.
 *
 * INVARIANT PINNED HERE: **every** auth handler that issues a session
 * cookie must also record the session through the ONE canonical helper
 * (`recordSessionFromSignedToken` → `recordAuthenticatedSession`). This is
 * deliberately an invariant over ALL handlers rather than three one-off
 * assertions, so a future login provider that forgets to record fails this
 * test instead of silently reintroducing the empty-session bug.
 *
 * Style note: `auth.routes.ts` imports the DB-coupled `db.js`, which throws
 * at import when DATABASE_URL is unset — so this suite is source-contract,
 * matching the existing auth/identity-security test style ("No DB —
 * source-text ... only"). A live login→row integration test belongs to the
 * provisioned `test:tenant:live` harness.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../src/routes/auth.routes.ts"), "utf8");

const COOKIE_CALL = "maybeSetWebCookie(req, reply, token)";
const RECORDER = "recordSessionFromSignedToken(req,";

/**
 * Split the route file into per-handler slices so a recorder call in one
 * handler can never satisfy the invariant for a different handler.
 */
function handlerSlices(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /app\.(post|get)\(\s*"(\/v1\/auth\/[^"]+)"/g;
  const starts: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC)) !== null) {
    starts.push({ name: m[2], at: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : SRC.length;
    out.push({ name: starts[i].name, body: SRC.slice(from, to) });
  }
  return out;
}

describe("auth session-inventory parity", () => {
  it("finds the auth handlers (guard against a broken parser)", () => {
    const names = handlerSlices().map((h) => h.name);
    expect(names.length).toBeGreaterThan(3);
    // The three previously-broken paths must be present in the parse.
    expect(names).toContain("/v1/auth/google");
    expect(names).toContain("/v1/auth/apple");
  });

  it("EVERY handler that sets a session cookie also records the session", () => {
    const offenders = handlerSlices()
      .filter((h) => h.body.includes(COOKIE_CALL))
      .filter((h) => !h.body.includes(RECORDER))
      .map((h) => h.name);
    expect(
      offenders,
      `these auth handlers issue a session cookie without recording an AuthenticatedSession row (users would see "No active sessions found"): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("Google login records the session", () => {
    const h = handlerSlices().find((x) => x.name === "/v1/auth/google");
    expect(h).toBeTruthy();
    expect(h!.body).toContain(RECORDER);
  });

  it("Apple login records the session", () => {
    const h = handlerSlices().find((x) => x.name === "/v1/auth/apple");
    expect(h).toBeTruthy();
    expect(h!.body).toContain(RECORDER);
  });

  it("recording happens only AFTER the MFA gate (no session row for an incomplete login)", () => {
    // Both OAuth handlers return early when the MFA gate issues a
    // challenge; the recorder must sit after that early return so a
    // login still awaiting a second factor never lands in the inventory.
    for (const name of ["/v1/auth/google", "/v1/auth/apple"]) {
      const h = handlerSlices().find((x) => x.name === name)!;
      const gateAt = h.body.indexOf("if (gate.mfaIssued) return;");
      const recAt = h.body.indexOf(RECORDER);
      expect(gateAt, `${name} must keep its MFA gate`).toBeGreaterThan(-1);
      expect(recAt, `${name} must record a session`).toBeGreaterThan(-1);
      expect(recAt, `${name} must record AFTER the MFA gate`).toBeGreaterThan(gateAt);
    }
  });

  it("the MFA-verify completion path records the session", () => {
    // This is where MFA-enrolled users of ANY provider actually get their
    // session (the primary handlers return early at the gate).
    // Anchor on the ordered success sequence (record → clear pending →
    // set session cookie). `clearMfaPendingCookie` also appears on
    // failure paths, so a plain indexOf would inspect the wrong site.
    expect(SRC).toMatch(
      /recordSessionFromSignedToken\(req,[\s\S]{0,200}clearMfaPendingCookie\(req, reply\);[\s\S]{0,200}maybeSetWebCookie\(req, reply, token\);/,
    );
  });

  it("uses ONE canonical session model — no per-provider session recorder", () => {
    // Exactly one recorder helper, delegating to the one inventory service.
    expect(SRC).toMatch(/async function recordSessionFromSignedToken\(/);
    expect(
      (SRC.match(/async function recordSessionFromSignedToken\(/g) ?? []).length,
    ).toBe(1);
    expect(SRC).toContain("recordAuthenticatedSession");
    expect(SRC).not.toMatch(/record(Google|Apple|Oauth)Session/i);
  });
});
