/**
 * THE TENANT / OPERATOR RUNTIME BOUNDARY — enforced over every client source.
 *
 * The defect this guards against was not one banner's wording. A platform
 * readiness diagnostic was mounted directly inside ordinary workflow pages
 * (Evidence detail, Home, Governance, reviewer pages), with no statement of
 * which user action it concerned — so a missing Sentry DSN told a Personal
 * user their evidence "may be partial or stale". Rewording it fixed one page;
 * the class of defect is "a status notice with no declared relevance".
 *
 * These rules hold for web AND native, so a new page cannot reintroduce it:
 *
 *   1. Every contextual service notice declares the capabilities of the action
 *      beside it (`requires={[...]}`, literal, known capabilities).
 *   2. The Evidence record's own page never mounts a status notice itself;
 *      notices live inside the sections whose actions they affect.
 *   3. `reviewAutomation` is said only on reviewer surfaces.
 *   4. No client source outside the admin console reads the platform readiness
 *      report (`/v1/admin/runtime/*`) — tenants read `/v1/runtime/status`.
 *   5. The operator diagnostic panel (`RuntimeDegradedNotice`: subsystem
 *      count, subsystem list, runbooks) does not exist to be re-mounted.
 *
 * Deliberately NOT a rule: "no warnings on Evidence". Record-specific
 * processing and integrity alerts belong there and must stay visible.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TENANT_SERVICE_CAPABILITIES } from "@proovra/shared";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__" || name === "test") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = [
  ...walk(resolve(ROOT, "apps/web/app")),
  ...walk(resolve(ROOT, "apps/web/components")),
  ...walk(resolve(ROOT, "apps/web/lib")),
  ...walk(resolve(ROOT, "apps/mobile/app")),
  ...walk(resolve(ROOT, "apps/mobile/src")),
].map((abs) => ({ rel: relative(ROOT, abs).replace(/\\/g, "/"), src: readFileSync(abs, "utf8") }));

/** Strip comments so prose describing the old defect does not trip a rule. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MOUNT = /<RuntimeStatusBanner\b([^>]*)\/?>/g;

test("sanity: the walker sees both clients", () => {
  assert.ok(SOURCES.some((f) => f.rel.startsWith("apps/web/app/(app)/evidence/")));
  assert.ok(SOURCES.some((f) => f.rel.startsWith("apps/mobile/app/(stack)/evidence/")));
  assert.ok(SOURCES.length > 200);
});

test("1. every contextual service notice declares the capabilities of its action", () => {
  const bad: string[] = [];
  let mounts = 0;
  for (const f of SOURCES) {
    for (const m of code(f.src).matchAll(MOUNT)) {
      mounts += 1;
      const req = /requires=\{\[([^\]]*)\]\}/.exec(m[1]);
      if (!req) {
        bad.push(`${f.rel}: ${m[0]}`);
        continue;
      }
      const names = [...req[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      if (names.length === 0 || names.some((n) => !(TENANT_SERVICE_CAPABILITIES as readonly string[]).includes(n))) {
        bad.push(`${f.rel}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(mounts > 0, "no contextual notices found — the rule is checking nothing");
});

test("2. the Evidence record page itself mounts no status notice or indicator", () => {
  for (const rel of ["apps/web/app/(app)/evidence/[id]/page.tsx", "apps/mobile/app/(stack)/evidence/[id].tsx"]) {
    const f = SOURCES.find((s) => s.rel === rel);
    assert.ok(f, `${rel} not found`);
    const c = code(f!.src);
    if (rel.startsWith("apps/web")) {
      assert.doesNotMatch(c, /<RuntimeStatusBanner\b/, `${rel} mounts a status notice over the record`);
    } else {
      // Native renders its sections inline; a notice must sit beside an
      // action, never directly under the screen header.
      const head = c.slice(c.indexOf("<ProovraScreen"), c.indexOf("<ProovraScreen") + 1500);
      assert.doesNotMatch(head, /<RuntimeStatusBanner\b/, `${rel} mounts a status notice above the record`);
    }
    assert.doesNotMatch(c, /<(GlobalRuntimeIndicator|ServiceStatusIndicator)\b/);
  }
});

test("3. review automation is said only on reviewer surfaces", () => {
  const bad = SOURCES.filter((f) => /reviewAutomation/.test(code(f.src).match(MOUNT)?.join(" ") ?? ""))
    .map((f) => f.rel)
    .filter((rel) => !/reviewer/.test(rel));
  assert.deepEqual(bad, []);
});

test("4. no client outside the admin console reads the platform readiness report", () => {
  const bad = SOURCES.filter(
    (f) =>
      !f.rel.includes("/admin/") &&
      /["'`]\/v1\/admin\/runtime\//.test(code(f.src)),
  ).map((f) => f.rel);
  assert.deepEqual(bad, []);
});

test("5. the operator diagnostic panel is gone, and nothing renders an empty subsystem list", () => {
  for (const f of SOURCES) {
    const c = code(f.src);
    assert.doesNotMatch(c, /\bRuntimeDegradedNotice\b/, f.rel);
    assert.doesNotMatch(c, /subsystem\(s\) reported/, f.rel);
    assert.doesNotMatch(c, /Failing subsystems: \$\{/, f.rel);
  }
});
