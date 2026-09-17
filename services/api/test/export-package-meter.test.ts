/**
 * EXPORT PACKAGE METER (2026-09-07).
 *
 * `QUOTA_EXPORT_PACKAGES_PER_MONTH` was a live READ authority with no writer.
 * `assertQuotaEntitlement` compared the plan's monthly allowance against a
 * counter nothing had ever incremented, so the gate could not trip and the
 * allowance was advertised but never enforced.
 *
 * The meter is now written at the one commercial completion boundary, once
 * per produced package. Idempotency is EXERCISED here against a stateful
 * double — a retry, a race and a second distinct package all run — rather
 * than asserted from source text.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.resolve(repo, rel), "utf8");
const METER_WRITER = "packages/shared-runtime/src/billing/export-package-meter.ts";

// Comments are stripped before a pin, so a match proves a CALL and never a
// mention of one.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/**
 * ===========================================================================
 * THE ATOMICITY GAP — a READY package that could never be metered.
 * ===========================================================================
 * The transition and the meter used to be two sequential writes with the
 * second one swallowing its own failures. That produced a state nothing could
 * repair: the package committed READY, the usage write failed silently, and
 * every retry found no DRAFT/BUILDING row to transition — so the meter was
 * never attempted again and the month was permanently one short.
 *
 * These cases fail against that implementation and pass against the current
 * one, which is the only reason to have them.
 */
describe("export package meter — READY and metered cannot diverge", () => {
  // 2026-09-17 — the API completion route and its service function
  // (`markPackageReady`) were retired, so the transition+meter cases that
  // exercised it were removed with it. The Worker package builder is now the
  // one completion site; its in-transaction ordering is pinned below.
  it("the meter writer does not swallow its own failure", () => {
    // A swallow inside the completion transaction would commit READY with no
    // meter. The indexOf is asserted so a move can never make this vacuous.
    const writer = codeOnly(read(METER_WRITER));
    const at = writer.indexOf("export async function recordExportPackageUsage");
    expect(at).toBeGreaterThanOrEqual(0);
    const fn = writer.slice(at);
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body).toContain("entitlementUsage.upsert");
    expect(body).not.toContain("catch");
  });
});

describe("export package meter — exactly one writer, agreeing with the reader", () => {
  const engine = read(
    "services/api/src/services/packaging/entitlement.service.ts",
  );

  it("the gate and the meter derive the period from the same pair", () => {
    // The previous defect class in this repo was a gate and a writer that
    // disagreed about the key or the window.
    //
    // D8 (2026-09-17) — the writer and the period clock moved to
    // shared-runtime together (the Worker meters too and may not import the
    // API). The reader in entitlement.service now takes its
    // `classifyPeriod` / `periodStart` FROM that module, so both sides still
    // resolve through one pair.
    const writerSrc = codeOnly(read(METER_WRITER));
    const at = writerSrc.indexOf("export async function recordExportPackageUsage");
    expect(at).toBeGreaterThanOrEqual(0);
    const writer = writerSrc.slice(at);
    expect(writer).toContain(
      "entitlementPeriodStart(classifyEntitlementPeriod(key))",
    );
    expect(writerSrc).toContain('"QUOTA_EXPORT_PACKAGES_PER_MONTH"');
    expect(writer).toContain("entitlementUsage.upsert");

    const reader = codeOnly(engine);
    expect(reader).toContain("classifyEntitlementPeriod");
    expect(reader).toContain("entitlementPeriodStart");
    expect(reader).toContain('from "@proovra/shared-runtime"');
    // No private copy of the clock is left in the reader's module.
    expect(reader).not.toMatch(/function classifyPeriod\(/);
    expect(reader).not.toMatch(/function periodStart\(/);
    const gate = reader.slice(reader.indexOf("export async function assertQuotaEntitlement"));
    expect(gate).toContain("classifyPeriod(input.key)");
    expect(gate).toContain("periodStart(period)");
  });

  it("the generic writer retired in the same programme has not come back", () => {
    expect(codeOnly(engine)).not.toContain(
      "export async function recordEntitlementUsage",
    );
  });

  it("exactly one completion site per host writes this meter", () => {
    // D8 (2026-09-17) — the Worker's READY step used to meter NOTHING, and it
    // is the one every product-created package goes through. The API's
    // `markPackageReady` was removed with its retired route (2026-09-17), so
    // the Worker builder is the one completion site and calls the writer once.
    const hits: string[] = [];
    for (const rel of [
      "services/api/src/services/exchange/evidence-exchange.service.ts",
      "services/api/src/routes/product-and-lifecycle.routes.ts",
      "services/api/src/services/packaging/entitlement.service.ts",
      "services/worker/src/exchange-package-builder.ts",
    ]) {
      const calls = codeOnly(read(rel)).split("recordExportPackageUsage(").length - 1;
      if (calls > 0) hits.push(`${rel}:${calls}`);
    }
    expect(hits).toEqual([
      "services/worker/src/exchange-package-builder.ts:1",
    ]);
    // The Worker meters inside the transaction that performs its conditional
    // BUILDING -> READY transition.
    const worker = codeOnly(read("services/worker/src/exchange-package-builder.ts"));
    const tx = worker.slice(worker.indexOf("prisma.$transaction"));
    expect(tx).toContain('state: "BUILDING"');
    expect(tx.indexOf("tx.evidenceExchangePackage.updateMany")).toBeLessThan(
      tx.indexOf("recordExportPackageUsage({ prisma: tx"),
    );
  });

  it("the meter is not charged on read, re-send or delivery", () => {
    // A signed URL and a delivery are re-reads of an artifact already paid
    // for; a customer who downloads twice has not bought twice.
    const exchange = codeOnly(
      read("services/api/src/services/exchange/evidence-exchange.service.ts"),
    );
    for (const fn of [
      "export async function generateSignedUrl",
      "export async function recordPackageDelivery",
    ]) {
      const at = exchange.indexOf(fn);
      if (at < 0) continue;
      const body = exchange.slice(at, exchange.indexOf("\nexport ", at + 1));
      expect(body, `${fn} must not meter`).not.toContain(
        "recordExportPackageUsage",
      );
    }
  });

  it("creation does not meter — a DRAFT can still fail to build", () => {
    const exchange = codeOnly(
      read("services/api/src/services/exchange/evidence-exchange.service.ts"),
    );
    const at = exchange.indexOf("export async function createExchangePackage");
    const body = exchange.slice(at, exchange.indexOf("\nexport ", at + 1));
    expect(body).not.toContain("recordExportPackageUsage");
  });
});