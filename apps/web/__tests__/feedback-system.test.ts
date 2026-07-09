/**
 * PROOVRA Feedback System — contract tests.
 *
 * Locks the enterprise feedback upgrade: premium distinct toasts with
 * a11y, sanitized API errors (no raw message / no inline requestId),
 * branded 404/500/global-error, and non-bare forbidden copy.
 */

import { test } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { toSafeUserError } from "../lib/feedback/toSafeUserError";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string) => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// 1. Toast — premium, distinct severities, a11y, no dark-navy hardcode
// ---------------------------------------------------------------------------

test("toast: old dark-navy (#102126) toast block is gone from globals.css", () => {
  const css = read("app/globals.css");
  // The old cheap toast used `background: #102126`. That must be gone.
  // (#102126 may still exist as the unrelated --velvet-900 brand token.)
  assert.ok(!/background:\s*#102126/.test(css), "no dark-navy toast background");
  assert.ok(!/\.toast-item\s*\{/.test(css), "the old .toast-item block must be removed");
});

test("toast: ProovraToast is a light card, not a dark-navy block", () => {
  const src = read("components/feedback/ProovraToast.tsx");
  assert.ok(!/background:\s*["']#102126/.test(src), "toast card must not use the old dark-navy colour");
  assert.ok(src.includes("FEEDBACK_SURFACE.card"), "toast uses the light card surface");
});

test("toast: severities render distinct accents", () => {
  const src = read("components/feedback/severity.tsx");
  const accents = ["#059669", "#DC2626", "#D97706", "#2563EB"]; // success/error/warning/info
  for (const a of accents) assert.ok(src.includes(a), `severity accent ${a} present`);
  assert.equal(new Set(accents).size, accents.length, "severity accents are distinct");
});

test("toast: has correct ARIA roles + accessible close", () => {
  const src = read("components/feedback/ProovraToast.tsx");
  assert.ok(src.includes("role={feedbackRole(toast.severity)}"), "role is severity-driven");
  assert.ok(src.includes("aria-live={feedbackAriaLive(toast.severity)}"), "aria-live present");
  assert.ok(src.includes('aria-label="Dismiss notification"'), "close button is labelled");
  assert.ok(src.includes("data-severity={toast.severity}"), "severity is exposed for styling/tests");
});

test("toast: error/warning are assertive alerts, success/info are polite status", () => {
  const src = read("components/feedback/severity.tsx");
  assert.match(src, /feedbackRole[\s\S]*?"error"[\s\S]*?"warning"[\s\S]*?"alert"/);
  assert.match(src, /feedbackAriaLive[\s\S]*?"assertive"/);
});

test("toast: container is an accessible region and errors last longer than success", () => {
  const ui = read("components/ui-legacy.tsx");
  assert.ok(ui.includes('role="region"'), "toast container is a region");
  assert.match(ui, /error"\s*\|\|\s*type === "warning"\s*\?\s*7000\s*:\s*4500/);
});

// ---------------------------------------------------------------------------
// 2. API error sanitization
// ---------------------------------------------------------------------------

test("api: no inline (requestId: …) leak in lib/api.ts", () => {
  const src = read("lib/api.ts");
  assert.ok(!src.includes("(requestId: ${requestId})"), "requestId must not be inlined into the message");
});

test("toSafeUserError: never returns a raw backend message", () => {
  const safe = toSafeUserError({ message: "Prisma failed: relation \"users\" does not exist" });
  assert.ok(!safe.message.includes("Prisma"), "raw backend text must not surface");
  assert.ok(!safe.message.toLowerCase().includes("relation"), "no SQL/internal text");
  assert.ok(safe.title.length > 0 && safe.message.length > 0);
});

test("toSafeUserError: requestId becomes supportReference, never inline", () => {
  const safe = toSafeUserError({ code: "API_ERROR", statusCode: 500, requestId: "ABC123" });
  assert.equal(safe.supportReference, "ABC123");
  assert.ok(!safe.message.includes("ABC123"), "id must not be inside the sentence");
  assert.ok(!safe.message.includes("requestId"), "no requestId label in the sentence");
});

test("toSafeUserError: known codes map to safe copy (no raw enum)", () => {
  const unauth = toSafeUserError({ code: "UNAUTHORIZED" });
  assert.equal(unauth.severity, "warning");
  assert.ok(!unauth.message.includes("UNAUTHORIZED"), "raw enum not shown");
  assert.match(unauth.message.toLowerCase(), /sign in/);

  const forbidden = toSafeUserError({ code: "FORBIDDEN" });
  assert.ok(!/^forbidden$/i.test(forbidden.title), "not a bare Forbidden title");
  assert.match(forbidden.title.toLowerCase(), /don't have access|access/);

  const server = toSafeUserError({ statusCode: 503 });
  assert.equal(server.severity, "error");
  assert.match(server.message.toLowerCase(), /try again|temporarily unavailable/);
});

// ---------------------------------------------------------------------------
// 3. Branded 404
// ---------------------------------------------------------------------------

test("404: branded, uses ProovraErrorState, has useful CTAs", () => {
  const src = read("app/not-found.tsx");
  assert.ok(src.includes("ProovraErrorState"), "404 uses the branded error state");
  assert.match(src, /Page not found/);
  assert.match(src, /Back to home/);
  assert.match(src, /Contact support/);
  assert.ok(!/does not exist\.<\/p>/.test(src), "old bare copy is gone");
});

// ---------------------------------------------------------------------------
// 4. Branded 500 / route error
// ---------------------------------------------------------------------------

test("error page: branded, safe, retry + escape, no raw message/stack", () => {
  const src = read("app/error.tsx");
  assert.ok(src.includes("ProovraErrorState"));
  assert.match(src, /Try again/);
  assert.match(src, /Contact support/);
  assert.ok(!src.includes("{error.message}"), "must not render the raw error message");
  assert.ok(!src.includes("error.stack"), "must not render the stack");
  assert.ok(src.includes("supportReference={error.digest}"), "digest surfaced as support reference");
  assert.ok(!/Something went wrong<\/h1>/.test(src), "no bare 'Something went wrong' heading");
});

// ---------------------------------------------------------------------------
// 5. Global error exists + branded
// ---------------------------------------------------------------------------

test("global-error: exists, branded, self-contained html", () => {
  assert.ok(existsSync(resolve(APP_ROOT, "app/global-error.tsx")), "app/global-error.tsx exists");
  const src = read("app/global-error.tsx");
  assert.ok(src.includes("<html"), "renders its own html shell");
  assert.ok(src.includes("ProovraErrorState"), "branded surface");
  assert.ok(!src.includes("{error.message}"), "no raw message");
});

// ---------------------------------------------------------------------------
// 6. Forbidden / access denied is not bare
// ---------------------------------------------------------------------------

test("forbidden: SurfaceGate no longer renders a bare 'Forbidden' heading", () => {
  const src = read("components/surface/SurfaceGate.tsx");
  assert.ok(!/<h1>Forbidden<\/h1>/.test(src), "bare Forbidden heading removed");
  assert.ok(src.includes("ProovraErrorState"), "uses the branded state");
  assert.match(src, /You don't have access to this area/);
});

// ---------------------------------------------------------------------------
// 7. No raw developer language in branded feedback surfaces
// ---------------------------------------------------------------------------

test("no raw developer language leaks in branded surfaces", () => {
  const files = [
    "app/not-found.tsx",
    "app/error.tsx",
    "app/global-error.tsx",
    "components/surface/SurfaceGate.tsx",
    "lib/feedback/toSafeUserError.ts",
  ];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/>\s*Forbidden\s*</.test(src), `${f}: no bare 'Forbidden' node`);
    assert.ok(!src.includes("Something went wrong"), `${f}: no vague 'Something went wrong'`);
    assert.ok(!/requestId:\s*\$\{/.test(src), `${f}: no inline requestId`);
  }
});
