/**
 * REDESIGN/INTAKE-LINKS — the convergence guard.
 *
 * The intake-links surface used to describe itself with ~120 `React.CSSProperties`
 * objects spread over a 3,187-line page and a 1,950-line console, plus a private
 * palette of literal colours, five native `<select>` controls and browser-default
 * checkboxes. Deleting that once is not the same as keeping it deleted.
 *
 * This file measures every module the route OWNS — `app/(app)/intake-links/**`
 * plus the two `lib/intake-links/*` modules no other surface consumes — and
 * asserts the end state:
 *
 *   1. no presentation objects and no presentation `style={…}` sites,
 *   2. no private colour palette; colour comes from tokens and primitives,
 *   3. no legacy Card / Button / Badge / Modal, and no native `<select>`,
 *   4. every `ilk-*` selector in the stylesheet has a real consumer,
 *   5. every `app-*` class the route names actually exists,
 *   6. one implementation — no V2 route, no parallel console, no `.js`/`.jsx`
 *      twin, and no surviving reference to the deleted console.
 *
 * Source-text assertions, like the rest of this directory's contracts. The
 * BEHAVIOUR the deleted modules used to guarantee is re-proven by the render
 * suites, not by this file.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps/web");
const ROUTE = resolve(WEB, "app/(app)/intake-links");
const MODEL_DIR = resolve(WEB, "lib/intake-links");
const CSS_PATH = join(ROUTE, "intake-links.css");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

function relative(p: string): string {
  return p.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
}

/** A file's text with block and line comments removed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every TS/TSX file the intake-links surface is built from. */
const ROUTE_FILES = walk(ROUTE, /\.tsx?$/);
const MODEL_FILES = walk(MODEL_DIR, /\.tsx?$/);
const OWNED_FILES = [...ROUTE_FILES, ...MODEL_FILES];
const OWNED_SOURCE = OWNED_FILES.map(read).join("\n");
/** The subset that renders — the model modules are data, not presentation. */
const RENDER_FILES = ROUTE_FILES;
const RENDER_SOURCE = RENDER_FILES.map(read).join("\n");

test("the route is actually built from more than one module", () => {
  assert.ok(
    ROUTE_FILES.length >= 12,
    `expected the route to be decomposed, found ${ROUTE_FILES.length} files`,
  );
  assert.ok(existsSync(CSS_PATH), "the route must own a stylesheet");
});

// ===========================================================================
// 1. No presentation objects, no presentation style props
// ===========================================================================

test("the intake-links surface declares no React.CSSProperties objects", () => {
  const offenders = OWNED_FILES.filter((f) =>
    /React\.CSSProperties/.test(stripComments(read(f))),
  ).map(relative);
  assert.deepEqual(
    offenders,
    [],
    "presentation belongs in intake-links.css or the app-* primitives",
  );
});

test("the intake-links surface carries no inline style props", () => {
  const offenders = OWNED_FILES.filter((f) =>
    /\sstyle=\{/.test(stripComments(read(f))),
  ).map(relative);
  assert.deepEqual(offenders, [], "no style={…} site may survive");
});

test("no scoped <style> block is injected to reach a pseudo-class", () => {
  // The old modal shipped a `<style>{…}</style>` sheet purely so its native
  // selects could have a focus ring. Real controls have real states.
  assert.doesNotMatch(stripComments(RENDER_SOURCE), /<style>/);
});

// ===========================================================================
// 2. No private palette, no overrides
// ===========================================================================

test("the intake-links components name no literal colours", () => {
  const offenders: string[] = [];
  for (const f of RENDER_FILES) {
    const src = stripComments(read(f));
    if (/#[0-9a-fA-F]{3,8}\b/.test(src) || /\brgba?\(/.test(src)) {
      offenders.push(relative(f));
    }
  }
  assert.deepEqual(offenders, [], "colour comes from tokens, not call sites");
});

test("the stylesheet carries no !important and no compatibility overrides", () => {
  // Comments are stripped first: the file's own header PROMISES no
  // `!important`, and a promise must not fail the check it describes.
  const css = read(CSS_PATH).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(
    css,
    /\.cases-|\.evd-|\.search-/,
    "the route must not reach into another surface's family",
  );
});

// ===========================================================================
// 3. No legacy primitives, no native select, no unstyled checkbox
// ===========================================================================

test("the surface consumes no legacy Card / Button / Badge / Modal", () => {
  const offenders = OWNED_FILES.filter((f) =>
    /from "[^"]*(components\/ui\/(Card|Button|Badge)|components\/ui-legacy)"/.test(
      read(f),
    ),
  ).map(relative);
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(
    stripComments(RENDER_SOURCE),
    /<(Card|Button|Badge|Modal|Select|Input)[\s/>]/,
    "the canonical app-* primitives are the only ones this surface uses",
  );
});

test("the surface renders no native <select>", () => {
  // A native select renders the OS popup: it cannot be styled, it cannot
  // escape a clipping ancestor, and it cannot be audited for keyboard
  // behaviour. AppListbox is the one option control.
  assert.doesNotMatch(stripComments(RENDER_SOURCE), /<select[\s/>]/);
  assert.doesNotMatch(stripComments(RENDER_SOURCE), /<optgroup[\s/>]/);
  assert.match(RENDER_SOURCE, /<AppListbox\b/);
});

test("every checkbox is the canonical one and every radio is a choice card", () => {
  // Whole `<input …/>` elements, so the assertion does not depend on whether
  // `type` happens to be written before or after `className`.
  const inputs = [
    ...stripComments(RENDER_SOURCE).matchAll(/<input\b[\s\S]*?\/>/g),
  ].map((m) => m[0]);

  const checkboxes = inputs.filter((el) => /type="checkbox"/.test(el));
  assert.ok(checkboxes.length > 0, "the wizard must render checkboxes");
  for (const c of checkboxes) {
    assert.match(
      c,
      /className="app-checkbox"/,
      "a browser-default checkbox survived",
    );
  }

  const radios = inputs.filter((el) => /type="radio"/.test(el));
  assert.ok(radios.length > 0, "the wizard must render radios");
  for (const r of radios) {
    assert.match(
      r,
      /className="ilk-choice__input"/,
      "a native unstyled radio circle survived",
    );
  }
});

test("the row actions menu is a menu, not a selector", () => {
  const menu = read(join(ROUTE, "_components/RowActionsMenu.tsx"));
  assert.match(menu, /role="menu"/);
  assert.match(menu, /role="menuitem"/);
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /AppAnchoredOverlay/, "the menu must escape the table");
  assert.doesNotMatch(stripComments(menu), /<select/);
});

// ===========================================================================
// 4. Every ilk-* selector has a consumer
// ===========================================================================

test("every ilk-* selector in intake-links.css has a real consumer", () => {
  const css = read(CSS_PATH).replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (m[1].startsWith("ilk-")) declared.add(m[1]);
  }
  assert.ok(declared.size > 50, "the stylesheet should describe the surface");

  // A dynamic family is a class assembled at runtime — `ilk-x--${variant}`.
  const dynamicFamilies = [
    ...RENDER_SOURCE.matchAll(/["'`]([a-zA-Z0-9_ -]*ilk-[a-zA-Z0-9_-]*)\$\{/g),
  ].map((m) => m[1].trim());

  const orphans = [...declared]
    .filter((cls) => {
      if (new RegExp(`\\b${cls}\\b`).test(RENDER_SOURCE)) return false;
      return !dynamicFamilies.some((prefix) => prefix && cls.startsWith(prefix));
    })
    .sort();

  assert.deepEqual(
    orphans,
    [],
    "a selector nothing renders is dead presentation — delete it",
  );
});

// ===========================================================================
// 5. Every app-* class the route names exists
// ===========================================================================

test("every app-* class the intake-links surface names is declared by the primitives", () => {
  const primitives = read(
    resolve(WEB, "components/app-primitives/app-primitives.css"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set<string>();
  for (const m of primitives.matchAll(/\.([a-zA-Z0-9_-]+)/g)) declared.add(m[1]);

  const used = new Set<string>();
  for (const m of RENDER_SOURCE.matchAll(/className=\{?["'`]([^"'`]+)["'`]/g)) {
    for (const cls of m[1].split(/\s+/)) {
      const stem = cls.split("$")[0];
      if (stem.startsWith("app-")) used.add(stem);
    }
  }
  assert.ok(used.size > 10, "the surface should consume the primitives");
  const missing = [...used].filter((c) => !declared.has(c)).sort();
  assert.deepEqual(missing, [], "a class the primitives do not define is a typo");
});

// ===========================================================================
// 6. One implementation
// ===========================================================================

test("the deleted operations console leaves no reference behind", () => {
  const deleted = [
    "apps/web/components/intake-links/IntakeLinksOperationsConsole.tsx",
    "apps/web/components/intake-links/IntakeLinkDeliveryDrawer.tsx",
  ];
  for (const p of deleted) {
    assert.ok(!existsSync(resolve(REPO_ROOT, p)), `${p} must be deleted`);
  }
  assert.doesNotMatch(OWNED_SOURCE, /IntakeLinksOperationsConsole/);
  assert.doesNotMatch(OWNED_SOURCE, /components\/intake-links\//);
});

test("there is exactly one intake-links route and no V2 twin", () => {
  const appDir = resolve(WEB, "app/(app)");
  const siblings = readdirSync(appDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /intake/i.test(e.name))
    .map((e) => e.name)
    .sort();
  assert.deepEqual(siblings, ["intake-links"]);
  assert.ok(existsSync(join(ROUTE, "page.tsx")));
});

test("no compiled .js / .jsx twin shadows a route module", () => {
  const twins = walk(ROUTE, /\.(js|jsx)$/).map(relative);
  assert.deepEqual(twins, [], "a stale compiled twin can shadow the TS source");
});

test("the orchestrator stays an orchestrator", () => {
  const page = read(join(ROUTE, "page.tsx"));
  const lines = page.split("\n").length;
  assert.ok(
    lines < 650,
    `page.tsx is ${lines} lines — presentation has crept back into the orchestrator`,
  );
  // It must mount the canonical shell and the canonical gate.
  assert.match(page, /<PageRouteGate routeId="workspace\.intake_links">/);
  assert.match(page, /<PageShell/);
  assert.match(page, /import "\.\/intake-links\.css"/);
});

test("the public contributor page is untouched by this route's stylesheet", () => {
  // `/intake/[token]` is a separate, deliberately unstyled-by-us surface.
  const publicPage = read(resolve(WEB, "app/intake/[token]/page.tsx"));
  assert.doesNotMatch(publicPage, /intake-links\.css/);
  assert.doesNotMatch(publicPage, /\bilk-/);
});

test("every exported symbol of the route's lib modules is consumed", () => {
  // An export nothing imports is dead surface area that the next migration
  // has to re-read before it can delete it.
  const libFiles = walk(join(ROUTE, "_lib"), /\.ts$/);
  const consumers = OWNED_SOURCE;
  const unconsumed: string[] = [];
  for (const f of libFiles) {
    const src = read(f);
    for (const m of src.matchAll(
      /^export (?:const|function|type|enum) ([A-Za-z0-9_]+)/gm,
    )) {
      const name = m[1];
      const uses = [...consumers.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
      // One occurrence is the declaration itself.
      if (uses <= 1) unconsumed.push(`${relative(f)}:${name}`);
    }
  }
  assert.deepEqual(unconsumed, [], "delete an export nothing consumes");
});

// ===========================================================================
// 7. The one shared primitive this redesign added
// ===========================================================================

test("the added success-alert selector has exactly one definition, and no rival", () => {
  const primitivesPath = resolve(
    WEB,
    "components/app-primitives/app-primitives.css",
  );
  const css = read(primitivesPath).replace(/\/\*[\s\S]*?\*\//g, "");
  const definitions = [...css.matchAll(/^\.app-alert--ok\s*\{/gm)].length;
  assert.equal(definitions, 1, "one authority, or it is not an authority");

  // No rival success-alert selector anywhere in the product stylesheets.
  const rivals: string[] = [];
  for (const file of walk(resolve(WEB, "app"), /\.css$/).concat(
    walk(resolve(WEB, "components"), /\.css$/),
    walk(resolve(WEB, "lib"), /\.css$/),
  )) {
    const body = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of body.matchAll(
      /\.(app-alert--(?:ok|success|green)|alert--success|success-alert)\s*[,{]/g,
    )) {
      if (file === primitivesPath && m[1] === "app-alert--ok") continue;
      rivals.push(`${relative(file)}: .${m[1]}`);
    }
  }
  assert.deepEqual(rivals, [], "a second success authority is a divergence");
});

test("the intake surface never redefines a shared app-* selector", () => {
  // Route CSS may DESCRIBE its own family and may scope a shared class inside
  // its own table; it may not redefine one, which would silently restyle every
  // other consumer that loads this stylesheet.
  const css = read(CSS_PATH).replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders: string[] = [];
  for (const m of css.matchAll(/^\s*(\.app-[a-zA-Z0-9_-]+)[^{,]*[,{]/gm)) {
    offenders.push(m[1]);
  }
  assert.deepEqual(
    offenders,
    [],
    "a top-level app-* rule here restyles every route that loads it",
  );
});

test("the shared primitives this surface consumes each have ONE implementation", () => {
  const singletons: Array<[string, string, RegExp]> = [
    ["AppListbox", "components/app-primitives", /export function AppListbox\b/],
    [
      "AppAnchoredOverlay",
      "components/app-primitives",
      /export function AppAnchoredOverlay\b/,
    ],
    [
      "AppStatusBadge",
      "components/app-primitives",
      /export function AppStatusBadge\b/,
    ],
    [
      "ConfirmActionProvider",
      "components/ui",
      /export function ConfirmActionProvider\b/,
    ],
  ];
  for (const [name, , pattern] of singletons) {
    const hits = walk(resolve(WEB, "components"), /\.tsx?$/).filter((f) =>
      pattern.test(read(f)),
    );
    assert.equal(hits.length, 1, `${name} has ${hits.length} implementations`);
  }
  // …and the canonical form controls have one CSS definition each.
  const primitives = read(
    resolve(WEB, "components/app-primitives/app-primitives.css"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const cls of ["app-checkbox", "app-listbox__trigger", "app-dialog"]) {
    const n = [...primitives.matchAll(new RegExp(`^\\.${cls}\\s*[,{]`, "gm"))]
      .length;
    assert.equal(n, 1, `.${cls} is defined ${n} times`);
  }
});

// ===========================================================================
// 8. The public contributor route stays isolated
// ===========================================================================

test("the public contributor route imports nothing this redesign owns", () => {
  const publicFiles = walk(resolve(WEB, "app/intake"), /\.tsx?$/);
  assert.ok(publicFiles.length > 0, "the public route must still exist");
  const offenders: string[] = [];
  for (const f of publicFiles) {
    const src = read(f);
    if (/intake-links/.test(src)) offenders.push(`${relative(f)}: intake-links`);
    if (/\bilk-/.test(src)) offenders.push(`${relative(f)}: ilk-* class`);
    // Management-only authorities.
    for (const admin of [
      "PageRouteGate",
      "INTAKE_LINKS_MANAGE",
      "useCan(",
      "usePlatformContext",
    ]) {
      if (src.includes(admin)) offenders.push(`${relative(f)}: ${admin}`);
    }
  }
  assert.deepEqual(offenders, [], "the contributor surface must stay isolated");
});

test("the management vocabulary never reaches the contributor's own copy", () => {
  // The operator reads "Link disabled"; the contributor is told something the
  // shared contributor-facing copy owns. One must not leak into the other.
  const publicSource = walk(resolve(WEB, "app/intake"), /\.tsx?$/)
    .map(read)
    .join("\n");
  for (const operatorPhrase of [
    "Link disabled",
    "Queued with provider",
    "Sent to provider",
    "Revoked or expired",
    "Failed delivery",
  ]) {
    assert.ok(
      !publicSource.includes(operatorPhrase),
      `operator vocabulary leaked to the contributor page: ${operatorPhrase}`,
    );
  }
});

// ===========================================================================
// 9. One implementation, proven by reachability rather than by filename
// ===========================================================================

test("nothing outside the route imports the route's internals", () => {
  const outside = [
    ...walk(resolve(WEB, "app"), /\.tsx?$/),
    ...walk(resolve(WEB, "components"), /\.tsx?$/),
    ...walk(resolve(WEB, "lib"), /\.tsx?$/),
  ].filter((f) => !f.startsWith(ROUTE));
  const offenders: string[] = [];
  for (const f of outside) {
    const src = read(f);
    if (/intake-links\/_components|intake-links\/_lib/.test(src)) {
      offenders.push(relative(f));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a route-internal module with an outside consumer is a second authority",
  );
});

test("the surface reaches its API only through the canonical client", () => {
  // A raw fetch would bypass the auth header, the error envelope and the
  // origin resolution the canonical client owns.
  const offenders: string[] = [];
  for (const f of ROUTE_FILES) {
    const src = stripComments(read(f));
    if (/\bfetch\s*\(/.test(src) && !/apiFetch/.test(src)) {
      offenders.push(relative(f));
    }
    if (/["'`]\/v1\//.test(src) && !/apiFetch/.test(src)) {
      offenders.push(`${relative(f)} (bare /v1 path)`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the route declares no lazily-reachable alternate implementation", () => {
  const src = stripComments(OWNED_SOURCE);
  assert.doesNotMatch(src, /next\/dynamic/);
  assert.doesNotMatch(src, /React\.lazy|\blazy\s*\(/);
  // A bare dynamic `import(` would hide a second component from every static
  // audit in this file.
  assert.doesNotMatch(src, /[^.\w]import\s*\(/);
});
