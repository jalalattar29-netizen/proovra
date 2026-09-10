/**
 * Batch G — three small operator-language findings, each held by one case.
 *
 *   PV-I18N-001  Google's sign-in script rendered its button in the BROWSER's
 *                language while every other word on the page is English, so an
 *                Arabic-locale browser showed an Arabic Google button on an
 *                English form. The script is loaded with `hl=en`.
 *   PV-COPY-002  The MFA recovery empty state was titled with a developer's
 *                phrase; it now says what an operator is looking at.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(WEB_ROOT, rel), "utf8");

test("PV-I18N-001 — the Google Identity script is requested in English", () => {
  const src = read("lib/oauth.ts");
  const loads = [...src.matchAll(/loadScriptOnce\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  const gsi = loads.filter((u) => u.startsWith("https://accounts.google.com/gsi/client"));
  assert.equal(gsi.length, 1, `one GSI load, found ${gsi.length}`);
  assert.equal(new URL(gsi[0]).searchParams.get("hl"), "en");
});

test("PV-COPY-002 — the MFA recovery empty state names the state, not the code path", () => {
  const src = read("app/(app)/security-center/mfa-recovery/page.tsx");
  assert.match(src, /title="No pending recovery requests"/);
});
