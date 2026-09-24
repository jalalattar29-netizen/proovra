/**
 * M — STATIC STYLE RESOLVER  (AUDIT INSTRUMENT — read-only)
 *
 * The brief forbids treating a shared token as proof of parity. That rule only
 * has teeth if both sides can be reduced to DECLARED VALUES, so this resolves:
 *
 *   WEB     className -> CSS rule(s) in the 29 stylesheets -> declarations
 *           -> var(--x) chased through tokens.css to a literal
 *           -> stock Tailwind utilities (tailwind.config.ts is `extend: {}`,
 *              so utilities carry DEFAULT Tailwind values, NOT PROOVRA tokens —
 *              a fact that matters and is reported, not smoothed over)
 *
 *   NATIVE  theme.color.surface.app -> packages/ui generated tokens -> literal
 *           StyleSheet.create({...}) -> declared numbers/strings
 *           style={[a, b]} arrays -> each member resolved, later wins
 *
 * Anything that depends on runtime state (a value computed from props, a
 * media query, a class applied conditionally at runtime) is returned as
 * SOURCE-UNRESOLVED with the reason. It is never guessed and never silently
 * dropped.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const REPO = resolve(process.env.PROOVRA_AUDIT_REPO ?? resolve(import.meta.dirname, "..", "..", ".."));
const rel = (abs) => relative(REPO, abs).split(sep).join("/");

/* ------------------------------------------------------------ CSS corpus */

function findCss() {
  const out = [];
  const skip = new Set(["node_modules", ".next", "dist", "coverage", ".expo"]);
  (function w(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) w(f);
      else if (e.name.endsWith(".css")) out.push(f);
    }
  })(join(REPO, "apps/web"));
  return out;
}

/** Strip comments, then split into {selector, body, atRule} rules. */
function parseCss(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const stack = [];
  let i = 0;
  let buf = "";
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === "{") {
      const head = buf.trim();
      buf = "";
      if (/^@/.test(head)) {
        stack.push(head);
      } else {
        // read body to matching close
        let depth = 1;
        let body = "";
        i++;
        while (i < clean.length && depth > 0) {
          if (clean[i] === "{") depth++;
          else if (clean[i] === "}") {
            depth--;
            if (depth === 0) break;
          }
          body += clean[i];
          i++;
        }
        rules.push({ selector: head, body, atRule: stack.length ? stack.join(" / ") : null });
      }
    } else if (ch === "}") {
      if (stack.length) stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
    i++;
  }
  return rules;
}

function declarations(body) {
  const out = {};
  for (const part of body.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!prop || prop.startsWith("/")) continue;
    out[prop] = val;
  }
  return out;
}

/* --------------------------------------------------------- the CSS index */

export function buildCssIndex() {
  const files = findCss();
  /** bare class name -> [{file, selector, atRule, decls}] */
  const byClass = new Map();
  /** custom property -> raw value (last :root declaration wins, as in the cascade) */
  const vars = new Map();
  const varSources = new Map();

  for (const abs of files) {
    const f = rel(abs);
    const rules = parseCss(readFileSync(abs, "utf8"));
    for (const r of rules) {
      const decls = declarations(r.body);
      if (/(^|,)\s*:root\s*$/.test(r.selector) || r.selector.trim() === ":root") {
        for (const [p, v] of Object.entries(decls)) {
          if (p.startsWith("--")) {
            vars.set(p, v);
            if (!varSources.has(p)) varSources.set(p, []);
            varSources.get(p).push({ file: f, value: v });
          }
        }
      }
      for (const sel of r.selector.split(",")) {
        for (const m of sel.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
          const cls = m[1];
          if (!byClass.has(cls)) byClass.set(cls, []);
          byClass.get(cls).push({ file: f, selector: sel.trim(), atRule: r.atRule, decls });
        }
      }
    }
  }
  return { files: files.map(rel), byClass, vars, varSources };
}

/** Chase var(--a, fallback) to a literal. Returns {value, chain, unresolved}. */
export function resolveVar(expr, vars, depth = 0, chain = []) {
  if (depth > 12) return { value: expr, chain, unresolved: "var-cycle" };
  const m = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)/.exec(expr);
  if (!m) return { value: expr.trim(), chain, unresolved: null };
  const name = m[1];
  const fallback = m[2];
  if (!vars.has(name)) {
    if (fallback !== undefined) {
      const next = expr.replace(m[0], fallback);
      return resolveVar(next, vars, depth + 1, [...chain, `${name}→(fallback) ${fallback}`]);
    }
    return { value: expr.trim(), chain, unresolved: `undeclared ${name}` };
  }
  const next = expr.replace(m[0], vars.get(name));
  return resolveVar(next, vars, depth + 1, [...chain, `${name}=${vars.get(name)}`]);
}

/** Resolve one className string to fully-resolved declarations. */
export function resolveClassName(classString, idx) {
  const classes = classString.split(/\s+/).filter(Boolean);
  const out = [];
  for (const cls of classes) {
    if (/[${}`]/.test(cls)) {
      out.push({ class: cls, status: "SOURCE-UNRESOLVED", reason: "class computed at runtime (template expression)" });
      continue;
    }
    const rules = idx.byClass.get(cls);
    if (!rules || rules.length === 0) {
      const tw = tailwindValue(cls);
      out.push(tw
        ? { class: cls, status: "TAILWIND_DEFAULT", resolved: tw, note: "tailwind.config.ts is `extend: {}` — this is a STOCK Tailwind value, not a PROOVRA token" }
        : { class: cls, status: "SOURCE-UNRESOLVED", reason: "no CSS rule in apps/web and not a recognised stock Tailwind utility" });
      continue;
    }
    for (const r of rules) {
      const resolved = {};
      for (const [p, v] of Object.entries(r.decls)) {
        const rv = resolveVar(v, idx.vars);
        resolved[p] = rv.unresolved ? { raw: v, unresolved: rv.unresolved } : { raw: v, value: rv.value, chain: rv.chain };
      }
      out.push({ class: cls, status: "RESOLVED", file: r.file, selector: r.selector, atRule: r.atRule, decls: resolved });
    }
  }
  return out;
}

/* ------------------------------------------- stock Tailwind (subset used) */

const TW_SPACE = { 0: "0px", px: "1px", 0.5: "2px", 1: "4px", 1.5: "6px", 2: "8px", 2.5: "10px", 3: "12px", 3.5: "14px", 4: "16px", 5: "20px", 6: "24px", 7: "28px", 8: "32px", 10: "40px", 12: "48px", 16: "64px", 20: "80px", 24: "96px" };
const TW_TEXT = { xs: "12px/16px", sm: "14px/20px", base: "16px/24px", lg: "18px/28px", xl: "20px/28px", "2xl": "24px/32px", "3xl": "30px/36px", "4xl": "36px/40px" };
const TW_RADIUS = { none: "0px", sm: "2px", DEFAULT: "4px", md: "6px", lg: "8px", xl: "12px", "2xl": "16px", "3xl": "24px", full: "9999px" };
const TW_FONT = { thin: 100, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 };

export function tailwindValue(cls) {
  let m;
  if ((m = /^(p|m)([trblxy])?-(.+)$/.exec(cls)) && TW_SPACE[m[3]]) return { kind: m[1] === "p" ? "padding" : "margin", side: m[2] ?? "all", value: TW_SPACE[m[3]] };
  if ((m = /^gap-(.+)$/.exec(cls)) && TW_SPACE[m[1]]) return { kind: "gap", value: TW_SPACE[m[1]] };
  if ((m = /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl)$/.exec(cls))) return { kind: "font-size/line-height", value: TW_TEXT[m[1]] };
  if ((m = /^rounded(?:-(.+))?$/.exec(cls))) return { kind: "border-radius", value: TW_RADIUS[m[1] ?? "DEFAULT"] };
  if ((m = /^font-(\w+)$/.exec(cls)) && TW_FONT[m[1]]) return { kind: "font-weight", value: TW_FONT[m[1]] };
  if (/^(flex|grid|block|inline-flex|hidden|items-\w+|justify-\w+|flex-\w+|w-full|h-full|absolute|relative|fixed|sticky|truncate|overflow-\w+)$/.test(cls)) return { kind: "layout", value: cls };
  return null;
}

/* ------------------------------------------------------- native tokens */

let TOKENS = null;
export async function nativeTokens() {
  if (TOKENS) return TOKENS;
  const f = join(REPO, "packages/ui/src/tokens/proovra.generated.ts");
  const src = readFileSync(f, "utf8");
  // evaluate the object literals without a bundler: strip TS, keep exports
  const js = src
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/\bexport\s+/g, "globalThis.__t_")
    .replace(/\bas const\b/g, "")
    .replace(/:\s*[A-Za-z_][\w<>.\[\]| ]*(?=\s*=)/g, "");
  try {
    // eslint-disable-next-line no-new-func
    new Function(js)();
  } catch {
    /* fall through to regex extraction */
  }
  const flat = new Map();
  // regex fallback: capture `group = { key: "value", ... }`
  for (const m of src.matchAll(/export const (\w+)\s*=\s*\{([\s\S]*?)\n\}/g)) {
    const group = m[1];
    for (const d of m[2].matchAll(/(\w+)\s*:\s*("([^"]*)"|'([^']*)'|[\d.]+)/g)) {
      flat.set(`${group}.${d[1]}`, (d[3] ?? d[4] ?? d[2]).toString());
    }
  }
  TOKENS = { file: rel(f), flat };
  return TOKENS;
}

/** theme.color.surface.app -> "#F7F8FC" via the generated token groups. */
export async function resolveNativeToken(expr) {
  const t = await nativeTokens();
  const m = /theme\.(color|space|radius|font|type|shadow)\.([\w.]+)/.exec(expr);
  if (!m) return null;
  const path = m[2].split(".");
  const groupMap = {
    surface: "proovraSurface", border: "proovraBorder", ink: "proovraInk",
    accent: "proovraAccent", semantic: "proovraSemantic", status: "proovraStatus",
    statusText: "proovraStatusText", nav: "proovraNav", layout: "proovraLayout",
  };
  if (path.length >= 2 && groupMap[path[0]]) {
    const key = `${groupMap[path[0]]}.${path[1]}`;
    if (t.flat.has(key)) return { token: expr, value: t.flat.get(key), source: t.file };
  }
  if (m[1] === "space" || m[1] === "radius") {
    const g = m[1] === "space" ? "proovraSpace" : "proovraRadius";
    const key = `${g}.${path[0]}`;
    if (t.flat.has(key)) return { token: expr, value: t.flat.get(key), source: t.file };
  }
  return { token: expr, value: null, unresolved: "token path not found in proovra.generated.ts" };
}

/* ------------------------------------------------------------------ CLI */

if (process.argv[2] === "--selftest") {
  const idx = buildCssIndex();
  console.log("css files indexed :", idx.files.length);
  console.log("classes indexed   :", idx.byClass.size);
  console.log("custom properties :", idx.vars.size);
  for (const cls of ["evidence-detail-field", "app-secondary-action", "app-primary-action"]) {
    console.log(`\n--- .${cls} ---`);
    const r = resolveClassName(cls, idx);
    for (const x of r) {
      if (x.status !== "RESOLVED") { console.log("  ", x.status, x.reason ?? ""); continue; }
      console.log("  ", x.file, "|", x.selector, x.atRule ? `[${x.atRule}]` : "");
      for (const [p, v] of Object.entries(x.decls).slice(0, 8)) {
        console.log("      ", p, "=", v.value ?? v.raw, v.chain?.length ? `  (${v.chain.join(" → ")})` : "");
      }
    }
  }
  const t = await nativeTokens();
  console.log("\nnative token entries:", t.flat.size);
  for (const e of ["theme.color.surface.app", "theme.color.ink.primary", "theme.color.border.strong"]) {
    console.log("  ", e, "=>", JSON.stringify(await resolveNativeToken(e)));
  }
}
