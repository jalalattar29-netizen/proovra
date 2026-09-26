/**
 * The read-only scan scope suppresses USAGE telemetry for a dry run's own
 * call tree — and for nothing running beside it.
 */
import { describe, expect, it } from "vitest";

import { isReadOnlyScan, runReadOnlyScan } from "../src/lib/read-only-scan.js";

describe("read-only scan scope", () => {
  it("is set inside the scan's async call tree and nowhere else", async () => {
    expect(isReadOnlyScan()).toBe(false);
    let concurrentSaw: boolean | null = null;
    const concurrent = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      concurrentSaw = isReadOnlyScan();
    })();
    const inside = await runReadOnlyScan(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return isReadOnlyScan();
    });
    await concurrent;
    expect(inside).toBe(true);
    expect(concurrentSaw).toBe(false);
    expect(isReadOnlyScan()).toBe(false);
  });

  it("the legacy-contract fallback records its use except inside a scan", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/services/organization/enterprise-contract.service.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/if \(!isReadOnlyScan\(\)\) emitTenantAudit\(\{\s*action: "billing\.enterprise_contract_legacy_fallback"/);
    // The ONLY consumer: no authorization or action audit may depend on it.
    const { execSync } = await import("node:child_process");
    const users = execSync("grep -rl isReadOnlyScan src", { cwd: new URL("..", import.meta.url).pathname })
      .toString()
      .trim()
      .split("\n")
      .sort();
    expect(users).toEqual(["src/lib/read-only-scan.ts", "src/services/organization/enterprise-contract.service.ts"]);
  });
});
