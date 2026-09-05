/**
 * AUTH PAGES — one tree, one id, one description target.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHAT IT IS NOT DEFENDING AGAINST
 * ---------------------------------------------------------------------------
 *
 * A "duplicate Register DOM" was reported: two forms, two <h1>s, duplicated
 * ids. Measured in a real browser it does not happen — Register and Sign in
 * each render exactly one tree at every breakpoint. The duplication was an
 * artefact of the measuring instrument: the in-app Browser pane runs its tabs
 * with `document.visibilityState === "hidden"`, so `requestAnimationFrame`
 * never fires; React's streaming reveal sets `$RT` inside a rAF callback and
 * its `$RC` completion script reads it, so the streamed copy stays stranded in
 * `<div hidden id="S:0">` while React client-renders the boundary. Neutering
 * rAF in headless Chrome reproduces it exactly, on BOTH auth pages; leaving
 * rAF alone produces one clean tree, including in a genuinely backgrounded
 * tab. Nothing in the pages caused it and nothing in the pages was changed
 * for it.
 *
 * So this file does NOT defend against that. It pins the invariant the report
 * asked for and that a future change genuinely could break: each auth route
 * mounts ONE interactive auth tree. The specific way that would be broken is
 * the one the brief forbids — adding a second "mobile" form beside the
 * desktop one and hiding one with CSS — and that IS visible in the source.
 *
 * These are structural counts, not character windows: the assertions survive
 * reformatting, restyling and copy edits, and fail only if the SHAPE changes.
 *
 * The runtime half of the proof (a real browser, five breakpoints, unique ids,
 * resolved aria references, one request per submit) is not reproduced here
 * because it needs a running server and a browser; it lives in the task
 * record rather than being faked in a unit test.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const PAGES = [
  { name: "register", src: read("apps/web/app/register/page.tsx") },
  { name: "login", src: read("apps/web/app/login/page.tsx") },
] as const;

/** Occurrences of a JSX opening tag, ignoring self-closing text in strings. */
const countTag = (src: string, tag: string) =>
  (src.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;

// ===========================================================================
test("each auth page declares exactly one form", () => {
  for (const { name, src } of PAGES) {
    assert.equal(
      countTag(src, "form"),
      1,
      `${name} must mount ONE form. A second one — a "mobile" variant beside ` +
        `the desktop one — gives the page duplicate ids, duplicate focus ` +
        `targets, and two candidate forms for the browser's password manager. ` +
        `Responsive behaviour belongs in CSS, not in a second interactive tree.`,
    );
  }
});

test("each auth page declares exactly one primary heading", () => {
  /*
   * Scoped to the CONTENT component, not the whole file. Sign in also has an
   * <h1> in its Suspense fallback ("Preparing the sign-in form…"), which is a
   * different tree that never coexists with the page — Chrome reports one
   * <h1> on both routes. Counting the file would fail on a heading that is
   * correct.
   */
  for (const { name, src } of PAGES) {
    const marker = `function ${name === "login" ? "LoginPageContent" : "RegisterPageContent"}(`;
    const start = src.indexOf(marker);
    assert.ok(start > 0, `${name}: content component not found`);
    assert.equal(
      countTag(src.slice(start), "h1"),
      1,
      `${name} must render one <h1> in its page content`,
    );
  }
});

test("every auth field id is rendered exactly once", () => {
  /*
   * The ids are what break first when a tree is duplicated, and they are what
   * `label[for]`, `aria-describedby` and `aria-controls` resolve through. One
   * render site each, so every reference has exactly one target.
   */
  const ids = [
    // register
    ["register", /id=\{PASSWORD_FIELD_ID\}/g],
    ["register", /id=\{PASSWORD_CONFIRM_FIELD_ID\}/g],
    ["register", /id=\{PASSWORD_RULES_DESC_ID\}/g],
    // login
    ["login", /id="login-email"/g],
    ["login", /id="login-password"/g],
  ] as const;

  for (const [page, pattern] of ids) {
    const src = PAGES.find((p) => p.name === page)!.src;
    assert.equal(
      (src.match(pattern) ?? []).length,
      1,
      `${page}: ${pattern.source} must have exactly one render site`,
    );
  }
});

test("each password input has exactly one visibility toggle", () => {
  const register = PAGES.find((p) => p.name === "register")!.src;
  const login = PAGES.find((p) => p.name === "login")!.src;
  // Register has two password fields, Sign in has one.
  assert.equal((register.match(/<PasswordVisibilityToggle/g) ?? []).length, 2);
  assert.equal((login.match(/<PasswordVisibilityToggle/g) ?? []).length, 1);
  // And each toggle governs a different field.
  assert.match(register, /controls=\{PASSWORD_FIELD_ID\}/);
  assert.match(register, /controls=\{PASSWORD_CONFIRM_FIELD_ID\}/);
  assert.match(login, /controls="login-password"/);
});

// ===========================================================================
// The real defect this pass found.
// ===========================================================================
test("a description is only referenced while it exists", () => {
  /*
   * The password requirements list renders under `showPasswordRules` — it is
   * absent at rest, which is exactly the state a screen-reader user meets the
   * field in. The input named it unconditionally, so `aria-describedby`
   * pointed at an element that was not in the document. Measured in Chrome:
   * `targetExists: false` at rest, true only while focused.
   *
   * The attribute now carries the same condition as the element, so the two
   * cannot disagree.
   */
  const register = PAGES.find((p) => p.name === "register")!.src;

  // The list is conditional...
  assert.match(register, /\{showPasswordRules \?/);
  // ...so the reference to it must be too.
  assert.match(
    register,
    /aria-describedby=\{\s*showPasswordRules \? PASSWORD_RULES_DESC_ID : undefined\s*\}/,
    "aria-describedby must be guarded by the same flag that renders its target",
  );
  assert.doesNotMatch(
    register,
    /aria-describedby=\{PASSWORD_RULES_DESC_ID\}/,
    "the unconditional reference must not come back",
  );
});

test("no auth aria reference points at an id the page never renders", () => {
  /*
   * A cheap integrity sweep over both pages: every id named by
   * `aria-describedby` / `aria-controls` — whether written as a literal or as
   * one of the page's id constants — must have a render site in the same
   * file. This is what catches a renamed field id that leaves its references
   * behind.
   */
  for (const { name, src } of PAGES) {
    const referenced = new Set<string>();
    for (const m of src.matchAll(
      /aria-(?:describedby|controls)=\{?\s*(?:[A-Za-z0-9_.]+\s*\?\s*)?"([a-z0-9-]+)"/g,
    )) {
      referenced.add(m[1]);
    }
    for (const m of src.matchAll(
      /aria-(?:describedby|controls)=\{\s*(?:[A-Za-z0-9_.]+\s*\?\s*)?([A-Z][A-Z0-9_]+)\s*[:}]/g,
    )) {
      referenced.add(m[1]);
    }

    for (const ref of referenced) {
      const rendered = /^[A-Z][A-Z0-9_]+$/.test(ref)
        ? new RegExp(`id=\\{${ref}\\}`).test(src)
        : new RegExp(`id="${ref}"`).test(src);
      assert.ok(rendered, `${name}: aria reference "${ref}" has no render site`);
    }
  }
});
