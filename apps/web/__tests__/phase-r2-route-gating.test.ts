/**
 * Phase R2 — Authentication / route-gating hardening (regression).
 *
 * Defends three fixes from the remediation program (findings F7, F8, F18):
 *
 *   1. F8 — the platform-operations pages that mutate global state
 *      (`/admin/platform/queues|signers|exports|recovery`) were gated by the
 *      WRONG routeId `workspace.security_center` (OPS-tier,
 *      PERSONAL_OR_ORG, `SECURITY_CENTER_VIEW`) — a weaker gate than their
 *      PLATFORM_ADMIN siblings. R2 repoints them to PLATFORM_ADMIN routeIds
 *      (`platform.queue_ops` / `operations.signers|exports|recovery`).
 *
 *   2. F8 — the three new registry entries must exist and be
 *      `requiredActiveSpace: "PLATFORM_ADMIN"`.
 *
 *   3. F7 — the middleware INTERNAL-surface gate must 404 only
 *      UNAUTHENTICATED requests (presence check on `proovra_session`), so
 *      authenticated platform admins are no longer 404'd on the admin-nav
 *      ops links in production. This is only safe BECAUSE of fix (1).
 *
 *   4. F18 — the investigation→reviewers empty-state must link to the real
 *      `/review/external` page, not the nonexistent `/reviewer-ops/external`.
 *
 * Source-contract style (node:test), matching the sibling web tests.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const registrySrc = read("../lib/navigation/routeRegistry.ts");
const middlewareSrc = read("../middleware.ts");

const OPS_PAGES: Array<{ path: string; routeId: string }> = [
  { path: "../app/(app)/admin/platform/queues/page.tsx", routeId: "platform.queue_ops" },
  { path: "../app/(app)/admin/platform/signers/page.tsx", routeId: "operations.signers" },
  { path: "../app/(app)/admin/platform/exports/page.tsx", routeId: "operations.exports" },
  { path: "../app/(app)/admin/platform/recovery/page.tsx", routeId: "operations.recovery" },
];

test("F8 — global-ops pages use PLATFORM_ADMIN routeIds, not workspace.security_center", () => {
  for (const { path, routeId } of OPS_PAGES) {
    const src = read(path);
    assert.ok(
      src.includes(`routeId="${routeId}"`),
      `${path} should gate on ${routeId}`,
    );
    assert.ok(
      !src.includes('routeId="workspace.security_center"'),
      `${path} must not use the weaker workspace.security_center gate`,
    );
  }
});

test("F8 — new operations.* registry entries exist and require PLATFORM_ADMIN", () => {
  for (const id of ["operations.signers", "operations.exports", "operations.recovery"]) {
    const idx = registrySrc.indexOf(`id: "${id}"`);
    assert.ok(idx > -1, `registry must declare ${id}`);
    // The `requiredActiveSpace: "PLATFORM_ADMIN"` must appear within the
    // entry's body (before the next entry's `id:`).
    const nextId = registrySrc.indexOf("id: \"", idx + 1);
    const body = registrySrc.slice(idx, nextId === -1 ? undefined : nextId);
    assert.ok(
      /requiredActiveSpace:\s*"PLATFORM_ADMIN"/.test(body),
      `${id} must require PLATFORM_ADMIN active space`,
    );
  }
});

test("F7 — middleware INTERNAL 404 gate is conditioned on an absent session cookie", () => {
  // The rewrite must be guarded by a proovra_session presence check.
  assert.ok(
    middlewareSrc.includes('req.cookies.get("proovra_session")'),
    "middleware must read the proovra_session cookie in the tier gate",
  );
  // The /not-found rewrite must sit inside the `!hasSession` branch.
  const gateIdx = middlewareSrc.indexOf('rule.tier === "INTERNAL"');
  assert.ok(gateIdx > -1, "INTERNAL tier gate must exist");
  const region = middlewareSrc.slice(gateIdx, gateIdx + 500);
  assert.ok(/if \(!hasSession\)/.test(region), "404 must be gated by !hasSession");
  assert.ok(
    region.indexOf("!hasSession") < region.indexOf('"/not-found"'),
    "the !hasSession guard must precede the /not-found rewrite",
  );
});

test("F18 — investigation reviewers empty-state links to the real /review/external page", () => {
  const src = read("../app/(app)/investigation/reviewers/page.tsx");
  assert.ok(
    !src.includes("/reviewer-ops/external"),
    "must not link to the nonexistent /reviewer-ops/external",
  );
  assert.ok(
    src.includes('href: "/review/external"'),
    "must link to the real /review/external page",
  );
});
