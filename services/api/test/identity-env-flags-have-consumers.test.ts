/**
 * IDENT-015 — a documented identity flag does what it says, or is not documented.
 * Operators read .env.example as the list of switches, and most of these names
 * were read by nothing, including kill switches.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAMILY = /^(SSO|SCIM|SAML|SESSION|MFA|RBAC|ADAPTIVE)_[A-Z0-9_]+$/;
/**
 * Round 3 (2026-11-04) — the last two are decided. SCIM_ENABLED is wired as the
 * /v2/scim kill switch (on unless "false", like SAML_ENABLED and
 * SSO_CALLBACKS_ENABLED). SSO_ENABLED stays out: those two already switch OIDC
 * and SAML, and a third name nothing reads is not a control.
 */

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("identity environment flags", () => {
  it("every one in .env.example has a reader", () => {
    const documented = readFileSync(join(API, ".env.example"), "utf8")
      .split(/\r?\n/)
      .map((line) => /^#?\s*([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((name): name is string => !!name && FAMILY.test(name));
    expect(documented.length).toBeGreaterThan(0);
    const code = sources(join(API, "src")).map((file) => readFileSync(file, "utf8")).join("\n");
    const unread = documented.filter((name) => !code.includes(name));
    expect(unread).toEqual([]);
  });

  it("the identity kill switches are documented and read; SSO_ENABLED is not documented", () => {
    const example = readFileSync(join(API, ".env.example"), "utf8");
    for (const name of ["SAML_ENABLED", "SSO_CALLBACKS_ENABLED", "SCIM_ENABLED"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
    }
    expect(example).not.toMatch(/^#?\s*SSO_ENABLED=/m);
    const scim = readFileSync(join(API, "src", "routes", "scim.routes.ts"), "utf8");
    expect(scim).toMatch(/process\.env\["SCIM_ENABLED"\] !== "false"/);
  });
});
