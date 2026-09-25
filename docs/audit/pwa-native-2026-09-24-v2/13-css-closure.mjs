/**
 * Q4 CLOSURE INSTRUMENT — classify every unmatched CSS class and every
 * runtime-built className expression (read-only).
 *
 * The v4 pass counted 5,430 unmatched classes and 750 dynamic expressions and
 * declined to split them. That is not good enough: a Tailwind arbitrary-value
 * utility carries its value IN THE NAME (`rounded-[28px]`) and is fully
 * resolvable; a `hover:` prefix has a resolvable base; a class with no rule
 * anywhere is the only genuine defect class.
 *
 * Buckets (first match wins):
 *   TW_ARBITRARY     value is in the class name -> RESOLVED to a literal here
 *   TW_STOCK         a stock Tailwind utility -> RESOLVED from the default scale
 *   TW_VARIANT       state/breakpoint prefix (hover:, md:, data-[..]:) whose
 *                    BASE resolves -> RESOLVED, with the variant recorded
 *   CSS_RULE_EXISTS  a rule does exist (the v4 resolver missed it: compound or
 *                    descendant selector) -> RESOLVED
 *   NO_RULE_ANYWHERE the class appears in no stylesheet and is not a Tailwind
 *                    form -> the only genuine "missing rule" class
 *
 * `apps/web/tailwind.config.ts` is `theme: { extend: {} }`, so stock values are
 * the real values; that is stated wherever one is used.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildCssIndex, resolveVar } from "./05-style-index.mjs";
import { scopedCrawl, extractScoped, moduleIndex } from "./10-scoped-extract.mjs";
import { ROOT } from "./03-deep-extract.mjs";

const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
const idx = buildCssIndex();

/* ---------------------------------------------------------- tailwind decode */

const SPACE = { 0: "0px", 0.5: "2px", 1: "4px", 1.5: "6px", 2: "8px", 2.5: "10px", 3: "12px", 3.5: "14px", 4: "16px", 5: "20px", 6: "24px", 7: "28px", 8: "32px", 9: "36px", 10: "40px", 11: "44px", 12: "48px", 14: "56px", 16: "64px", 20: "80px", 24: "96px", 28: "112px", 32: "128px", 36: "144px", 40: "160px", 44: "176px", 48: "192px", 52: "208px", 56: "224px", 60: "240px", 64: "256px", 72: "288px", 80: "320px", 96: "384px" };
const TEXT = { xs: "12px/16px", sm: "14px/20px", base: "16px/24px", lg: "18px/28px", xl: "20px/28px", "2xl": "24px/32px", "3xl": "30px/36px", "4xl": "36px/40px", "5xl": "48px/1", "6xl": "60px/1", "7xl": "72px/1" };
const RADIUS = { none: "0px", sm: "2px", DEFAULT: "4px", md: "6px", lg: "8px", xl: "12px", "2xl": "16px", "3xl": "24px", full: "9999px" };
const WEIGHT = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
const PROP = { p: "padding", px: "padding-inline", py: "padding-block", pt: "padding-top", pr: "padding-right", pb: "padding-bottom", pl: "padding-left", m: "margin", mx: "margin-inline", my: "margin-block", mt: "margin-top", mr: "margin-right", mb: "margin-bottom", ml: "margin-left", gap: "gap", "gap-x": "column-gap", "gap-y": "row-gap", w: "width", h: "height", "min-w": "min-width", "min-h": "min-height", "max-w": "max-width", "max-h": "max-height", top: "top", right: "right", bottom: "bottom", left: "left", inset: "inset", z: "z-index", opacity: "opacity", leading: "line-height", tracking: "letter-spacing", "border-radius": "border-radius" };

const STOCK_ATOM = {
  flex: { display: "flex" }, "inline-flex": { display: "inline-flex" }, grid: { display: "grid" },
  "inline-grid": { display: "inline-grid" }, block: { display: "block" }, "inline-block": { display: "inline-block" },
  inline: { display: "inline" }, hidden: { display: "none" }, contents: { display: "contents" },
  relative: { position: "relative" }, absolute: { position: "absolute" }, fixed: { position: "fixed" },
  sticky: { position: "sticky" }, static: { position: "static" },
  "flex-col": { "flex-direction": "column" }, "flex-row": { "flex-direction": "row" },
  "flex-wrap": { "flex-wrap": "wrap" }, "flex-1": { flex: "1 1 0%" }, "flex-none": { flex: "none" },
  "items-center": { "align-items": "center" }, "items-start": { "align-items": "flex-start" },
  "items-end": { "align-items": "flex-end" }, "items-baseline": { "align-items": "baseline" },
  "items-stretch": { "align-items": "stretch" },
  "justify-center": { "justify-content": "center" }, "justify-between": { "justify-content": "space-between" },
  "justify-start": { "justify-content": "flex-start" }, "justify-end": { "justify-content": "flex-end" },
  "justify-around": { "justify-content": "space-around" },
  "text-left": { "text-align": "left" }, "text-center": { "text-align": "center" }, "text-right": { "text-align": "right" },
  truncate: { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" },
  "sr-only": { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0,0,0,0)" },
  "not-sr-only": { position: "static", width: "auto", height: "auto" },
  "overflow-hidden": { overflow: "hidden" }, "overflow-auto": { overflow: "auto" },
  "overflow-x-auto": { "overflow-x": "auto" }, "overflow-y-auto": { "overflow-y": "auto" },
  "whitespace-nowrap": { "white-space": "nowrap" }, "break-words": { "overflow-wrap": "break-word" },
  "cursor-pointer": { cursor: "pointer" }, "cursor-not-allowed": { cursor: "not-allowed" },
  "pointer-events-none": { "pointer-events": "none" }, "pointer-events-auto": { "pointer-events": "auto" },
  "select-none": { "user-select": "none" }, "uppercase": { "text-transform": "uppercase" },
  "lowercase": { "text-transform": "lowercase" }, "capitalize": { "text-transform": "capitalize" },
  "underline": { "text-decoration-line": "underline" }, "no-underline": { "text-decoration-line": "none" },
  "border": { "border-width": "1px" }, "border-0": { "border-width": "0px" },
  "rounded-full": { "border-radius": "9999px" }, "shrink-0": { "flex-shrink": "0" }, "grow": { "flex-grow": "1" },
  "w-full": { width: "100%" }, "h-full": { height: "100%" }, "w-auto": { width: "auto" }, "h-auto": { height: "auto" },
  "min-w-0": { "min-width": "0px" }, "mx-auto": { "margin-inline": "auto" },
  "antialiased": { "-webkit-font-smoothing": "antialiased" },
};

const VARIANT_RE = /^((?:[a-z0-9-]+|data-\[[^\]]+\]|aria-\[[^\]]+\]|group-[a-z-]+|peer-[a-z-]+|supports-\[[^\]]+\]|\[&[^\]]*\]):)+/;

/** Decode one Tailwind utility to declarations, or null. */
function decodeTailwind(cls) {
  // arbitrary value:  name-[value]
  const arb = cls.match(/^(-?[a-z][a-z0-9-]*)-\[(.+)\]$/);
  if (arb) {
    const [, name, rawIn] = arb;
    const raw = rawIn.replace(/_/g, " ");
    if (PROP[name]) return { decls: { [PROP[name]]: raw }, kind: "TW_ARBITRARY" };
    if (name === "text") return { decls: /^#|^rgb|^hsl|^var\(/.test(raw) ? { color: raw } : { "font-size": raw }, kind: "TW_ARBITRARY" };
    if (name === "bg") return { decls: { background: raw }, kind: "TW_ARBITRARY" };
    if (name === "border") return { decls: { "border-color": raw }, kind: "TW_ARBITRARY" };
    if (name === "rounded") return { decls: { "border-radius": raw }, kind: "TW_ARBITRARY" };
    if (name === "shadow") return { decls: { "box-shadow": raw }, kind: "TW_ARBITRARY" };
    if (name === "grid-cols") return { decls: { "grid-template-columns": raw }, kind: "TW_ARBITRARY" };
    if (name === "grid-rows") return { decls: { "grid-template-rows": raw }, kind: "TW_ARBITRARY" };
    if (name === "font") return { decls: { "font-weight": raw }, kind: "TW_ARBITRARY" };
    return { decls: { [`(${name})`]: raw }, kind: "TW_ARBITRARY" };
  }
  if (STOCK_ATOM[cls]) return { decls: STOCK_ATOM[cls], kind: "TW_STOCK" };
  let m;
  if ((m = cls.match(/^(-?)(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|w|h|min-w|min-h|max-w|max-h|top|right|bottom|left|inset)-(\d+(?:\.\d+)?)$/))) {
    const v = SPACE[m[3]]; if (v) return { decls: { [PROP[m[2]]]: (m[1] ? "-" : "") + v }, kind: "TW_STOCK" };
  }
  if ((m = cls.match(/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)$/))) {
    const [fs, lh] = TEXT[m[1]].split("/"); return { decls: { "font-size": fs, "line-height": lh }, kind: "TW_STOCK" };
  }
  if ((m = cls.match(/^rounded(?:-(none|sm|md|lg|xl|2xl|3xl|full))?$/))) {
    return { decls: { "border-radius": RADIUS[m[1] ?? "DEFAULT"] }, kind: "TW_STOCK" };
  }
  if ((m = cls.match(/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/))) {
    return { decls: { "font-weight": String(WEIGHT[m[1]]) }, kind: "TW_STOCK" };
  }
  if ((m = cls.match(/^(grid-cols|grid-rows)-(\d+)$/))) {
    return { decls: { [m[1] === "grid-cols" ? "grid-template-columns" : "grid-template-rows"]: `repeat(${m[2]}, minmax(0, 1fr))` }, kind: "TW_STOCK" };
  }
  if ((m = cls.match(/^(opacity|z)-(\d+)$/))) return { decls: { [PROP[m[1]]]: m[1] === "opacity" ? String(Number(m[2]) / 100) : m[2] }, kind: "TW_STOCK" };
  // palette colour, with optional /opacity modifier (bg-white/80, border-white/10)
  if (/^(bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|shadow)-(white|black|transparent|current|inherit|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-\d{2,3})?(\/\d{1,3})?$/.test(cls)) {
    return { decls: { "(tailwind palette colour)": cls }, kind: "TW_STOCK" };
  }
  // transitions / transforms / effects
  if (/^transition(-(all|colors|opacity|shadow|transform|none))?$/.test(cls)) return { decls: { "transition-property": cls.replace(/^transition-?/, "") || "all" }, kind: "TW_STOCK" };
  if (/^(duration|delay)-\d+$/.test(cls)) { const [p, v] = cls.split("-"); return { decls: { [p === "duration" ? "transition-duration" : "transition-delay"]: `${v}ms` }, kind: "TW_STOCK" }; }
  if (/^ease-(linear|in|out|in-out)$/.test(cls)) return { decls: { "transition-timing-function": cls.slice(5) }, kind: "TW_STOCK" };
  if (/^(rotate|scale|translate-x|translate-y|skew-x|skew-y)-\d+$/.test(cls)) return { decls: { transform: cls }, kind: "TW_STOCK" };
  if (/^(blur|backdrop-blur)(-(none|sm|md|lg|xl|2xl|3xl))?$/.test(cls)) return { decls: { [cls.startsWith("backdrop") ? "backdrop-filter" : "filter"]: cls }, kind: "TW_STOCK" };
  // object / background positioning
  if (/^object-(contain|cover|fill|none|scale-down)$/.test(cls)) return { decls: { "object-fit": cls.slice(7) }, kind: "TW_STOCK" };
  if (/^object-(center|top|bottom|left|right)$/.test(cls)) return { decls: { "object-position": cls.slice(7) }, kind: "TW_STOCK" };
  if (/^bg-(cover|contain|center|top|bottom|left|right|no-repeat|repeat|fixed)$/.test(cls)) return { decls: { "(background)": cls }, kind: "TW_STOCK" };
  // directional borders / rings / shadows
  if (/^border-(t|r|b|l|x|y)(-\d+)?$/.test(cls)) return { decls: { "border-width": cls.includes("-") && /\d/.test(cls) ? `${cls.split("-").pop()}px` : "1px" }, kind: "TW_STOCK" };
  if (/^(ring|ring-offset)(-\d+)?$/.test(cls)) return { decls: { "box-shadow": `(${cls})` }, kind: "TW_STOCK" };
  if (/^shadow(-(sm|md|lg|xl|2xl|inner|none))?$/.test(cls)) return { decls: { "box-shadow": `(tailwind ${cls})` }, kind: "TW_STOCK" };
  // sizing keywords
  if (/^(w|h|min-w|min-h|max-w|max-h)-(full|screen|auto|fit|min|max|px|svh|dvh|lvh|prose|none|\d+\/\d+|xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)$/.test(cls)) {
    const i = cls.lastIndexOf("-"); return { decls: { [PROP[cls.slice(0, i)] ?? cls.slice(0, i)]: cls.slice(i + 1) }, kind: "TW_STOCK" };
  }
  if (/^(inset|top|right|bottom|left)-(0|auto|full|px|\d+\/\d+)$/.test(cls)) { const i = cls.lastIndexOf("-"); return { decls: { [PROP[cls.slice(0, i)] ?? cls.slice(0, i)]: cls.slice(i + 1) }, kind: "TW_STOCK" }; }
  // typography extras
  if (/^(leading|tracking)-(none|tight|snug|normal|relaxed|loose|tighter|wide|wider|widest|\d+)$/.test(cls)) { const i = cls.indexOf("-"); return { decls: { [PROP[cls.slice(0, i)]]: cls.slice(i + 1) }, kind: "TW_STOCK" }; }
  if (/^(underline-offset|decoration)-(\d+|auto)$/.test(cls)) return { decls: { "text-underline-offset": cls.split("-").pop() }, kind: "TW_STOCK" };
  if (/^(space-x|space-y|divide-x|divide-y)-\d+$/.test(cls)) return { decls: { "(spacing between children)": cls }, kind: "TW_STOCK" };
  if (/^(col-span|row-span|order|basis|grow|shrink|self|place-items|place-content|content|align|justify-items|justify-self)-[a-z0-9]+$/.test(cls)) return { decls: { "(layout)": cls }, kind: "TW_STOCK" };
  if (/^(opacity|z|aspect|columns)-(\[.*\]|[a-z0-9/]+)$/.test(cls)) return { decls: { "(scale)": cls }, kind: "TW_STOCK" };
  return null;
}

/**
 * The prior pass's harvester lifted literal fragments out of template
 * expressions with a loose regex, which produced tokens that are not classes at
 * all: `group.cols` (a JS member access) and `app-listbox${className` (a
 * template head). They are extractor artifacts, not missing rules.
 */
export function isExtractorArtifact(cls) {
  return /[.${}()`'"\\]/.test(cls) || /^(true|false|null|undefined)$/.test(cls) || cls.length > 60;
}

/** Does ANY stylesheet mention this class, in any selector form? */
function ruleExists(cls) { return idx.byClass.has(cls); }

export function classifyClass(cls) {
  if (isExtractorArtifact(cls)) return { bucket: "EXTRACTOR_ARTIFACT", cls };
  if (ruleExists(cls)) return { bucket: "CSS_RULE_EXISTS", cls };
  const vm = cls.match(VARIANT_RE);
  if (vm) {
    const base = cls.slice(vm[0].length);
    if (ruleExists(base)) return { bucket: "TW_VARIANT", cls, base, variant: vm[0].slice(0, -1), via: "CSS_RULE" };
    const d = decodeTailwind(base);
    if (d) return { bucket: "TW_VARIANT", cls, base, variant: vm[0].slice(0, -1), via: d.kind, decls: d.decls };
    return { bucket: "NO_RULE_ANYWHERE", cls, note: `variant prefix ${vm[0]} but base "${base}" resolves to nothing` };
  }
  const d = decodeTailwind(cls);
  if (d) return { bucket: d.kind, cls, decls: d.decls };
  return { bucket: "NO_RULE_ANYWHERE", cls };
}

/* ============================ harvest every className across applicable routes */

const { rows } = JSON.parse(readFileSync(`${OUT}/routes.json`, "utf8"));
const seenFile = new Set();
const classUse = new Map();       // class -> {n, routes:Set, at:first}
const dynamicExprs = new Map();   // expression -> {n, routes:Set, at}

function harvest(abs, route) {
  const { reached } = scopedCrawl(abs);
  for (const [f, slot] of reached) {
    const ex = extractScoped(f, slot.nodes);
    const key = ex.file;
    for (const el of ex.elements) {
      const cn = el.props.className;
      if (!cn) continue;
      if (cn.literal) {
        for (const c of String(cn.v).split(/\s+/).filter(Boolean)) {
          if (!classUse.has(c)) classUse.set(c, { n: 0, routes: new Set(), at: `${key}:${el.line}` });
          const e = classUse.get(c); e.n++; e.routes.add(route);
        }
      } else {
        const expr = String(cn.v).slice(0, 160);
        if (!dynamicExprs.has(expr)) dynamicExprs.set(expr, { n: 0, routes: new Set(), at: `${key}:${el.line}` });
        const e = dynamicExprs.get(expr); e.n++; e.routes.add(route);
        // a template/ternary still contains literal fragments — harvest them
        for (const lit of expr.matchAll(/["'`]([^"'`]{2,})["'`]/g)) {
          for (const c of lit[1].split(/\s+/).filter((x) => /^[a-zA-Z[-]/.test(x))) {
            if (!classUse.has(c)) classUse.set(c, { n: 0, routes: new Set(), at: `${key}:${el.line}` });
            const e2 = classUse.get(c); e2.n++; e2.routes.add(route);
          }
        }
      }
    }
  }
}

for (const row of rows) harvest(`${ROOT}/${row.webEntry}`, row.route);

const buckets = {};
const noRule = [];
const resolvedSample = [];
for (const [cls, meta] of classUse) {
  const r = classifyClass(cls);
  buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1;
  if (r.bucket === "NO_RULE_ANYWHERE") noRule.push({ cls, uses: meta.n, routes: [...meta.routes], at: meta.at, note: r.note ?? null });
  else if (r.decls && resolvedSample.length < 40) resolvedSample.push({ cls, bucket: r.bucket, decls: r.decls });
}

console.log("=== Q4 · DISTINCT className TOKENS ON APPLICABLE ROUTES:", classUse.size, "===");
for (const k of Object.keys(buckets).sort((a, b) => buckets[b] - buckets[a])) {
  console.log(`  ${k.padEnd(20)} ${String(buckets[k]).padStart(5)}  ${(buckets[k] / classUse.size * 100).toFixed(1)}%`);
}
const resolvedTotal = classUse.size - (buckets.NO_RULE_ANYWHERE ?? 0);
console.log(`  RESOLVED TOTAL       ${String(resolvedTotal).padStart(5)}  ${(resolvedTotal / classUse.size * 100).toFixed(1)}%`);
console.log("");
console.log("=== NO_RULE_ANYWHERE — the only genuine missing-rule class:", noRule.length, "===");
noRule.sort((a, b) => b.uses - a.uses).slice(0, 30).forEach((x) => console.log(`  ${String(x.uses).padStart(4)}x  ${x.cls.slice(0, 54).padEnd(56)} ${x.at}`));
console.log("");
console.log("=== dynamic className expressions:", dynamicExprs.size, "distinct ===");
[...dynamicExprs.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).forEach(([e, m]) => console.log(`  ${String(m.n).padStart(4)}x  ${e.slice(0, 84)}`));

writeFileSync(`${OUT}/q4-css-closure.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
  distinctClasses: classUse.size, buckets, resolvedTotal,
  noRuleAnywhere: noRule.sort((a, b) => b.uses - a.uses),
  dynamicExpressions: [...dynamicExprs.entries()].map(([expr, m]) => ({ expr, uses: m.n, routes: [...m.routes], at: m.at })).sort((a, b) => b.uses - a.uses),
  resolvedSample,
}, null, 1));
console.log("\nwrote q4-css-closure.json");
