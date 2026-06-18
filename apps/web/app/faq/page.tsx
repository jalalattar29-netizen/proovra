import type { Metadata } from "next";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { PageHero } from "../../components/marketing/page-shell/PageHero";
import { FAQAccordion } from "../../components/marketing/page-shell/FAQAccordion";
import { LegalClarification } from "../../components/marketing/page-shell/LegalClarification";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";

export const metadata: Metadata = {
  title: "FAQ — PROOVRA",
  description:
    "Buyer and product questions about PROOVRA: what it does, what verification checks, how reports work, identity integration, APIs, and how to get a demo.",
};

const FAQ = [
  {
    q: "What is PROOVRA?",
    a: "PROOVRA is an enterprise evidence operations platform. It captures, preserves, verifies, reports on, and proves digital evidence end-to-end — with cryptographic integrity, tamper-evident custody, and reviewer-ready outputs.",
  },
  {
    q: "What is an Evidence Record?",
    a: "An Evidence Record is a structured digital artifact composed of the original content, a SHA-256 fingerprint, structured metadata, a linked-hash custody log, and verification signals (timestamp, signature, anchoring). It is more reviewable than an ordinary file because reviewers can verify it independently.",
  },
  {
    q: "What does verification check?",
    a: "Verification confirms that the content fingerprint matches the recorded SHA-256, that the signature on the fingerprint is valid for a known PROOVRA signing key, that the trusted timestamp (RFC 3161) and/or OpenTimestamps anchoring state are present and consistent, and that the linked-hash custody chain is complete.",
  },
  {
    q: "Does PROOVRA prove truth?",
    a: "No. PROOVRA verifies integrity signals and custody continuity — it does not determine factual truth, authorship, or identity. We are explicit about this on every report and verification page.",
  },
  {
    q: "Does PROOVRA guarantee legal admissibility?",
    a: "No. Admissibility depends on jurisdiction, matter, and process. PROOVRA produces court-review-ready records and reports, but admissibility is determined by the relevant tribunal — not by PROOVRA.",
  },
  {
    q: "How do reports work?",
    a: "Reports are generated deterministically from an Evidence Record. Each report includes record identity, integrity proof (hash, signature, timestamp, anchoring state), custody chain, and a technical appendix describing what the report does and does not assert.",
  },
  {
    q: "What is a verification package?",
    a: "A verification package is a portable, signed bundle that contains the manifest, hashes, signatures, custody references, and an embedded verification report — so a reviewer can verify the record offline or on their own infrastructure.",
  },
  {
    q: "What are trusted timestamps?",
    a: "PROOVRA uses RFC 3161 trusted timestamping authorities to bind a record's fingerprint to an independent, externally signed time. When a TSA reply is unavailable, the record carries a clearly labelled fallback signal — never a fabricated timestamp.",
  },
  {
    q: "What is OpenTimestamps?",
    a: "OpenTimestamps (OTS) is a public protocol that anchors digests to public timestamping calendars that roll up into Bitcoin transactions. PROOVRA records may be in a PENDING (calendar accepted) or ANCHORED (settled into Bitcoin) state. We surface anchoring state honestly.",
  },
  {
    q: "How does chain of custody work?",
    a: "Every action on an evidence record produces a custody event. Events are stored in a linked-hash log where each event includes the hash of the previous one, so any later modification is detectable on review.",
  },
  {
    q: "Can teams collaborate?",
    a: "Yes. PROOVRA workspaces support roles, access control, assignments, discussion threads, and escalations. External reviewers can participate through token-based portals without needing an account.",
  },
  {
    q: "Do you support APIs and webhooks?",
    a: "Yes. PROOVRA exposes a REST API with bearer-token authentication and HMAC-SHA256 signed webhooks. Both surfaces are audit-logged and scope-restricted.",
  },
  {
    q: "Do you support SSO, SAML, and SCIM?",
    a: "Yes. PROOVRA supports SAML 2.0 single sign-on and SCIM 2.0 provisioning for enterprise identity integration.",
  },
  {
    q: "How is data protected?",
    a: "Where configured, evidence is stored with object-lock / immutable storage controls and retention modes. Access is governed by role-based access control with department scoping, MFA, and immutable audit logging. Specific deployment options depend on contract.",
  },
  {
    q: "How do I request a demo?",
    a: "Visit our request-a-demo page or contact sales. A PROOVRA expert will walk you through the platform against your specific evidence operations needs.",
  },
];

export default function FAQPage() {
  return (
    <MarketingPage>
      <PageHero
        eyebrow="FAQ"
        title="Honest answers."
        highlight="No marketing fog."
        description="The questions buyers, reviewers, and security teams actually ask — answered straight."
        primaryCta={{ label: "Request a demo", href: MARKETING_LINKS.requestDemo }}
        secondaryCta={{ label: "Try live verification", href: MARKETING_LINKS.verifyDemo }}
      />
      <FAQAccordion
        eyebrow="Common questions"
        title="Frequently asked."
        items={FAQ}
      />
      <LegalClarification />
      <PageCTA
        title="Still have"
        highlight="a question?"
        primary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
        secondary={{ label: "Support", href: MARKETING_LINKS.support }}
      />
    </MarketingPage>
  );
}
