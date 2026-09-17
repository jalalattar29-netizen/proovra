/**
 * PV-DIS-001 — A DISABLED CONTROL STATES WHY.
 *
 * The audit measured forty-three controls on twenty-six routes rendered
 * disabled with neither a title nor an aria-describedby, so an operator could
 * not tell a missing permission from a missing plan from an empty required
 * field. The console already did this well in places — this guard makes it
 * the rule on those routes.
 *
 * A control carrying `disabled` must be one of:
 *
 *   REASONED   it states its reason: `disabledReason` (the shared Button and
 *              the components that forward it expose it as the accessible
 *              description, a hover title and data-disabled-reason), `title`,
 *              or `aria-describedby`;
 *   IN_FLIGHT  it is disabled ONLY while a request it (or its row) started is
 *              running — every term of its condition names request state
 *              (busy, loading, creating, exporting, …) or compares such a state
 *              to an id. That state explains itself while it lasts, and it
 *              ends.
 *
 * Anything else — an empty required field, a missing permission, a plan
 * limit, a pagination end, an unmet prerequisite — must say so.
 *
 * The attribute value is read by BRACE MATCHING, not a regex, so a condition
 * written across several lines is read whole.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const APP = join(WEB, "app/(app)");

/** The routes the audit swept (PV-DIS-001), at their current homes. */
const ROUTES = [
  "/admin/audit", "/admin/customers", "/admin/evidence-ops/records",
  "/security-center/identity/timeline", "/admin/operations", "/admin/users",
  "/admin/workspaces", "/evidence-lifecycle/chain-transfers",
  "/evidence-lifecycle/destruction", "/evidence-lifecycle/legal-holds",
  "/evidence-lifecycle/webhooks", "/exchange",
  "/governance-platform/access-reviews", "/governance-platform/cross-org",
  "/governance-platform/delegated-admin", "/governance-platform/departments",
  "/governance-platform/policies", "/governance/policy",
  "/organizations/:id/admin/audit", "/organizations/:id/admin/bulk-invite",
  "/organizations/:id/admin/domains", "/organizations/:id/setup",
  "/redaction", "/redaction/policy", "/security-center", "/settings",
];

const dirFor = (route) => join(APP, route.replace(/^\//, "").replace(/:(\w+)/g, "[$1]"));

function filesFor(route) {
  const dir = dirFor(route);
  const out = [];
  if (existsSync(join(dir, "page.tsx"))) out.push(join(dir, "page.tsx"));
  for (const sub of ["_sections", "_tabs", "_components", "components"]) {
    const d = join(dir, sub);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const n of readdirSync(d)) if (/\.tsx$/.test(n)) out.push(join(d, n));
  }
  return out;
}

/** The text of a `{...}` starting at `open` (the index of `{`), braces matched. */
function braced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The opening tag that contains index `at` (from its `<` to its closing `>`). */
function openingTagAround(src, at) {
  const start = src.lastIndexOf("<", at);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/**
 * Request-state names, by convention rather than by list: the common verbs
 * (busy, loading, creating, …), any name ENDING in Busy / Loading / Saving /
 * InFlight (cookieBusy, downloadBusy, prefsBusy), and a per-row marker that
 * holds the id of the row whose request is running (busyId, replayingId,
 * releasingId). A name outside the convention is not guessed to be in flight.
 */
const IN_FLIGHT_NAME =
  /^(?:busy|loading|creating|saving|submitting|mutating|pending|releasing|replaying|transitioning|inFlight|working|sending|deleting|revoking|refreshing|exporting|loadingMore|busyId)$|^[a-z][A-Za-z]*(?:Busy|Loading|Saving|InFlight)$|^[a-z][A-Za-z]*(?:ing|Busy)Id$/;

function inFlightOnly(expr) {
  const e = expr.replace(/\s+/g, " ").trim();
  if (!e || e === "true") return false;
  return e.split("||").every((raw) => {
    const t = raw.trim().replace(/^\(+|\)+$/g, "").trim();
    if (IN_FLIGHT_NAME.test(t)) return true;
    if (/^status === "saving"$/.test(t)) return true;
    const m = /^([A-Za-z_$][\w$]*)\s*(===|!==)\s*.+$/.exec(t);
    return Boolean(m && IN_FLIGHT_NAME.test(m[1]));
  });
}

function classify() {
  const unreasoned = [];
  let reasoned = 0;
  let inFlight = 0;
  for (const route of ROUTES) {
    for (const file of filesFor(route)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\sdisabled=\{/g)) {
        const open = m.index + m[0].length - 1;
        const expr = braced(src, open) ?? "";
        const tag = openingTagAround(src, m.index);
        const name = /^<([A-Za-z][\w.]*)/.exec(tag)?.[1] ?? "?";
        if (/\s(disabledReason|title|aria-describedby)=/.test(tag)) {
          reasoned += 1;
        } else if (inFlightOnly(expr)) {
          inFlight += 1;
        } else {
          const line = src.slice(0, m.index).split("\n").length;
          unreasoned.push(
            `${relative(APP, file).split("\\").join("/")}:${line} <${name}> disabled={${expr.replace(/\s+/g, " ").trim().slice(0, 80)}}`,
          );
        }
      }
    }
  }
  return { unreasoned, reasoned, inFlight };
}

test("the audited route set is found", () => {
  for (const route of ROUTES) {
    assert.ok(filesFor(route).length > 0, `no source found for ${route}`);
  }
});

test("every disabled control on the audited routes states why, or is only in flight", () => {
  const { unreasoned, reasoned, inFlight } = classify();
  assert.ok(reasoned > 0 && inFlight > 0, "the classifier saw both kinds");
  assert.deepEqual(
    unreasoned,
    [],
    `these controls are disabled with no stated reason (give them disabledReason, ` +
      `title or aria-describedby):\n${unreasoned.join("\n")}`,
  );
});

test("the shared Button exposes the reason to assistive technology", () => {
  const button = readFileSync(join(WEB, "components/ui/Button.tsx"), "utf8");
  assert.match(button, /disabledReason\?: string/);
  assert.match(button, /aria-describedby=\{describedBy\}/);
  assert.match(button, /data-disabled-reason=\{reason \?\? undefined\}/);
});
