/**
 * AUD-07 (2026-10-20) — NO CUSTOMER IDENTIFIER IN SOURCE CONTROL OR THE RUNBOOK BUNDLE.
 *
 * Operator documents carried a customer's personal email address, record,
 * user and workspace UUIDs and workspace name, and the web runbook console
 * compiled one of them into its generated catalog (served on the admin page).
 * They are placeholders now; this scanner keeps them out:
 *
 *   EMAIL  every tracked file under docs/, the generated runbook catalog and
 *          audit-output/: an address must be a PROOVRA role mailbox or on a
 *          reserved / placeholder domain. A real person's address never is.
 *   UUID   operator procedures and runbooks (docs/operations/**.md,
 *          docs/runbooks/**, the generated catalog) name records by
 *          placeholder (`<evidence-id>`), never by a real identifier; only the
 *          nil-shaped fixture ids (`00000000-…`) are allowed.
 *
 * Git history is not rewritten here (a separate owner decision).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const tracked = (...paths: string[]): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
const TEXT = /\.(md|mdx|txt|json|ts|tsx|js|mjs|cjs|sql|ya?ml|sh|csv|html)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const ROLE_MAILBOXES = new Set(["security", "support", "privacy", "legal", "dpo", "abuse", "noreply", "no-reply", "billing", "hello", "contact", "ops"]);
const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|example|invalid|test|local|localhost|company\.com|tenant\.onmicrosoft\.com)$/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NIL_SHAPED = /^0{8}-0{4}-0{4}-/;

function emailFindings(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((p) => TEXT.test(p))) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(EMAIL)) {
      const [address, domain] = [m[0], m[1]!];
      const local = address.slice(0, address.indexOf("@")).toLowerCase();
      if (PLACEHOLDER_DOMAIN.test(domain)) continue;
      if (/^proovra\.com$/i.test(domain) && ROLE_MAILBOXES.has(local)) continue;
      // An npm scope or a git ref is not an address.
      if (/^\d/.test(domain) || /\.(ts|js|tsx|json|md)$/i.test(domain)) continue;
      out.push(`${f}: ${address}`);
    }
  }
  return out;
}

function uuidFindings(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((p) => TEXT.test(p))) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(UUID)) if (!NIL_SHAPED.test(m[0])) out.push(`${f}: ${m[0]}`);
  }
  return out;
}

describe("AUD-07: no customer identifier in tracked documents or the runbook bundle", () => {
  it("no personal email address in docs/, the runbook catalog or audit-output/", () => {
    const files = tracked("docs", "apps/web/lib/runbooks", "audit-output");
    expect(files.length).toBeGreaterThan(50);
    expect(emailFindings(files)).toEqual([]);
  });

  it("operator procedures and runbooks name records by placeholder, never by a real id", () => {
    const files = [
      ...tracked("docs/operations").filter((p) => p.endsWith(".md")),
      ...tracked("docs/runbooks"),
      ...tracked("apps/web/lib/runbooks"),
    ];
    expect(files.length).toBeGreaterThan(10);
    expect(uuidFindings(files)).toEqual([]);
  });

  it("the scanner itself catches what it exists to catch", () => {
    // Characterization: the redacted identifiers, as they were.
    const sample = "account `someone.real@hotmail.com` · Record `c30b0572-96d8-44fb-80d0-94f4520b8980`";
    expect([...sample.matchAll(EMAIL)].map((m) => m[1])).toEqual(["hotmail.com"]);
    expect(PLACEHOLDER_DOMAIN.test("hotmail.com")).toBe(false);
    expect([...sample.matchAll(UUID)].filter((m) => !NIL_SHAPED.test(m[0])).length).toBe(1);
    expect(PLACEHOLDER_DOMAIN.test("example.invalid")).toBe(true);
    expect(ROLE_MAILBOXES.has("jalal.attar")).toBe(false);
  });
});
