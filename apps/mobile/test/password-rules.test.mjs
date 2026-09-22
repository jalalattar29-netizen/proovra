/**
 * PASSWORD RULES — one module, four surfaces.
 *
 * The rules moved to `@proovra/shared/password-rules` when Native needed them.
 * What these pin:
 *   - the web still imports the SAME module, so the two platforms cannot
 *     disagree about what a valid password is. A user told their password is
 *     fine on one surface and refused on the other, with the server siding
 *     with neither, is worse off than with no panel at all;
 *   - the native screens gate on EVERY rule, not on length. They previously
 *     checked only `password.length >= 12`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

// pathToFileURL: a Windows absolute path is not a valid ESM specifier.
const { PASSWORD_RULES, evaluatePassword } = await import(
  pathToFileURL(resolve(ROOT, "packages/shared/dist/password-rules.js")).href
);

test("there is ONE password rules module, and the web re-exports it", () => {
  const webShim = read("apps/web/lib/passwordRules.ts");
  assert.match(webShim, /export \* from "@proovra\/shared\/password-rules"/);
  // The rules themselves must not survive in the web copy.
  assert.doesNotMatch(webShim, /Minimum 12 characters/);
});

test("both native password screens gate on every rule, not on length", () => {
  for (const file of [
    "apps/mobile/app/(stack)/register.tsx",
    "apps/mobile/app/(stack)/reset-password.tsx",
  ]) {
    const src = read(file);
    assert.match(src, /passwordMeetsRules\(password\)/, file);
    // The old length-only gate must be gone from the submit path.
    assert.doesNotMatch(src, /password\.length < 12/, file);
  }
});

test("the rules are the canonical five", () => {
  assert.deepEqual(
    PASSWORD_RULES.map((r) => r.id),
    ["length", "upper", "lower", "digit", "special"],
  );
});

test("a long but simple password does not pass", () => {
  // The exact case the length-only gate let through: twelve characters, all
  // lowercase, refused by the server with no explanation offered.
  const e = evaluatePassword("abcdefghijkl");
  assert.equal(e.allMet, false);
  assert.equal(e.ruleResults.find((r) => r.id === "length").met, true);
  assert.equal(e.ruleResults.find((r) => r.id === "upper").met, false);
});

test("an empty password scores zero and meets nothing", () => {
  const e = evaluatePassword("");
  assert.equal(e.score, 0);
  assert.equal(e.passedCount, 0);
  assert.equal(e.allMet, false);
});

test("all five rules met is Strong, and length carries it to Excellent", () => {
  const strong = evaluatePassword("Abcdefghijk1!");
  assert.equal(strong.allMet, true);
  assert.equal(strong.score, 3);

  const excellent = evaluatePassword("Abcdefghijklmn1!");
  assert.equal(excellent.allMet, true);
  assert.equal(excellent.score, 4);
});

test("every score has a label and a colour, so the meter never renders blank", () => {
  for (const pwd of ["", "a", "ab1", "Abc1", "Abcdefghijk1!", "Abcdefghijklmn1!"]) {
    const e = evaluatePassword(pwd);
    assert.ok(e.label.length > 0, JSON.stringify(pwd));
    assert.match(e.color, /^#[0-9A-Fa-f]{6}$/, JSON.stringify(pwd));
  }
});
