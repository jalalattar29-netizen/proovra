/**
 * PLATFORM ADMIN — implemented capabilities must be REACHABLE (ADM-020, ADM-021, ADM-026).
 *
 * WHY THIS TEST EXISTS
 * ---------------------------------------------------------------------------
 * Three findings in the admin audit shared one shape: a capability that was
 * fully built on the server — registered, gated, authorized, audited, and in
 * two cases step-up protected — and that nothing in the product could invoke.
 * An operator could not suspend a customer, could not mint a support grant, and
 * could not activate break-glass, because the only callers were tests.
 *
 * That is invisible to every server-side test. The route exists, the gate
 * holds, the handler works, and the suite is green — while the capability is
 * unreachable by any human. It is only detectable by asking the OTHER side
 * whether anyone calls it.
 *
 * When one of these fails, the fix is to wire the caller. Deleting the
 * assertion re-hides the capability.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = resolve(HERE, "../app/(app)/admin");

function adminSource(): string {
  let out = "";
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry)) out += readFileSync(abs, "utf8");
    }
  };
  walk(ADMIN);
  return out;
}

const SRC = adminSource();

test("ADM-020 — organization suspend and resume have a caller", () => {
  // The caller builds the path from a `leg` variable, so pin the template it
  // actually emits plus the two legs it iterates — not a substring loose
  // enough for an unrelated URL to satisfy.
  assert.ok(
    SRC.includes("/v1/admin/orgs/") && SRC.includes("apiFetch("),
    "no admin surface calls /v1/admin/orgs/:id/* at all",
  );
  assert.ok(
    SRC.includes("runLifecycle(\"suspend\")"),
    "nothing invokes the suspend leg",
  );
  assert.ok(
    SRC.includes("runLifecycle(\"resume\")"),
    "nothing invokes the resume leg",
  );
  assert.ok(
    SRC.includes("const runLifecycle = async (leg: \"suspend\" | \"resume\")"),
    "the suspend/resume caller is gone or changed shape",
  );
  // The effect reaches every member of the organization, so it must be
  // confirmed — and never through window.confirm, which this app bans.
  assert.match(SRC, /useConfirmAction/, "suspend must be confirmed");
  assert.doesNotMatch(SRC, /window\.confirm\(/, "window.confirm is banned");
});

test("ADM-021 — support access and break-glass can be MINTED, not only revoked", () => {
  assert.ok(
    SRC.includes('"/v1/support-access/start"'),
    "a support grant can never be created from the product",
  );
  assert.ok(
    SRC.includes('"/v1/break-glass/activate"'),
    "break-glass can never be activated from the product",
  );
  // Both were already reachable for revocation; the gap was creation.
  assert.ok(SRC.includes('"/v1/support-access/revoke"'));
  assert.ok(SRC.includes('"/v1/break-glass/revoke"'));
});

test("ADM-021 — the console does not describe a workflow that does not exist", () => {
  assert.doesNotMatch(
    SRC,
    /Activation happens through\s+the incident workflow/,
    "the page claimed activation happens elsewhere; no such caller exists",
  );
});

test("ADM-026 — the demo-request back-link is not inert", () => {
  const list = readFileSync(join(ADMIN, "demo-requests/page.tsx"), "utf8");
  const detail = readFileSync(join(ADMIN, "demo-requests/[id]/page.tsx"), "utf8");

  assert.match(
    detail,
    /\/admin\/demo-requests\?id=/,
    "the detail page still links back with ?id=",
  );
  assert.ok(
    list.includes('params.get("id")'),
    "the list ignores ?id=, so 'back' drops the record being viewed",
  );
});
