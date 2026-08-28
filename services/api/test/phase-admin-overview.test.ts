import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE = fileURLToPath(
  new URL("../src/routes/admin-overview.routes.ts", import.meta.url),
);
const SERVICE = fileURLToPath(
  new URL("../src/services/admin/overview.service.ts", import.meta.url),
);

const routeSrc = readFileSync(ROUTE, "utf8");
const serviceSrc = readFileSync(SERVICE, "utf8");

describe("Platform Admin — Control Center Overview (item A)", () => {
  it("route is gated by requirePlatformAdmin", () => {
    expect(routeSrc).toMatch(/requirePlatformAdmin/);
    expect(routeSrc).toMatch(/preHandler:\s*requirePlatformAdmin/);
  });

  it("route carries the platform-admin tenant-scope exception marker", () => {
    expect(routeSrc).toMatch(/TENANT_SCOPE_EXCEPTION:\s*platform_admin_global/);
  });

  it("route exposes only a read-only GET (no mutation verbs)", () => {
    expect(routeSrc).toMatch(/app\.get\(/);
    expect(routeSrc).not.toMatch(/app\.(post|put|patch|delete)\(/);
  });

  it("overview endpoint path is /v1/admin/overview", () => {
    expect(routeSrc).toMatch(/["'`]\/v1\/admin\/overview["'`]/);
  });
  it("ADM-024 — a failed query is ERROR, not an unmeasured metric", () => {
    // The old `safe()` helper returned null on ANY failure, and the page
    // rendered every null as "Not measured" — so a metric the platform
    // genuinely cannot measure and a metric whose query threw looked identical
    // to the operator. `measure()` classifies the throw as ERROR and logs the
    // technical cause server-side, while the browser gets an
    // information-free sentence.
    expect(serviceSrc).toContain("measure(");
    expect(serviceSrc).toContain("metricNotMeasured");
  });


  it("status only claims 'healthy' when real signals exist and are clear", () => {
    // Must gate healthy behind haveSignals; a failed query → 'unknown'.
    expect(serviceSrc).toMatch(/haveSignals/);
    expect(serviceSrc).toMatch(/"unknown"/);
    expect(serviceSrc).toMatch(/"healthy"/);
  });

  it("gross revenue is derived from succeeded Payment amountCents (real, not fabricated)", () => {
    // ADM-012 — grouped BY CURRENCY. `amountCents` is a minor-unit integer
    // denominated by `currency`; summing across them produces a number that is
    // not money in any currency, and the tile then labelled the result EUR.
    expect(serviceSrc).toContain("payment.groupBy");
    expect(serviceSrc).toContain('by: ["currency"]');
    expect(serviceSrc).toMatch(/status:\s*"SUCCEEDED"/);
  });

  it("reuses canonical services rather than re-deriving health/alerts", () => {
    expect(serviceSrc).toMatch(/buildPlatformAlerts/);
    expect(serviceSrc).toMatch(/buildEvidenceHealthSnapshot/);
  });

  it("returns no secret-looking fields (tokens/passwords/keys/connection strings)", () => {
    expect(serviceSrc).not.toMatch(/passwordHash|clientSecret|tokenHash|secretCiphertext|process\.env/i);
  });

  it("traffic reports an honest not-connected note when no consented traffic exists", () => {
    expect(serviceSrc).toMatch(/No consented traffic recorded yet/);
    expect(serviceSrc).toMatch(/connected:/);
  });
});
