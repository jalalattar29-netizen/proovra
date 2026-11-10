/**
 * AUD-0025 (b) — small text below WCAG AA 4.5:1, and AUD-0060 — action rows
 * pushed past a 375px edge under the body's overflow-x clip.
 *
 * The contrast half COMPUTES the ratio from the values the stylesheets
 * actually declare, resolving design tokens through tokens.css, so a later
 * edit that swaps a token back to a decorative tone fails here with a number.
 *
 * The wrap half is source-level: node has no layout engine, so it pins the
 * rules that let each row wrap or fill, not a measured rectangle.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

const TOKENS = read("lib/design-tokens/tokens.css");
const SHELL_CSS = read("components/app-shell-v2/app-shell-v2.css");
const HOME_CSS = read("components/home-experience/home.css");
const LOGIN = read("app/login/page.tsx");

// ---------------------------------------------------------------------------
// WCAG 2.x relative luminance / contrast
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
};
const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (fg: RGB, alpha: number, bg: RGB): RGB =>
  fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as RGB;

/** The body of the first rule whose selector line is exactly `selector {`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `rule not found: ${selector}`);
  const body = css.slice(at + selector.length + 2);
  return body.slice(0, body.indexOf("}"));
}
const decl = (body: string, prop: string) => {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`));
  assert.ok(m, `no ${prop} in rule`);
  return m![1]!.trim();
};

/** Resolve `#hex`, `var(--x)` or `var(--x, fallback)` through the given sheets. */
function resolveColor(value: string, sheets: string[]): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  const m = v.match(/^var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)$/i);
  assert.ok(m, `cannot resolve colour: ${v}`);
  for (const sheet of sheets) {
    const d = sheet.match(new RegExp(`${m![1]}:\\s*([^;]+);`));
    if (d) return resolveColor(d[1]!, sheets);
  }
  assert.ok(m![2], `undeclared token without fallback: ${m![1]}`);
  return resolveColor(m![2]!, sheets);
}

const AA = 4.5;

test("AUD-0025 header search label ('Search or jump to…') is AA on its own ground", () => {
  const body = rule(SHELL_CSS, ".app-header-search");
  const fg = resolveColor(decl(body, "color"), [TOKENS]);
  const bg = decl(body, "background");
  assert.match(decl(body, "color"), /var\(--silver-ink/);
  const r = ratio(hex(fg), hex(bg));
  assert.ok(r >= AA, `${fg} on ${bg} = ${r.toFixed(2)}:1`);
  // The old value, for the record: it is what the audit measured.
  assert.ok(ratio(hex("#94A3B8"), hex(bg)) < AA);
});

test("AUD-0025 Home 'Also: …' line is AA on the white alert card", () => {
  const fg = resolveColor(decl(rule(HOME_CSS, ".self-serve-home .home-alert__also"), "color"), [
    HOME_CSS,
    TOKENS,
  ]);
  const card = resolveColor("var(--home-card)", [HOME_CSS]);
  const r = ratio(hex(fg), hex(card));
  assert.ok(r >= AA, `${fg} on ${card} = ${r.toFixed(2)}:1`);
});

test("AUD-0025 Home 'Needs attention' badge is AA on its warning tint", () => {
  const body = rule(
    HOME_CSS,
    '.self-serve-home .home-alert[data-exec-status="needs_attention"] .home-alert__badge',
  );
  assert.match(decl(body, "background"), /var\(--home-warn-soft\)/);
  const fg = resolveColor(decl(body, "color"), [HOME_CSS, TOKENS]);
  const tint = HOME_CSS.match(/--home-warn-soft:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  assert.ok(tint);
  const card = hex(resolveColor("var(--home-card)", [HOME_CSS]));
  const ground = over([+tint![1]!, +tint![2]!, +tint![3]!], +tint![4]!, card);
  const r = ratio(hex(fg), ground);
  assert.ok(r >= AA, `${fg} on rgb(${ground.join(",")}) = ${r.toFixed(2)}:1`);
  // The decorative orange it replaced is the 3.19:1 the audit measured.
  assert.ok(ratio(hex("#EA580C"), ground) < AA);
});

test("AUD-0025 login check marks are AA on white and on the ground the audit measured", () => {
  const marks = [...LOGIN.matchAll(/style=\{\{ color: "(#[0-9A-Fa-f]{6})" \}\}>✓</g)];
  assert.ok(marks.length > 0, "check-mark span not found");
  // The audit measured #E64880 at 3.45:1 on the chip's ground; recover that
  // ground's luminance from the measurement and test the new ink against it.
  const groundLum = 3.45 * (lum(hex("#E64880")) + 0.05) - 0.05;
  for (const [, color] of marks) {
    const fg = hex(color!);
    const onWhite = ratio(fg, [255, 255, 255]);
    const onGround = (groundLum + 0.05) / (lum(fg) + 0.05);
    assert.ok(onWhite >= AA, `${color} on white = ${onWhite.toFixed(2)}:1`);
    assert.ok(onGround >= AA, `${color} on measured ground = ${onGround.toFixed(2)}:1`);
  }
});

// ---------------------------------------------------------------------------
// AUD-0060 — rows that must wrap (class/style level; no layout in node)
// ---------------------------------------------------------------------------

test("AUD-0060 the admin wrap utility the rows use still wraps", () => {
  const body = rule(read("app/(app)/admin/admin-system.css"), ".adm-row");
  assert.match(body, /flex-wrap: wrap/);
  assert.match(body, /min-inline-size: 0/);
});

test("AUD-0060 customer suspend row (reason + 'Suspend customer') wraps", () => {
  const src = read("app/(app)/admin/customers/[id]/page.tsx");
  assert.match(src, /<span className="adm-row" data-testid="customer-suspend-row">/);
  assert.doesNotMatch(src, /display: "inline-flex", gap: 8, alignItems: "center"/);
});

test("AUD-0060 recovery validation buttons wrap", () => {
  const src = read("app/(app)/admin/platform/recovery/page.tsx");
  const at = src.indexOf('data-testid="recovery-validation-actions"');
  assert.ok(at > 0);
  const open = src.lastIndexOf("<div", at);
  assert.match(src.slice(open, at), /className="adm-row"/);
  assert.ok(src.indexOf('data-testid="run-restore-validation"') > at);
});

test("AUD-0060 Cases search fills the toolbar on a phone, and the rule comes last", () => {
  const css = read("components/cases-experience/cases-experience.css");
  const base = css.indexOf(".cases-toolbar-right .cases-search-field {\n  flex: 0 0 auto;\n  width: 340px;");
  assert.ok(base > 0, "base 340px rule moved");
  const narrow = css.slice(base);
  const media = narrow.indexOf("@media (max-width: 720px)");
  assert.ok(media > 0, "a 720px block must follow the 340px rule, or the 340px rule wins");
  const block = narrow.slice(media);
  assert.match(block, /\.cases-toolbar-right \{\s*flex: 1 1 100%;\s*min-width: 0;/);
  assert.match(block, /\.cases-toolbar-right \.cases-search-field \{\s*flex: 1 1 auto;\s*width: 100%;\s*min-width: 0;/);
});

test("AUD-0060 public home 'Enter Hash' mode strip wraps", () => {
  const src = read("components/marketing/VerifyInstantly.tsx");
  const m = src.match(/className="([^"]*)"\s*data-verify-instantly-modes/);
  assert.ok(m, "mode strip not found");
  assert.match(m![1]!, /\bflex-wrap\b/);
  // The button (not the comment above the strip) sits inside the strip.
  assert.ok(src.lastIndexOf("Enter Hash") > src.indexOf("data-verify-instantly-modes"));
});
