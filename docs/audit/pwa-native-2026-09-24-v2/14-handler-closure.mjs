/**
 * Q5 CLOSURE INSTRUMENT — resolve the outstanding handler bindings by
 * enumerating PARENT CALL SITES (read-only).
 *
 * The v4 ledger stopped at "callee X is a prop callback the static graph cannot
 * bind". That is only true for a SINGLE binding; the set of possible bindings is
 * enumerable: find every place the owning component is rendered, read the value
 * passed for that prop, and trace THAT to its terminal effect.
 *
 * For each unresolved entry:
 *   1. identify the owning component (the exported declaration containing the line)
 *   2. find every JSX call site of that component across the repo half it lives in
 *   3. read the expression passed for the prop name
 *   4. trace each such expression to its terminal effects
 *   5. report: ALL call sites resolved / PARTIALLY resolved / genuinely unbound
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./03-deep-extract.mjs";

const ts = createRequire(`${ROOT}/apps/mobile/package.json`)("typescript");
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".expo", "dist", "coverage"].includes(e.name)) continue;
    const f = join(dir, e.name).split("\\").join("/");
    if (e.isDirectory()) walkFiles(f, acc);
    else if (/\.tsx$/.test(e.name)) acc.push(f);
  }
  return acc;
}
const WEB_FILES = walkFiles(`${ROOT}/apps/web/app`).concat(walkFiles(`${ROOT}/apps/web/components`));
const NAT_FILES = walkFiles(`${ROOT}/apps/mobile/app`).concat(walkFiles(`${ROOT}/apps/mobile/src`));

const sfCache = new Map();
function sf(abs) {
  if (!sfCache.has(abs)) {
    sfCache.set(abs, ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  }
  return sfCache.get(abs);
}

/** Which exported component declaration contains this line? */
function ownerComponentAt(abs, line) {
  const s = sf(abs);
  let best = null;
  const visit = (n) => {
    const start = s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1;
    const end = s.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
    if (start <= line && line <= end) {
      let name = null;
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) name = n.name.text;
      if (name && /^[A-Z]/.test(name)) best = { name, start, end };
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  return best;
}

/** Every JSX site rendering <Component ...> with the value passed for `prop`. */
function callSitesFor(component, prop, pool) {
  const out = [];
  for (const f of pool) {
    const src = readFileSync(f, "utf8");
    if (!src.includes(`<${component}`)) continue;
    const s = sf(f);
    const visit = (n) => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) {
        const tag = n.tagName.getText(s);
        if (tag === component || tag.endsWith(`.${component}`)) {
          const line = s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1;
          let passed = null, spread = false;
          for (const a of n.attributes.properties) {
            if (!ts.isJsxAttribute(a)) { spread = true; continue; }
            if (a.name.getText(s) !== prop) continue;
            const init = a.initializer;
            if (init && ts.isJsxExpression(init) && init.expression) passed = init.expression.getText(s).replace(/\s+/g, " ").slice(0, 180);
            else if (init) passed = init.getText(s).slice(0, 180);
          }
          out.push({ file: f.replace(`${ROOT}/`, ""), line, passed, spread });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(s);
  }
  return out;
}

const EFFECT_RULES = [
  [/\bapiFetch\s*\(|\bfetch\s*\(|["'`]\/v1\//, "API"],
  [/\brouter\.(push|replace|back|navigate)\b|\bredirect\s*\(|Linking\.openURL/, "NAV"],
  [/\bAlert\.alert\b|addToast|notifyApiError|toSafeUserError|setError\b|showToast/, "FEEDBACK"],
  [/\bset[A-Z]\w*\s*\(|\bdispatch\s*\(/, "STATE"],
  [/setOpen|setShow|setDialog|setModal|onClose|present\(/, "DIALOG"],
  [/preventDefault|requestSubmit|\.submit\(/, "FORM"],
  [/createObjectURL|Share\.share|FileSystem\.|downloadAsync|saveAs/, "DOWNLOAD"],
  [/AsyncStorage|SecureStore|localStorage|sessionStorage/, "STORAGE"],
];
const effectsOf = (t) => EFFECT_RULES.filter(([re]) => re.test(t)).map(([, tag]) => tag);

/* ======================================================================= main */
const ledger = JSON.parse(readFileSync(`${OUT}/handler-ledger.json`, "utf8"));
const unresolved = ledger.entries.filter((e) => e.verdict === "UNRESOLVED");
const uniq = new Map();
for (const e of unresolved) uniq.set(`${e.file}:${e.line}:${e.prop}`, e);
console.log("distinct UNRESOLVED handler bindings:", uniq.size);

const results = [];
let fully = 0, partly = 0, none = 0;
for (const [key, e] of uniq) {
  const abs = `${ROOT}/${e.file}`;
  if (!existsSync(abs)) { results.push({ ...e, closure: "FILE_MISSING" }); none++; continue; }
  const owner = ownerComponentAt(abs, e.line);
  /* The bound expression may be `onCancel`, `props.onCancel`, `() => onCancel()`
   * or `busy ? undefined : onCancel`. Take the first identifier that LOOKS like a
   * callback prop, not simply the first token — otherwise `busy ? … : onCancel`
   * resolves the prop name to "busy" and every call site reports PROP_NEVER_PASSED. */
  const cands = [...e.expr.matchAll(/\b(on[A-Z]\w*|handle[A-Z]\w*)\b/g)].map((m) => m[1]);
  const bareProp = cands[0] ?? e.expr.trim().replace(/^\(\)\s*=>\s*/, "").replace(/^props\./, "").split(/[^\w$]/)[0];
  const pool = e.side === "web" ? WEB_FILES : NAT_FILES;

  if (!owner) { results.push({ ...e, closure: "NO_OWNER_COMPONENT", note: "the binding is not inside an exported capitalised component" }); none++; continue; }
  const sites = callSitesFor(owner.name, bareProp, pool);
  const withValue = sites.filter((s) => s.passed);
  const eff = new Set();
  for (const s of withValue) {
    for (const x of effectsOf(s.passed)) eff.add(x);
    /* SECOND HOP. A call site usually passes a NAME (`removeToast`,
     * `handleChangePlan`), not a body. Without resolving that name in the call
     * site's own file, every resolution came back with an empty effect set —
     * which would have looked like "bound but does nothing". */
    for (const id of [...String(s.passed).matchAll(/\b([a-z_$][\w$]*)\b/g)].map((m) => m[1])) {
      if (["void", "async", "await", "return", "if", "const", "let", "true", "false", "null", "undefined"].includes(id)) continue;
      const callerAbs = `${ROOT}/${s.file}`;
      if (!existsSync(callerAbs)) continue;
      const cs = sf(callerAbs);
      let body = null;
      const find = (n) => {
        if (body) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === id) body = n.getText(cs);
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id && n.initializer) body = n.initializer.getText(cs);
        ts.forEachChild(n, find);
      };
      find(cs);
      if (body) for (const x of effectsOf(body.slice(0, 4000))) eff.add(x);
    }
  }

  let closure;
  if (sites.length === 0) closure = "NO_CALL_SITE";              // component never rendered with that prop
  else if (withValue.length === sites.length) { closure = "ALL_CALL_SITES_RESOLVED"; fully++; }
  else if (withValue.length > 0) { closure = "PARTIAL"; partly++; }
  else { closure = "PROP_NEVER_PASSED"; none++; }

  results.push({
    side: e.side, route: e.route, file: e.file, line: e.line, prop: e.prop, expr: e.expr,
    ownerComponent: owner.name, propName: bareProp,
    callSites: sites.length, callSitesWithValue: withValue.length,
    effects: [...eff], closure,
    sites: withValue.slice(0, 6).map((s) => ({ at: `${s.file}:${s.line}`, passes: s.passed })),
  });
}

const hist = {};
for (const r of results) hist[r.closure] = (hist[r.closure] ?? 0) + 1;
console.log("\n=== Q5 CLOSURE ===");
for (const k of Object.keys(hist).sort((a, b) => hist[b] - hist[a])) console.log(`  ${k.padEnd(26)} ${hist[k]}`);
const resolvedNow = (hist.ALL_CALL_SITES_RESOLVED ?? 0) + (hist.PARTIAL ?? 0);
console.log(`\nRESOLVED by call-site enumeration: ${resolvedNow} of ${uniq.size}`);
console.log("\n=== sample resolutions ===");
results.filter((r) => r.closure === "ALL_CALL_SITES_RESOLVED").slice(0, 10).forEach((r) =>
  console.log(`  ${r.side} ${r.ownerComponent}.${r.propName} <- ${r.callSites} site(s), effects [${r.effects.join(",")}]  e.g. ${r.sites[0]?.passes?.slice(0, 60)}`));

writeFileSync(`${OUT}/q5-handler-closure.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
  distinctUnresolved: uniq.size, closure: hist, resolvedNow, results,
}, null, 1));
console.log("\nwrote q5-handler-closure.json");
