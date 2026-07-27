import test from "node:test";
import assert from "node:assert/strict";

import {
  internalResourcePath,
  internalNavPath,
  absoluteInternalUrl,
  publicShareUrl,
  parseInternalResourcePath,
  classifyLink,
  safeIntendedDestination,
} from "../dist/index.js";

const ORIGINS = ["https://www.proovra.com"];

test("P11 URL — resource path is resource-id based, no tenant segment, id-encoded", () => {
  assert.equal(internalResourcePath({ type: "evidence", id: "ev 1/x" }), "/evidence/ev%201%2Fx");
  assert.equal(internalResourcePath({ type: "cases", id: "c1" }), "/cases/c1");
});

test("P11 URL — nav path normalises protocol-relative to a safe single slash", () => {
  assert.equal(internalNavPath("home"), "/home");
  assert.equal(internalNavPath("//evil.com"), "/evil.com");
});

test("P11 URL — absolute compose trims base + ensures single slash", () => {
  assert.equal(absoluteInternalUrl("https://www.proovra.com/", "/evidence/1"), "https://www.proovra.com/evidence/1");
  assert.equal(publicShareUrl("https://www.proovra.com", "tok/a"), "https://www.proovra.com/share/tok%2Fa");
});

test("P11 URL — parse ONLY the canonical resource shape, else null", () => {
  assert.deepEqual(parseInternalResourcePath("/evidence/ev-1"), { type: "evidence", id: "ev-1" });
  assert.deepEqual(parseInternalResourcePath("/cases/c-1?tab=x#f"), { type: "cases", id: "c-1" });
  assert.equal(parseInternalResourcePath("/home"), null); // nav-only → no resource binding
  assert.equal(parseInternalResourcePath("//evidence/1"), null); // protocol-relative → null
  assert.equal(parseInternalResourcePath("/unknown/1"), null); // unsupported family
  assert.equal(parseInternalResourcePath("/evidence"), null); // no id
});

test("P11 URL — classify internal vs public-signed vs external", () => {
  assert.equal(classifyLink("/evidence/1", ORIGINS), "INTERNAL_AUTHENTICATED");
  assert.equal(classifyLink("/share/tok", ORIGINS), "PUBLIC_SIGNED");
  assert.equal(classifyLink("https://www.proovra.com/cases/1", ORIGINS), "INTERNAL_AUTHENTICATED");
  assert.equal(classifyLink("https://www.proovra.com/portal/x", ORIGINS), "PUBLIC_SIGNED");
  assert.equal(classifyLink("https://evil.com/evidence/1", ORIGINS), "EXTERNAL");
  assert.equal(classifyLink("//evil.com", ORIGINS), "EXTERNAL");
});

test("P11 URL — safeIntendedDestination only preserves safe relative paths (no open redirect)", () => {
  assert.equal(safeIntendedDestination("/evidence/1"), "/evidence/1");
  assert.equal(safeIntendedDestination("//evil.com"), "/");
  assert.equal(safeIntendedDestination("https://evil.com"), "/");
  assert.equal(safeIntendedDestination(null), "/");
  assert.equal(safeIntendedDestination("https://www.proovra.com/x", ORIGINS), "https://www.proovra.com/x");
});
