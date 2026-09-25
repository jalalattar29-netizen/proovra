/**
 * support — the native port of apps/web/app/support/page.tsx.
 *
 * The screen makes no API call of its own; its only server contract is the
 * legal reader it routes into: GET /v1/legal/:slug
 * (services/api/src/routes/legal.routes.ts:72), which serves the corpus
 * generated from apps/web/content/legal/en/*.md and answers an unknown slug
 * with 404 LEGAL_DOCUMENT_NOT_FOUND (:75-83). So every slug this screen routes
 * to must exist in that corpus, or the user lands on "No such legal document".
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const CORPUS = resolve(MOBILE, "../web/content/legal/en");
let M;
let fetched = [];

before(async () => {
  M = await loadModule("app/(stack)/support.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  fetched = [];
  globalThis.__EXPO_PARAMS__ = {};
  globalThis.__LINKING_OPENED__ = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

const ROUTES = [
  ["Product", "Product support", "For questions about capture, evidence records, verification pages, reports, account workflows, and general product usage.", "Email support@proovra.com"],
  ["Billing", "Account and billing", "For login, subscription, payment, invoice, refund, and plan questions.", "Email billing@proovra.com"],
  ["Security", "Security and responsible disclosure", "For vulnerability reports, suspected compromise, security concerns, and responsible-disclosure intake.", "Open Security policy"],
  ["Legal & privacy", "Legal and privacy requests", "For law-enforcement, data-subject, privacy, copyright, abuse, and other legally sensitive requests.", "Open Trust Center"],
];

test("renders the web's four routes, in order, with the web's copy — and fetches nothing", async () => {
  const r = await render();
  assert.equal(r.byTestId("support").length > 0, true);
  assert.ok(r.hasText("Support"));
  assert.ok(r.hasText("Pick the route that matches your request."));
  const texts = r.texts();
  let last = -1;
  for (const [label, title, body, cta] of ROUTES) {
    for (const t of [label, title, body, cta]) assert.ok(r.hasText(t), `missing "${t}"`);
    const at = texts.indexOf(title);
    assert.ok(at > last, `${title} is out of the web's order`);
    last = at;
  }
  assert.deepEqual(fetched, [], "a static screen made a network call");
});

test("the email routes open a mailto: on the device and do not navigate", async () => {
  const r = await render();
  await r.press("Email support@proovra.com");
  await r.press("Email billing@proovra.com");
  await settle();
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["mailto:support@proovra.com", "mailto:billing@proovra.com"]);
  assert.deepEqual(M.calls.push, []);
});

test("Security opens the in-app legal reader; Legal & privacy opens the IN-APP Trust Center", async () => {
  const r = await render();
  await r.press("Open Security policy");
  await r.press("Open Trust Center");
  assert.deepEqual(M.calls.push, ["/legal/security", "/(stack)/trust-center"]);
  assert.deepEqual(globalThis.__LINKING_OPENED__, [], "a support route ejected the user to a browser");
  assert.ok(existsSync(resolve(MOBILE, "app/(stack)/trust-center.tsx")));
  assert.ok(existsSync(resolve(MOBILE, "app/(stack)/legal/[slug].tsx")));
});

test("Back returns to where the user came from", async () => {
  const r = await render();
  await r.press("Back");
  assert.equal(M.calls.back, 1);
});

/* ------------------------------------------------ NEW:SUPPORT-SECTIONS */
/*
 * Every section of the web page, with the web's copy. The expected strings
 * below are copied from apps/web/app/support/page.tsx, not from the native
 * module — a test that read its expectations from the module under test would
 * pass whatever the module said.
 */
const SECTIONS = {
  hero: ["Get the right help path.", "Choose the support route that matches your request — product help, billing, security reports, legal and privacy requests, or enterprise evaluation.", "Product help", "Security reports", "Legal routing", "Email support", "Talk to sales"],
  paths: ["Support paths", "Pick the route that matches your request.", "Each path routes your request to the correct operational, security, legal, or enterprise workflow."],
  routing: ["Support routing", "From question to the right team.", "PROOVRA support is routed by request type so sensitive matters reach the correct operational, security, legal, or enterprise path.", "Step 1", "Start with your request", "Describe what you need. Most requests fall into one of five types.", "Step 2", "Choose request type", "Legal / privacy", "Enterprise review", "Step 3", "Correct path", "Support team", "Billing support", "Security disclosure path", "Legal / privacy intake", "Sales / enterprise review"],
  scope: ["Support scope", "What support can help with — and where support must draw the line.", "What support can help with", "Product navigation and getting-started questions", "Evidence workflow, capture, intake, and reviewer questions", "Verification page, report, and verification-package questions", "Account, login, subscription, and billing questions", "Security reports and responsible-disclosure intake", "Enterprise evaluation, procurement, and security review questions", "What support cannot do", "Does not provide legal advice.", "Does not determine factual truth, authorship, identity, or intent.", "Does not certify legal admissibility or evidentiary weight.", "Does not act as a court, law-enforcement authority, regulator, or forensic-investigation authority.", "Cannot bypass customer-controlled access permissions or workspace policies.", "Cannot provide real-time emergency response or personal-safety monitoring.", "Cannot guarantee recovery of deleted content."],
  response: ["Response expectations", "How requests are prioritized.", "PROOVRA routes requests by severity, risk, plan, contractual commitments, and operational capacity. Unless an enterprise agreement states otherwise, these expectations are not guaranteed response or resolution times.", "Typical handling path", "Expectation",
    "Support queue", "Reviewed in the ordinary support flow",
    "Billing questions", "Routed to billing support or payment-provider context",
    "Prioritized based on severity and exploitability",
    "Privacy requests", "Privacy request process", "Handled according to applicable privacy law",
    "Law-enforcement requests", "Legal process intake", "Reviewed through the published Law Enforcement Request Policy",
    "Enterprise procurement", "Routed to sales for documentation, security review, and procurement evaluation"],
  enterprise: ["Enterprise evaluation", "Support for procurement, security review, and enterprise adoption.", "Organizations evaluating PROOVRA may need technical, legal, privacy, and security materials before adoption. The enterprise path routes these requests to the right team instead of mixing them with ordinary product support.", "Enterprise reviewers may ask for", "Trust Center documentation", "Security overview", "Subprocessor review", "DPA review", "TOMs review", "Verification Methodology", "AI Use Policy", "Data Retention Policy", "Security questionnaire support", "Pilot or proof-of-concept discussion", "Review packet", "Trust Center", "Data Processing Addendum", "Security Overview", "Subprocessors"],
  security: ["Security reviews", "Security questions should go through the right path.", "Before adopting PROOVRA, organizations may review security documentation, architecture boundaries, subprocessors, incident response posture, and verification controls.",
    "PROOVRA's security posture, governance, key management, evidence-integrity controls, and responsible disclosure.", "Open Security Overview",
    "Technical and Organizational Measures", "TOMs covering access control, authentication, audit logging, data protection, and operational controls.", "Open TOMs",
    "Incident Response", "Severity classification, notification expectations, and processor-role handling consistent with applicable law.", "Open Incident Response",
    "Current subprocessor register with provider, purpose, data categories, region, role, and status.", "Open Subprocessors",
    "Report a vulnerability", "Vulnerability reports should go to security@proovra.com.", "Enterprise security questionnaire", "Enterprise security questionnaires should go through /contact-sales."],
  sensitive: ["Sensitive or legal requests", "Use the dedicated request path.", "For legally sensitive matters, use the dedicated intake path so the request is logged and routed correctly. Each path links to the relevant policy with the full submission process.",
    "Government, law-enforcement, regulator, court, and legal-process requests follow a published intake path.", "Law Enforcement Requests",
    "Abuse reports", "Reports of misuse, abusive content, impersonation, fraudulent verification use, or unlawful activity have a dedicated intake.", "Abuse Reporting",
    "Privacy / data-subject requests", "Access, rectification, deletion, restriction, portability, objection, and consent-withdrawal requests under applicable privacy law.", "Privacy Requests",
    "Security vulnerabilities", "Responsible-disclosure intake for vulnerabilities discovered in PROOVRA's public or product surfaces."],
  policy: ["Support vs policy", "Public Support and Support Policy are different surfaces.", "/support", "Public Support", "The operational support page for product help, billing routing, sensitive-request paths, and enterprise evaluation.", "You are here", "/legal/support", "Support Policy", "The legal policy document describing support scope, severity prioritization, escalation, limitations, and availability expectations.", "Open Support Policy"],
  resources: ["Helpful resources", "Read the documents behind each support path.",
    "Trust & governance", "Where the platform's boundary, posture, and policies are described.",
    "Evidence & verification", "How PROOVRA records, verifies, and bounds evidence operations.", "Evidence Handling Policy", "Verification Disclaimer",
    "Legal & sensitive requests", "Dedicated intake paths for legally sensitive matters.", "Consumer Cancellation and Refund Policy", "Copyright and DMCA Policy",
    "Enterprise adoption", "What enterprise reviewers usually request before adoption."],
  finalCta: ["Not sure yet?", "Still not sure where your request belongs?", "Email the team and we will route it to the right path. For enterprise procurement, security review, or vendor evaluation, talk to sales."],
};

const withWebBase = async (value, fn) => {
  const prev = process.env.EXPO_PUBLIC_WEB_BASE;
  if (value === undefined) delete process.env.EXPO_PUBLIC_WEB_BASE;
  else process.env.EXPO_PUBLIC_WEB_BASE = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_WEB_BASE;
    else process.env.EXPO_PUBLIC_WEB_BASE = prev;
  }
};

/** Press EVERY element carrying this label, not only the first. */
const pressAll = async (r, label) => {
  const hits = r.byLabel(label).filter((n) => n.props.onPress);
  for (const n of hits) await act(async () => { await n.props.onPress(); });
  return hits.length;
};

test("every section of the web page is present, with the web's copy, in the web's order", async () => {
  const r = await withWebBase("https://www.proovra.com", render);
  for (const [section, strings] of Object.entries(SECTIONS)) {
    for (const t of strings) assert.ok(r.hasText(t), `${section}: missing "${t}"`);
  }
  const texts = r.texts();
  const order = ["Get the right help path.", "Support paths", "Support routing", "Support scope", "Response expectations", "Enterprise evaluation", "Security reviews", "Sensitive or legal requests", "Support vs policy", "Helpful resources", "Not sure yet?"];
  let last = -1;
  for (const heading of order) {
    const at = texts.indexOf(heading);
    assert.ok(at > last, `"${heading}" is missing or out of the web's order`);
    last = at;
  }
});

test("reference labels use the web's wording", async () => {
  const r = await render();
  assert.ok(r.hasText("Data Processing Addendum"));
  assert.ok(r.hasText("Security Overview"));
  assert.equal(r.hasText("Data Processing Agreement"), false, "the web calls the DPA an Addendum");
  assert.equal(r.hasText("Security & Responsible Disclosure"), false, "the web calls it Security Overview");
});

/** Every legal link the web page carries: [label on the web, slug]. */
const LEGAL_LINKS = [
  ["Open Security policy", "security"],
  ["Data Processing Addendum", "dpa"],
  ["Security Overview", "security"],
  ["Subprocessors", "subprocessors"],
  ["Verification Methodology", "verification-methodology"],
  ["Open Security Overview", "security"],
  ["Open TOMs", "toms"],
  ["Open Incident Response", "incident-response"],
  ["Open Subprocessors", "subprocessors"],
  ["Law Enforcement Requests", "law-enforcement"],
  ["Abuse Reporting", "abuse-reporting"],
  ["Privacy Requests", "privacy-requests"],
  ["Open Support Policy", "support"],
  ["Support Policy", "support"],
  ["Evidence Handling Policy", "evidence-handling"],
  ["Technical and Organizational Measures", "toms"],
  ["Verification Disclaimer", "verification-disclaimer"],
  ["Consumer Cancellation and Refund Policy", "refund-policy"],
  ["Copyright and DMCA Policy", "dmca"],
  ["AI Use Policy", "ai-use-policy"],
];

test("every legal link opens the in-app reader on a slug GET /v1/legal/:slug actually serves", async () => {
  // The corpus the server generates its documents from — read, not restated.
  const served = new Set(readdirSync(CORPUS).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  assert.ok(served.size > 0, `no corpus at ${CORPUS}`);
  const r = await render();
  for (const [label, slug] of LEGAL_LINKS) {
    assert.ok(served.has(slug), `/legal/${slug} would be a 404 LEGAL_DOCUMENT_NOT_FOUND`);
    M.calls.reset();
    const n = await pressAll(r, label);
    assert.ok(n > 0, `missing link "${label}"`);
    assert.ok(
      M.calls.push.length === n && M.calls.push.every((p) => p === `/legal/${slug}`),
      `"${label}" should open /legal/${slug}, opened ${JSON.stringify(M.calls.push)}`,
    );
  }
  assert.deepEqual(globalThis.__LINKING_OPENED__, [], "a legal document ejected the user to a browser");
});

test("nothing pressable on the screen routes to a legal slug the corpus does not serve", async () => {
  const served = new Set(readdirSync(CORPUS).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  await withWebBase("https://www.proovra.com", async () => {
    const r = await render();
    M.calls.reset();
    const labels = new Set(
      r.byRole("button").map((n) => n.props.accessibilityLabel).filter((l) => l && l !== "Back"),
    );
    for (const label of labels) await pressAll(r, label);
    const legal = M.calls.push.filter((p) => p.startsWith("/legal/"));
    assert.ok(legal.length >= LEGAL_LINKS.length);
    for (const p of legal) assert.ok(served.has(p.slice("/legal/".length)), `${p} is not served`);
    for (const p of M.calls.push) {
      assert.ok(p.startsWith("/legal/") || p === "/(stack)/trust-center", `unexpected in-app route ${p}`);
    }
  });
});

test("every Trust Center link opens the IN-APP Trust Center", async () => {
  const r = await render();
  M.calls.reset();
  const n = (await pressAll(r, "Open Trust Center")) + (await pressAll(r, "Trust Center"));
  assert.ok(n >= 4, "support path, enterprise action, review packet and resource directory");
  assert.ok(M.calls.push.length === n && M.calls.push.every((p) => p === "/(stack)/trust-center"), JSON.stringify(M.calls.push));
  assert.deepEqual(globalThis.__LINKING_OPENED__, []);
});

test("mailto targets: support and security open the device mail app", async () => {
  const r = await render();
  for (const [label, target, count] of [
    ["Email support", "mailto:support@proovra.com", 2],
    ["security@proovra.com", "mailto:security@proovra.com", 1],
  ]) {
    globalThis.__LINKING_OPENED__ = [];
    const n = await pressAll(r, label);
    assert.equal(n, count, `"${label}" should appear ${count}x, as on the web`);
    assert.deepEqual(globalThis.__LINKING_OPENED__, Array(count).fill(target), label);
  }
  assert.deepEqual(M.calls.push, []);
});

test("Contact Sales has no native counterpart: it opens the public web page on EXPO_PUBLIC_WEB_BASE", async () => {
  await withWebBase("https://www.proovra.com/", async () => {
    const r = await render();
    for (const [label, count] of [["Talk to sales", 3], ["Contact Sales", 1], ["/contact-sales", 1]]) {
      globalThis.__LINKING_OPENED__ = [];
      const n = await pressAll(r, label);
      assert.equal(n, count, `"${label}" should appear ${count}x, as on the web`);
      assert.deepEqual(globalThis.__LINKING_OPENED__, Array(count).fill("https://www.proovra.com/contact-sales"), label);
    }
    assert.deepEqual(M.calls.push, [], "a web-only destination was pushed as an in-app route");
  });
});

test("with no web origin configured, the sales links are hidden rather than dead", async () => {
  await withWebBase(undefined, async () => {
    const r = await render();
    for (const label of ["Talk to sales", "Contact Sales", "/contact-sales"]) {
      assert.equal(r.byLabel(label).length, 0, `"${label}" rendered with nowhere to go`);
    }
    // The copy that names the path still reads.
    assert.ok(r.hasText("Enterprise security questionnaires should go through /contact-sales."));
  });
});
