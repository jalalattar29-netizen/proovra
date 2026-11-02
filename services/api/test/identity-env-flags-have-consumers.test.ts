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
 * SSO_ENABLED and SCIM_ENABLED are the two still undecided: deployments carry them
 * with different values, so wiring them could switch off a working connection.
 */
const AWAITING_DECISION = new Set(["SSO_ENABLED", "SCIM_ENABLED"]);

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
    const unread = documented.filter((name) => !AWAITING_DECISION.has(name) && !code.includes(name));
    expect(unread).toEqual([]);
  });
});
