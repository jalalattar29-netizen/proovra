/**
 * V3 INSTRUMENT — style resolution for BOTH platforms (read-only).
 *
 * WEB  : index every authored stylesheet (build output excluded) into
 *        selector -> declarations, then resolve `var(--x)` transitively through
 *        tokens.css to a literal. A class with no rule is reported, never
 *        silently defaulted. Stock Tailwind utilities are resolved from a small
 *        explicit table and FLAGGED as stock (apps/web/tailwind.config.ts is
 *        `theme: { extend: {} }`, so it carries no PROOVRA values).
 *
 * NATIVE: parse packages/ui/src/tokens/proovra.generated.ts into
 *        `color.ink.primary` -> literal, so `theme.color.ink.primary` in a screen
 *        resolves to the same kind of literal the web side produces.
 *
 * The point is LEVEL 5 of the comparison: which APPLICABLE ELEMENT uses which
 * RESOLVED value on each platform — not whether a token name is shared.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/digital-witness";

/* ===================================================================== web CSS */

export function findAuthoredCss() {
  const out = [];
  const skip = new Set(["node_modules", ".next", "dist", "coverage", ".expo", "playwright-report", "test-results"]);
  (function w(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) w(f);
      else if (e.name.endsWith(".css")) out.push(f);
    }
  })(join(ROOT, "apps/web"));
  return out;
}

/** Strip comments, split into {selector, decls, atRule}. */
function parseCss(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let i = 0, buf = "", stack = [];
  while (i < clean.length) {
    const c = clean[i];
    if (c === "{") {
      const head = buf.trim(); buf = "";
      if (head.startsWith("@")) { stack.push(head); i++; continue; }
      // read body
      let depth = 1, body = "";
      i++;
      while (i < clean.length && depth > 0) {
        if (clean[i] === "{") depth++;
        else if (clean[i] === "}") { depth--; if (!depth) break; }
        body += clean[i]; i++;
      }
      i++;
      const decls = {};
      for (const d of body.split(";")) {
        const k = d.indexOf(":");
        if (k < 0) continue;
        const prop = d.slice(0, k).trim();
        const val = d.slice(k + 1).trim();
        if (prop && val && !prop.includes("{")) decls[prop] = val;
      }
      rules.push({ selector: head, decls, atRule: stack.length ? stack.join(" / ") : null });
      continue;
    }
    if (c === "}") { stack.pop(); buf = ""; i++; continue; }
    buf += c; i++;
  }
  return rules;
}

export function buildCssIndex() {
  const files = findAuthoredCss();
  const byClass = new Map();   // class -> [{file, selector, decls, atRule}]
  const customProps = new Map(); // --name -> raw value (last :root wins)
  let ruleCount = 0;
  for (const f of files) {
    const rules = parseCss(readFileSync(f, "utf8"));
    ruleCount += rules.length;
    for (const r of rules) {
      for (const [p, v] of Object.entries(r.decls)) {
        if (p.startsWith("--") && /(^|,)\s*:root\s*$/.test(r.selector.replace(/\s+/g, " "))) customProps.set(p, v);
        if (p.startsWith("--") && r.selector.trim() === ":root") customProps.set(p, v);
      }
      for (const m of r.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        const cls = m[1];
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push({ file: f.replace(ROOT + "/", "").split("\\").join("/"), selector: r.selector.trim(), decls: r.decls, atRule: r.atRule });
      }
    }
  }
  return { files: files.length, ruleCount, byClass, customProps };
}

/** Resolve var(--x[, fallback]) transitively. Returns {value, chain, unresolved}. */
export function resolveVar(value, customProps, seen = new Set()) {
  const chain = [];
  let v = value, guard = 0;
  while (/var\(/.test(v) && guard++ < 24) {
    const m = v.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/);
    if (!m) break;
    const name = m[1];
    if (seen.has(name)) return { value: v, chain, unresolved: `circular ${name}` };
    seen.add(name); chain.push(name);
    const repl = customProps.has(name) ? customProps.get(name) : (m[2] ?? null);
    if (repl === null) return { value: v, chain, unresolved: `${name} is not declared in :root` };
    v = v.slice(0, m.index) + repl + v.slice(m.index + m[0].length);
  }
  return { value: v.trim(), chain, unresolved: /var\(/.test(v) ? "var() still present" : null };
}

/* Stock Tailwind utilities actually used by this app, resolved to defaults and FLAGGED. */
const TW = {
  flex: { display: "flex" }, "inline-flex": { display: "inline-flex" }, grid: { display: "grid" },
  hidden: { display: "none" }, block: { display: "block" }, relative: { position: "relative" },
  absolute: { position: "absolute" }, fixed: { position: "fixed" }, sticky: { position: "sticky" },
  "items-center": { "align-items": "center" }, "items-start": { "align-items": "flex-start" },
  "justify-between": { "justify-content": "space-between" }, "justify-center": { "justify-content": "center" },
  "text-center": { "text-align": "center" }, "text-left": { "text-align": "left" },
  "font-bold": { "font-weight": "700" }, "font-semibold": { "font-weight": "600" }, "font-medium": { "font-weight": "500" },
  truncate: { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" },
  "w-full": { width: "100%" }, "h-full": { height: "100%" }, "min-w-0": { "min-width": "0px" },
  "sr-only": { position: "absolute", width: "1px", height: "1px", overflow: "hidden" },
};
const TW_SCALE = { 0: "0px", 1: "0.25rem", 2: "0.5rem", 3: "0.75rem", 4: "1rem", 5: "1.25rem", 6: "1.5rem", 8: "2rem", 10: "2.5rem", 12: "3rem" };
const TW_PREFIX = { p: "padding", px: "padding-inline", py: "padding-block", m: "margin", mx: "margin-inline", my: "margin-block", gap: "gap", "mt": "margin-top", "mb": "margin-bottom" };

export function resolveTailwind(cls) {
  if (TW[cls]) return { decls: TW[cls], stock: true };
  const m = cls.match(/^(p|px|py|m|mx|my|mt|mb|gap)-(\d+)$/);
  if (m && TW_SCALE[m[2]] && TW_PREFIX[m[1]]) return { decls: { [TW_PREFIX[m[1]]]: TW_SCALE[m[2]] }, stock: true };
  return null;
}

/**
 * Resolve one className string to the set of declarations it contributes.
 * Returns { resolved: {prop:{value,from,chain}}, unresolvedClasses: [...] }.
 * NOTE: which declaration finally WINS is a runtime fact (cascade + specificity
 * + conditional class application). Competing rules are returned, not collapsed.
 */
export function resolveClassName(classString, idx) {
  const resolved = {}, unresolved = [], competing = [];
  const classes = String(classString).split(/\s+/).filter(Boolean).filter((c) => !/[{}$`]/.test(c));
  for (const cls of classes) {
    const rules = idx.byClass.get(cls);
    if (rules && rules.length) {
      if (rules.length > 1) competing.push({ cls, n: rules.length, where: rules.map((r) => `${r.file}:${r.selector}`) });
      for (const r of rules) {
        for (const [p, v] of Object.entries(r.decls)) {
          if (p.startsWith("--")) continue;
          const rv = resolveVar(v, idx.customProps);
          const entry = { value: rv.value, raw: v, from: `${r.file} ${r.selector}`, chain: rv.chain, atRule: r.atRule, unresolved: rv.unresolved };
          if (resolved[p] && resolved[p].value !== entry.value) {
            (resolved[p].conflicts ??= []).push(entry);
          } else resolved[p] = entry;
        }
      }
      continue;
    }
    const tw = resolveTailwind(cls);
    if (tw) { for (const [p, v] of Object.entries(tw.decls)) resolved[p] ??= { value: v, from: "stock tailwind default", stock: true }; continue; }
    unresolved.push(cls);
  }
  return { resolved, unresolvedClasses: unresolved, competing };
}

/* ============================================================== native tokens */

/**
 * Build the native token index by EVALUATING the real modules rather than
 * re-parsing them. `proovra.generated.ts` + `proovra.ts` + `theme.ts` are plain
 * data with no React/RN imports once types are erased, so they run standalone.
 * This yields the literal a screen actually receives for `theme.color.x.y`,
 * including the adapter-computed `elevation` shadows — which a textual parse
 * cannot produce.
 */
export async function buildNativeTokenIndex() {
  const load = async (abs) => {
    const { createRequire } = await import("node:module");
    const ts = createRequire(`${ROOT}/apps/mobile/package.json`)("typescript");
    let src = readFileSync(abs, "utf8");
    // rewrite the workspace alias + extensionless relatives to data-URL-safe inline imports
    return { ts, src };
  };
  const { createRequire } = await import("node:module");
  const ts = createRequire(`${ROOT}/apps/mobile/package.json`)("typescript");
  const tr = (p) => ts.transpileModule(readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
  }).outputText;

  const gen = tr(`${ROOT}/packages/ui/src/tokens/proovra.generated.ts`);
  let proovra = tr(`${ROOT}/packages/ui/src/tokens/proovra.ts`);
  let themeSrc = tr(`${ROOT}/apps/mobile/src/theme/theme.ts`);

  const genMod = await import(`data:text/javascript,${encodeURIComponent(gen)}`);
  // proovra.ts imports from "./proovra.generated.js" — inline that module's exports
  const genPrelude = Object.entries(genMod)
    .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join("\n");
  proovra = proovra.replace(/^\s*import[^\n]*\n/gm, "");
  const proovraMod = await import(`data:text/javascript,${encodeURIComponent(genPrelude + "\n" + proovra)}`);

  themeSrc = themeSrc.replace(/^\s*import[^\n]*\n/gm, "");
  const themePrelude = `const proovraTokens = ${JSON.stringify(proovraMod.proovraTokens)};`;
  const themeMod = await import(`data:text/javascript,${encodeURIComponent(themePrelude + "\n" + themeSrc)}`);

  const flat = new Map();
  (function walk(obj, path) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const key = path ? `${path}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
      else flat.set(key, v);
    }
  })(themeMod.theme, "");
  return flat;
}

/** `theme.color.ink.primary` -> literal (theme.ts passes proovraTokens through). */
export function resolveThemeToken(expr, tokenIdx) {
  const key = expr.replace(/^theme\./, "");
  if (tokenIdx.has(key)) return { value: tokenIdx.get(key), key };
  for (const suffix of [".DEFAULT", ".default"]) if (tokenIdx.has(key + suffix)) return { value: tokenIdx.get(key + suffix), key: key + suffix };
  return { value: null, key, unresolved: "not present in proovra.generated.ts (may be an adapter-computed value such as elevation)" };
}

/* ======================================================================= main */
if (process.argv[1] && process.argv[1].endsWith("05-style-index.mjs")) {
  const idx = buildCssIndex();
  console.log("authored css files:", idx.files, " rules:", idx.ruleCount, " classes:", idx.byClass.size, " :root custom props:", idx.customProps.size);
  const tok = await buildNativeTokenIndex();
  console.log("native token leaves:", tok.size);
  for (const k of ["color.ink.primary", "color.surface.app", "color.accent.a500", "space.s3"]) {
    console.log("  ", k, "=", tok.get(k));
  }
  const probe = resolveClassName("app-shell-v2 flex items-center", idx);
  console.log("probe resolved props:", Object.keys(probe.resolved).length, "unresolved:", probe.unresolvedClasses);
}
