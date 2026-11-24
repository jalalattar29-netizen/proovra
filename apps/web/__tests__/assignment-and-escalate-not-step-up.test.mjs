/**
 * Stage B — T-036 / T-037: assignment (single or bulk) and raising an
 * escalation are not step-up actions, so no client wraps them in
 * `runStepUpAction`. On e4e908e88 the Queues row assign, the console assign and
 * the inspector's escalation create were wrapped in a runner the server never
 * triggered, which read as if those acts were step-up gated.
 *
 * Scans every web source file for a `runStepUpAction(` call and reads the call
 * by parenthesis matching; none may post the assign routes or the escalation
 * create route.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["app", "components", "lib"].map((d) => join(WEB, d));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function callBody(src, start) {
  let depth = 0;
  for (let i = src.indexOf("(", start); i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const FORBIDDEN = [
  { re: /\/reviews\/\$\{[^}]+\}\/assign[`"']/, what: "single assign" },
  { re: /\/reviews\/\$\{[^}]+\}\/reassign[`"']/, what: "single reassign" },
  { re: /\/v1\/reviewer\/bulk\/assign/, what: "bulk assign" },
  { re: /["'`]\/v1\/reviewer-ops\/escalations["'`]/, what: "escalation create" },
  { re: /\bbulkAssign\(/, what: "bulk assign helper" },
];

test("no client wraps assignment or escalation create in runStepUpAction", () => {
  const offenders = [];
  for (const file of ROOTS.flatMap(walk)) {
    const src = readFileSync(file, "utf8");
    let at = src.indexOf("runStepUpAction(");
    while (at !== -1) {
      const body = callBody(src, at);
      for (const f of FORBIDDEN) {
        if (f.re.test(body)) offenders.push(`${relative(WEB, file)}: ${f.what}`);
      }
      at = src.indexOf("runStepUpAction(", at + 1);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the scan sees the wrappers that remain (approve/decisions are still wrapped)", () => {
  const inspector = readFileSync(join(WEB, "app/(app)/reviewer-ops/[reviewId]/page.tsx"), "utf8");
  const at = inspector.indexOf("runStepUpAction(");
  assert.ok(at > -1);
  assert.match(callBody(inspector, at), /\/decisions/);
});
