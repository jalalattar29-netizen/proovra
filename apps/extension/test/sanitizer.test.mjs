import assert from "node:assert/strict";
import { test } from "node:test";

import {
  shouldClearInputValue,
  isStrippedAttr,
  isStrippedTag,
  STRIPPED_TAGS,
} from "./dist/sanitizer.js";

test("password, hidden and secret-named fields are cleared", () => {
  assert.equal(shouldClearInputValue({ type: "password" }), true);
  assert.equal(shouldClearInputValue({ type: "hidden", name: "csrf_token" }), true);
  assert.equal(shouldClearInputValue({ type: "text", name: "user_password" }), true);
  assert.equal(shouldClearInputValue({ type: "text", autocomplete: "one-time-code" }), true);
  assert.equal(shouldClearInputValue({ type: "text", name: "authenticity_token" }), true);
  assert.equal(shouldClearInputValue({ type: "text", id: "cardNumber" }), true);
});

test("ordinary fields are not cleared", () => {
  assert.equal(shouldClearInputValue({ type: "text", name: "search" }), false);
  assert.equal(shouldClearInputValue({ type: "email", name: "email" }), false);
});

test("event-handler and injection attributes are stripped", () => {
  assert.equal(isStrippedAttr("onclick"), true);
  assert.equal(isStrippedAttr("onmouseover"), true);
  assert.equal(isStrippedAttr("srcdoc"), true);
  assert.equal(isStrippedAttr("formaction"), true);
  assert.equal(isStrippedAttr("href"), false);
  assert.equal(isStrippedAttr("class"), false);
});

test("executable/non-representational tags are stripped", () => {
  assert.equal(isStrippedTag("script"), true);
  assert.equal(isStrippedTag("IFRAME"), true);
  assert.equal(isStrippedTag("div"), false);
  assert.ok(STRIPPED_TAGS.includes("script"));
});
