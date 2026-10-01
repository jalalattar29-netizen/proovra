/**
 * UC-ARCH-007 — device registration, platform attestation and the trust
 * timeline are SERVER-ONLY capabilities: no shipped client calls them.
 *
 * This is the "prove no consumer" half of the decision recorded in the header
 * of routes/capture-trust.routes.ts. If a client starts calling one of these
 * routes, this test fails and the decision (and every surface's copy about
 * device-signed / attested capture) must be revisited — it cannot drift
 * silently. The routes that DO have a consumer (device list + revoke, used by
 * the web Security Center) are asserted to keep it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const CLIENT_ROOTS = ["apps/web", "apps/mobile", "apps/extension"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", "test", "__tests__", "e2e", "docs", "ios", "android"]);

function sources(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

const clientFiles = CLIENT_ROOTS.flatMap((r) => sources(join(REPO, r)));
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const callers = (re: RegExp) => clientFiles.filter((p) => re.test(code(p))).map((p) => p.slice(REPO.length + 1));

describe("UC-ARCH-007 — server-only capture-trust surfaces have no shipped client", () => {
  it("scans the real client trees", () => {
    expect(clientFiles.length).toBeGreaterThan(100);
  });

  it("no client registers a capture device", () => {
    // A POST to the collection path; the web's list (GET) and revoke (…/revoke) are consumers.
    const posts = clientFiles.filter((p) => {
      const src = code(p);
      return /["'`]\/v1\/capture\/devices["'`]\s*,\s*\{[^}]*method:\s*["']POST["']/.test(src);
    });
    expect(posts).toEqual([]);
  });

  it("no client submits a platform attestation or reads a trust timeline", () => {
    expect(callers(/direct-sessions\/[^"'`]*\/attestation/)).toEqual([]);
    expect(callers(/trust-timeline/)).toEqual([]);
  });

  it("the mobile app declares every part unsigned and opens unbound sessions", () => {
    const directCapture = code(join(REPO, "apps/mobile/src/direct-capture.ts"));
    expect(directCapture).toMatch(/signed: null/);
    expect(directCapture).not.toMatch(/deviceId:/);
  });

  it("the device routes that DO have a consumer keep it (web Security Center list + revoke)", () => {
    const web = callers(/\/v1\/capture\/devices/);
    expect(web.some((p) => p.includes("security-center"))).toBe(true);
  });
});
