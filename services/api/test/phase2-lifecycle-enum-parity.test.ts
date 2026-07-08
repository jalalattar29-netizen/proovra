/**
 * Phase 2 (Workstream B) — Lifecycle enum parity lock.
 *
 * TWO shipped UI pages drove their <select> option values from local
 * arrays that had drifted away from the backend contract, so CREATE
 * failed against the live route:
 *
 *   * legal-holds/page.tsx sent `kind` = LITIGATION/REGULATORY/… (a
 *     litigation *category*), but POST /v1/lifecycle/legal-holds
 *     validates `kind` against LEGAL_HOLD_KINDS (a *scope*:
 *     EVIDENCE/CASE/WORKSPACE/ORGANIZATION) → zod parse failure.
 *   * retention/page.tsx sent `template` = STANDARD_1Y/STANDARD_3Y/
 *     LEGAL_HOLD_EXEMPT, but the retention engine only accepts
 *     RETENTION_POLICY_TEMPLATES (INSURANCE_7Y/JOURNALISM_10Y/
 *     CORPORATE_5Y/CUSTOM) → POLICY_REJECTED (409).
 *
 * The frontend has no JS test runner, so we string-scan each page's
 * option array and assert it is a SUBSET of the canonical shared
 * contract enum. This makes the drift structurally impossible to
 * re-ship: adding a UI value that the route does not validate breaks
 * this suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LEGAL_HOLD_KINDS,
  RETENTION_POLICY_TEMPLATES,
} from "@proovra/shared";
import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

/**
 * Extract the string members of a `const NAME = [ "A", "B" ] as const;`
 * array literal from source text. Deliberately narrow: it targets the
 * single named declaration and pulls every double-quoted token inside
 * the bracket pair.
 */
function extractStringArray(source: string, constName: string): string[] {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const m = re.exec(source);
  if (!m) {
    throw new Error(`could not find const ${constName} array in source`);
  }
  const body = m[1];
  const tokens = body.match(/"([^"]+)"/g) ?? [];
  return tokens.map((t) => t.replace(/"/g, ""));
}

describe("phase2 lifecycle enum parity — UI option values are a subset of the contract", () => {
  it("legal-holds page `kind` options are all valid LEGAL_HOLD_KINDS", () => {
    const source = readWeb("app/(app)/evidence-lifecycle/legal-holds/page.tsx");
    const uiKinds = extractStringArray(source, "HOLD_KINDS");

    expect(uiKinds.length).toBeGreaterThan(0);
    const contract = new Set<string>(LEGAL_HOLD_KINDS);
    for (const kind of uiKinds) {
      expect(
        contract.has(kind),
        `legal-hold UI kind "${kind}" is not in LEGAL_HOLD_KINDS [${[...contract].join(", ")}]`,
      ).toBe(true);
    }
  });

  it("retention page `template` options are all valid RETENTION_POLICY_TEMPLATES", () => {
    const source = readWeb("app/(app)/evidence-lifecycle/retention/page.tsx");
    const uiTemplates = extractStringArray(source, "RETENTION_TEMPLATES");

    expect(uiTemplates.length).toBeGreaterThan(0);
    const contract = new Set<string>(RETENTION_POLICY_TEMPLATES);
    for (const template of uiTemplates) {
      expect(
        contract.has(template),
        `retention UI template "${template}" is not in RETENTION_POLICY_TEMPLATES [${[...contract].join(", ")}]`,
      ).toBe(true);
    }
  });

  it("retention page sends `years` when the CUSTOM template is selected", () => {
    // CUSTOM has no server-side default window; createRetentionPolicy
    // rejects it with `custom_template_requires_years` unless `years`
    // is present in the request body. Lock that the page wires it.
    const source = readWeb("app/(app)/evidence-lifecycle/retention/page.tsx");
    expect(source).toMatch(/template\s*===\s*"CUSTOM"/);
    expect(source).toMatch(/years/);
  });
});
