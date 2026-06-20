/**
 * Phase ADM — Admin-console CTA contract for marketing lead notification
 * emails.
 *
 * Production reports surfaced two related defects:
 *
 *   1. Request Demo notification email rendered Quick Actions but no
 *      "Open in admin console" primary button (the demo-request branch
 *      of sendDemoRequestNotification was passing only title/preheader/
 *      bodyHtml to emailShell — without ctaText/ctaUrl, the shell omits
 *      the entire CTA block).
 *   2. Contact Sales notification email DID render an admin button, but
 *      the URL was built off a non-existent PROOVRA_WEB_BASE env var
 *      and fell back to https://proovra.com/admin/contact-sales/<id> —
 *      which a) isn't the admin host (admin lives on app.proovra.com)
 *      and b) returns 404 because the admin page is at the (app) route
 *      group with no /<id> Next.js route.
 *
 * Both faults are now fixed by routing both emails through a shared
 * buildAdminLeadUrl helper that resolves ADMIN_BASE_URL → APP_BASE_URL
 * → https://app.proovra.com (with a structured log on fallback).
 *
 * These are file-text contracts so they stay green in CI without infra.
 * No DB, no Resend, no env config required.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_ROOT = resolve(__dirname, "..");
const EMAIL_SERVICE = readFileSync(
  resolve(API_ROOT, "src/services/email.service.ts"),
  "utf8",
);

describe("Email — shared buildAdminLeadUrl helper", () => {
  it("exports a buildAdminLeadUrl helper with the two lead kinds", () => {
    expect(EMAIL_SERVICE).toMatch(
      /export function buildAdminLeadUrl\(input: \{[\s\S]+kind: "demo-request" \| "contact-sales";[\s\S]+id: string;/,
    );
  });

  it("resolves ADMIN_BASE_URL → APP_BASE_URL → https://app.proovra.com", () => {
    // Helper reads ADMIN_BASE_URL first, then APP_BASE_URL, then
    // falls back to the admin subdomain.
    expect(EMAIL_SERVICE).toMatch(
      /env\("ADMIN_BASE_URL"\)\s*\?\?\s*env\("APP_BASE_URL"\)/,
    );
    expect(EMAIL_SERVICE).toContain('"https://app.proovra.com"');
  });

  it("warns on missing config without exposing lead PII", () => {
    // The fallback path emits a tagged structured warning so ops can
    // page on it. The log line must NOT include requestId, fullName,
    // workEmail, or any payload value — only the static tag.
    expect(EMAIL_SERVICE).toMatch(/tag:\s*"admin_lead_url_fallback"/);
    expect(EMAIL_SERVICE).not.toMatch(
      /admin_lead_url_fallback[\s\S]{0,300}requestId/,
    );
    expect(EMAIL_SERVICE).not.toMatch(
      /admin_lead_url_fallback[\s\S]{0,300}workEmail/,
    );
  });

  it("builds the path under /admin/<segment>/<id>", () => {
    expect(EMAIL_SERVICE).toMatch(
      /\/admin\/\$\{segment\}\/\$\{encodeURIComponent\(input\.id\)\}/,
    );
  });
});

// Helper: slice the REAL implementation block of a method (skipping the
// not-configured stub, which appears first). The real implementation is
// recognisable by `async <method>(params) {` (with the `params` arg),
// whereas the stub is `async <method>() {`.
function sliceImpl(methodName: string, nextMethodName: string): string {
  const re = new RegExp(`async\\s+${methodName}\\s*\\(params\\)\\s*\\{`);
  const startMatch = EMAIL_SERVICE.match(re);
  if (!startMatch || startMatch.index == null) return "";
  const start = startMatch.index;
  const nextRe = new RegExp(`async\\s+${nextMethodName}\\s*\\(`);
  const rest = EMAIL_SERVICE.slice(start);
  const nextMatch = rest.match(nextRe);
  const end = nextMatch && nextMatch.index != null ? start + nextMatch.index : EMAIL_SERVICE.length;
  return EMAIL_SERVICE.slice(start, end);
}

describe("Email — Request Demo notification", () => {
  const demoBlock = sliceImpl(
    "sendDemoRequestNotification",
    "sendDemoRequestAutoReply",
  );

  it("invokes emailShell with ctaText 'Open in admin console'", () => {
    // The previous bug was missing ctaText/ctaUrl on this emailShell
    // call. Lock the strings literally — if either is removed again,
    // this test fails immediately.
    expect(demoBlock).toMatch(/title:\s*"New demo request"/);
    expect(demoBlock).toMatch(/ctaText:\s*"Open in admin console"/);
    expect(demoBlock).toMatch(/ctaUrl:\s*adminConsoleUrl/);
  });

  it("computes admin URL via buildAdminLeadUrl({kind: 'demo-request'})", () => {
    expect(demoBlock).toMatch(
      /buildAdminLeadUrl\(\{\s*kind:\s*"demo-request",\s*id:\s*params\.requestId/,
    );
  });

  it("includes admin URL in the plain-text fallback so non-HTML clients still get it", () => {
    expect(demoBlock).toMatch(/Open in admin console: \$\{adminConsoleUrl\}/);
  });

  it("keeps the Quick actions block intact (don't regress existing helpful links)", () => {
    expect(demoBlock).toContain("<strong>Quick actions</strong>");
    expect(demoBlock).toContain("Reply to lead");
    expect(demoBlock).toContain("Open sample report");
    expect(demoBlock).toContain("Open verification demo");
    expect(demoBlock).toContain("Open methodology");
    expect(demoBlock).toContain("Open pricing");
    expect(demoBlock).toContain("Open request demo page");
    expect(demoBlock).toContain("Open contact sales page");
  });
});

describe("Email — Contact Sales notification", () => {
  const csBlock = sliceImpl(
    "sendContactSalesNotification",
    "sendContactSalesAutoReply",
  );

  it("invokes emailShell with ctaText 'Open in admin console'", () => {
    expect(csBlock).toMatch(/ctaText:\s*"Open in admin console"/);
  });

  it("computes admin URL via buildAdminLeadUrl({kind: 'contact-sales'})", () => {
    expect(csBlock).toMatch(
      /buildAdminLeadUrl\(\{\s*kind:\s*"contact-sales",\s*id:\s*params\.requestId/,
    );
  });

  it("never points the admin button at the public marketing host", () => {
    // These are the strings that were in the broken production
    // version. Block them across the entire file so neither template
    // can regress.
    expect(EMAIL_SERVICE).not.toMatch(/"https:\/\/proovra\.com"\s*\)\s*\}\s*\/admin/);
    expect(EMAIL_SERVICE).not.toMatch(/www\.proovra\.com\/admin/);
    // The phantom env var that was used before — also blocked.
    expect(EMAIL_SERVICE).not.toMatch(/PROOVRA_WEB_BASE/);
  });
});

describe("Admin detail routes — Next.js pages exist", () => {
  const WEB_ROOT = resolve(API_ROOT, "../../apps/web");

  it("apps/web/app/(app)/admin/contact-sales/[id]/page.tsx exists", () => {
    const detail = readFileSync(
      resolve(WEB_ROOT, "app/(app)/admin/contact-sales/[id]/page.tsx"),
      "utf8",
    );
    expect(detail).toContain("AdminContactSalesDetailPage");
    expect(detail).toMatch(/\/v1\/admin\/contact-sales\/\$\{encodeURIComponent\(id\)\}/);
    expect(detail).toContain("Back to list");
    expect(detail).toContain("Copy");
  });

  it("apps/web/app/(app)/admin/demo-requests/[id]/page.tsx exists", () => {
    const detail = readFileSync(
      resolve(WEB_ROOT, "app/(app)/admin/demo-requests/[id]/page.tsx"),
      "utf8",
    );
    expect(detail).toContain("AdminDemoRequestDetailPage");
    expect(detail).toMatch(/\/v1\/admin\/demo-requests\/\$\{encodeURIComponent\(id\)\}/);
    expect(detail).toContain("Back to list");
    expect(detail).toContain("Copy");
  });

  it("contact-sales list page links rows to the dedicated detail route", () => {
    const list = readFileSync(
      resolve(WEB_ROOT, "app/(app)/admin/contact-sales/page.tsx"),
      "utf8",
    );
    expect(list).toMatch(
      /href=\{`\/admin\/contact-sales\/\$\{encodeURIComponent\(it\.id\)\}`\}/,
    );
  });

  it("demo-requests list page links rows to the dedicated detail route", () => {
    const list = readFileSync(
      resolve(WEB_ROOT, "app/(app)/admin/demo-requests/page.tsx"),
      "utf8",
    );
    expect(list).toMatch(
      /href=\{`\/admin\/demo-requests\/\$\{encodeURIComponent\(item\.id\)\}`\}/,
    );
  });
});
