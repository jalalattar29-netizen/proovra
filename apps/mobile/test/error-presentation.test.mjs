/**
 * THE SURFACES CONSUME THE DICTIONARY — not merely "a dictionary exists".
 *
 * A central error table proves nothing on its own. What matters is whether the
 * screen a person is looking at resolves through it, and the capture screens
 * did not: seventeen sites rendered `err.message` straight into a toast or an
 * inline error, which is the exact anti-pattern `safe-error.ts` opens by
 * naming. On an API failure that is the backend's own string; on a bounded
 * refusal it is the technical summary instead of the product's sentence.
 *
 * These are source-level guards on purpose. The property is "no surface takes
 * this shortcut", and that is a statement about every file, not about the one
 * a render test happens to mount.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCES = [...walk(join(MOBILE, "app")), ...walk(join(MOBILE, "src"))].filter(
  (f) => !/[/\\]errors[/\\]safe-error\.ts$/.test(f),
);

const rel = (f) => relative(MOBILE, f).split("\\").join("/");

test("no surface renders a raw thrown message", () => {
  // `err.message` reaches a person only through the canonical layer, which
  // decides whether the backend's string is safe to show for that kind and
  // otherwise answers with the product's own words.
  const offenders = [];
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\w+ instanceof Error \? \w+\.message/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      const context = src.split("\n")[line - 1] ?? "";
      // A test for the SHAPE of a thrown value — `/cancel/i.test(err.message)`
      // — is not a rendering of it.
      if (/\.test\(|includes\(|match\(/.test(context)) continue;
      // The reviewer panel's builder invariant is our own literal, raised by
      // a local guard rather than by the API, and the surface states it
      // deliberately.
      if (/reviewer-workflow-panel\.tsx$/.test(file)) continue;
      offenders.push(`${rel(file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the capture screens resolve failures through the canonical layer", () => {
  // The product's core flow. Each of these files catches, and each must route
  // what it shows through `toSafeUserError`.
  for (const name of ["capture.tsx", "continuous-capture.tsx", "screen-capture.tsx"]) {
    const file = join(MOBILE, "app", "(stack)", name);
    const src = readFileSync(file, "utf8");
    assert.ok(
      /toSafeUserError/.test(src),
      `${name} shows failures without the canonical layer`,
    );
  }
});

test("the dictionary is the SHARED one, and native actually imports it", () => {
  // Not a second copy of the web's table: the same module, so a refusal reads
  // the same on both clients.
  // From the package ROOT, which is what Metro can resolve: package `exports`
  // subpaths are off by default in this Expo version, and the subpath form of
  // this very import took the Android bundle down.
  const safeError = readFileSync(join(MOBILE, "src/errors/safe-error.ts"), "utf8");
  assert.match(safeError, /from "@proovra\/shared"/);
  assert.match(safeError, /userFacingErrorFor/);

  const dictionary = readFileSync(
    resolve(MOBILE, "../../packages/shared/src/user-facing-errors.ts"),
    "utf8",
  );
  const entries = [...dictionary.matchAll(/^ {2}[A-Z][A-Z0-9_]+: \{/gm)].length;
  assert.ok(entries > 80, `the shared dictionary carries only ${entries} codes`);

  // And the copy is not a placeholder: every entry says something.
  for (const m of dictionary.matchAll(/^ {2}([A-Z][A-Z0-9_]+): \{\n\s*title: "([^"]*)"/gm)) {
    assert.ok(m[2].trim().length > 3, `${m[1]} has no title`);
  }
});

test("a mapped refusal never tells a phone to just try again", () => {
  // The defect this closes, stated as a property. "Please try again" is the
  // right answer for a transport failure and the wrong one for an evidence
  // lock, a plan limit or a mixed-origin conflict — and before the dictionary
  // reached native, every 409 got it.
  const dictionary = readFileSync(
    resolve(MOBILE, "../../packages/shared/src/user-facing-errors.ts"),
    "utf8",
  );
  for (const code of ["EVIDENCE_LOCKED", "STORAGE_LIMIT_REACHED", "FEATURE_DISABLED"]) {
    const entry = new RegExp(`^ {2}${code}: \\{[\\s\\S]*?\\n {2}\\},`, "m").exec(dictionary);
    assert.ok(entry, `${code} is not in the shared dictionary`);
    assert.ok(
      !/Please try again\.?"/.test(entry[0]),
      `${code} answers with a bare retry, which is what the status bucket already said`,
    );
  }
});

test("no source imports a @proovra subpath Metro cannot resolve", () => {
  // THE DEFECT THIS CLOSES, AND IT COST THE WHOLE APP.
  //
  // Expo 52's Metro does not resolve package `exports` subpaths, so
  // `@proovra/shared/password-rules` and `@proovra/shared/user-facing-errors`
  // do not resolve AT ALL — the bundle fails on the first file whose import
  // graph reaches one. `password-rules.tsx` carried such an import for some
  // time without consequence, because nothing reachable imported that
  // component; adding one in the error layer, which everything reaches, took
  // the Android build down at the Bundle JavaScript phase.
  //
  // Every JavaScript suite in this app passed throughout, because they
  // transpile modules directly and never run Metro. This guard is the cheap
  // part of that lesson.
  const offenders = [];
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from "(@proovra\/[a-z-]+\/[^"]+)"/g)) {
      offenders.push(`${rel(file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
