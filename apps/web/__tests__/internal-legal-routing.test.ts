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
 * Authenticated surfaces never deep-link the public routes in the same
 * tab. Back-links return to an in-app origin (the internal /trust-center
 * hub or a specific settings anchor). The ONLY sanctioned public
 * destinations are links explicitly labeled "Open public Trust Center"
 * (→ /trust) that open in a NEW tab (target="_blank" +
 * rel="noopener noreferrer"), so the authenticated App Shell stays open
 * in the current tab (2026-07-21).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";

// The test runner (tsx/esbuild) compiles the renderer's JSX with the
// classic `React.createElement` transform, but `legal-content.tsx` relies
// on Next's automatic runtime and never imports React. Expose it globally
// so calling `renderLegalMarkdown` (which builds JSX elements) works here.
(globalThis as unknown as { React: typeof React }).React = React;

import { findSurfaceTierRule } from "../lib/surface/tiers";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import {
  internalLegalDocumentHref,
  isAuthenticatedPublicExit,
  renderLegalMarkdown,
} from "../app/legal/legal-content";

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
  // The per-document "View public version" action was removed (2026-07-20
  // UX cleanup): the authenticated + public docs share the same canonical
  // content, so the only public exit is the labelled Trust Center link.
  const SHELL_SRC = read("components/legal/LegalDocumentShell.tsx");
  assert.doesNotMatch(READER, /publicVersionHref/);
  assert.doesNotMatch(SHELL_SRC, /publicVersionHref/);
  assert.doesNotMatch(SHELL_SRC, /View public version/);
  // The kept Trust Center action opens the public site in a NEW tab and
  // leaves the app open in the current one.
  assert.match(SHELL_SRC, /data-legal-open-public-trust-center/);
  assert.match(SHELL_SRC, /target="_blank"/);
  assert.match(SHELL_SRC, /rel="noopener noreferrer"/);
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
  // The ONE intentional public destination is explicitly labeled AND
  // opens in a new tab (never a same-tab exit that drops the App Shell).
  assert.match(PRIVACY_SECTION, /Open public Trust Center/);
  assert.match(PRIVACY_SECTION, /data-cc-open-public-trust-center/);
  // Prove the public exit is a real new-tab anchor. Anchor the target +
  // rel to the same element that carries the data attribute.
  const privacyTrust = PRIVACY_SECTION.match(
    /<a\b[\s\S]*?data-cc-open-public-trust-center[\s\S]*?<\/a>/,
  );
  assert.ok(privacyTrust, "the public Trust Center exit must be an <a> anchor");
  assert.match(privacyTrust![0], /href="\/trust"/);
  assert.match(privacyTrust![0], /target="_blank"/);
  assert.match(privacyTrust![0], /rel="noopener noreferrer"/);
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

test("trust-center related links use the internal reader; back-links stay in-app", () => {
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
  // (2026-07-21) Authenticated trust-center back-links must return to the
  // INTERNAL Trust Center hub — never a same-tab exit to the public /trust
  // route (that drops the App Shell and reads as a sign-out). No
  // authenticated shell consumer may pass `backHref="/trust"`.
  for (const rel of [
    "app/(app)/trust-center/_section-list.tsx",
    "app/(app)/trust-center/status/page.tsx",
    "app/(app)/trust-center/subprocessors/page.tsx",
  ]) {
    const src = read(rel);
    assert.ok(
      !src.includes('backHref="/trust"'),
      `${rel}: a trust-center back-link must NOT exit to the public /trust route in the same tab`,
    );
    assert.ok(
      src.includes('backHref="/trust-center"'),
      `${rel}: the back-link must return to the internal /trust-center hub`,
    );
  }
  // Org Admin's public deep link opens the public site in a NEW tab.
  const orgAdmin = read("app/(app)/organizations/[id]/admin/trust/page.tsx");
  assert.match(orgAdmin, /Open public Trust Center/);
  const orgTrustAnchor = orgAdmin.match(
    /href="\/trust"[\s\S]{0,120}?external/,
  );
  assert.ok(
    orgTrustAnchor,
    "Org Admin's /trust deep link must be flagged external (new tab)",
  );
});

// ---------------------------------------------------------------------------
// 3c. Authenticated public Trust Center exits open in a NEW tab (2026-07-21)
// ---------------------------------------------------------------------------

test("every authenticated public Trust Center exit opens in a new tab, none use router.push", () => {
  // The shared authenticated document shell must default its back-link to
  // an in-app origin, and its ONE public exit must be a new-tab anchor.
  const SHELL_SRC = read("components/legal/LegalDocumentShell.tsx");
  assert.match(
    SHELL_SRC,
    /backHref\s*=\s*"\/trust-center"/,
    "the shell's default back-link must be internal, not public /trust",
  );
  assert.doesNotMatch(
    SHELL_SRC,
    /backHref\s*=\s*"\/trust"/,
    "the shell must not default its back-link to public /trust",
  );
  // The shell's public exit is a real new-tab anchor.
  const shellExit = SHELL_SRC.match(
    /<a\b[\s\S]*?data-legal-open-public-trust-center[\s\S]*?<\/a>/,
  );
  assert.ok(shellExit, "the shell public exit must be an <a> anchor");
  assert.match(shellExit![0], /href="\/trust"/);
  assert.match(shellExit![0], /target="_blank"/);
  assert.match(shellExit![0], /rel="noopener noreferrer"/);

  // Every authenticated caller that names the public /trust route must
  // either open it in a new tab or delegate to a component that does. No
  // authenticated surface may router.push / navigate to /trust in-tab.
  for (const rel of [
    "app/(app)/settings/_sections/PrivacySection.tsx",
    "components/legal/LegalDocumentShell.tsx",
  ]) {
    const src = read(rel);
    // Every full <a>…</a> element that points at the public /trust route
    // must carry target="_blank" (a new-tab exit, never a same-tab drop).
    const anchors = (src.match(/<a\b[\s\S]*?<\/a>/g) ?? []).filter((a) =>
      /href="\/trust"/.test(a),
    );
    assert.ok(anchors.length > 0, `${rel}: expected a public /trust anchor`);
    for (const a of anchors) {
      assert.match(
        a,
        /target="_blank"/,
        `${rel}: a public /trust anchor must open in a new tab`,
      );
      assert.match(
        a,
        /rel="noopener noreferrer"/,
        `${rel}: a public /trust anchor must set rel="noopener noreferrer"`,
      );
    }
  }

  // No authenticated surface performs a same-tab router navigation to the
  // public Trust Center.
  for (const rel of [
    "app/(app)/settings/_sections/PrivacySection.tsx",
    "app/(app)/organizations/[id]/admin/trust/page.tsx",
    "app/(app)/trust-center/status/page.tsx",
    "app/(app)/trust-center/subprocessors/page.tsx",
    "app/(app)/trust-center/_section-list.tsx",
    "components/legal/LegalDocumentShell.tsx",
  ]) {
    const src = read(rel);
    assert.doesNotMatch(
      src,
      /router\.(push|replace)\(\s*["'`]\/trust["'`]/,
      `${rel}: must not router-navigate to public /trust in the same tab`,
    );
    assert.doesNotMatch(
      src,
      /window\.open\s*\(/,
      `${rel}: must not use window.open (use a semantic new-tab anchor)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3d. Public callers are untouched (public /trust exits stay same-tab)
// ---------------------------------------------------------------------------

test("public callers keep their same-tab /trust links (unchanged)", () => {
  // The public legal reader's "Back to Trust Center" is public→public and
  // must stay a same-tab Link — this fix is scoped to authenticated callers.
  const PUBLIC_SLUG = read("app/legal/[slug]/page.tsx");
  assert.match(PUBLIC_SLUG, /href="\/trust"/);
  assert.match(PUBLIC_SLUG, /data-legal-back-to-trust/);
  const publicBack = PUBLIC_SLUG.match(
    /<Link\b[\s\S]*?data-legal-back-to-trust[\s\S]*?<\/Link>/,
  );
  assert.ok(publicBack, "the public reader back-link must exist");
  assert.doesNotMatch(
    publicBack![0],
    /target="_blank"/,
    "the public reader back-link stays same-tab (public→public)",
  );
});

// ---------------------------------------------------------------------------
// 3e. DOCUMENT-BODY Trust Center link — the actual "7. RELATED DOCUMENTS"
// anchor rendered from markdown (NOT the LegalDocumentShell footer).
// This is the exact link reported still opening /trust in the same tab.
// ---------------------------------------------------------------------------

// Minimal React-element walker — the renderer returns plain
// createElement objects; we collect every <a> and read its props.
type Elt = {
  type?: unknown;
  props?: { children?: unknown; href?: string; target?: string; rel?: string };
};
function collectAnchors(node: unknown, acc: Elt[] = []): Elt[] {
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) collectAnchors(n, acc);
    return acc;
  }
  const el = node as Elt;
  if (el.type === "a") acc.push(el);
  if (el.props && el.props.children != null) collectAnchors(el.props.children, acc);
  return acc;
}
function anchorText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(anchorText).join("");
  if (typeof node === "object") return anchorText((node as Elt).props?.children);
  return "";
}

test("internal reader renders the in-document Trust Center link as a NEW-TAB public exit", () => {
  // The exact reproduction document + its actual RELATED DOCUMENTS link.
  const md = read("content/legal/en/privacy-requests.md");
  assert.match(md, /\[Trust Center\]\(\/trust\)/, "fixture must contain the body link");

  // Render exactly as the authenticated reader does.
  const authed = renderLegalMarkdown(md, {
    mapHref: internalLegalDocumentHref,
    enhance: true,
    externalizePublicExits: true,
  });
  const authedAnchors = collectAnchors(authed);

  // The in-document Trust Center anchor (href="/trust", visible text
  // "Trust Center") — NOT the shell footer (this render has no footer).
  const trustAnchor = authedAnchors.find(
    (a) => a.props?.href === "/trust" && anchorText(a).includes("Trust Center"),
  );
  assert.ok(trustAnchor, "the body Trust Center anchor must exist");
  assert.equal(trustAnchor!.props?.href, "/trust");
  assert.equal(
    trustAnchor!.props?.target,
    "_blank",
    "the body Trust Center link must open in a new tab",
  );
  assert.equal(
    trustAnchor!.props?.rel,
    "noreferrer noopener",
    "the body Trust Center link must set rel noopener/noreferrer",
  );

  // The OTHER related-document links stay internal + same-tab.
  const internalAnchors = authedAnchors.filter((a) =>
    (a.props?.href ?? "").startsWith("/settings/legal/"),
  );
  assert.ok(
    internalAnchors.length >= 1,
    "internal related links must map to /settings/legal/*",
  );
  for (const a of internalAnchors) {
    assert.equal(
      a.props?.target,
      undefined,
      `${a.props?.href} must stay in the current app tab`,
    );
  }
  // The document must not leak the public /legal/* namespace after mapping.
  assert.ok(
    !authedAnchors.some((a) => (a.props?.href ?? "").startsWith("/legal/")),
    "authenticated body links must not point at the public /legal namespace",
  );

  // PUBLIC rendering (no externalizePublicExits) keeps /trust same-tab.
  const publicRender = renderLegalMarkdown(md);
  const publicTrust = collectAnchors(publicRender).find(
    (a) => a.props?.href === "/trust",
  );
  assert.ok(publicTrust, "public render still has the /trust anchor");
  assert.equal(
    publicTrust!.props?.target,
    undefined,
    "public legal rendering is unchanged (same-tab /trust)",
  );

  // The flag is the ONLY thing that externalizes: with mapHref+enhance but
  // WITHOUT the flag, /trust stays same-tab (proves no global forcing).
  const noFlag = renderLegalMarkdown(md, {
    mapHref: internalLegalDocumentHref,
    enhance: true,
  });
  const noFlagTrust = collectAnchors(noFlag).find(
    (a) => a.props?.href === "/trust",
  );
  assert.equal(
    noFlagTrust?.props?.target,
    undefined,
    "without externalizePublicExits, /trust is not forced to a new tab",
  );
});

test("isAuthenticatedPublicExit flags /trust but never internal /trust-center", () => {
  for (const h of ["/trust", "/trust/", "/trust?x=1", "/trust#anchor"]) {
    assert.equal(isAuthenticatedPublicExit(h), true, `${h} is a public exit`);
  }
  for (const h of [
    "/trust-center",
    "/trust-center/security",
    "/settings/legal/privacy",
    "/trusted-thing",
    "/support",
  ]) {
    assert.equal(isAuthenticatedPublicExit(h), false, `${h} is NOT a public exit`);
  }
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

test("the internal reader wires mapper + enhance into renderLegalMarkdown; public page uses neither", () => {
  assert.match(READER, /mapHref: internalLegalDocumentHref/);
  assert.match(READER, /enhance: true/);
  const PUBLIC_SLUG = read("app/legal/[slug]/page.tsx");
  assert.doesNotMatch(PUBLIC_SLUG, /mapHref|enhance/);
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
