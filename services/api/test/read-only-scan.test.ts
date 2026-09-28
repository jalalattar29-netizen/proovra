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
    //
    // A portable walk, not `grep -rl` in a shell: on Windows `URL.pathname` is
    // `/D:/…` (not a directory) and there is no `grep`, so the spawn failed
    // with `cmd.exe ENOENT` before the assertion ever ran.
    const { readdirSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const apiRoot = fileURLToPath(new URL("..", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    const users = walk(join(apiRoot, "src"))
      .filter((file) => readFileSync(file, "utf8").includes("isReadOnlyScan"))
      .map((file) => relative(apiRoot, file).split(sep).join("/"))
      .sort();
    expect(users).toEqual(["src/lib/read-only-scan.ts", "src/services/organization/enterprise-contract.service.ts"]);
  });
});
