/**
 * GENERATE the cross-platform token module FROM the web design authority.
 *
 * `packages/ui/src/tokens/proovra.ts` was hand-mirrored from
 * `apps/web/lib/design-tokens/tokens.css`: two physical files holding the same
 * values, with a drift guard that checked 27 of them. 63 of the CSS file's
 * custom properties were mirrored and ~95 were not, so a native surface simply
 * had no counterpart for most of the design language — which is why Native
 * reads as a different product rather than a differently-shaped one.
 *
 * This reads the `:root` block and EMITS the module, so there is one authored
 * source (the CSS) and one derived artefact. Re-run it after changing
 * tokens.css; `test/tokens-generated.test.mjs` fails if the checked-in file and
 * a fresh generation disagree, which is what makes the drift impossible rather
 * than merely detected.
 *
 *   node packages/ui/tools/generate-tokens.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOKENS_CSS = resolve(HERE, "../../../apps/web/lib/design-tokens/tokens.css");
export const OUT_TS = resolve(HERE, "../src/tokens/proovra.generated.ts");

/** Every `--name: value;` inside the FIRST `:root { … }` block. */
export function parseRootTokens(rawCss) {
  // Strip comments FIRST. tokens.css documents several decisions in long
  // `/* … */` blocks INSIDE :root, and those contain both `;` and `--name:`
  // text, so a declaration scan over the raw source swallows prose as a value.
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(":root");
  if (start < 0) throw new Error("tokens.css has no :root block");
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open + 1, end);
  const out = new Map();
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    // A later declaration wins in CSS; mirror that so the generated value is
    // the one the browser actually renders.
    out.set(m[1], m[2].trim());
  }
  return resolveAliases(out);
}

/**
 * Flatten `var(--other)` indirection to a literal value.
 *
 * The browser resolves these at paint time; React Native has no `var()` and no
 * cascade, so an alias emitted verbatim would reach a StyleSheet as the literal
 * string "var(--surface-app)" and render as nothing. Resolved here so native
 * receives the same COLOUR the browser paints — the alias is a web authoring
 * convenience, not a value. A `var(--x, fallback)` uses the fallback when the
 * target is undefined, exactly as CSS would.
 */
export function resolveAliases(vars) {
  const out = new Map(vars);
  // Matches a var() anywhere in the value, not only as the whole value: the
  // composite font shorthands embed `var(--font-sans, …)` inside a larger
  // declaration, and leaving those unresolved would ship a literal "var(…)"
  // string to a StyleSheet.
  const VAR = /var\(\s*--([a-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/i;
  const resolve1 = (value, seen) => {
    let current = value;
    for (let guard = 0; guard < 32; guard += 1) {
      const m = VAR.exec(current);
      if (!m) return current.trim();
      const [whole, target, fallback] = m;
      if (seen.has(target)) {
        throw new Error(`tokens.css: circular var() reference at --${target}`);
      }
      const next = out.get(target);
      let replacement;
      if (next === undefined) {
        if (fallback === undefined) {
          throw new Error(`tokens.css: --${target} referenced but never declared`);
        }
        replacement = fallback.trim();
      } else {
        replacement = resolve1(next, new Set([...seen, target]));
      }
      current = current.replace(whole, replacement);
    }
    throw new Error(`tokens.css: var() resolution did not settle for "${value}"`);
  };
  for (const [name, value] of out) out.set(name, resolve1(value, new Set([name])));
  return out;
}

/** `--ink-primary` → `primary` within the `ink` group. */
function groupOf(name, prefix) {
  return name.slice(prefix.length + 1);
}

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Numeric px value, or null when the token is not a plain pixel length. */
function px(value) {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Group the flat custom properties into the nested bundle native consumes.
 * Anything that does not fall into a known group is still emitted, under `raw`,
 * so a new web token is AVAILABLE to native immediately instead of silently
 * missing — the failure mode that left 95 tokens with no counterpart.
 */
export function buildTokenModel(vars) {
  const groups = {
    surface: {},
    border: {},
    ink: {},
    accent: {},
    semantic: {},
    status: {},
    radius: {},
    space: {},
    nav: {},
    layout: {},
    raw: {},
  };

  const PREFIX_GROUP = [
    ["surface", "surface"],
    ["border", "border"],
    ["ink", "ink"],
    ["accent", "accent"],
    ["status", "status"],
    ["radius", "radius"],
    ["space", "space"],
    ["nav", "nav"],
  ];

  const SEMANTIC_NAMES = new Set([
    "success", "warning", "error", "info", "danger-500", "orange-fill", "orange-ink",
    "success-ink", "warning-ink", "error-ink", "info-border", "danger-border",
    "danger-strong", "success-standard", "silver-ink", "brand-accent", "focus-ring",
    "hairline", "ink-link",
  ]);

  const LAYOUT_NAMES = new Set([
    "page-max-w", "page-pad-x", "page-pad-y", "header-h", "cell-max-w",
    "adm-w-page", "adm-w-read", "adm-w-wide",
  ]);

  for (const [name, value] of vars) {
    if (LAYOUT_NAMES.has(name)) {
      groups.layout[camel(name)] = px(value) ?? value;
      continue;
    }
    if (SEMANTIC_NAMES.has(name)) {
      groups.semantic[camel(name)] = value;
      continue;
    }
    const hit = PREFIX_GROUP.find(([p]) => name === p || name.startsWith(`${p}-`));
    if (hit) {
      const [prefix, key] = hit;
      const leaf = name === prefix ? "default" : camel(groupOf(name, prefix));
      const num = px(value);
      groups[key][leaf] = key === "radius" || key === "space" ? (num ?? value) : value;
      continue;
    }
    groups.raw[camel(name)] = value;
  }
  return groups;
}

/**
 * `status-verified-bg` → status.verified.bg — the shape AppStatusBadge wants.
 *
 * Split into COMPLETE badge tones (all four of bg/fg/border/solid) and
 * text-only tones. tokens.css declares --status-ok-fg and --status-warn-fg with
 * no surface, because they colour text rather than a badge; emitting them
 * alongside the full tones widened ProovraStatusTone to a union where `.bg`
 * does not exist on every member, and every badge call site stopped type-
 * checking. They are real tokens, so they are kept — just not as badge tones.
 */
export function nestStatus(flat) {
  const grouped = {};
  for (const [k, v] of Object.entries(flat)) {
    const m = /^([a-zA-Z0-9]+?)(Bg|Fg|Border|Solid)$/.exec(k);
    if (!m) continue;
    const tone = m[1];
    grouped[tone] = grouped[tone] ?? {};
    grouped[tone][m[2].toLowerCase()] = v;
  }
  const badge = {};
  const text = {};
  for (const [tone, parts] of Object.entries(grouped)) {
    const complete = ["bg", "fg", "border", "solid"].every((p) => parts[p]);
    if (complete) badge[tone] = parts;
    else text[tone] = parts.fg ?? Object.values(parts)[0];
  }
  return { badge, text };
}

const lit = (v) => (typeof v === "number" ? String(v) : JSON.stringify(v));

/**
 * Some canonical token names begin with a digit (`--space-1`, `--accent-500`),
 * which is a valid CSS name and an invalid JS identifier. Emitting only the
 * canonical key forces every call site into bracket syntax; emitting only an
 * alias would hide the canonical name. So both are emitted, and the prefix is
 * the one the codebase already used before the tokens were derived (`s4`,
 * `a500`) so existing consumers keep working.
 */
const IDENT_PREFIX = { space: "s", accent: "a", radius: "r" };

function withIdentifierAliases(obj, group) {
  const prefix = IDENT_PREFIX[group];
  if (!prefix) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (/^\d/.test(k)) out[`${prefix}${k}`] = v;
  }
  return out;
}

function emitObject(obj, indent = "  ") {
  const lines = Object.entries(obj).map(([k, v]) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
    if (v && typeof v === "object") {
      return `${indent}${key}: {\n${emitObject(v, indent + "  ")}\n${indent}},`;
    }
    return `${indent}${key}: ${lit(v)},`;
  });
  return lines.join("\n");
}

export function renderModule(groups, status) {
  const sections = [
    ["proovraSurface", groups.surface, "Semantic surface backgrounds."],
    ["proovraBorder", groups.border, "Hairline/border tones."],
    ["proovraInk", groups.ink, 'Text ("ink") hierarchy.'],
    ["proovraAccent", withIdentifierAliases(groups.accent, "accent"), "The brand accent ramp."],
    ["proovraSemantic", groups.semantic, "Semantic status colours and their WCAG-tuned ink variants."],
    ["proovraStatus", status.badge, "Status badge palette: bg / fg / border / solid per tone."],
    ["proovraStatusText", status.text, "Text-only status tones (tokens.css declares these without a surface)."],
    ["proovraRadius", withIdentifierAliases(groups.radius, "radius"), "Corner radii (px numbers, ready for RN)."],
    ["proovraSpace", withIdentifierAliases(groups.space, "space"), "Spacing scale (px numbers, ready for RN)."],
    ["proovraNav", groups.nav, "Navigation shell tones."],
    ["proovraLayout", groups.layout, "Layout measures the web shell clamps to."],
    ["proovraRaw", groups.raw, "Every other web token, verbatim, so nothing is unavailable to native."],
  ];

  const body = sections
    .map(([name, obj, doc]) => `/** ${doc} */\nexport const ${name} = {\n${emitObject(obj)}\n} as const;\n`)
    .join("\n");

  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source:    apps/web/lib/design-tokens/tokens.css (:root)
 * Generator: packages/ui/tools/generate-tokens.mjs
 * Guard:     packages/ui/tests/tokens-generated.test.mjs
 *
 * The web renders these as CSS custom properties; native maps them through the
 * StyleSheet adapter in apps/mobile/src/theme. One authored source, two
 * renderers — editing this file instead of the CSS will be overwritten and the
 * guard will fail.
 */

${body}
/** Everything above, as one bundle. */
export const proovraGenerated = {
  surface: proovraSurface,
  border: proovraBorder,
  ink: proovraInk,
  accent: proovraAccent,
  semantic: proovraSemantic,
  status: proovraStatus,
  statusText: proovraStatusText,
  radius: proovraRadius,
  space: proovraSpace,
  nav: proovraNav,
  layout: proovraLayout,
  raw: proovraRaw,
} as const;

export type ProovraStatusTone = keyof typeof proovraStatus;
`;
}

export function generate() {
  const vars = parseRootTokens(readFileSync(TOKENS_CSS, "utf8"));
  const groups = buildTokenModel(vars);
  const status = nestStatus(groups.status);
  return { source: renderModule(groups, status), tokenCount: vars.size };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { source, tokenCount } = generate();
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUT_TS, "utf8");
    if (current !== source) {
      console.error("proovra.generated.ts is stale — re-run: node packages/ui/tools/generate-tokens.mjs");
      process.exit(1);
    }
    console.log(`tokens up to date (${tokenCount} custom properties)`);
  } else {
    writeFileSync(OUT_TS, source);
    console.log(`generated ${OUT_TS} from ${tokenCount} custom properties`);
  }
}
