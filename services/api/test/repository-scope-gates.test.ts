/**
 * The two scope gates ran only by hand, so violations reached a merged branch
 * unseen. Here they run with the unit suite, and CI runs that.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gate(script: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [path.join(API_ROOT, "scripts", script)], {
      cwd: API_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string };
    return { code: failure.status ?? 2, output: failure.stdout ?? "" };
  }
}

describe("repository scope gates", () => {
  it("every mixed-ownership population read resolves through the canonical scope", () => {
    const result = gate("verify-workspace-scope-authorities.mjs");
    expect(result.code, result.output).toBe(0);
  }, 120_000);

  it("every handed-in authorized context is asserted at its read class", () => {
    const result = gate("verify-authorized-context-consumers.mjs");
    expect(result.code, result.output).toBe(0);
  }, 120_000);
});
