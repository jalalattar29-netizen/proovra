/**
 * T-09c / RC-10 — the signed-in identity must be visible in the chrome, and the
 * strings that carry it must never be invented.
 *
 * THE DEFECT THIS WOULD HAVE CAUGHT
 * ---------------------------------
 * Native showed the identity NOWHERE in its chrome. Combined with the absent
 * workspace switcher (T-09b), "I am looking at the wrong account's data" was
 * close to undiagnosable from the UI — which is one of the things the user hit
 * on a physical iPad.
 *
 * The projections are pure, so the fallback chain is asserted directly rather
 * than through a render.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");

const { accountInitials, accountDisplayName } = await import(
  "../src/product/account-identity.ts"
).catch(async () => {
  // .ts is not importable by node:test directly; bundle it the way the render
  // harness does so the pure module can still be exercised.
  const mod = await loadWithProviders("src/product/account-identity.ts", [
    "accountInitials",
    "accountDisplayName",
  ]);
  return mod;
});

test("initials: a full name uses first and last", () => {
  assert.equal(accountInitials({ displayName: "Jalal Attar" }), "JA");
  assert.equal(accountInitials({ displayName: "  Ada  Lovelace " }), "AL");
});

test("initials: a single word uses its first two letters", () => {
  assert.equal(accountInitials({ displayName: "Jalal" }), "JA");
});

test("initials: falls back to the email local-part, split on separators", () => {
  assert.equal(accountInitials({ email: "jalal.attar@proovra.com" }), "JA");
  assert.equal(accountInitials({ displayName: "", email: "ada_lovelace@x.io" }), "AL");
  assert.equal(accountInitials({ email: "ada@x.io" }), "AD");
});

test("initials: NEVER invents a name when there is nothing to show", () => {
  // A wrong identity in permanent chrome is worse than no identity.
  assert.equal(accountInitials(null), "•");
  assert.equal(accountInitials({}), "•");
  assert.equal(accountInitials({ displayName: "   ", email: null }), "•");
});

test("display name: displayName → email → neutral, never a guess", () => {
  assert.equal(accountDisplayName({ displayName: "Jalal Attar" }), "Jalal Attar");
  assert.equal(accountDisplayName({ displayName: null, email: "a@b.c" }), "a@b.c");
  assert.equal(accountDisplayName(null), "Account");
});

test("the header renders the identity and reaches account settings", () => {
  const header = readFileSync(resolve(MOBILE, "src/ui/header.tsx"), "utf8");
  assert.match(header, /accountInitials\(user\)/, "the header shows no identity");
  assert.match(
    header,
    /Signed in as \$\{accountName\}\. Open account settings\./,
    "the account control does not announce who is signed in",
  );
  assert.match(header, /router\.push\("\/settings"\)/, "the account control reaches nothing");
});

test("the account control REUSES the Settings surface rather than duplicating it", () => {
  // The web menu's entries (Settings, Billing, Organizations, Sign out) all
  // already exist as rows in app/(tabs)/settings.tsx. A second menu here would
  // be a duplicate surface, which the remediation mandate forbids.
  const header = readFileSync(resolve(MOBILE, "src/ui/header.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(header, /signOut|logout|\/billing|\/organizations/, "the header re-implements Settings entries");
});

test("RENDER: the avatar is present with the initials", async () => {
  const mod = await loadWithProviders("src/ui/header.tsx", ["ProovraHeader"]);
  const r = await renderInProviders(mod, React.createElement(mod.ProovraHeader, null));
  const texts = r.texts();
  // Signed out in the harness → the neutral glyph, not a fabricated name.
  assert.ok(
    texts.some((t) => t === "•" || /^[A-Z]{2}$/.test(t)),
    `the header renders no account initials; saw ${JSON.stringify(texts)}`,
  );
});
