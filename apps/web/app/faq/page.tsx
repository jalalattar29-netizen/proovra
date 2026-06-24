import type { Metadata } from "next";
import { MarketingPage } from "../../components/marketing/page-shell/MarketingPage";
import { FAQAccordion } from "../../components/marketing/page-shell/FAQAccordion";
import { PageCTA } from "../../components/marketing/page-shell/PageCTA";
import { MARKETING_LINKS } from "../../components/marketing/tokens";
import { MARKETING_BTN } from "../../lib/marketing-buttons";
import { RevealSection } from "../../components/motion";

export const metadata: Metadata = {
  title: "FAQ — PROOVRA",
description:
  "Enterprise FAQ for PROOVRA: evidence operations, Evidence Records, verification reports, verification packages, governance, deployment, AI assistance, security review, APIs, and support.",
};

const FAQ_HERO_IMAGE = "/assets/hero/faq-hero.png";

const FAQ = 
[ 
  { q: "What is PROOVRA?", 
    a: "PROOVRA is an enterprise evidence operations platform that helps organizations capture, preserve, verify, review, report on, package, and govern digital evidence through structured evidence workflows.",
   },
 { q: "What is an Evidence Record?",
   a: "An Evidence Record is a structured record around a captured or uploaded file. It may include the original material, metadata, SHA-256 fingerprints, custody events, signature context, timestamp or anchoring context where enabled, reports, verification packages, and reviewer-facing outputs.",
   }, 
   {
  q: "What is the difference between a file and an Evidence Record?",
  a: "A file is the original digital material, such as a photo, video, document, audio file, or export. An Evidence Record is the structured PROOVRA record around that file. It can include metadata, SHA-256 fingerprints, custody events, signature context, timestamp or anchoring context where enabled, reports, verification packages, governance context, and reviewer-facing outputs.",
},
   { q: "How is PROOVRA different from file storage?", 
    a: "File storage keeps files. PROOVRA helps preserve the review context around evidence: integrity signals, custody history, reports, verification packages, audit logs, governance controls, and reviewer-ready outputs.",
   }, 
   { q: "Is PROOVRA only for legal teams?", 
    a: "No. PROOVRA supports legal teams, investigations, insurance and claims, compliance and audit, journalism or source review, enterprise security, risk teams, and public-sector or oversight workflows.", }, { q: "What can teams do inside PROOVRA?", 
      a: "Workspaces can organize evidence into cases and matters; manage records; review integrity status; generate reports; create verification packages; track custody events; apply governance controls; and prepare materials for internal or external review.",
    }, 
    { q: "Do you support cases and matters?", 
      a: "Yes. PROOVRA supports case- and matter-based organization so evidence, reports, reviewers, packages, notes, and activity can stay connected to the relevant workflow.",
     }, 
     { q: "Can teams collaborate?", 
      a: "Yes. PROOVRA supports team workflows, roles, workspace separation, reviewer access, assignments, audit visibility, and operational collaboration around evidence records.", 
    }, 
    { q: "What are reviewer workflows?", 
      a: "Reviewer workflows help teams prepare evidence for internal review, expert review, disclosure, audit, claims review, legal review, escalation, or external inspection.", 
    }, 
    { q: "What does verification check?", 
      a: "Verification can check recorded integrity signals such as SHA-256 hash match, fingerprint consistency, signature context, timestamp or anchoring state where enabled, custody continuity, and related verification materials.",
     }, 
     { q: "Does PROOVRA prove truth?", 
      a: "No. PROOVRA does not determine factual truth, authorship, identity, intent, liability, or real-world authenticity. It records and exposes technical integrity and custody context for review.", 
    }, 
    { q: "Does PROOVRA guarantee legal admissibility?", 
      a: "No. Legal admissibility depends on jurisdiction, matter context, procedure, and the decision-maker. PROOVRA provides review-ready records, reports, and verification materials, but it does not decide admissibility.", 
    }, 
    { q: "What is chain of custody?", 
      a: "Chain of custody is the recorded activity history around an Evidence Record. PROOVRA can record platform actions as custody events so reviewers can inspect how the record moved through the workflow.", 
    }, 
    { q: "How do reports work?", 
      a: "PROOVRA reports summarize selected recorded materials such as record identifiers, hashes, verification status, custody events, signature context, timestamp context where available, and important limitations.", 
    }, 
    { q: "What is a verification package?", 
      a: "A verification package is a portable bundle that may include reports, manifest data, hashes, signatures, custody references, and technical materials for reviewer inspection.", 
    }, 
    {
  q: "What is the difference between a report and a verification package?",
  a: "A Verification Report is a human-readable summary of recorded materials such as hashes, custody events, verification status, timestamp context, signature context, and limitations. A Verification Package is a portable bundle that may include the report, manifest data, hashes, signatures, custody references, and technical materials for internal or external reviewer inspection.",
},
    { q: "What is a Public Verification URL?", 
        a: "A Public Verification URL is a controlled reviewer-facing surface where selected verification information can be inspected, subject to access controls, token settings, expiry, redaction, and customer configuration.", 
      }, 
{
  q: "Can external reviewers review evidence without a PROOVRA account?",
  a: "Depending on configuration, PROOVRA can provide reviewer-facing outputs such as Verification Reports, Verification Packages, or Public Verification URLs so external recipients can inspect selected integrity, custody, and verification context without needing to work inside the customer workspace.",
},
      { q: "How is data protected?", 
        a: "Depending on deployment configuration, PROOVRA may support encryption in transit, provider-supported encryption at rest, access controls, audit logging, MFA, SSO/SAML, SCIM, retention controls, storage governance controls, and related security measures.", 
      }, 
      { q: "Do you support SSO, SAML, and SCIM?", 
        a: "Yes. PROOVRA supports enterprise identity features such as SSO/SAML and SCIM where configured for eligible plans or deployments.", 
      }, 
      { q: "Do you support audit logs?", 
          a: "Yes. PROOVRA is designed around audit visibility, including custody events, access-related activity, report generation, package creation, and operational history where available.", 
        }, 
        { q: "Do you support legal hold workflows?", 
          a: "Yes. PROOVRA supports legal hold concepts where configured. Legal hold controls can help organizations preserve relevant records and suspend normal lifecycle actions while review, investigation, regulatory, or legal processes remain active.", 
        }, 
        { q: "Where can security teams review your documentation?", 
          a: "Security teams can review the Trust Center, Security Overview, TOMs, Subprocessors, DPA, Incident Response Policy, Verification Methodology, and AI Use Policy where available.", 
        }, 
        { q: "Where can PROOVRA be deployed?", 
          a: "Cloud, dedicated, private, or jurisdiction-specific deployment models may be available depending on operational, regulatory, and enterprise requirements.", 
        }, 
        { q: "Do customers control where evidence is stored?", 
          a: "Storage architecture depends on deployment configuration. Organizations may have different storage, residency, and infrastructure requirements that are reviewed during onboarding.", 
        }, 
        { q: "Who owns the evidence uploaded to PROOVRA?", 
          a: "Customers retain ownership and responsibility for their evidence and related content. PROOVRA provides the platform used to preserve, organize, verify, and review those materials.", 
        }, 
        { q: "Can customers export their evidence and records?", 
          a: "Yes. PROOVRA is designed to support export of evidence-related materials, reports, verification outputs, and associated records, subject to plan and configuration.", 
        }, 
        { q: "Do you provide security and legal documentation during evaluation?", 
          a: "Yes. Security, privacy, governance, verification, and compliance documentation is available through the Trust Center and enterprise evaluation process.", 
        }, 
        { q: "Can security teams perform vendor assessments?", 
          a: "PROOVRA supports security and governance review processes through published documentation, deployment discussions, and enterprise evaluation workflows.", 
        }, 
        { q: "Does PROOVRA use AI?", 
          a: "PROOVRA may include AI assistance where enabled. AI is advisory only and is designed to help with support, capture guidance, review preparation, and operational context.", 
        }, 
        { q: "Does AI determine whether evidence is true?", 
          a: "No. AI does not determine truth, authorship, identity, liability, admissibility, or legal conclusions.", 
        }, 
        { q: "Can AI access evidence content?", 
          a: "AI access depends on the specific feature. By default, PROOVRA follows a metadata-first approach and does not send raw evidence content to AI systems unless explicitly disclosed and enabled.", 
        }, 
        { q: "Do you use customer evidence to train AI models?", 
          a: "PROOVRA does not use customer evidence content to train general-purpose AI models.", 
        }, 
        { q: "Do you support APIs and webhooks?", 
          a: "Yes. PROOVRA supports API and webhook concepts for integrating evidence operations with other systems, depending on plan and configuration.", 
        }, 
        { q: "Can PROOVRA integrate with enterprise systems?", 
          a: "PROOVRA may integrate with identity providers, cloud infrastructure, payment providers, monitoring systems, communications tools, and customer workflows where configured.", 
        }, 
        { q: "Who should request a demo?", 
          a: "Legal teams, insurers, investigation teams, compliance teams, enterprise security teams, auditors, public-sector teams, and organizations handling sensitive digital evidence should request a demo.", 
        }, 
        { q: "Can small teams use PROOVRA?", 
          a: "Yes. PROOVRA can support solo professionals and small teams as well as larger organizations that need structured evidence operations.", 
        }, 
        { q: "Where do I get support?", 
          a: "Use the public Support page for product, billing, security, legal, privacy, and enterprise routing.", 
        }, 
        { q: "Where can I review legal and trust documents?", 
          a: "Use the Trust Center for privacy, security, verification, governance, legal, support, and compliance documentation.", 
        }, 
        { q: "How do I request a demo?", 
          a: "Use the Request Demo page or contact sales to discuss your evidence workflow, review needs, security requirements, and enterprise evaluation.", 
        }, 
      ];

export default function FAQPage() {
  return (
    <MarketingPage>
<section className="relative min-h-[720px] overflow-hidden bg-white">
  <div
    aria-hidden="true"
    className="absolute inset-0"
    style={{
      backgroundImage: `url("${FAQ_HERO_IMAGE}")`,
      backgroundSize: "100% 100%",
      backgroundPosition: "center center",
      backgroundRepeat: "no-repeat",
    }}
  />

  <div className="relative z-10 mx-auto max-w-[1320px] px-6 pb-24 pt-20 md:px-8 lg:pb-28 lg:pt-28">
    <div className="max-w-[640px]">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#E0E7FF] bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#2563EB]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7A3CFF]" />
        FAQ
      </span>

      <h1 className="mt-4 max-w-[600px] text-[2rem] font-semibold leading-[1.06] tracking-[-0.025em] text-[#0F172A] md:text-[2.6rem] lg:text-[3rem]">
        Honest answers.{" "}
        <span
          className="bg-clip-text text-transparent"
          style={{
            backgroundImage:
              "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)",
          }}
        >
          No marketing fog.
        </span>
      </h1>

      <p className="mt-4 max-w-[560px] text-[15px] leading-[1.65] text-[#475569]">
        The questions buyers, reviewers, and security teams actually ask — answered straight.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <a
          href={MARKETING_LINKS.requestDemo}
          className="rounded-full bg-[#071B5D] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-[#071B5D]/20"
        >
          Request a demo
        </a>
        <a
          href={MARKETING_LINKS.verifyDemo}
          className={MARKETING_BTN.heroSecondary}
        >
          Try live verification
        </a>
      </div>
    </div>
  </div>
</section>
      <RevealSection direction="up">
      <FAQAccordion
        eyebrow="Common questions"
        title="Frequently asked."
        items={FAQ}
      />
      </RevealSection>
      <RevealSection direction="right">
      <PageCTA
        title="Still have"
        highlight="a question?"
        primary={{ label: "Contact sales", href: MARKETING_LINKS.contactSales }}
        secondary={{ label: "Support", href: MARKETING_LINKS.support }}
      />
      </RevealSection>
    </MarketingPage>
  );
}
