/**
 * G0 CLOSURE — resolve the 28 `HOOK_RETURNED_CALLABLE` bindings (read-only).
 *
 * These were labelled runtime-unknown. They are not: each names a callable that
 * is either
 *   (a) destructured from a custom hook's return object  -> resolve the hook,
 *   (b) a member of a props object (`links.onUnlink`, `handlers.onOpen`) -> resolve
 *       the object's producer at the call site, or
 *   (c) an inline body whose effect is visible in place (DOM select, clipboard).
 *
 * For each we resolve the DECLARING body and its terminal effects, and record the
 * exact file:line of the declaration so the route registers can be updated.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve as pres } from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./03-deep-extract.mjs";
import { resolveImport } from "./03-deep-extract.mjs";

const ts = createRequire(`${ROOT}/apps/mobile/package.json`)("typescript");
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;

const cache = new Map();
const sf = (abs) => {
  if (!cache.has(abs)) cache.set(abs, ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return cache.get(abs);
};

const EFFECT = [
  [/\bapiFetch\s*\(|\bfetch\s*\(|["'`]\/v1\//, "API"],
  [/\brouter\.(push|replace|back)\b|\bredirect\s*\(|window\.location|window\.open/, "NAV"],
  [/notifyApiError|toSafeUserError|setError\b|toast|setBanner|setNotice/, "FEEDBACK"],
  [/\bset[A-Z]\w*\s*\(|\bdispatch\s*\(/, "STATE"],
  [/setOpen|setShow|setDialog|setModal|onClose|setConfirm/, "DIALOG"],
  [/createObjectURL|revokeObjectURL|saveAs|\.download\b|Blob\s*\(/, "DOWNLOAD"],
  [/navigator\.clipboard|writeText/, "CLIPBOARD"],
  [/\.select\(\)|\.focus\(\)|preventDefault|stopPropagation/, "DOM_FOCUS"],
  [/localStorage|sessionStorage/, "STORAGE"],
];
const effectsOf = (t) => EFFECT.filter(([re]) => re.test(t)).map(([, k]) => k);

/** Find `const { NAME, ... } = useHook(...)` in a file; return the hook name. */
function hookProducing(abs, name) {
  const s = sf(abs);
  let hook = null;
  const visit = (n) => {
    if (hook) return;
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)) {
      const callee = n.initializer.expression.getText(s);
      if (/^use[A-Z]/.test(callee)) {
        if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const bound = (el.propertyName ?? el.name).getText(s);
            if (bound === name) { hook = callee; return; }
          }
        } else if (ts.isIdentifier(n.name) && n.name.text === name.split(".")[0]) { hook = callee; return; }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  return hook;
}

/** Locate a declaration by name in a file (function, const, or object-literal property). */
function declIn(abs, name) {
  if (!existsSync(abs)) return null;
  const s = sf(abs);
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
    else if (ts.isPropertyAssignment(n) && n.name.getText(s).replace(/['"]/g, "") === name) found = n.initializer;
    else if (ts.isShorthandPropertyAssignment(n) && n.name.text === name) found = n;
    ts.forEachChild(n, visit);
  };
  visit(s);
  if (!found) return null;
  const line = s.getLineAndCharacterOfPosition(found.getStart(s)).line + 1;
  return { text: found.getText(s), line };
}

/** Where is `useHook` declared? same file, or an import. */
function locateHook(abs, hookName) {
  if (declIn(abs, hookName)) return abs;
  const s = sf(abs);
  let spec = null;
  const visit = (n) => {
    if (spec) return;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const names = [];
      if (c?.name) names.push(c.name.text);
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push(e.name.text);
      if (names.includes(hookName)) spec = n.moduleSpecifier.text;
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  if (!spec) return null;
  return resolveImport(spec, abs);
}

/* ======================================================================= main */
const q5 = JSON.parse(readFileSync(`${OUT}/q5-closure-final.json`, "utf8"));
const targets = q5.rows.filter((r) => r.final === "STILL_UNBOUND");
const out = [];

for (const r of targets) {
  const abs = `${ROOT}/${r.file}`;
  const expr = String(r.expr ?? "");
  // 1. direct inline effects
  let eff = new Set(effectsOf(expr));
  const trail = [];

  // 2. identifiers that look like callables: `foo()` or `obj.foo(`
  const ids = [...expr.matchAll(/\b([a-z_$][\w$]*)\s*(?:\.\s*([a-zA-Z_$][\w$]*)\s*)?\(/g)]
    .map((m) => (m[2] ? `${m[1]}.${m[2]}` : m[1]))
    .filter((x) => !["if", "for", "while", "void", "return", "Set", "Array", "String", "Number", "Boolean", "catch", "then", "filter", "map", "forEach", "find"].includes(x.split(".")[0]));

  for (const id of new Set(ids)) {
    const base = id.split(".")[0];
    const member = id.includes(".") ? id.split(".")[1] : null;

    // same-file declaration first
    let d = declIn(abs, member ? base : id);
    let where = r.file;
    let via = "same-file";

    if (!d) {
      const hook = hookProducing(abs, member ? base : id);
      if (hook) {
        const hookFile = locateHook(abs, hook);
        if (hookFile) {
          const hd = declIn(hookFile, hook);
          if (hd) {
            // find the returned key inside the hook body
            const inner = member ? member : id;
            const keyRe = new RegExp(`\\b${inner}\\s*[,:}]`);
            d = { text: hd.text, line: hd.line };
            where = hookFile.replace(`${ROOT}/`, "");
            via = `hook ${hook}${keyRe.test(hd.text) ? " (key present in return)" : ""}`;
          }
        }
      }
    }
    if (d) {
      trail.push({ id, declaredIn: where, line: d.line, via });
      for (const x of effectsOf(d.text.slice(0, 6000))) eff.add(x);
      // one more hop: named callees inside that body, same file
      for (const m of d.text.matchAll(/\b([a-z_$][\w$]*)\s*\(/g)) {
        const d2 = declIn(`${ROOT}/${where}`, m[1]);
        if (d2) for (const x of effectsOf(d2.text.slice(0, 6000))) eff.add(x);
      }
    } else {
      trail.push({ id, declaredIn: null, via: "unresolved" });
    }
  }

  out.push({
    file: r.file, line: r.line, prop: r.prop, expr: expr.slice(0, 140),
    effects: [...eff].sort(),
    trail,
    verdict: eff.size ? "RESOLVED_TO_EFFECT" : "NO_EFFECT_DETECTED",
  });
}

const hist = {};
for (const o of out) hist[o.verdict] = (hist[o.verdict] ?? 0) + 1;
console.log("=== G0 · 28 HOOK_RETURNED_CALLABLE closure ===");
for (const k of Object.keys(hist)) console.log(`  ${k.padEnd(24)} ${hist[k]}`);
console.log("");
for (const o of out) {
  console.log(`  ${o.verdict === "RESOLVED_TO_EFFECT" ? "OK " : "?? "} [${o.effects.join(",") || "-"}]  ${o.file.replace("apps/web/", "")}:${o.line}`);
  for (const t of o.trail.filter((x) => x.declaredIn)) console.log(`         ${t.id} <- ${t.declaredIn}:${t.line}  (${t.via})`);
}

writeFileSync(`${OUT}/q5-hook-closure.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5", total: out.length, verdicts: hist, rows: out,
}, null, 1));
console.log("\nwrote q5-hook-closure.json");
