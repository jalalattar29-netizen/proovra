/**
 * Account & Security Activity emitters (lifecycle Phase 2, 2026-07-16).
 *
 * Profile/preference mutations must leave exactly one identity.* audit
 * event so the personal timeline (which already reads the `identity.`
 * prefix from /v1/identity-security/security-events) shows them — WITHOUT
 * a second audit log or a new read path.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const USERS = readFileSync(resolve(HERE, "../src/routes/users.routes.ts"), "utf8");
const IDSEC = readFileSync(
  resolve(HERE, "../src/routes/identity-security.routes.ts"),
  "utf8",
);

describe("profile/preference mutation emitters", () => {
  const at = USERS.indexOf('app.patch("/v1/users/me"');
  // The window follows the handler, which grew when the timezone gained its
  // IANA validation. The contract being asserted — metadata carries changed
  // FIELD NAMES and never submitted values — is unchanged; it simply sits
  // further down the function now.
  const H = USERS.slice(at, at + 5200);

  it("PATCH /v1/users/me emits one identity.* audit event after a successful update", () => {
    expect(at).toBeGreaterThan(-1);
    // Re-pointed to the canonical PLATFORM facade (Phase 11 §3): the
    // route now calls `emitPlatformAudit`, which composes
    // `appendPlatformAuditLog` as its sink under category
    // "platform_audit" with null tenant columns (this event has no
    // workspace scope — it's a pure identity/profile event).
    expect(H).toMatch(/emitPlatformAudit/);
    expect(H).toMatch(/"identity\.profile_updated"/);
    expect(H).toMatch(/"identity\.preferences_updated"/);
    // Emitted only when something actually changed.
    expect(H).toMatch(/Object\.keys\(data\)\.length > 0/);
    // AFTER the mutation (no event for a failed update).
    expect(H.indexOf("prisma.user.update")).toBeLessThan(
      H.indexOf("emitPlatformAudit"),
    );
  });

  it("metadata carries changed FIELD NAMES only — never submitted values", () => {
    expect(H).toMatch(/metadata:\s*\{\s*changedFields:\s*changed\s*\}/);
    expect(H).not.toMatch(/metadata:[\s\S]{0,120}(body\.|data\[|data\.)/);
  });

  it("the existing personal timeline already includes the identity. prefix (no new read path)", () => {
    // The feed filters by the SECURITY_ACTIONS_PREFIX list, which carries
    // the "identity." prefix — so the new emitters surface with zero new
    // read paths and no second audit log.
    expect(IDSEC).toMatch(/SECURITY_ACTIONS_PREFIX[\s\S]{0,120}"identity\."/);
  });
});
