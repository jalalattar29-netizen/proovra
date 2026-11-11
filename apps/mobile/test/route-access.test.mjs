/**
 * AUD-0034 — a screen that needs a session is never shown without one.
 *
 * Signed out, 29 of 36 protected stack screens rendered (with a "Signed in as
 * Account" header and permission messages) instead of going to sign-in. The
 * route classification is one pure list (src/auth/route-access.ts); the root
 * layout mounts the gate that applies it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "../app");
const src = readFileSync(resolve(HERE, "../src/auth/route-access.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const R = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/** Every route file under app/, as Expo Router segments. */
function routes() {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tsx") && !name.startsWith("_layout")) {
        const segs = relative(APP, p).replace(/\.tsx$/, "").split(sep);
        if (segs[segs.length - 1] === "index") segs.pop();
        out.push(segs);
      }
    }
  })(APP);
  return out;
}

const PUBLIC = [
  "auth", "forgot-password", "intake/[token]", "intake/capture", "invite/[token]", "legal", "legal/[slug]",
  "mfa", "mfa-recovery-verify", "org-invite/[token]", "portal", "portal/[token]", "portal/accept/[grantId]",
  "portal/work/[workflowId]", "register", "reset-password", "sso-complete", "verify", "verify/[id]",
  "verify/package/[id]", "verify-email", "+not-found",
];

test("every route file is classified, and exactly the public list is open signed out", () => {
  const open = [];
  for (const segs of routes()) {
    const path = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/");
    if (!path) continue; // the root index and the tabs' own index decide for themselves
    if (!R.routeNeedsSession(segs)) open.push(path);
  }
  assert.deepEqual(open.sort(), [...PUBLIC].sort());
});

test("the audit's signed-out screens all need a session", () => {
  for (const path of [
    "billing", "capture", "case/[id]", "collaboration-team/[id]", "continuous-capture", "evidence-archive",
    "evidence-request/[id]", "evidence-requests", "evidence/[id]", "intake-link-create", "intake-links",
    "legal-acceptance", "operations", "operations/batch-analysis", "operations/health", "operations/quotas",
    "organizations", "organizations/[id]", "reports", "screen-capture", "search", "settings/security",
    "settings/privacy", "spaces", "step-up/complete", "support", "trust-center", "workspace-people",
  ]) {
    assert.equal(R.routeNeedsSession(["(stack)", ...path.split("/")]), true, `${path} must need a session`);
  }
  // Tab screens too (their own layout also redirects).
  assert.equal(R.routeNeedsSession(["(tabs)", "cases"]), true);
});

test("a route that is not on the list needs a session (fail closed)", () => {
  assert.equal(R.routeNeedsSession(["(stack)", "some-new-screen"]), true);
  assert.equal(R.routeNeedsSession([]), false);
});

test("the root layout mounts the gate, and the gate replaces the screen with sign-in", () => {
  const layout = readFileSync(resolve(APP, "_layout.tsx"), "utf8");
  assert.match(layout, /<SignedOutRouteGate \/>/);
  const gate = readFileSync(resolve(HERE, "../src/auth/session-end-gate.tsx"), "utf8");
  assert.match(gate, /authReady && !token && routeNeedsSession\(segments\)/);
  assert.match(gate, /router\.replace\("\/\(stack\)\/auth"\)/);
});
