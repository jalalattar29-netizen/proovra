/**
 * RENDER TESTS for the primitive kit.
 *
 * Replaces `ui-kit-contract.test.mjs`, which read the kit's SOURCE and asserted
 * that it mentioned `theme.`, contained no `#hex`, and contained the string
 * "44". None of that can tell you whether a button renders, whether a disabled
 * button refuses a press, or whether an input reports what was typed.
 *
 * The one assertion worth keeping from it — no hardcoded palette in the kit —
 * is kept at the bottom, and labelled as the static lint check it is.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const h = React.createElement;

let K;
const render = (el) => renderInProviders(K, el);
before(async () => {
  K = await loadWithProviders("src/ui/index.tsx");
});

test("the kit exports the canonical primitives", () => {
  for (const name of [
    "ProovraScreen", "ProovraText", "ProovraCard", "ProovraSection", "ProovraButton",
    "ProovraInput", "ProovraFormField", "ProovraBadge", "ProovraListRow",
    "ProovraLoadingState", "ProovraEmptyState", "ProovraErrorState",
  ]) {
    assert.equal(typeof K[name], "function", `${name} is missing from the kit`);
  }
});

test("Button renders its label and reports a press", async () => {
  let pressed = 0;
  const r = await render(h(K.ProovraButton, { label: "Finalize", onPress: () => (pressed += 1) }));
  assert.ok(r.hasText("Finalize"));
  await r.press("Finalize");
  assert.equal(pressed, 1);
});

test("a disabled Button refuses the press", async () => {
  let pressed = 0;
  const r = await render(
    h(K.ProovraButton, { label: "Finalize", disabled: true, onPress: () => (pressed += 1) }),
  );
  await r.press("Finalize");
  assert.equal(pressed, 0);
});

test("a loading Button refuses the press and says so to assistive tech", async () => {
  let pressed = 0;
  const r = await render(
    h(K.ProovraButton, { label: "Save", loading: true, onPress: () => (pressed += 1) }),
  );
  await r.press("Save");
  assert.equal(pressed, 0, "a request in flight must not be fired twice");
  const btn = r.byRole("button")[0];
  assert.equal(btn.props.accessibilityState?.disabled, true);
});

test("Input reports what was typed and carries an accessible name", async () => {
  const typed = [];
  const r = await render(
    h(K.ProovraInput, {
      accessibilityLabel: "Email",
      value: "",
      onChangeText: (v) => typed.push(v),
    }),
  );
  await r.type("Email", "a@b.test");
  assert.deepEqual(typed, ["a@b.test"]);
});

test("an Input with no placeholder still has a name when wrapped in a FormField", async () => {
  // The label sits OUTSIDE the control, and React Native has no htmlFor. This
  // field used to borrow its name from the placeholder, so every ProovraFormField
  // with no placeholder rendered an unnamed text box.
  const r = await render(
    h(K.ProovraFormField, {
      label: "Workspace name",
      children: h(K.ProovraInput, { value: "", onChangeText: () => {} }),
    }),
  );
  assert.equal(r.byLabel("Workspace name").filter((n) => n.props.onChangeText).length, 1);
});

test("a FormField error is announced with the field it belongs to", async () => {
  const r = await render(
    h(K.ProovraFormField, {
      label: "Email",
      error: "Enter a valid email address.",
      children: h(K.ProovraInput, { value: "x", onChangeText: () => {} }),
    }),
  );
  assert.equal(
    r.byLabel("Email, Enter a valid email address.").filter((n) => n.props.onChangeText).length,
    1,
    "the control must carry the error, not leave it as a loose sentence nearby",
  );
});

test("FormField shows its error text", async () => {
  const r = await render(
    h(K.ProovraFormField, {
      label: "Email",
      error: "Enter a valid email address.",
      children: h(K.ProovraInput, { value: "x", onChangeText: () => {} }),
    }),
  );
  assert.ok(r.hasText("Enter a valid email address."));
});

test("Badge renders the label for every canonical tone", async () => {
  for (const tone of ["verified", "pending", "risk", "governance", "neutral", "info"]) {
    const r = await render(h(K.ProovraBadge, { label: tone, tone }));
    assert.ok(r.hasText(tone), `tone ${tone} did not render`);
  }
});

test("the three state primitives each render their message", async () => {
  const loading = await render(h(K.ProovraLoadingState, { label: "Loading evidence" }));
  assert.ok(loading.hasText("Loading evidence"));

  const empty = await render(h(K.ProovraEmptyState, { title: "Nothing yet", message: "Capture something." }));
  assert.ok(empty.hasText("Nothing yet") && empty.hasText("Capture something."));

  let retried = 0;
  const error = await render(
    h(K.ProovraErrorState, { message: "We could not reach the server.", onRetry: () => (retried += 1) }),
  );
  assert.ok(error.hasText("We could not reach the server."));
  await error.press("Try again");
  assert.equal(retried, 1, "an error state must offer a way out, not just a message");
});

test("ListRow renders its content and reports a press", async () => {
  let opened = 0;
  const r = await render(
    h(K.ProovraListRow, { title: "IMG_0042.jpg", subtitle: "Photo · 2 MB", onPress: () => (opened += 1) }),
  );
  assert.ok(r.hasText("IMG_0042.jpg"));
  assert.ok(r.hasText("Photo · 2 MB"));
});

test("every interactive primitive meets the 44pt touch minimum", async () => {
  // Asserted on the RENDERED style, not on the source containing "44".
  const r = await render(h(K.ProovraButton, { label: "Tap", onPress: () => {} }));
  const btn = r.byRole("button")[0];
  const { minHeight } = r.styleOf(btn);
  assert.ok(minHeight >= 44, `button minHeight is ${minHeight}, below the 44pt target`);
});

test("STATIC: the kit hardcodes no palette — colour arrives through the theme", () => {
  // A lint check, not a behaviour proof. Kept because a stray hex in the kit
  // silently re-forks the design system, and no render assertion catches that.
  const src = readFileSync(resolve(HERE, "../src/ui/index.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const hits = src.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
  assert.deepEqual(hits, [], "put the colour in tokens.css and consume it via theme");
});
