/**
 * SUPPORT — the routes a user takes when something needs a human.
 *
 * Ports `apps/web/app/support/page.tsx`, which the AUTHENTICATED app sends
 * users to from five call sites: `app/(app)/error.tsx`, `not-found.tsx`,
 * Search and billing. It is a public page in the web's tree, but it is a real
 * in-app destination — which is why it is in the Native scope at all, and why
 * a phone user hitting an error had nowhere to go until now.
 *
 * ===========================================================================
 * WHERE THE CONTENT COMES FROM
 * ===========================================================================
 * Every section's copy is the web page's, VERBATIM and in the web's order:
 * hero, support paths, routing, scope, response expectations, enterprise
 * evaluation, security reviews, sensitive requests, support-vs-policy, the
 * four-group resource directory and the closing CTA. It is restated here
 * because it is UI copy over a fixed set of destinations, not content with a
 * canonical source. Everything that DOES have a canonical source is taken from
 * it: every policy the page links is a legal document served by
 * `GET /v1/legal/:slug` (generated from apps/web/content/legal/en/*.md), so
 * this module names SLUGS and the reader renders the real text. None of that
 * text is duplicated here.
 *
 * ===========================================================================
 * WHERE EACH LINK GOES
 * ===========================================================================
 *   - `/legal/<slug>` on the web → the in-app legal reader, same slug;
 *   - `mailto:` → the device mail app;
 *   - `/trust` → the IN-APP Trust Center. Native has the same material
 *     in-product, and ejecting a user into a browser from a support screen is
 *     precisely the handoff this conversion removed;
 *   - `/contact-sales` → the public web page. It is a sales form with no
 *     native counterpart, so it is the one `web` destination; the screen
 *     resolves it against `webOrigin()` and hides it when no origin is
 *     configured rather than render a button that goes nowhere.
 *
 * Pure: no React, no react-native, no fetch, no imports — the unit test loads
 * this file as a standalone module.
 */

export const SUPPORT_EMAIL = "support@proovra.com";
export const BILLING_EMAIL = "billing@proovra.com";
export const SECURITY_EMAIL = "security@proovra.com";

/** The one web-only destination the page links (a sales form). */
export const CONTACT_SALES_PATH = "/contact-sales";

export type SupportDestination =
  | { kind: "email"; address: string }
  | { kind: "legal"; slug: string }
  | { kind: "route"; path: string }
  /** A public web page with no native counterpart, as a path on the web origin. */
  | { kind: "web"; path: string };

export interface SupportLink {
  label: string;
  destination: SupportDestination;
}

export interface SupportRoute {
  key: string;
  label: string;
  title: string;
  body: string;
  cta: string;
  destination: SupportDestination;
}

const email = (address: string): SupportDestination => ({ kind: "email", address });
const legal = (slug: string): SupportDestination => ({ kind: "legal", slug });
/** The IN-APP Trust Center, standing in for the web's public `/trust`. */
const TRUST_CENTER: SupportDestination = { kind: "route", path: "/(stack)/trust-center" };
const CONTACT_SALES: SupportDestination = { kind: "web", path: CONTACT_SALES_PATH };

/* ------------------------------------------------------------ 1 — Hero */

export const SUPPORT_HERO = {
  eyebrow: "Support",
  title: "Get the right help path.",
  body: "Choose the support route that matches your request — product help, billing, security reports, legal and privacy requests, or enterprise evaluation.",
  actions: [
    { label: "Email support", destination: email(SUPPORT_EMAIL) },
    { label: "Talk to sales", destination: CONTACT_SALES },
  ] as ReadonlyArray<SupportLink>,
  chips: ["Product help", "Billing", "Security reports", "Legal routing"] as ReadonlyArray<string>,
};

/* ---------------------------------------------------- 2 — Support paths */

export const SUPPORT_PATHS_SECTION = {
  eyebrow: "Support paths",
  heading: "Pick the route that matches your request.",
  body: "Each path routes your request to the correct operational, security, legal, or enterprise workflow.",
};

/**
 * The four routes the web offers, in its order.
 *
 * Security and Legal point at documents rather than an inbox on purpose: the
 * web does the same, because a responsible-disclosure report sent before
 * reading the policy is a report that usually has to be sent again.
 */
export const SUPPORT_ROUTES: ReadonlyArray<SupportRoute> = [
  {
    key: "product",
    label: "Product",
    title: "Product support",
    body: "For questions about capture, evidence records, verification pages, reports, account workflows, and general product usage.",
    cta: `Email ${SUPPORT_EMAIL}`,
    destination: email(SUPPORT_EMAIL),
  },
  {
    key: "billing",
    label: "Billing",
    title: "Account and billing",
    body: "For login, subscription, payment, invoice, refund, and plan questions.",
    cta: `Email ${BILLING_EMAIL}`,
    destination: email(BILLING_EMAIL),
  },
  {
    key: "security",
    label: "Security",
    title: "Security and responsible disclosure",
    body: "For vulnerability reports, suspected compromise, security concerns, and responsible-disclosure intake.",
    cta: "Open Security policy",
    destination: legal("security"),
  },
  {
    key: "legal",
    label: "Legal & privacy",
    title: "Legal and privacy requests",
    body: "For law-enforcement, data-subject, privacy, copyright, abuse, and other legally sensitive requests.",
    cta: "Open Trust Center",
    destination: TRUST_CENTER,
  },
];

/* --------------------------------------------------- 3 — Support routing */

export const SUPPORT_ROUTING = {
  eyebrow: "Support routing",
  heading: "From question to the right team.",
  body: "PROOVRA support is routed by request type so sensitive matters reach the correct operational, security, legal, or enterprise path.",
  steps: [
    {
      step: "Step 1",
      title: "Start with your request",
      body: "Describe what you need. Most requests fall into one of five types.",
      items: [] as ReadonlyArray<string>,
    },
    {
      step: "Step 2",
      title: "Choose request type",
      body: null,
      items: ["Product", "Billing", "Security", "Legal / privacy", "Enterprise review"] as ReadonlyArray<string>,
    },
    {
      step: "Step 3",
      title: "Correct path",
      body: null,
      items: [
        "Support team",
        "Billing support",
        "Security disclosure path",
        "Legal / privacy intake",
        "Sales / enterprise review",
      ] as ReadonlyArray<string>,
    },
  ] as ReadonlyArray<{ step: string; title: string; body: string | null; items: ReadonlyArray<string> }>,
};

/* ----------------------------------------------------- 4 — Support scope */

export const SUPPORT_SCOPE = {
  eyebrow: "Support scope",
  heading: "What support can help with — and where support must draw the line.",
  canHelpTitle: "What support can help with",
  canHelp: [
    "Product navigation and getting-started questions",
    "Evidence workflow, capture, intake, and reviewer questions",
    "Verification page, report, and verification-package questions",
    "Account, login, subscription, and billing questions",
    "Security reports and responsible-disclosure intake",
    "Enterprise evaluation, procurement, and security review questions",
  ] as ReadonlyArray<string>,
  cannotDoTitle: "What support cannot do",
  cannotDo: [
    "Does not provide legal advice.",
    "Does not determine factual truth, authorship, identity, or intent.",
    "Does not certify legal admissibility or evidentiary weight.",
    "Does not act as a court, law-enforcement authority, regulator, or forensic-investigation authority.",
    "Cannot bypass customer-controlled access permissions or workspace policies.",
    "Cannot provide real-time emergency response or personal-safety monitoring.",
    "Cannot guarantee recovery of deleted content.",
  ] as ReadonlyArray<string>,
};

/* --------------------------------------------- 5 — Response expectations */

export const RESPONSE_EXPECTATIONS = {
  eyebrow: "Response expectations",
  heading: "How requests are prioritized.",
  body: "PROOVRA routes requests by severity, risk, plan, contractual commitments, and operational capacity. Unless an enterprise agreement states otherwise, these expectations are not guaranteed response or resolution times.",
  columns: { type: "Request type", path: "Typical handling path", expectation: "Expectation" },
  rows: [
    { type: "Product support", path: "Support queue", expectation: "Reviewed in the ordinary support flow" },
    { type: "Billing questions", path: "Billing support", expectation: "Routed to billing support or payment-provider context" },
    { type: "Security reports", path: "Security disclosure path", expectation: "Prioritized based on severity and exploitability" },
    { type: "Privacy requests", path: "Privacy request process", expectation: "Handled according to applicable privacy law" },
    {
      type: "Law-enforcement requests",
      path: "Legal process intake",
      expectation: "Reviewed through the published Law Enforcement Request Policy",
    },
    {
      type: "Enterprise procurement",
      path: "Sales / enterprise review",
      expectation: "Routed to sales for documentation, security review, and procurement evaluation",
    },
  ] as ReadonlyArray<{ type: string; path: string; expectation: string }>,
};

/* ---------------------------------------------- 6 — Enterprise evaluation */

export const ENTERPRISE_EVALUATION = {
  eyebrow: "Enterprise evaluation",
  heading: "Support for procurement, security review, and enterprise adoption.",
  body: "Organizations evaluating PROOVRA may need technical, legal, privacy, and security materials before adoption. The enterprise path routes these requests to the right team instead of mixing them with ordinary product support.",
  checklistTitle: "Enterprise reviewers may ask for",
  checklist: [
    "Trust Center documentation",
    "Security overview",
    "Subprocessor review",
    "DPA review",
    "TOMs review",
    "Verification Methodology",
    "AI Use Policy",
    "Data Retention Policy",
    "Security questionnaire support",
    "Pilot or proof-of-concept discussion",
  ] as ReadonlyArray<string>,
  actions: [
    { label: "Trust Center", destination: TRUST_CENTER },
    { label: "Talk to sales", destination: CONTACT_SALES },
  ] as ReadonlyArray<SupportLink>,
  packetTitle: "Review packet",
  packet: [
    { label: "Trust Center", destination: TRUST_CENTER },
    { label: "Data Processing Addendum", destination: legal("dpa") },
    { label: "Security Overview", destination: legal("security") },
    { label: "Subprocessors", destination: legal("subprocessors") },
    { label: "Verification Methodology", destination: legal("verification-methodology") },
  ] as ReadonlyArray<SupportLink>,
};

/* --------------------------------------------------- 7 — Security reviews */

export interface SupportCard {
  title: string;
  body: string;
  cta: string;
  destination: SupportDestination;
}

export const SECURITY_REVIEWS = {
  eyebrow: "Security reviews",
  heading: "Security questions should go through the right path.",
  body: "Before adopting PROOVRA, organizations may review security documentation, architecture boundaries, subprocessors, incident response posture, and verification controls.",
  cards: [
    {
      title: "Security Overview",
      body: "PROOVRA's security posture, governance, key management, evidence-integrity controls, and responsible disclosure.",
      cta: "Open Security Overview",
      destination: legal("security"),
    },
    {
      title: "Technical and Organizational Measures",
      body: "TOMs covering access control, authentication, audit logging, data protection, and operational controls.",
      cta: "Open TOMs",
      destination: legal("toms"),
    },
    {
      title: "Incident Response",
      body: "Severity classification, notification expectations, and processor-role handling consistent with applicable law.",
      cta: "Open Incident Response",
      destination: legal("incident-response"),
    },
    {
      title: "Subprocessors",
      body: "Current subprocessor register with provider, purpose, data categories, region, role, and status.",
      cta: "Open Subprocessors",
      destination: legal("subprocessors"),
    },
  ] as ReadonlyArray<SupportCard>,
  vulnerability: {
    title: "Report a vulnerability",
    text: `Vulnerability reports should go to ${SECURITY_EMAIL}.`,
    link: { label: SECURITY_EMAIL, destination: email(SECURITY_EMAIL) } as SupportLink,
  },
  questionnaire: {
    title: "Enterprise security questionnaire",
    text: `Enterprise security questionnaires should go through ${CONTACT_SALES_PATH}.`,
    link: { label: CONTACT_SALES_PATH, destination: CONTACT_SALES } as SupportLink,
  },
};

/* ------------------------------------------ 8 — Sensitive / legal requests */

export const SENSITIVE_REQUESTS = {
  eyebrow: "Sensitive or legal requests",
  heading: "Use the dedicated request path.",
  body: "For legally sensitive matters, use the dedicated intake path so the request is logged and routed correctly. Each path links to the relevant policy with the full submission process.",
  cards: [
    {
      title: "Law-enforcement requests",
      body: "Government, law-enforcement, regulator, court, and legal-process requests follow a published intake path.",
      cta: "Law Enforcement Requests",
      destination: legal("law-enforcement"),
    },
    {
      title: "Abuse reports",
      body: "Reports of misuse, abusive content, impersonation, fraudulent verification use, or unlawful activity have a dedicated intake.",
      cta: "Abuse Reporting",
      destination: legal("abuse-reporting"),
    },
    {
      title: "Privacy / data-subject requests",
      body: "Access, rectification, deletion, restriction, portability, objection, and consent-withdrawal requests under applicable privacy law.",
      cta: "Privacy Requests",
      destination: legal("privacy-requests"),
    },
    {
      title: "Security vulnerabilities",
      body: "Responsible-disclosure intake for vulnerabilities discovered in PROOVRA's public or product surfaces.",
      cta: "Security Overview",
      destination: legal("security"),
    },
  ] as ReadonlyArray<SupportCard>,
};

/* ---------------------------------------------- 9 — Support vs policy */

export const SUPPORT_VS_POLICY = {
  eyebrow: "Support vs policy",
  heading: "Public Support and Support Policy are different surfaces.",
  here: {
    badge: "/support",
    title: "Public Support",
    body: "The operational support page for product help, billing routing, sensitive-request paths, and enterprise evaluation.",
    marker: "You are here",
  },
  policy: {
    badge: "/legal/support",
    title: "Support Policy",
    body: "The legal policy document describing support scope, severity prioritization, escalation, limitations, and availability expectations.",
    cta: "Open Support Policy",
    destination: legal("support"),
  },
};

/* ------------------------------------------------ 10 — Helpful resources */

export const HELPFUL_RESOURCES = {
  eyebrow: "Helpful resources",
  heading: "Read the documents behind each support path.",
  groups: [
    {
      title: "Trust & governance",
      subtitle: "Where the platform's boundary, posture, and policies are described.",
      links: [
        { label: "Trust Center", destination: TRUST_CENTER },
        { label: "Privacy Requests", destination: legal("privacy-requests") },
        { label: "Security Overview", destination: legal("security") },
        { label: "Support Policy", destination: legal("support") },
      ],
    },
    {
      title: "Evidence & verification",
      subtitle: "How PROOVRA records, verifies, and bounds evidence operations.",
      links: [
        { label: "Evidence Handling Policy", destination: legal("evidence-handling") },
        { label: "Technical and Organizational Measures", destination: legal("toms") },
        { label: "Verification Disclaimer", destination: legal("verification-disclaimer") },
        { label: "Verification Methodology", destination: legal("verification-methodology") },
      ],
    },
    {
      title: "Legal & sensitive requests",
      subtitle: "Dedicated intake paths for legally sensitive matters.",
      links: [
        { label: "Abuse Reporting", destination: legal("abuse-reporting") },
        { label: "Consumer Cancellation and Refund Policy", destination: legal("refund-policy") },
        { label: "Copyright and DMCA Policy", destination: legal("dmca") },
        { label: "Law Enforcement Requests", destination: legal("law-enforcement") },
      ],
    },
    {
      title: "Enterprise adoption",
      subtitle: "What enterprise reviewers usually request before adoption.",
      links: [
        { label: "AI Use Policy", destination: legal("ai-use-policy") },
        { label: "Contact Sales", destination: CONTACT_SALES },
        { label: "Data Processing Addendum", destination: legal("dpa") },
        { label: "Subprocessors", destination: legal("subprocessors") },
      ],
    },
  ] as ReadonlyArray<{ title: string; subtitle: string; links: ReadonlyArray<SupportLink> }>,
};

/* ------------------------------------------------------- 11 — Final CTA */

export const SUPPORT_FINAL_CTA = {
  eyebrow: "Not sure yet?",
  heading: "Still not sure where your request belongs?",
  body: "Email the team and we will route it to the right path. For enterprise procurement, security review, or vendor evaluation, talk to sales.",
  actions: [
    { label: "Email support", destination: email(SUPPORT_EMAIL) },
    { label: "Talk to sales", destination: CONTACT_SALES },
  ] as ReadonlyArray<SupportLink>,
};

/* ----------------------------------------------------------- derived */

/** Every destination the screen can open, section by section. */
function allDestinations(): ReadonlyArray<SupportLink> {
  return [
    ...SUPPORT_HERO.actions,
    ...SUPPORT_ROUTES.map((r) => ({ label: r.cta, destination: r.destination })),
    ...ENTERPRISE_EVALUATION.actions,
    ...ENTERPRISE_EVALUATION.packet,
    ...SECURITY_REVIEWS.cards.map((c) => ({ label: c.cta, destination: c.destination })),
    SECURITY_REVIEWS.vulnerability.link,
    SECURITY_REVIEWS.questionnaire.link,
    ...SENSITIVE_REQUESTS.cards.map((c) => ({ label: c.cta, destination: c.destination })),
    { label: SUPPORT_VS_POLICY.policy.cta, destination: SUPPORT_VS_POLICY.policy.destination },
    ...HELPFUL_RESOURCES.groups.flatMap((g) => g.links),
    ...SUPPORT_FINAL_CTA.actions,
  ];
}

/**
 * Every legal document this screen opens, once each, labelled as the web
 * first labels it.
 *
 * Named by SLUG, never by text: every one of these is a legal document the
 * canonical corpus already serves, and a second copy of a DPA or a security
 * overview is the drift the legal delivery exists to prevent.
 */
export const SUPPORT_REFERENCES: ReadonlyArray<{ label: string; slug: string }> = (() => {
  const seen = new Map<string, string>();
  for (const link of allDestinations()) {
    if (link.destination.kind === "legal" && !seen.has(link.destination.slug)) {
      seen.set(link.destination.slug, link.label);
    }
  }
  return [...seen].map(([slug, label]) => ({ label, slug }));
})();

/** A `mailto:` a device can actually open. */
export function mailtoUrl(address: string, subject?: string): string {
  const base = `mailto:${address}`;
  return subject ? `${base}?subject=${encodeURIComponent(subject)}` : base;
}

/** The in-app path a destination resolves to, or null when it leaves the app (email, web). */
export function destinationPath(destination: SupportDestination): string | null {
  switch (destination.kind) {
    case "legal":
      return `/legal/${destination.slug}`;
    case "route":
      return destination.path;
    case "email":
    case "web":
      return null;
  }
}

/**
 * The absolute URL a web-only destination opens, on the configured public web
 * origin; null when there is no origin, so the caller can hide the link rather
 * than render one that goes nowhere.
 */
export function webUrl(origin: string | null, path: string): string | null {
  return origin ? `${origin.replace(/\/+$/, "")}${path}` : null;
}
