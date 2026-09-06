/**
 * THE CONSOLE PAINTS NOTHING IT DID NOT NAME.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * §B2 asks for one colour system in the Admin console: canonical purple for
 * primary actions, active nav, selected tabs and focus; success/warning/danger
 * mapped semantically; unknown and unavailable neutral. Every one of those is
 * a statement about a TOKEN, and a token can only be the authority if nothing
 * beside it writes a colour directly.
 *
 * The deletion proof already bans the specific mechanisms this console used to
 * carry — a `TOKENS.*` alias map, hex fallbacks inside `var()`, page-local
 * `INK_*` and `PALETTE` objects, hand-rolled status capsules. This is the
 * general form of the same rule: no literal colour anywhere under `/admin`,
 * in a stylesheet or in a component, in any notation.
 *
 * It is a companion to `admin-token-authority.spec.ts`, not a substitute. That
 * one measures what the browser RESOLVES, which is the only way to catch a
 * token that renders two values; this one catches the value that never went
 * through a token at all, which the browser cannot distinguish from one that
 * did.
 *
 * ===========================================================================
 * WHAT IS ALLOWED, AND WHY
 * ===========================================================================
 * Comments. A colour named in prose is documentation — most of the values this
 * console has removed are recorded in the comment explaining why they went,
 * and a rule that banned those would delete its own reasoning.
 *
 * Nothing else. A third-party brand colour would need an allowlisted entry
 * with a reason; there are none, and adding one without a reason fails here.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const ADMIN = resolve(WEB, "app/(app)/admin");

/**
 * Third-party brand colours, each with the reason it cannot be a token.
 *
 * Empty. An entry here is a deliberate exception — a provider's own mark,
 * which the product does not get to restyle — and the shape requires the
 * reason to be written down beside it.
 */
const BRAND_ALLOWLIST = /** @type {Array<{ file: string, value: string, reason: string }>} */ ([]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Strip comments so a colour DISCUSSED does not read as a colour PAINTED.
 *
 * Block comments, line comments, and the leading `*` continuation of a JSDoc
 * line — that last one matters because a hex mentioned mid-paragraph sits on a
 * line the block-comment stripper only sees the middle of.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\*.*$/gm, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/[^\n"'`]*$/gm, " ");
}

const LITERALS = [
  { name: "hex", re: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb", re: /\brgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g },
  { name: "hsl", re: /\bhsla?\(\s*\d/g },
  {
    name: "named",
    // The CSS names that actually get typed. Not the full 148: a rule that
    // banned `tomato` and `gainsboro` would be noise, and these are the ones
    // a hurried edit reaches for.
    re: /\b(?:color|background|background-color|border-color|fill|stroke)\s*:\s*(?:white|black|red|green|blue|orange|yellow|grey|gray|silver)\b/gi,
  },
];

test("no literal colour is painted anywhere under /admin", () => {
  const findings = [];
  for (const file of walk(ADMIN)) {
    const rel = file.slice(WEB.length + 1).split("\\").join("/");
    const src = readFileSync(file, "utf8");
    const body = code(src);
    const lines = src.split("\n");
    const bodyLines = body.split("\n");
    for (const { name, re } of LITERALS) {
      bodyLines.forEach((line, i) => {
        for (const m of line.matchAll(re)) {
          const allowed = BRAND_ALLOWLIST.some(
            (a) => a.file === rel && a.value === m[0] && a.reason.trim().length > 0,
          );
          if (allowed) continue;
          findings.push(`${rel}:${i + 1}  ${name}  ${m[0]}   ${lines[i]?.trim().slice(0, 100)}`);
        }
      });
    }
  }
  assert.equal(
    findings.length,
    0,
    `the console painted ${findings.length} colour(s) that never went through a token:\n  ` +
      findings.join("\n  "),
  );
});

test("every brand-colour exception carries a reason", () => {
  for (const entry of BRAND_ALLOWLIST) {
    assert.ok(
      entry.reason && entry.reason.trim().length > 20,
      `the allowlist entry for ${entry.value} in ${entry.file} has no reason`,
    );
  }
});

test("the guard still catches a colour written the four ways", () => {
  // Proving the stripper does not swallow real code, and that each notation
  // is actually matched. A guard nobody has watched fail is a guard nobody
  // knows the shape of.
  const FIXTURE = [
    'const a = { color: "#1e293b" };',
    "const b = { background: `rgba(124, 90, 255, 0.35)` };",
    "const c = { borderColor: 'hsl(210, 40%, 96%)' };",
    ".x { background-color: white; }",
  ].join("\n");
  const body = code(FIXTURE);
  const hits = LITERALS.filter(({ re }) => new RegExp(re.source, re.flags).test(body));
  assert.equal(
    hits.length,
    LITERALS.length,
    `only ${hits.map((h) => h.name).join(", ")} matched the fixture`,
  );

  // And that a colour in a COMMENT is not a finding.
  const COMMENTED = [
    "/* the old value was #1e293b, a navy that read as marketing */",
    " * and rgba(124,90,255,0.35) beside it",
    "// background: white;",
  ].join("\n");
  const commentBody = code(COMMENTED);
  for (const { name, re } of LITERALS) {
    assert.equal(
      new RegExp(re.source, re.flags).test(commentBody),
      false,
      `${name} matched inside a comment`,
    );
  }
});
