/**
 * `.app-field-label` — ONE declaration, product-wide.
 *
 * There were two. The canonical primitive in `app-primitives.css` set the
 * label tier (12.5px, weight 600, `--app-ink-label`); a second copy near the
 * bottom of `globals.css`, written for a dark admin shell that never used it,
 * set 11px uppercase weight-800 in `rgba(194, 204, 201, 0.56)`.
 *
 * Both are a single class, so specificity ties and SOURCE ORDER decides. The
 * primitive is `@import`ed at the top of `globals.css`, so the pale rule won —
 * and every field label in the authenticated product was painted at 56% alpha
 * on a light surface. It read as helper text, and no component could see why,
 * because nothing in any component or route stylesheet mentioned it.
 *
 * A duplicate that loses is invisible. A duplicate that wins is a second
 * authority. This test allows neither.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const WEB = resolve(dirname(__filename), "..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const PRIMITIVES = "components/app-primitives/app-primitives.css";

/** Every stylesheet the app cascade pulls in, in import order. */
function importedStylesheets(): string[] {
  const globals = read("app/globals.css");
  const imports = [...globals.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]!);
  return [
    ...imports
      .filter((p) => p.startsWith(".") && p.endsWith(".css"))
      .map((p) => resolve(WEB, "app", p).slice(WEB.length + 1).replace(/\\/g, "/")),
    "app/globals.css",
  ];
}

test("the field-label rule is declared exactly once, in the primitive", () => {
  const sheets = importedStylesheets();
  assert.ok(
    sheets.includes(PRIMITIVES),
    "the primitives sheet is no longer in the cascade",
  );

  const declaringSheets: string[] = [];
  for (const sheet of sheets) {
    // A RULE for the bare class — not a compound selector that merely mentions
    // it (`.app-field-label + p`, `.something .app-field-label`), which is a
    // contextual adjustment rather than a second definition of the tier.
    const rules = [...read(sheet).matchAll(/(^|\})\s*\.app-field-label\s*\{/gm)];
    if (rules.length > 0) declaringSheets.push(`${sheet} ×${rules.length}`);
  }
  assert.deepEqual(declaringSheets, [`${PRIMITIVES} ×1`]);
});

test("the one declaration is the label tier, not a pale uppercase variant", () => {
  const css = read(PRIMITIVES);
  const start = css.indexOf(".app-field-label {");
  const body = css.slice(start, css.indexOf("}", start));

  assert.match(body, /color:\s*var\(--app-ink-label\)/);
  assert.match(body, /font-weight:\s*600/);
  // The tier is legible at its size: no uppercase, no 11px, no alpha.
  assert.doesNotMatch(body, /text-transform/);
  assert.doesNotMatch(body, /rgba\(/);
  assert.match(body, /font-size:\s*12\.5px/);
});

test("the retired pale value is gone from the cascade entirely", () => {
  for (const sheet of importedStylesheets()) {
    assert.doesNotMatch(
      read(sheet),
      /\.app-field-label[^{}]*\{[^}]*rgba\(194,\s*204,\s*201/,
      `${sheet} still paints the retired pale label`,
    );
  }
});

// ===========================================================================
// The consumer inventory
// ===========================================================================

/** Every .tsx under the web app, with its path relative to `apps/web`. */
function webComponents(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const root of ["app", "components", "lib"]) {
    (function walk(dir: string) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) {
          out.push([p.slice(WEB.length + 1).replace(/\\/g, "/"), readFileSync(p, "utf8")]);
        }
      }
    })(resolve(WEB, root));
  }
  return out;
}

/**
 * THE INVENTORY.
 *
 * Every file that renders the class, recorded so the blast radius of a change
 * to the one declaration is a fact rather than an estimate. `StatusChangeModal`
 * is listed and is NOT reachable in the running product — nothing imports it —
 * which is why the browser gate measures the other families instead of
 * pretending to visit this one.
 */
const EXPECTED_CONSUMERS = [
  "app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/InvitesTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx",
  "app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx",
  "app/(app)/collaboration-teams/page.tsx",
  "app/(app)/intake-links/_components/LinkCreatedDialog.tsx",
  "app/(app)/intake-links/_components/wizard/fields.tsx",
  // The Operations workbench labels its ownership control with the canonical
  // field label, so the picker announces the same word the operator reads.
  "app/(app)/operations/_components/AssignmentControl.tsx",
  "components/cases-experience/matter-modals/StatusChangeModal.tsx",
  "components/search/SearchAuditLogPanel.tsx",
];

test("the consumer inventory is exactly what the browser gates cover", () => {
  const found = webComponents()
    .filter(([, src]) => src.includes("app-field-label"))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(
    found,
    [...EXPECTED_CONSUMERS].sort(),
    "a new consumer appeared, or one was removed — extend the browser gate to match",
  );
});

test("no consumer paints its own label ink, in any form", () => {
  const offenders: string[] = [];
  for (const [path, src] of webComponents()) {
    if (!src.includes("app-field-label")) continue;
    // Every element that carries the class, and the attributes beside it.
    const re = /className=\{?[`"'][^`"']*app-field-label[^`"']*[`"']\}?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // The label ELEMENT and everything it contains, bounded by its own
      // closing tag. A wider window catches the next component's styles; a
      // narrower one misses a coloured marker nested inside the label, which
      // is exactly where two of them were.
      const from = src.lastIndexOf("<", m.index);
      const close = src.indexOf("</label>", m.index);
      const end = close >= 0 ? close : src.indexOf(">", m.index);
      const subtree = src.slice(from, end);
      if (/style=\{\{[^}]*color/i.test(subtree)) {
        offenders.push(`${path} — inline colour inside a field label`);
      }
      // A second label class alongside would be a second authority by another
      // name.
      if (/app-field-label[^"'`]*\b(label|field)-[a-z-]*label\b/.test(m[0])) {
        offenders.push(`${path} — a competing label class: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("no stylesheet in the cascade appends an override layer for the class", () => {
  const offenders: string[] = [];
  for (const sheet of importedStylesheets()) {
    const css = read(sheet);
    // Any rule that MENTIONS the class and also raises its own priority is an
    // override layer, whatever it is named.
    const re = /([^\n{}]*\.app-field-label[^\n{}]*)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      const selector = m[1]!.trim();
      const body = m[2]!;
      if (/!important/.test(body)) {
        offenders.push(`${sheet}: ${selector} uses !important`);
      }
      // A compound selector that re-states the TIER (colour, size, weight,
      // case) is a second authority wearing a longer name.
      if (
        selector !== ".app-field-label" &&
        /(^|[^-])color:|font-weight:|font-size:|text-transform:/.test(body)
      ) {
        offenders.push(`${sheet}: ${selector} restates the label tier`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the admin shell needs no dark-surface treatment of its own", () => {
  const globals = read("app/globals.css");
  // The shell the pale rule was written beside declares no dark ground — it is
  // `position: relative` and nothing else — so there is no dark surface for a
  // scoped modifier to serve.
  const start = globals.indexOf(".admin-premium-shell {");
  assert.ok(start >= 0, "the admin shell rule is gone; re-check this claim");
  const body = globals.slice(start, globals.indexOf("}", start));
  assert.doesNotMatch(body, /background/);
  assert.doesNotMatch(body, /color/);

  // And nothing under the admin route renders the class, so no admin surface
  // depended on the deleted declaration.
  const adminConsumers = webComponents().filter(
    ([path, src]) =>
      path.startsWith("app/(app)/admin/") && src.includes("app-field-label"),
  );
  assert.deepEqual(adminConsumers.map(([p]) => p), []);
});
