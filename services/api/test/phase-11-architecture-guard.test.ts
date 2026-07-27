/**
 * PHASE 11 anti-divergence guard — machine-enforced canonical authority counts.
 * Fails if a second URL builder / deep-link resolver / tenant-audit emission or
 * query authority appears. Structural (authority/count) proof only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "..");
const SHARED = resolve(API, "../../packages/shared/src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
const norm = (p: string, base: string, prefix: string) =>
  prefix + p.slice(base.length + 1).split("\\").join("/");
const API_SRC = walk(resolve(API, "src")).map((f) => ({ rel: norm(f, API, ""), body: readFileSync(f, "utf8") }));
const SHARED_SRC = walk(SHARED).map((f) => ({ rel: norm(f, SHARED, "packages/shared/src/"), body: readFileSync(f, "utf8") }));
const ALL = [...API_SRC, ...SHARED_SRC];
const definers = (re: RegExp) => ALL.filter((f) => re.test(f.body)).map((f) => f.rel).sort();

describe("Phase 11 — canonical authority counts (anti-divergence)", () => {
  it("internal URL builder authority = 1 (only tenant-url.ts defines internalResourcePath)", () => {
    expect(definers(/export function internalResourcePath\b/)).toEqual(["packages/shared/src/tenant-url.ts"]);
  });
  it("deep-link resolver authority = 1", () => {
    expect(definers(/export async function resolveDeepLink\b/)).toEqual([
      "src/services/identity/deep-link-resolution.service.ts",
    ]);
  });
  it("tenant-audit EMISSION authority = 1", () => {
    expect(definers(/export async function emitTenantAudit\b/)).toEqual([
      "src/services/audit/tenant-audit.service.ts",
    ]);
  });
  it("tenant-audit QUERY/EXPORT authority = 1", () => {
    expect(definers(/export async function queryTenantAudit\b/)).toEqual([
      "src/services/audit/tenant-audit.service.ts",
    ]);
  });
  it("the deep-link resolver derives the workspace from the PERSISTED resource + concealed mismatch", () => {
    const src = ALL.find((f) => f.rel.endsWith("deep-link-resolution.service.ts"))!.body;
    expect(src).toMatch(/resolveResourceTeamId/);
    expect(src).toMatch(/context_mismatch/);
  });
  it("the tenant-audit envelope strips secret-shaped keys before the sink", () => {
    const src = ALL.find((f) => f.rel.endsWith("audit/tenant-audit.service.ts"))!.body;
    expect(src).toMatch(/stripSecrets/);
  });

  // §5 — an unwired authority is not convergence: production callers > 0.
  const callers = (re: RegExp) =>
    API_SRC.filter((f) => !f.rel.includes(".service.ts") ? re.test(f.body) : false || (re.test(f.body) && !f.rel.endsWith("deep-link-resolution.service.ts") && !f.rel.endsWith("audit/tenant-audit.service.ts"))).map((f) => f.rel);
  it("resolveDeepLink has a PRODUCTION consumer (route), not just a definition", () => {
    const c = API_SRC.filter((f) => /resolveDeepLink\(/.test(f.body) && !f.rel.endsWith("deep-link-resolution.service.ts"));
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((f) => f.rel.startsWith("src/routes/"))).toBe(true);
  });
  it("queryTenantAudit has a PRODUCTION consumer (authorized route)", () => {
    const c = API_SRC.filter((f) => /queryTenantAudit\(/.test(f.body) && !f.rel.endsWith("audit/tenant-audit.service.ts"));
    expect(c.some((f) => f.rel.startsWith("src/routes/"))).toBe(true);
  });
  it("emitTenantAudit has a PRODUCTION consumer", () => {
    const c = API_SRC.filter((f) => /emitTenantAudit\(/.test(f.body) && !f.rel.endsWith("audit/tenant-audit.service.ts"));
    expect(c.length).toBeGreaterThan(0);
  });
  it("the tenant-url builder has PRODUCTION consumers (migrated producers)", () => {
    const c = API_SRC.filter((f) => /(internalResourcePath|internalNavPath|absoluteInternalUrl|safeIntendedDestination)\(/.test(f.body));
    expect(c.length).toBeGreaterThan(3);
  });

  // §2/§10 — IMPORT LOCK: only the canonical audit authority may reach the
  // low-level hash-chained writer. A new external importer fails this guard.
  it("appendPlatformAuditLog is imported ONLY by the canonical audit facade", () => {
    const importers = API_SRC.filter(
      (f) =>
        /import[\s\S]{0,160}\bappendPlatformAuditLog\b/.test(f.body) &&
        !f.rel.endsWith("platform-audit-log.service.ts"),
    ).map((f) => f.rel);
    expect(importers).toEqual(["src/services/audit/tenant-audit.service.ts"]);
  });
  it("external appendPlatformAuditLog CALL sites = 0 (only the facade calls the sink)", () => {
    const callers = API_SRC.filter(
      (f) =>
        /\bappendPlatformAuditLog\(/.test(f.body) &&
        !f.rel.endsWith("platform-audit-log.service.ts") &&
        !f.rel.endsWith("audit/tenant-audit.service.ts"),
    ).map((f) => f.rel);
    expect(callers).toEqual([]);
  });
});

// ── §5 FINAL ADOPTION + VOCABULARY METRICS (comment-aware production scans) ──
//
// These scans strip line/block comments before matching so a prose mention can
// never satisfy — or falsely trip — a metric. Each metric names the exact
// production expression it counts.
describe("Phase 11 — final adoption metrics (machine-enforced)", () => {
  const WEB = resolve(API, "../../apps/web");
  const MOBILE = resolve(API, "../../apps/mobile");
  const read = (rel: string, base: string) => readFileSync(resolve(base, rel), "utf8");
  const stripComments = (s: string) =>
    // \r first — on a CRLF file `.` stops before \r and the line-comment strip
    // would silently fail, letting prose satisfy (or trip) a metric.
    s.replace(/\r/g, "").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  it("WEB deep-link consumers > 0: the chokepoint exists and a real product surface uses it", () => {
    const hook = read("lib/navigation/useDeepLinkNavigation.ts", WEB);
    expect(hook).toContain("resolveDeepLinkPath"); // composes the ONE web helper
    const bell = stripComments(read("components/app-shell-v2/NotificationBell.tsx", WEB));
    expect(bell).toContain("useDeepLinkNavigation"); // real consumer
    // The helper itself drives the ONE server authority.
    const helper = stripComments(read("lib/api/deep-link.ts", WEB));
    expect(helper).toContain("/v1/deep-link/resolve");
  });

  it("WEB tenant authorization engines = 0: the chokepoint never decides access locally", () => {
    const hook = stripComments(read("lib/navigation/useDeepLinkNavigation.ts", WEB));
    // No membership/capability/lifecycle decision primitives in the client hook.
    expect(/can\(|capabilit|membership|isAllowed|authorize/i.test(hook)).toBe(false);
  });

  it("MOBILE deep-link consumers > 0 and URL tenant inference = 0", () => {
    const gate = stripComments(read("src/DeepLinkGate.tsx", MOBILE));
    expect(gate).toContain("/v1/deep-link/resolve"); // server authority
    const layout = stripComments(read("app/_layout.tsx", MOBILE));
    expect(layout).toContain("DeepLinkGate"); // mounted at the app root
    const authority = stripComments(read("src/deep-link.ts", MOBILE));
    // The parser never reads workspace/team from the URL as truth.
    expect(/searchParams|[?&](workspace|team)=/.test(authority)).toBe(false);
  });

  it("AUDIT UI consumer > 0 and export uses the SAME endpoint (authorities = 1)", () => {
    const tab = stripComments(read("components/workspace-admin/WorkspaceAuditTab.tsx", WEB));
    expect(tab).toContain("/v1/audit/tenant"); // the ONE query/export authority
    expect(tab).toContain('"export", "true"'); // export through the same query
    const panel = stripComments(read("components/workspace-admin/WorkspaceAdminPanel.tsx", WEB));
    expect(panel).toContain("WorkspaceAuditTab"); // wired into the real admin surface
    // No client-side tenant filtering of rows: rows render as returned.
    expect(/items\.filter\(|rows\.filter\(/.test(tab)).toBe(false);
  });

  it("BILLING locator vocabulary = 1: retired ?team= runtime consumers = 0", () => {
    // The ONLY sanctioned reader of the billing workspace param is the locator.
    const billing = stripComments(read("app/(app)/billing/page.tsx", WEB));
    expect(/searchParams\.get\(["']team["']\)/.test(billing)).toBe(false);
    expect(billing).toContain("parseBillingWorkspaceLocator");
    const pricing = stripComments(read("app/pricing/page.tsx", WEB));
    expect(/[?&]team=|[?&]workspace=/.test(pricing)).toBe(false); // no hand-built vocab
    expect(pricing).toContain("buildBillingHref");
  });

  it("V3 is the ONLY current write format (new V1/V2 writes = 0)", () => {
    const writer = API_SRC.find((f) => f.rel.endsWith("platform-audit-log.service.ts"))!;
    const create = writer.body.slice(writer.body.indexOf("adminAuditLog.create"), writer.body.indexOf("adminAuditLog.create") + 700);
    expect(create).toMatch(/chainVersion:\s*3/);
    expect(create).not.toMatch(/chainVersion:\s*[12]\b/);
  });

  it("no skipped non-live Phase-11 test is counted as passing (skip markers = 0)", () => {
    const testDir = resolve(API, "test");
    const phase11Files = readdirSync(testDir).filter((f) => f.startsWith("phase-11-") && f.endsWith(".test.ts"));
    expect(phase11Files.length).toBeGreaterThan(5);
    for (const f of phase11Files) {
      const body = readFileSync(resolve(testDir, f), "utf8");
      expect(/\b(it|describe|test)\.(skip|todo|only)\(/.test(body), `${f} contains a skip/todo/only marker`).toBe(false);
    }
  });
});
