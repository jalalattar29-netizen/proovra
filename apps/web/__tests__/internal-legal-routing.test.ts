/**
 * Internal legal routing correction contracts (2026-07-19).
 *
 * SAME DESIGN, NOT SAME PUBLIC ROUTE: a signed-in user who opens a
 * legal/trust document from any authenticated surface must stay inside
 * the authenticated App Shell. The canonical internal reader lives at
 * `/settings/legal/[slug]` and reads the SAME markdown source as the
 * public `/legal/[slug]` pages — two shells, one content source:
 *
 *   CanonicalLegalContent (app/legal/legal-content.tsx)
 *   ├── public  → LegalHero + EnterpriseFooter   (/legal/[slug])
 *   └── internal → LegalDocumentShell in (app)   (/settings/legal/[slug])
 *
 * Authenticated surfaces never deep-link the public routes; the ONLY
 * sanctioned public destinations are links explicitly labeled
 * "Open public Trust Center" (→ /trust) and the reader's own labeled
 * public-counterpart link.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSurfaceTierRule } from "../lib/surface/tiers";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { internalLegalDocumentHref } from "../app/legal/legal-content";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const READER = read("app/(app)/settings/legal/[slug]/page.tsx");
const PRIVACY_SECTION = read("app/(app)/settings/_sections/PrivacySection.tsx");

// ---------------------------------------------------------------------------
// 1. The internal reader route exists, is registered, and stays in-shell
// ---------------------------------------------------------------------------

test("route registry carries the internal legal reader (both twins)", () => {
  const entry = ROUTE_REGISTRY.find((r) => r.id === "account.legal_document");
  assert.ok(entry, "account.legal_document must be registered");
  assert.equal(entry?.href, "/settings/legal/:slug");
  assert.equal(entry?.domain, "ACCOUNT");
  assert.equal(entry?.requiredActiveSpace, "NONE");
  // The CRLF runtime twin consumed by the API tests carries it too.
  const twin = read("lib/navigation/routeRegistry.js");
  assert.ok(twin.includes('"account.legal_document"'), "js twin has the entry");
  assert.ok(twin.includes('"/settings/legal/:slug"'), "js twin has the href");
});

test("internal reader renders the SHARED content source through the authenticated shell", () => {
  // One content source — the same loader/renderer/slug-allowlist as the
  // public page. No duplicated markdown, no forked renderer.
  assert.match(READER, /from "\.\.\/\.\.\/\.\.\/\.\.\/legal\/legal-content"/);
  assert.match(READER, /ALLOWED_LEGAL_SLUGS/);
  assert.match(READER, /loadLegalMarkdown/);
  assert.match(READER, /renderLegalMarkdown/);
  assert.match(READER, /legalHeroFor/);
  // Same visual system, authenticated shell variant.
  assert.match(READER, /LegalDocumentShell/);
  // Authorization stays with PageRouteGate inside the (app) layout.
  assert.match(READER, /PageRouteGate/);
  assert.match(READER, /routeId="account\.legal_document"/);
  // The reader must NOT mount the public chrome (that is the defect).
  // Import-scoped: the docblock prose may NAME the public shells.
  assert.doesNotMatch(
    READER,
    /^import[^\n]*(MarketingHeader|EnterpriseFooter|LegalHero)/m,
  );
  // Server component (markdown loads from disk) — never "use client".
  assert.doesNotMatch(READER, /^"use client"/m);
  // Unknown slugs 404 instead of rendering an empty document.
  assert.match(READER, /notFound\(\)/);
  // The one outbound link to the public counterpart is explicitly labeled.
  assert.match(READER, /data-internal-legal-public-counterpart/);
  assert.match(READER, /leaves the app/);
});

test("/settings/legal/* inherits the CORE allow tier (no redirect off the shell)", () => {
  const rule = findSurfaceTierRule("/settings/legal/privacy");
  assert.ok(rule, "a tier rule must match /settings/legal/*");
  assert.equal(rule?.tier, "CORE");
  assert.equal(rule?.directAccessPolicy, "allow");
});

// ---------------------------------------------------------------------------
// 2. Settings privacy links stay inside the app
// ---------------------------------------------------------------------------

test("Settings privacy references target the internal reader, never public routes", () => {
  for (const target of [
    "/settings/legal/privacy-requests",
    "/settings/legal/privacy",
    "/settings/legal/terms",
    "/settings/legal/cookies",
  ]) {
    assert.ok(
      PRIVACY_SECTION.includes(`href="${target}"`),
      `Settings must link ${target}`,
    );
  }
  // The public aliases and public legal namespace are banned from Settings.
  assert.doesNotMatch(PRIVACY_SECTION, /href="\/privacy"/);
  assert.doesNotMatch(PRIVACY_SECTION, /href="\/terms"/);
  assert.doesNotMatch(PRIVACY_SECTION, /href="\/legal\//);
  // The ONE intentional public destination is explicitly labeled.
  assert.match(PRIVACY_SECTION, /Open public Trust Center/);
  assert.match(PRIVACY_SECTION, /data-cc-open-public-trust-center/);
});

// ---------------------------------------------------------------------------
// 3. No authenticated surface deep-links the public legal namespace
// ---------------------------------------------------------------------------

function* walkTsx(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkTsx(p);
    else if (/\.(tsx|ts)$/.test(name)) yield p;
  }
}

test("no file under app/(app) links /legal/*, /privacy, or /terms", () => {
  const offenders: string[] = [];
  for (const file of walkTsx(resolve(APP_ROOT, "app", "(app)"))) {
    const src = readFileSync(file, "utf8");
    // JSX attributes, object-literal relatedLinks, and template literals.
    if (
      /href="\/legal\//.test(src) ||
      /href: "\/legal\//.test(src) ||
      /href="\/privacy"/.test(src) ||
      /href="\/terms"/.test(src)
    ) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `authenticated surfaces must use /settings/legal/*: ${offenders.join(", ")}`,
  );
});

test("trust-center related links use the internal reader; /trust exits are labeled", () => {
  const files = [
    "app/(app)/trust-center/methodology/page.tsx",
    "app/(app)/trust-center/security/page.tsx",
    "app/(app)/trust-center/ai-disclosure/page.tsx",
    "app/(app)/trust-center/subprocessors/page.tsx",
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.ok(
      src.includes('"/settings/legal/'),
      `${rel} must link internal legal documents`,
    );
  }
  // Every remaining back-link to public /trust is explicitly labeled.
  for (const rel of [
    "app/(app)/trust-center/_section-list.tsx",
    "app/(app)/trust-center/status/page.tsx",
    "app/(app)/trust-center/subprocessors/page.tsx",
  ]) {
    const src = read(rel);
    if (src.includes('backHref="/trust"')) {
      assert.ok(
        src.includes('backLabel="Open public Trust Center"'),
        `${rel}: a /trust back-link must be labeled "Open public Trust Center"`,
      );
    }
  }
  // Org Admin's deep link to /trust is labeled too.
  const orgAdmin = read("app/(app)/organizations/[id]/admin/trust/page.tsx");
  assert.match(orgAdmin, /Open public Trust Center/);
});

// ---------------------------------------------------------------------------
// 3b. Markdown-embedded document links stay in-app (runtime mapper)
// ---------------------------------------------------------------------------

test("internalLegalDocumentHref maps embedded public legal hrefs to the reader", () => {
  // Valid document links map into the authenticated namespace.
  assert.equal(internalLegalDocumentHref("/legal/privacy"), "/settings/legal/privacy");
  assert.equal(internalLegalDocumentHref("/legal/aup"), "/settings/legal/aup");
  assert.equal(internalLegalDocumentHref("/privacy"), "/settings/legal/privacy");
  assert.equal(internalLegalDocumentHref("/terms"), "/settings/legal/terms");
  assert.equal(internalLegalDocumentHref("/security-overview"), "/settings/legal/security");
  // Anchored links keep working.
  assert.equal(
    internalLegalDocumentHref("/legal/privacy#retention"),
    "/settings/legal/privacy",
  );
  // Non-document and unknown paths pass through untouched.
  assert.equal(internalLegalDocumentHref("/trust"), "/trust");
  assert.equal(internalLegalDocumentHref("/support"), "/support");
  assert.equal(internalLegalDocumentHref("/contact-sales"), "/contact-sales");
  assert.equal(internalLegalDocumentHref("/legal/not-a-doc"), "/legal/not-a-doc");
});

test("the internal reader wires the mapper into renderLegalMarkdown; public page does not", () => {
  assert.match(READER, /renderLegalMarkdown\(content, \{ mapHref: internalLegalDocumentHref \}\)/);
  const PUBLIC_SLUG = read("app/legal/[slug]/page.tsx");
  assert.doesNotMatch(PUBLIC_SLUG, /mapHref/);
});

// ---------------------------------------------------------------------------
// 4. Public legal system stays untouched (two shells, one source)
// ---------------------------------------------------------------------------

test("public /legal/[slug] keeps its public chrome and the shared source", () => {
  const PUBLIC_SLUG = read("app/legal/[slug]/page.tsx");
  assert.match(PUBLIC_SLUG, /LegalHero/);
  assert.match(PUBLIC_SLUG, /EnterpriseFooter/);
  assert.match(PUBLIC_SLUG, /legal-content/);
  // The internal reader never replaced or renamed the public route.
  const CONTENT = read("app/legal/legal-content.tsx");
  assert.match(CONTENT, /ALLOWED_LEGAL_SLUGS/);
});
