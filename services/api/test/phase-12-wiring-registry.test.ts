/**
 * PHASE 12 — executable route-to-surface WIRING REGISTRY (STEP-3 tracker).
 *
 * wiring-registry.json holds one entry per route that was MISSING_PRODUCT_CONSUMER
 * at the start of the STEP-3 convergence (the fixed 130-route baseline). Each
 * entry carries its wiring contract and a `finalState`:
 *   MISSING | WIRED_PRODUCT | PROVEN_EXTERNAL_MACHINE | INTENTIONALLY_INTERNAL | FULL_PARITY_REMOVED
 *
 * A route leaves MISSING ONLY when its real consumer + behavioral proof exist.
 * This suite machine-checks the tracker's integrity and keeps it consistent with
 * the registry slices (slice-e = the live MISSING set the closure gate reads).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const CLASS_DIR = resolve(REPO, "docs/architecture/route-classification");

type Entry = {
  method: string; route: string; family: string; registeringFile: string;
  targetSurface: string; apiClientWrapper: string; contextSource: string;
  authorizationCapability: string; stepUp: string; policyGate: string;
  canonicalService: string; auditEvent: string; proofSuite: string;
  finalState: "MISSING" | "WIRED_PRODUCT" | "PROVEN_EXTERNAL_MACHINE" | "INTENTIONALLY_INTERNAL" | "FULL_PARITY_REMOVED";
};
const registry = JSON.parse(read(join(CLASS_DIR, "wiring-registry.json"))) as Entry[];

// live registered routes
const registered = new Set<string>();
for (const f of readdirSync(resolve(REPO, "services/api/src/routes"))) {
  if (!f.endsWith(".ts")) continue;
  for (const m of read(resolve(REPO, "services/api/src/routes", f)).matchAll(
    /app\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*\n?\s*[`"']([^`"']+)[`"']/g,
  ))
    registered.add(m[2]);
}
// slice-e = live MISSING set
const sliceE = new Set((JSON.parse(read(join(CLASS_DIR, "slice-e.json"))) as Array<{ route: string }>).map((e) => e.route));

const BASELINE = 139; // fixed STEP-3 baseline — HTTP METHOD+PATH operations, not path strings (2026-07-28)
const RESOLVED = new Set(["WIRED_PRODUCT", "PROVEN_EXTERNAL_MACHINE", "INTENTIONALLY_INTERNAL", "FULL_PARITY_REMOVED"]);

describe("Phase 12 — wiring registry integrity", () => {
  it(`covers exactly the ${BASELINE}-route STEP-3 baseline with no duplicate route+method`, () => {
    expect(registry.length).toBe(BASELINE);
    const keys = registry.map((e) => `${e.method} ${e.route}`);
    expect(new Set(keys).size, "duplicate route+method entries").toBe(keys.length);
  });

  it("every MISSING entry is still a registered, unwired route (no phantom, consistent with slice-e)", () => {
    const bad: string[] = [];
    for (const e of registry.filter((x) => x.finalState === "MISSING")) {
      if (!registered.has(e.route)) bad.push(`MISSING but not registered: ${e.route}`);
      if (!sliceE.has(e.route)) bad.push(`MISSING in registry but not in slice-e: ${e.route}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every RESOLVED entry has a complete contract + an existing proof suite, and left slice-e", () => {
    const bad: string[] = [];
    for (const e of registry.filter((x) => RESOLVED.has(x.finalState))) {
      const key = `${e.method} ${e.route} (${e.finalState})`;
      if (!e.targetSurface) bad.push(`${key}: missing targetSurface/machineConsumer`);
      if (!e.canonicalService) bad.push(`${key}: missing canonicalService`);
      if (e.finalState !== "FULL_PARITY_REMOVED" && !e.authorizationCapability) bad.push(`${key}: missing authorizationCapability`);
      if (!e.proofSuite) bad.push(`${key}: missing proofSuite`);
      else {
        const p = e.proofSuite.split(":")[0];
        const abs = p.startsWith("services/") || p.startsWith("apps/") || p.startsWith("e2e/") ? p : join("services/api", p);
        if (!existsSync(resolve(REPO, abs))) bad.push(`${key}: proofSuite not on disk: ${e.proofSuite}`);
      }
      // WIRED/EXTERNAL/INTERNAL routes must still be registered; FULL_PARITY_REMOVED must be gone.
      if (e.finalState === "FULL_PARITY_REMOVED") {
        if (registered.has(e.route)) bad.push(`${key}: FULL_PARITY_REMOVED but still registered`);
      } else if (!registered.has(e.route)) {
        bad.push(`${key}: resolved but route no longer registered`);
      }
      if (sliceE.has(e.route)) bad.push(`${key}: resolved but still in slice-e MISSING set`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("reports STEP-3 convergence counts", () => {
    const counts: Record<string, number> = {};
    for (const e of registry) counts[e.finalState] = (counts[e.finalState] ?? 0) + 1;
    // Visible in test output; not an assertion beyond the baseline conservation.
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(BASELINE);
    // eslint-disable-next-line no-console
    console.log("PHASE 12 STEP-3 wiring:", JSON.stringify(counts));
  });
});
