export type ListItem = {
  title: string;
  body: string;
};

export type LifecycleStep = {
  label: string;
  body: string;
};

export type ComparisonRow = {
  traditional: string;
  proovra: string;
};

export type FaqItem = {
  q: string;
  a: string;
};

export type UseCasePageContent = {
  slug: string;
  industryImage: string;
  verificationImage: string;

  eyebrow: string;
  headline: string;
  headlineHighlight: string;
  subhead: string;
  proofPoints: string[];

  challengesEyebrow: string;
  challengesTitle: string;
  challengesNarrative: string[];
  challenges: ListItem[];

  workflowEyebrow: string;
  workflowTitle: string;
  workflowNarrative: string[];
  lifecycle: LifecycleStep[];

  comparisonEyebrow: string;
  comparisonTitle: string;
  comparisonIntro: string;
  comparisonRows: ComparisonRow[];

  operationsEyebrow: string;
  operationsTitle: string;
  operationsIntro: string;
  operationsItems: ListItem[];

  governanceEyebrow: string;
  governanceTitle: string;
  governanceIntro: string;
  governanceItems: ListItem[];

  visualCaption: string;

  reportingEyebrow: string;
  reportingTitle: string;
  reportingIntro: string;
  reportingItems: ListItem[];

  faqEyebrow: string;
  faqTitle: string;
  faqIntro: string;
  faqs: FaqItem[];

  ctaTitle: string;
  ctaBody: string;
};

export const USE_CASES: Record<string, UseCasePageContent> = {
  lawyers: {
    slug: "lawyers",
    industryImage: "/assets/industries/industry-legal.png",
    verificationImage: "/assets/verification/law-verification.png",

    eyebrow: "For Law Firms & In-House Legal",
    headline: "A structured evidence layer for",
    headlineHighlight: "matter teams.",
    subhead:
      "PROOVRA gives litigation, dispute, in-house, and eDiscovery teams a structured way to intake client-submitted material, preserve it as matter-bound evidence records with integrity signals and custody history, and present it to experts, co-counsel, and opposing parties through a reviewer-ready verification surface.",
    proofPoints: [
      "Matter-bound evidence records",
      "Custody history on every record",
      "Verification packages for review",
    ],

    challengesEyebrow: "The problem",
    challengesTitle: "Matter evidence rarely arrives in a state your team can review and explain cleanly.",
    challengesNarrative: [
      "Counsel receives matter evidence the way the rest of the world sends files — forwarded emails, phone screenshots, drag-and-drop attachments, exports from chat applications, social media captures. Each piece survives the journey into the matter folder; almost none arrives with the preservation context an expert or opposing party will eventually demand.",
      "By the time the matter reaches review, the gap becomes operational risk. Paralegals reconstruct custody from email threads. External counsel receives zip bundles instead of structured evidence. Expert witnesses ask where the file came from and the answer lives in someone's memory. The work behind the matter is solid; the way the evidence is delivered makes it harder to review and explain later.",
    ],
    challenges: [
      {
        title: "Email attachments and forwards lose context",
        body: "Client uploads arrive over email and chat. The file reaches the matter folder; the integrity signal, timing context, and submission chain do not.",
      },
      {
        title: "Shared drives don't preserve custody",
        body: "Matter folders capture documents but not the structured handling history an expert or opposing party will eventually ask for.",
      },
      {
        title: "Zip bundles for production look weak",
        body: "External counsel and opposing parties receive zipped attachments instead of reviewer-ready verification packages with a structured surface.",
      },
      {
        title: "Screenshots and exports lack integrity signals",
        body: "Phone captures and platform exports arrive at intake without SHA-256 fingerprints or independent timing anchors a reviewer can later re-check.",
      },
      {
        title: "Custody history reconstructed from memory",
        body: "When the matter escalates, paralegals reconstruct who handled what, from where, and when — often weeks after the events themselves.",
      },
      {
        title: "Expert review starts from raw files",
        body: "Experts open files in a folder with no surrounding structure, slowing review and weakening the package the firm can stand behind.",
      },
    ],

    workflowEyebrow: "How PROOVRA fits the workflow",
    workflowTitle: "Matter intake to production, on one verification layer.",
    workflowNarrative: [
      "PROOVRA converts every piece of client-submitted material — uploads, captured screens, exports, recordings — into a structured evidence record bound to the matter. Each record carries its integrity signals, timing context, and custody history from the moment of intake. The verification surface stays with the record wherever it goes next.",
      "Reviewers, expert witnesses, co-counsel, and opposing parties read the same structured surface — not raw files in a folder. Counsel can hand off a reviewer-ready verification page, a PDF report, and supporting technical materials together, instead of explaining where the evidence came from after the fact.",
      "Under the hood, every record carries SHA-256 integrity signals, timing context with RFC 3161 and OpenTimestamps third-party anchoring where available, and a structured custody history. Counsel can stand up an intake link bound to a specific matter so clients and counter-parties submit straight into the verification workflow, and place records on legal hold when retention rules need to pause.",
    ],
    lifecycle: [
      {
        label: "Matter Intake",
        body: "Client uploads, captures, and exports arrive through a matter-bound intake link or workspace upload.",
      },
      {
        label: "Evidence Records",
        body: "Each piece becomes a structured matter-bound evidence record — not a loose file in a folder.",
      },
      {
        label: "Verification",
        body: "SHA-256 hash, RFC 3161 timestamp context, and OpenTimestamps anchoring (where configured) are captured.",
      },
      {
        label: "Review",
        body: "Counsel, paralegals, and expert reviewers work from a single verification surface.",
      },
      {
        label: "Reports",
        body: "PDF reports and verification packages travel into production, briefing, and external review.",
      },
      {
        label: "Governance",
        body: "Retention rules, access controls, legal hold, and audit trail support firm governance and matter discipline.",
      },
    ],

    comparisonEyebrow: "Why traditional methods fail",
    comparisonTitle: "Files survive. The structure around them does not.",
    comparisonIntro:
      "Law firms run on shared drives, email, and zip bundles. Each stores the file. None of them produce the structured evidence layer matter teams need under expert review or opposing scrutiny.",
    comparisonRows: [
      {
        traditional: "Email attachments forwarded by clients",
        proovra: "Matter-bound evidence records via a controlled intake link",
      },
      {
        traditional: "Shared drives full of loose files",
        proovra: "Structured records with SHA-256, timestamp, and custody history",
      },
      {
        traditional: "Screenshots submitted without preservation context",
        proovra: "Captures attached to an evidence record with integrity signals",
      },
      {
        traditional: "Zip bundles handed to external counsel",
        proovra: "Verification packages with a reviewer-facing verification page",
      },
      {
        traditional: "Custody reconstructed from email threads",
        proovra: "Audit logs and chain-of-custody attached to every record",
      },
      {
        traditional: "Retention managed ad-hoc per matter",
        proovra: "Retention policies and legal hold applied at record and matter level",
      },
    ],

    operationsEyebrow: "Platform operations",
    operationsTitle: "How matter teams use PROOVRA every day.",
    operationsIntro:
      "PROOVRA fits the operational shape of a matter team — intake, custody, review, expert collaboration, production — without forcing the firm to rebuild around it.",
    operationsItems: [
      {
        title: "Matter review",
        body: "Counsel and paralegals open the verification surface to inspect integrity state, custody history, and the structured report for any matter evidence record.",
      },
      {
        title: "Client evidence intake",
        body: "A matter-bound intake link gives the client one URL to submit material straight into the matter workspace as structured evidence records.",
      },
      {
        title: "Expert review collaboration",
        body: "Expert witnesses receive verification packages with a verification page and a PDF report instead of raw files, accelerating expert engagement.",
      },
      {
        title: "Production and disclosure handoff",
        body: "Verification packages support production, disclosure, and external-counsel handoff with a structured surface attached to every record.",
      },
      {
        title: "Disputed-material defense",
        body: "When a record is challenged, the verification page exposes the integrity state, timing context, and custody history a reviewer can re-check.",
      },
      {
        title: "Internal escalation and supervision",
        body: "Supervising partners and ethics review consume the same verification surface as the matter team, without rebuilding the evidence package.",
      },
    ],

    governanceEyebrow: "Governance & oversight",
    governanceTitle: "Firm-grade governance attached to every record.",
    governanceIntro:
      "Matter discipline lives at the record level. Retention rules, legal hold, access controls, and audit trail travel with the record into review, production, and supervision.",
    governanceItems: [
      {
        title: "Retention policies at record level",
        body: "Each evidence record carries retention rules that govern how long it is kept and how disposition is handled — visible to firm governance and supervising partners.",
      },
      {
        title: "Legal hold at matter level",
        body: "Records can be placed on legal hold to suspend retention rules during active matters and preserve evidence for the duration of the engagement.",
      },
      {
        title: "Access controls and role separation",
        body: "Workspace-scoped role-based permissions separate matter teams, supervising partners, ethics review, and external counsel.",
      },
      {
        title: "Audit trail for every action",
        body: "Creation, upload, report generation, reviewer access, and download events are recorded on each evidence record and exportable for supervision.",
      },
      {
        title: "Chain of custody as first-class history",
        body: "The custody history is part of the record — not a separate spreadsheet — so it survives every handoff inside or outside the firm.",
      },
      {
        title: "Workspace separation for matters and clients",
        body: "Matter workspaces isolate evidence by engagement, with separate access lists and retention scopes for each client.",
      },
    ],

    visualCaption:
      "Every matter evidence record opens onto a single verification surface: integrity state, SHA-256 fingerprint, RFC 3161 and OpenTimestamps timing context, custody history, the report, and a shareable verification package — usable by counsel, experts, and opposing parties without rebuilding the evidence package.",

    reportingEyebrow: "Reporting & verification",
    reportingTitle: "What reviewers actually receive.",
    reportingIntro:
      "PROOVRA produces a structured set of reviewer-facing outputs for every matter evidence record. Each travels with the matter into production, expert review, and external handoff.",
    reportingItems: [
      {
        title: "Verification Page",
        body: "A reviewer-facing surface that exposes the integrity state, SHA-256 fingerprint, timing context, custody history, and supporting verification materials — shareable internally or externally.",
      },
      {
        title: "Verification Package",
        body: "A bundled package of the record, the report, and supporting verification materials for counsel, experts, and opposing parties.",
      },
      {
        title: "PDF Report",
        body: "A consolidated structured report suitable for production, briefing, expert review, and external-counsel handoff.",
      },
      {
        title: "Audit Trail Export",
        body: "An exportable audit log of access, generation, and review events on each evidence record, for supervising partners and ethics review.",
      },
      {
        title: "Governance Attachment",
        body: "Retention rules, legal hold status, and matter governance context attached to every record produced.",
      },
    ],

    faqEyebrow: "Frequently asked",
    faqTitle: "Questions matter teams ask.",
    faqIntro:
      "Common questions from in-house legal, litigation support, and eDiscovery operators evaluating PROOVRA for matter evidence handling.",
    faqs: [
      {
        q: "Is PROOVRA eDiscovery software?",
        a: "No. PROOVRA is an evidence integrity, verification, and governance platform. It complements eDiscovery by giving matter teams structured evidence records with integrity signals, custody history, and reviewer-ready verification packages.",
      },
      {
        q: "Can clients submit evidence directly into a matter?",
        a: "Yes. A matter-bound intake link lets clients submit material straight into the matter workspace as structured evidence records with integrity signals captured at submission.",
      },
      {
        q: "Does PROOVRA replace our document management system?",
        a: "No. PROOVRA sits alongside document and matter management — it handles the verification, integrity, and custody layer for evidence that needs to stand up under review.",
      },
      {
        q: "What integrity signals are captured?",
        a: "Each evidence record carries a SHA-256 hash, RFC 3161 timestamp context, OpenTimestamps anchoring where available, and digital signatures on records and reports.",
      },
      {
        q: "How does legal hold work?",
        a: "Records can be placed on legal hold at the matter or record level. Legal hold suspends retention rules so the record is preserved while the matter is active.",
      },
      {
        q: "Can opposing counsel verify the evidence independently?",
        a: "Yes. A shareable verification page lets opposing counsel and expert reviewers re-check the integrity state and timing context without relying on the firm's narrative.",
      },
      {
        q: "How is custody history captured?",
        a: "Creation, upload, report generation, reviewer access, and download events are recorded on each evidence record and surfaced in the verification page and audit trail.",
      },
      {
        q: "Does PROOVRA make claims about legal admissibility?",
        a: "No. PROOVRA verifies recorded integrity signals, timestamp context, custody metadata, and supporting review materials. It does not determine factual truth, authorship, identity, or legal admissibility — those remain matters for counsel and the tribunal.",
      },
      {
        q: "Can experts use the verification package outside PROOVRA?",
        a: "Yes. The verification package and PDF report are portable and can be reviewed by external experts. The SHA-256 hash and OpenTimestamps anchor remain independently checkable.",
      },
      {
        q: "Is AI used to assess evidence?",
        a: "Any AI assistance inside the workflow is advisory only — it surfaces observations and prompts to reviewers. It never asserts truth, authorship, identity, or admissibility about the underlying material.",
      },
    ],

    ctaTitle: "Bring matter evidence into a verification surface counsel can review and explain clearly.",
    ctaBody:
      "Book a demo to see a real matter move through PROOVRA — from client intake to a verification package external counsel and experts can re-check independently.",
  },

  insurance: {
    slug: "insurance",
    industryImage: "/assets/industries/industry-insurance.png",
    verificationImage: "/assets/verification/insurance-verification.png",

    eyebrow: "For Claims, Adjusters & SIU",
    headline: "Claim evidence with",
    headlineHighlight: "review-ready integrity.",
    subhead:
      "PROOVRA gives claims, adjuster, fraud, and SIU teams a structured way to intake first-notice submissions — photos, videos, documents, repair estimates, recordings — preserve them as structured claim evidence records with integrity signals, and route them through adjuster review, fraud escalation, and external counsel without rebuilding the package at each handoff.",
    proofPoints: [
      "FNOL intake with integrity signals",
      "Post-submission mismatch visibility",
      "SIU and external-counsel packages",
    ],

    challengesEyebrow: "The problem",
    challengesTitle: "Claim portals capture the file. They don't capture the claim.",
    challengesNarrative: [
      "First-notice intake captures the photo, the video, the repair estimate. It rarely captures the preservation context, the timing signals, or the handling history a fraud reviewer, supervisor, or external counsel will eventually ask for. By the time the claim is disputed, the file is doing the work of an evidence record with none of its structure.",
      "Upload portals were built for ticketing, not evidence handling. They store the file; they don't surface whether the preserved record still matches the state at submission, they don't produce a reviewer-facing verification surface, and they don't give SIU or external counsel a structured package to consume. The carrier pays for that gap downstream.",
    ],
    challenges: [
      {
        title: "First-notice submissions lack integrity signals",
        body: "Customer-app uploads land in the claim file without SHA-256 fingerprints or independent timing anchors a reviewer can later re-check.",
      },
      {
        title: "Adjuster coordination over email and tickets",
        body: "Handling history is reconstructed from notes fields and email threads — not visible to SIU or external counsel as a structured trail.",
      },
      {
        title: "Property and vehicle claim photos easy to challenge",
        body: "Repair photos and damage videos arrive without preservation context, weakening the carrier's response when the submission is disputed.",
      },
      {
        title: "Broker portal submissions inconsistent",
        body: "Submissions from broker and partner channels arrive in different shapes — without a structured evidence layer to harmonize them.",
      },
      {
        title: "Fraud review starts from raw files",
        body: "SIU reviewers open files in a portal with no surrounding structure, slowing investigation and weakening the package they can refer.",
      },
      {
        title: "External-counsel referrals lack a structured package",
        body: "When a claim escalates to outside counsel, the carrier hands over zip files and a narrative — not a verification package counsel can re-check.",
      },
    ],

    workflowEyebrow: "How PROOVRA fits the workflow",
    workflowTitle: "FNOL to resolution, on one verification layer.",
    workflowNarrative: [
      "Customer-app uploads, broker portal submissions, and adjuster captures become structured evidence records bound to the claim — not loose attachments on a ticket. Each record locks in its integrity signals and timing context at submission, so post-submission mismatch becomes visible later instead of being argued from memory.",
      "Adjusters, SIU, supervisors, and external counsel work from the same verification surface. When a claim escalates, the same record carries its context with it — no rebuild, no narrative reconstruction, no zip files standing in for evidence handling.",
      "Under the hood, every claim record carries SHA-256 integrity signals, timing context with RFC 3161 and OpenTimestamps third-party anchoring where available, and a structured custody history. Carriers can stand up an intake link bound to a specific claim so customer-app and broker submissions land straight into the verification workflow — with post-submission mismatch visible to reviewers later, not argued from memory.",
    ],
    lifecycle: [
      {
        label: "FNOL",
        body: "First-notice submissions arrive through a customer-app, broker portal, or claim-bound intake link.",
      },
      {
        label: "Claim Intake",
        body: "Each submission becomes a structured claim-bound evidence record with integrity signals captured at completion.",
      },
      {
        label: "Adjuster Review",
        body: "Adjusters open the verification surface to inspect integrity state, custody history, and the structured report.",
      },
      {
        label: "Verification",
        body: "SHA-256 hash, RFC 3161 timestamp, and OpenTimestamps anchoring travel with the claim into supervisor and SIU review.",
      },
      {
        label: "Resolution",
        body: "Verification packages support payout, denial, supervisor approval, or SIU referral — no rebuild required.",
      },
      {
        label: "Governance",
        body: "Retention rules, access controls, and audit logs support carrier governance and downstream litigation.",
      },
    ],

    comparisonEyebrow: "Why traditional methods fail",
    comparisonTitle: "Upload portals were not built for claim evidence.",
    comparisonIntro:
      "Customer-app intake and broker portals capture the file. They do not produce the structured evidence layer claims operations need under SIU referral, supervisor escalation, or external-counsel review.",
    comparisonRows: [
      {
        traditional: "Customer-app photo uploads without preservation context",
        proovra: "Photo attached to a structured claim-bound evidence record",
      },
      {
        traditional: "Broker portal submissions in inconsistent shapes",
        proovra: "Broker submissions arrive as records via a claim-bound intake link",
      },
      {
        traditional: "Adjuster handling history in notes fields",
        proovra: "Audit logs and chain-of-custody attached to every record",
      },
      {
        traditional: "SIU receives raw files and a verbal summary",
        proovra: "SIU receives a verification package with a reviewer-facing page",
      },
      {
        traditional: "Post-submission tampering argued from memory",
        proovra: "Mismatch visible on the verification surface — re-checkable",
      },
      {
        traditional: "External counsel handed a zip and a narrative",
        proovra: "External counsel receives a structured verification package",
      },
    ],

    operationsEyebrow: "Platform operations",
    operationsTitle: "How claims teams use PROOVRA every day.",
    operationsIntro:
      "PROOVRA fits the operational shape of claims operations — intake, adjuster review, SIU escalation, supervisor approval, external counsel referral — without forcing the carrier to rebuild around it.",
    operationsItems: [
      {
        title: "FNOL and first-notice intake",
        body: "Customer-app submissions and broker portal uploads land in PROOVRA as structured claim-evidence records with integrity signals captured at submission.",
      },
      {
        title: "Adjuster review and triage",
        body: "Adjusters open the verification surface to inspect the integrity state, custody history, and the structured report — before deciding triage or escalation.",
      },
      {
        title: "Property claim documentation",
        body: "Damage photos, video walk-throughs, and repair estimates become records on the claim, with timing context and a re-checkable integrity signal.",
      },
      {
        title: "Vehicle claim documentation",
        body: "Crash scene captures, vehicle photos, and repair documentation flow into the claim with structured verification context attached.",
      },
      {
        title: "Fraud review and SIU escalation",
        body: "SIU receives the same verification surface adjusters use, with the verification package and PDF report ready for referral or external review.",
      },
      {
        title: "Supervisor approval and external-counsel referral",
        body: "Supervisor approval and external-counsel referral consume the verification package — no rebuild from notes and zip files at handoff.",
      },
    ],

    governanceEyebrow: "Governance & oversight",
    governanceTitle: "Carrier-grade governance on every claim record.",
    governanceIntro:
      "Claims discipline lives at the record level. Retention rules, access controls, audit logs, and downstream legal hold travel with the record into adjuster review, SIU, supervisor approval, and external-counsel handoff.",
    governanceItems: [
      {
        title: "Retention rules per claim type",
        body: "Records carry retention rules that govern how long claim evidence is kept and how disposition is handled across product lines.",
      },
      {
        title: "Legal hold for litigated claims",
        body: "Claims that escalate to litigation can place evidence on legal hold to suspend retention and preserve records during the matter.",
      },
      {
        title: "Access controls and role separation",
        body: "Workspace-scoped role-based permissions separate adjusters, SIU, supervisors, and external counsel on each claim.",
      },
      {
        title: "Audit logs for every claim event",
        body: "Submission, upload, report generation, reviewer access, and download events are recorded and exportable for governance and audit.",
      },
      {
        title: "Chain of custody on claim evidence",
        body: "The custody history is part of every claim-evidence record — not a spreadsheet — so it survives adjuster, SIU, and external-counsel handoff.",
      },
      {
        title: "Workspace separation by product line",
        body: "Workspaces isolate evidence by product line — property, auto, commercial — with separate access lists, retention scopes, and governance.",
      },
    ],

    visualCaption:
      "Every claim submission opens onto the verification surface: integrity state, SHA-256 fingerprint, RFC 3161 and OpenTimestamps timing context, custody history, the report, and a shareable verification package — usable by adjusters, SIU, supervisors, and external counsel without rebuilding the package.",

    reportingEyebrow: "Reporting & verification",
    reportingTitle: "What claims reviewers actually receive.",
    reportingIntro:
      "PROOVRA produces a structured set of reviewer-facing outputs for every claim record. Each travels with the claim into adjuster review, SIU referral, supervisor approval, and external counsel.",
    reportingItems: [
      {
        title: "Verification Page",
        body: "A reviewer-facing surface that exposes the integrity state, SHA-256 fingerprint, timing context, custody history, and supporting verification materials.",
      },
      {
        title: "Verification Package",
        body: "A bundled package of the claim record, the report, and supporting verification materials for SIU and external counsel.",
      },
      {
        title: "PDF Report",
        body: "A consolidated structured report suitable for the claim file, escalation packets, and external referrals.",
      },
      {
        title: "Audit Trail Export",
        body: "An exportable audit log of access, generation, and review events on each claim record, for governance and litigation support.",
      },
      {
        title: "Governance Attachment",
        body: "Retention rules, legal hold status, and claim-level governance context attached to every record produced.",
      },
    ],

    faqEyebrow: "Frequently asked",
    faqTitle: "Questions claims teams ask.",
    faqIntro:
      "Common questions from claims operations, SIU, and underwriting evaluating PROOVRA for claim evidence handling.",
    faqs: [
      {
        q: "Is PROOVRA a claim management system?",
        a: "No. PROOVRA is an evidence integrity, verification, and governance platform. It complements claim management by giving claims operations structured evidence records with integrity signals, custody history, and reviewer-ready verification packages.",
      },
      {
        q: "Can policyholders submit claim evidence directly?",
        a: "Yes. A claim-bound intake link lets policyholders submit photos, videos, and documents straight into the claim as structured records with integrity signals captured at submission.",
      },
      {
        q: "How are broker and partner submissions handled?",
        a: "Brokers and partners can submit via a claim-bound intake link or workspace upload. Each submission becomes a structured claim-evidence record in the same verification workflow.",
      },
      {
        q: "What integrity signals are captured on claim evidence?",
        a: "Each claim-evidence record carries a SHA-256 hash, RFC 3161 timestamp context, OpenTimestamps anchoring where available, and digital signatures on records and reports.",
      },
      {
        q: "Does PROOVRA detect fraud?",
        a: "No. PROOVRA surfaces post-submission mismatch and exposes the recorded integrity signals to reviewers. SIU investigators interpret those signals — PROOVRA does not assert that any submission is fraudulent.",
      },
      {
        q: "Can SIU re-check the evidence independently?",
        a: "Yes. The verification page lets SIU re-check the integrity state and timing context independently. The SHA-256 hash and OpenTimestamps anchor remain externally re-checkable.",
      },
      {
        q: "How does PROOVRA handle disputed claims?",
        a: "When a claim is disputed, the verification page exposes the integrity state, timing context, and custody history a supervisor or external counsel can re-check — instead of arguing handling from memory.",
      },
      {
        q: "How is retention handled across product lines?",
        a: "Workspaces isolate evidence by product line. Retention rules attached to each record govern how long claim evidence is kept and how disposition is handled.",
      },
      {
        q: "Does AI assess whether a claim is valid?",
        a: "No. Any AI assistance inside the workflow is advisory only — it surfaces observations and prompts to adjusters and SIU. Decisions on payout, denial, or referral remain with the carrier.",
      },
      {
        q: "Can the verification package be used in litigation?",
        a: "External counsel can consume the verification package and re-check the integrity signals independently. PROOVRA does not determine legal admissibility — that remains a matter for counsel and the tribunal.",
      },
    ],

    ctaTitle: "Replace claim portals with a verification surface SIU and counsel can re-check.",
    ctaBody:
      "Book a demo to see how a real claim moves through PROOVRA — from FNOL to a verification package SIU and external counsel can re-check independently.",
  },

  investigations: {
    slug: "investigations",
    industryImage: "/assets/industries/industry-investigations.png",
    verificationImage: "/assets/verification/investigator-verification.png",

    eyebrow: "For Corporate Investigations & HR",
    headline: "One review-grade evidence layer for",
    headlineHighlight: "sensitive cases.",
    subhead:
      "PROOVRA gives corporate investigators, HR, ethics, compliance, and internal security teams a structured way to intake incident evidence — witness submissions, captured screens, recordings, exports — preserve it as structured case evidence records, and route it through investigator review, escalation, and external counsel without rebuilding the package at each handoff.",
    proofPoints: [
      "Case-bound evidence intake",
      "Structured custody history",
      "Built for sensitive escalation",
    ],

    challengesEyebrow: "The problem",
    challengesTitle: "Sensitive cases live on shared drives. They shouldn't.",
    challengesNarrative: [
      "Internal investigations cross HR, ethics, compliance, security, legal, and operations. Incident evidence moves across teams over chat, email, ticketing, and shared drives — and arrives at the next reviewer without the preservation context the case will eventually rest on for review. Investigators do the work; the handoff loses the structure.",
      "When the case escalates externally — to outside counsel, audit, or regulators — the gap becomes visible. Outside counsel asks where the evidence came from. Audit asks what was preserved and how. Investigators end up rebuilding the case package at every handoff. PROOVRA gives investigators a single review-grade evidence layer that survives those handoffs without rebuild.",
    ],
    challenges: [
      {
        title: "Workplace incident evidence over chat and email",
        body: "Witness statements and incident captures arrive through ad-hoc channels and land on shared drives without a custody history attached.",
      },
      {
        title: "HR matters lose structure between teams",
        body: "HR, ethics, and legal review the same incident in different formats — there is no single review-grade evidence layer they share.",
      },
      {
        title: "Whistleblower reports lack a protected intake path",
        body: "Whistleblower submissions go through ad-hoc channels; the carrier loses preservation context and reporter context at the same time.",
      },
      {
        title: "Ethics complaints scattered across systems",
        body: "Ethics complaints land in a ticketing system, ethics inbox, and HR record — none of which produce a verification surface.",
      },
      {
        title: "Fraud review starts from folders",
        body: "Internal-fraud reviewers open files in a folder with no surrounding structure, slowing investigation and weakening the case package.",
      },
      {
        title: "External counsel and audit handed zip files",
        body: "When cases escalate, outside counsel and audit receive zips and verbal narratives instead of a verification package they can re-check.",
      },
    ],

    workflowEyebrow: "How PROOVRA fits the workflow",
    workflowTitle: "Incident to escalation, on one verification layer.",
    workflowNarrative: [
      "Submitted media, witness uploads, and investigator captures become structured evidence records bound to the case — not attachments on a ticket. Each record locks in its integrity signals, timing context, and custody history at the moment of completion, so the preservation posture is visible to every reviewer the case eventually reaches.",
      "Investigators, HR, compliance reviewers, security teams, legal, and external review work from the same verification surface. When the case escalates, the record carries its context with it — no rebuild, no narrative reconstruction, no folders standing in for evidence handling.",
      "Under the hood, every case record carries SHA-256 integrity signals, timing context with RFC 3161 and OpenTimestamps third-party anchoring where available, and a structured custody history. Investigators can stand up a case-bound intake link so witnesses and field officers submit straight into the verification workflow, and place records on legal hold when retention rules need to pause.",
    ],
    lifecycle: [
      {
        label: "Incident",
        body: "A workplace incident, ethics complaint, whistleblower report, or fraud signal opens a case in PROOVRA.",
      },
      {
        label: "Intake",
        body: "Witnesses, investigators, and field staff submit through a case-bound intake link or workspace capture.",
      },
      {
        label: "Case Records",
        body: "Each submission becomes a structured case-bound evidence record with integrity signals at completion.",
      },
      {
        label: "Review",
        body: "Investigators, HR, ethics, and security work from the same verification surface — not raw folders.",
      },
      {
        label: "Verification",
        body: "SHA-256 hash, RFC 3161 timestamp, and OpenTimestamps anchoring stay with the case through escalation.",
      },
      {
        label: "Escalation",
        body: "Verification packages support handoff to legal, audit, external counsel, or regulators without rebuild.",
      },
    ],

    comparisonEyebrow: "Why traditional methods fail",
    comparisonTitle: "Shared drives and chat threads are not investigations infrastructure.",
    comparisonIntro:
      "Internal investigations move evidence across many teams. PROOVRA replaces the ad-hoc handling chain with one review-grade evidence layer that survives every reviewer the case reaches.",
    comparisonRows: [
      {
        traditional: "Witness submissions over email and chat",
        proovra: "Witnesses submit via a case-bound intake link",
      },
      {
        traditional: "HR/ethics/security each holding their own copy",
        proovra: "One case-bound evidence record shared by all reviewers",
      },
      {
        traditional: "Custody history reconstructed from a tracker",
        proovra: "Chain of custody as a first-class history on every record",
      },
      {
        traditional: "Whistleblower reports through ad-hoc channels",
        proovra: "Controlled case-bound intake for whistleblower submissions",
      },
      {
        traditional: "External counsel handed a zip and a narrative",
        proovra: "External counsel receives a structured verification package",
      },
      {
        traditional: "Audit reconstructs handling at audit time",
        proovra: "Audit logs and retention context already attached at intake",
      },
    ],

    operationsEyebrow: "Platform operations",
    operationsTitle: "How investigations teams use PROOVRA every day.",
    operationsIntro:
      "PROOVRA fits the operational shape of corporate investigations — incident intake, witness submission, investigator review, escalation to legal, audit, or external counsel.",
    operationsItems: [
      {
        title: "Internal investigations and workplace incidents",
        body: "Investigators open a case workspace, take in witness submissions and field captures, and review on one verification surface.",
      },
      {
        title: "HR matters and policy violations",
        body: "HR-led cases carry the same verification surface as security-led cases, with role separation for privacy and access discipline.",
      },
      {
        title: "Ethics complaints and whistleblower intake",
        body: "Controlled case-bound intake links provide a structured submission path for ethics and whistleblower reports.",
      },
      {
        title: "Internal-fraud review",
        body: "Fraud cases combine field captures, system exports, and witness submissions into a single review-grade evidence layer.",
      },
      {
        title: "Legal hold for active matters",
        body: "When a case escalates to legal or external counsel, records can be placed on legal hold to suspend retention rules during the matter.",
      },
      {
        title: "Escalation to external counsel or regulators",
        body: "The same case workspace produces a verification package for external counsel, audit, or regulators — no rebuild at handoff.",
      },
    ],

    governanceEyebrow: "Governance & oversight",
    governanceTitle: "Case governance attached to every record.",
    governanceIntro:
      "Investigations discipline lives at the record level. Retention rules, legal hold, access controls, and audit trail travel with the case into HR, ethics, security, legal, and external review.",
    governanceItems: [
      {
        title: "Retention per case type",
        body: "Records carry retention rules that govern how long case evidence is kept and how disposition is handled across case types.",
      },
      {
        title: "Legal hold for live matters",
        body: "Records can be placed on legal hold to suspend retention rules during active investigations or follow-on litigation.",
      },
      {
        title: "Access controls and role separation",
        body: "Workspace-scoped role-based permissions separate investigators, HR, ethics, security, and external counsel on each case.",
      },
      {
        title: "Audit logs for sensitive matters",
        body: "Submission, upload, report generation, reviewer access, and download events are recorded on every case record and exportable for governance.",
      },
      {
        title: "Chain of custody across handoffs",
        body: "The custody history is part of every case-evidence record so it survives HR, legal, audit, and external-counsel handoff.",
      },
      {
        title: "Workspace separation by case",
        body: "Each case has its own workspace with isolated access, retention scope, and governance — privacy by default.",
      },
    ],

    visualCaption:
      "Every case-evidence record opens onto the verification surface: integrity state, SHA-256 fingerprint, RFC 3161 and OpenTimestamps timing context, custody history, the report, and a shareable verification package — usable by HR, legal, audit, and external review without rebuilding the package.",

    reportingEyebrow: "Reporting & verification",
    reportingTitle: "What case reviewers actually receive.",
    reportingIntro:
      "PROOVRA produces a structured set of reviewer-facing outputs for every case record. Each travels with the case into HR, legal, audit, and external-counsel review.",
    reportingItems: [
      {
        title: "Verification Page",
        body: "A reviewer-facing surface that exposes the integrity state, SHA-256 fingerprint, timing context, custody history, and supporting verification materials.",
      },
      {
        title: "Verification Package",
        body: "A bundled package of the case record, the report, and supporting verification materials for legal, audit, or external review.",
      },
      {
        title: "PDF Report",
        body: "A consolidated structured report suitable for case briefing, internal escalation, and external review.",
      },
      {
        title: "Audit Trail Export",
        body: "An exportable audit log of access, generation, and review events on each case record, for governance and oversight.",
      },
      {
        title: "Governance Attachment",
        body: "Retention rules, legal hold status, and case-level governance context attached to every record produced.",
      },
    ],

    faqEyebrow: "Frequently asked",
    faqTitle: "Questions investigations teams ask.",
    faqIntro:
      "Common questions from corporate investigators, HR, ethics, and internal security evaluating PROOVRA for case evidence handling.",
    faqs: [
      {
        q: "Is PROOVRA a case management system?",
        a: "No. PROOVRA is an evidence integrity, verification, and governance platform. It complements case management by giving investigators structured evidence records with integrity signals, custody history, and reviewer-ready verification packages.",
      },
      {
        q: "Can witnesses submit evidence directly into a case?",
        a: "Yes. A case-bound intake link lets witnesses, field staff, or whistleblowers submit material straight into the case as structured records with integrity signals captured at submission.",
      },
      {
        q: "How are whistleblower reports handled?",
        a: "Controlled case-bound intake links provide a structured submission path for whistleblower reports, with access controls that keep the reporter context separated from operational reviewers.",
      },
      {
        q: "What integrity signals are captured on case evidence?",
        a: "Each case-evidence record carries a SHA-256 hash, RFC 3161 timestamp context, OpenTimestamps anchoring where available, and digital signatures on records and reports.",
      },
      {
        q: "Does PROOVRA decide whether a complaint is valid?",
        a: "No. PROOVRA preserves the recorded integrity signals and exposes them to investigators. Decisions on the substance of a complaint remain with HR, ethics, and legal.",
      },
      {
        q: "How does legal hold work for investigations?",
        a: "Records can be placed on legal hold at the case or record level. Legal hold suspends retention rules so the record is preserved during the active matter.",
      },
      {
        q: "Can external counsel re-check the evidence?",
        a: "Yes. The verification page lets external counsel re-check the integrity state and timing context independently. The SHA-256 hash and OpenTimestamps anchor remain externally re-checkable.",
      },
      {
        q: "How is access separated between HR, ethics, and security?",
        a: "Workspace-scoped role-based permissions separate HR, ethics, security, legal, and external counsel on each case — with audit logs visible to case governance.",
      },
      {
        q: "Does AI judge the credibility of witnesses?",
        a: "No. Any AI assistance inside the workflow is advisory only — it surfaces observations and prompts to investigators. It never asserts truth, identity, or credibility about witnesses or subjects.",
      },
      {
        q: "Can a case workspace be wound down after closure?",
        a: "Yes. Retention rules govern how long case evidence is kept after closure, and records can be placed on legal hold if follow-on matters require ongoing preservation.",
      },
    ],

    ctaTitle: "Bring sensitive case evidence into a verification surface every reviewer can use.",
    ctaBody:
      "Book a demo to see how a real corporate investigation moves through PROOVRA — from incident intake to a verification package external counsel and audit can re-check independently.",
  },

  journalism: {
    slug: "journalism",
    industryImage: "/assets/industries/industry-journalism.png",
    verificationImage: "/assets/verification/journalism-verification.png",

    eyebrow: "For Newsrooms & Editorial Teams",
    headline: "Source material preserved with",
    headlineHighlight: "an editor-grade review layer.",
    subhead:
      "PROOVRA gives investigative reporters, editors, fact-checkers, and legal review a structured way to preserve source material — submitted media, captured screens, recordings, leaked documents — as structured evidence records with integrity signals, timing context, and a reviewer-ready verification surface for editorial scrutiny and post-publication challenge.",
    proofPoints: [
      "Source preservation, not just storage",
      "Editor-facing review surface",
      "Built for post-publication scrutiny",
    ],

    challengesEyebrow: "The problem",
    challengesTitle: "Source files survive. The review context usually doesn't.",
    challengesNarrative: [
      "A leaked document, a captured screen, or a sensitive recording rarely survives editorial review with its preservation context intact. Folders, shared drives, and message threads preserve the file but lose the structure an editor or fact-checker needs to scrutinize it carefully — and that a post-publication challenge will eventually demand.",
      "Reporters become preservation engineers by accident. A screenshot is captured at intake; a hash is computed by hand later; a custody history is reconstructed from chat threads weeks afterward. The work is done with care; the structure that backs it up is fragmented. PROOVRA preserves the file and the review context together.",
    ],
    challenges: [
      {
        title: "Source material on shared drives loses context",
        body: "Leaked documents and captured screens land in folders without SHA-256 fingerprints, timing anchors, or custody history a reviewer can re-check.",
      },
      {
        title: "Reporter intake over message threads",
        body: "Sources reach reporters through chat and message threads; the file survives the hop, the preservation chain usually doesn't.",
      },
      {
        title: "Editorial review starts from raw files",
        body: "Editors and fact-checkers open files in a folder with no surrounding structure, slowing review and weakening pre-publication scrutiny.",
      },
      {
        title: "Legal review reconstructs handling at publication time",
        body: "Newsroom counsel reviews handling shortly before publication and finds gaps — without the structured preservation context they need.",
      },
      {
        title: "Post-publication challenge demands records the newsroom rebuilt",
        body: "When a story is challenged, the newsroom rebuilds the handling chain from chat threads — under time pressure and with imperfect memory.",
      },
      {
        title: "Source protection at odds with recordkeeping",
        body: "Strong recordkeeping cannot come at the cost of source protection — newsrooms need access controls that separate reporter context from review context.",
      },
    ],

    workflowEyebrow: "How PROOVRA fits the workflow",
    workflowTitle: "Source intake to publication records, on one verification layer.",
    workflowNarrative: [
      "Submitted media, captured screens, and reporter uploads become structured source records — not loose copies in a folder. Each record locks in its integrity signals and timing context at the moment of completion, so editors and fact-checkers can review the source material with the surrounding record visible.",
      "Editors, fact-checkers, legal review, and external reviewers work from the same verification surface. When a story is questioned after publication, the newsroom has structured preservation context — not a folder and a memory of where the file came from.",
      "Under the hood, every source record carries SHA-256 integrity signals, timing context with RFC 3161 and OpenTimestamps third-party anchoring where available, and a structured custody history. Newsrooms can stand up a controlled intake link so sources submit straight into the verification workflow. Any AI assistance inside the workflow is advisory only — it surfaces observations, never truth claims about the source.",
    ],
    lifecycle: [
      {
        label: "Source Submission",
        body: "Sources submit through a controlled intake link or reporter capture into a newsroom workspace.",
      },
      {
        label: "Intake",
        body: "Each submission becomes a structured source-bound evidence record with integrity signals at completion.",
      },
      {
        label: "Preservation",
        body: "SHA-256 hash, RFC 3161 timestamp, and OpenTimestamps anchoring capture the recorded state at completion.",
      },
      {
        label: "Verification",
        body: "Reporters, editors, and fact-checkers re-check the integrity state and timing context on one verification surface.",
      },
      {
        label: "Editorial Review",
        body: "Editorial review and newsroom legal consume the same verification surface — not a folder of raw files.",
      },
      {
        label: "Publication Records",
        body: "Publication-time records, verification packages, and audit trail support post-publication scrutiny.",
      },
    ],

    comparisonEyebrow: "Why traditional methods fail",
    comparisonTitle: "Shared drives are not newsroom evidence infrastructure.",
    comparisonIntro:
      "Newsrooms run on shared drives, message threads, and last-mile screenshots. PROOVRA replaces the ad-hoc preservation chain with a reviewer-grade evidence layer that exists from intake forward.",
    comparisonRows: [
      {
        traditional: "Source files dropped into a folder",
        proovra: "Structured source-bound evidence records with integrity signals",
      },
      {
        traditional: "Reporter intake over messaging apps",
        proovra: "Controlled intake links bound to a story workspace",
      },
      {
        traditional: "Hashes computed by hand at publication time",
        proovra: "SHA-256 and timestamp context captured at completion",
      },
      {
        traditional: "Editorial review against raw files",
        proovra: "Editorial review against a verification surface",
      },
      {
        traditional: "Post-publication challenge faced from a folder",
        proovra: "Post-publication challenge answered from a verification package",
      },
      {
        traditional: "Source protection vs. recordkeeping trade-off",
        proovra: "Role-based access separates reporter context from review context",
      },
    ],

    operationsEyebrow: "Platform operations",
    operationsTitle: "How newsrooms use PROOVRA every day.",
    operationsIntro:
      "PROOVRA fits the operational shape of an investigative newsroom — source intake, editorial review, fact-checking, legal review, publication, and post-publication challenge.",
    operationsItems: [
      {
        title: "Source material preservation",
        body: "Sources submit through a controlled intake link or reporter capture; each submission becomes a structured source record with integrity signals.",
      },
      {
        title: "Editorial review at desk level",
        body: "Editors open the verification surface to inspect integrity state, custody history, and the structured report alongside the source material.",
      },
      {
        title: "Fact-checking and verification",
        body: "Fact-checkers re-check the integrity state and timing context on the verification surface — and capture their own review trail on the record.",
      },
      {
        title: "Newsroom legal review",
        body: "Newsroom counsel consumes the verification package and audit trail to assess publication risk before the story runs.",
      },
      {
        title: "Publication-time records",
        body: "At publication, the verification package and audit trail are archived as publication records for the story's long-term recordkeeping.",
      },
      {
        title: "Post-publication scrutiny response",
        body: "When a story is challenged, the newsroom answers with a verification package and audit trail — not a folder and a verbal narrative.",
      },
    ],

    governanceEyebrow: "Governance & oversight",
    governanceTitle: "Source protection and recordkeeping together.",
    governanceIntro:
      "Editorial discipline lives at the record level. Retention rules, access controls, audit logs, and source-protection workspace boundaries travel with the source material from intake into post-publication scrutiny.",
    governanceItems: [
      {
        title: "Workspace separation by story",
        body: "Each story has its own workspace with isolated access, retention scope, and governance — source protection by default.",
      },
      {
        title: "Role separation between reporter, editor, fact-check, legal",
        body: "Role-based access permissions separate reporter context, editorial review, fact-checking, and newsroom legal on each story.",
      },
      {
        title: "Retention for editorial recordkeeping",
        body: "Records carry retention rules that govern how long source material is kept and how disposition is handled across story types.",
      },
      {
        title: "Audit logs for editorial scrutiny",
        body: "Submission, upload, report generation, reviewer access, and download events are recorded on every source record and exportable for newsroom governance.",
      },
      {
        title: "Chain of custody across editorial handoff",
        body: "The custody history is part of every source record so it survives editorial, fact-check, and legal review.",
      },
      {
        title: "Controlled sharing for external review",
        body: "Verification packages support controlled sharing with external reviewers without exposing raw source material casually.",
      },
    ],

    visualCaption:
      "Every source record opens onto the verification surface: integrity state, SHA-256 fingerprint, RFC 3161 and OpenTimestamps timing context, custody history, the report, and a shareable verification package — usable by editors, fact-checkers, legal review, and external reviewers without exposing raw source material casually.",

    reportingEyebrow: "Reporting & verification",
    reportingTitle: "What editorial reviewers actually receive.",
    reportingIntro:
      "PROOVRA produces a structured set of reviewer-facing outputs for every source record. Each travels with the source material into editorial review, fact-checking, legal review, and post-publication scrutiny.",
    reportingItems: [
      {
        title: "Verification Page",
        body: "A reviewer-facing surface that exposes the integrity state, SHA-256 fingerprint, timing context, custody history, and supporting verification materials.",
      },
      {
        title: "Verification Package",
        body: "A bundled package of the source record, the report, and supporting verification materials for editorial, legal, and external review.",
      },
      {
        title: "PDF Report",
        body: "A consolidated structured report suitable for editorial review, legal review, and the newsroom's own recordkeeping.",
      },
      {
        title: "Audit Trail Export",
        body: "An exportable audit log of access, generation, and review events on each source record, for editorial governance.",
      },
      {
        title: "Publication-time Archive",
        body: "At publication, the verification package and audit trail are archived as publication records for the story's long-term recordkeeping.",
      },
    ],

    faqEyebrow: "Frequently asked",
    faqTitle: "Questions newsrooms ask.",
    faqIntro:
      "Common questions from investigative reporters, editors, fact-checkers, and newsroom legal evaluating PROOVRA for source-material preservation.",
    faqs: [
      {
        q: "Does PROOVRA say a source is reliable?",
        a: "No. PROOVRA preserves the recorded integrity signals around source material and exposes them to editorial review. Reliability and credibility judgments remain with reporters and editors.",
      },
      {
        q: "Can sources submit material directly?",
        a: "Yes. A story-bound intake link lets sources submit material straight into the newsroom workspace as structured records with integrity signals captured at submission.",
      },
      {
        q: "How does PROOVRA protect source identity?",
        a: "Workspace separation and role-based access permissions separate reporter context from editorial review context. PROOVRA does not assert identity claims about sources.",
      },
      {
        q: "What integrity signals are captured?",
        a: "Each source record carries a SHA-256 hash, RFC 3161 timestamp context, OpenTimestamps anchoring where available, and digital signatures on records and reports.",
      },
      {
        q: "Can external reviewers re-check the source material?",
        a: "Yes. The verification page lets external reviewers re-check the integrity state and timing context independently. The SHA-256 hash and OpenTimestamps anchor remain externally re-checkable.",
      },
      {
        q: "How does PROOVRA help newsroom legal review?",
        a: "Newsroom counsel consumes the verification package and audit trail to assess publication risk — with a structured preservation context instead of a folder and a verbal narrative.",
      },
      {
        q: "Does PROOVRA claim a story is true?",
        a: "No. PROOVRA does not assert truth, authorship, identity, or admissibility about source material. Editorial judgments and standards remain with the newsroom.",
      },
      {
        q: "What happens after publication?",
        a: "At publication, the verification package and audit trail are archived as publication records. If the story is challenged later, the newsroom answers with structured preservation context, not a folder and a memory.",
      },
      {
        q: "How does AI assistance work in editorial review?",
        a: "Any AI assistance inside the workflow is advisory only — it surfaces observations and prompts. It never asserts truth, identity, or admissibility about the source or the story.",
      },
      {
        q: "Can older source material be brought into PROOVRA?",
        a: "Yes. Existing source material can be brought in and preserved as evidence records; integrity signals are captured at the moment of ingestion, with the preservation context surfaced going forward.",
      },
    ],

    ctaTitle: "Preserve source material with structure your newsroom can stand behind.",
    ctaBody:
      "Book a demo to see how source material moves through PROOVRA — from intake to a verification package external reviewers can re-check independently.",
  },

  compliance: {
    slug: "compliance",
    industryImage: "/assets/industries/industry-compliance.png",
    verificationImage: "/assets/verification/audit-verification.png",

    eyebrow: "For Compliance, Audit & Controls",
    headline: "Traceable evidence for",
    headlineHighlight: "audit and regulatory review.",
    subhead:
      "PROOVRA gives internal audit, compliance, controls, and governance teams a structured way to preserve control evidence — captured screens, exports, policy attestations, approvals, attached media — as structured records with integrity signals, custody history, and a reviewer-ready verification surface for internal, external, and regulatory review.",
    proofPoints: [
      "Audit-grade evidence structure",
      "Retention and legal hold by design",
      "Built for cross-functional review",
    ],

    challengesEyebrow: "The problem",
    challengesTitle: "Shared drives store control evidence. They do not survive audit-grade review.",
    challengesNarrative: [
      "Controls evidence usually lives in folders, ticket attachments, and exported screenshots. When internal audit, external audit, or a regulator engages, the preservation posture is uneven, the review trail is reconstructed, and the controls team spends weeks rebuilding what should have been recorded once.",
      "The gap is structural. Folder hierarchies preserve files; they do not preserve the review structure an auditor needs. Ticket attachments capture the evidence; they do not produce a reviewer-facing surface. The work behind the controls is solid; the way the evidence is delivered to audit makes that work harder to explain and review.",
    ],
    challenges: [
      {
        title: "Control evidence on shared drives",
        body: "Captured screens, system exports, and attestations land in folders without SHA-256 fingerprints or independent timing anchors auditors can later re-check.",
      },
      {
        title: "Policy evidence captured as screenshots",
        body: "Policy attestations and approvals live as screenshots in ticket attachments — without a verification surface auditors can consume.",
      },
      {
        title: "Audit-readiness cycle each quarter",
        body: "Controls teams spend weeks rebuilding the evidence package each audit cycle, instead of recording the preservation context once at intake.",
      },
      {
        title: "Regulatory review starts from a folder",
        body: "Regulators receive zip bundles and a verbal narrative instead of a structured verification package they can re-check.",
      },
      {
        title: "Retention managed ad-hoc",
        body: "Retention rules live in policy documents but not on the records themselves — disposition is reconstructed from memory at audit time.",
      },
      {
        title: "Evidence requests cross many teams",
        body: "Audit requests cross controls, IT, legal, and operations — each holds a different shape of the same evidence, with no shared review surface.",
      },
    ],

    workflowEyebrow: "How PROOVRA fits the workflow",
    workflowTitle: "Control capture to external audit, on one verification layer.",
    workflowNarrative: [
      "Captured screens, system exports, attestations, and attached media become structured evidence records bound to the control they support — not loose files in a folder. Each record locks in its integrity signals and timing context at the moment of completion, so the preservation posture is visible to every reviewer the control eventually reaches.",
      "Internal audit, external audit, regulators, legal review, and partner audit work from the same verification surface. When external review engages, the same record carries its context with it — no rebuild, no audit-prep cycle, no folders standing in for evidence handling.",
      "Under the hood, every control record carries SHA-256 integrity signals, timing context with RFC 3161 and OpenTimestamps third-party anchoring where available, and a structured custody history. Retention rules, access controls, and legal hold settings travel with the record so internal audit, external audit, and regulators read the same governance posture controls owners do.",
    ],
    lifecycle: [
      {
        label: "Control Capture",
        body: "Captured screens, system exports, and policy attestations enter PROOVRA as structured control-evidence records.",
      },
      {
        label: "Evidence Records",
        body: "Each control record is bound to the control it supports — visible to controls owners and audit.",
      },
      {
        label: "Verification",
        body: "SHA-256 hash, RFC 3161 timestamp, and OpenTimestamps anchoring travel with the record into review.",
      },
      {
        label: "Internal Review",
        body: "Controls owners, internal audit, and compliance read the same verification surface across the program.",
      },
      {
        label: "External Audit",
        body: "External auditors and regulators consume a verification package with the integrity signals attached.",
      },
      {
        label: "Governance",
        body: "Retention rules, access controls, legal hold, and audit logs support governance and program discipline.",
      },
    ],

    comparisonEyebrow: "Why traditional methods fail",
    comparisonTitle: "Audit folders do not survive review-grade scrutiny.",
    comparisonIntro:
      "Compliance and audit teams run on shared drives, ticket attachments, and quarterly audit-prep cycles. PROOVRA replaces that cycle with an audit-grade evidence layer that exists from intake forward.",
    comparisonRows: [
      {
        traditional: "Control screenshots in ticket attachments",
        proovra: "Structured control-evidence records with integrity signals",
      },
      {
        traditional: "Policy attestations on shared drives",
        proovra: "Attestations as evidence records with SHA-256 and timestamps",
      },
      {
        traditional: "Audit-prep rebuild every quarter",
        proovra: "Verification surface ready continuously — no audit-prep cycle",
      },
      {
        traditional: "Regulators handed a zip and a verbal narrative",
        proovra: "Regulators receive a verification package they can re-check",
      },
      {
        traditional: "Retention rules in a policy document",
        proovra: "Retention rules attached to every record at intake",
      },
      {
        traditional: "Custody history reconstructed at audit time",
        proovra: "Chain of custody on every record from the start",
      },
    ],

    operationsEyebrow: "Platform operations",
    operationsTitle: "How compliance teams use PROOVRA every day.",
    operationsIntro:
      "PROOVRA fits the operational shape of compliance and audit programs — control capture, evidence requests, internal review, external audit, regulatory review.",
    operationsItems: [
      {
        title: "Audit readiness for ISO and SOX-style programs",
        body: "Controls owners run ISO-aligned and SOX-style controls on PROOVRA, with evidence records ready for internal and external audit at any time.",
      },
      {
        title: "Regulatory review and inquiry",
        body: "When a regulator engages, the program produces a verification package and audit trail — instead of rebuilding the response from folders and trackers.",
      },
      {
        title: "Evidence requests across teams",
        body: "Audit, controls, IT, legal, and operations work from the same verification surface — no separate copies of the evidence held in each function.",
      },
      {
        title: "Policy verification at attestation time",
        body: "Policy attestations and approvals become structured records with integrity signals captured at the moment of attestation.",
      },
      {
        title: "Continuous controls monitoring evidence",
        body: "Outputs from continuous monitoring become evidence records on the control they support, with timing context and a re-checkable integrity signal.",
      },
      {
        title: "Cross-functional review",
        body: "Internal audit, controls owners, legal review, and program governance read the same verification surface — without recreating evidence per stakeholder.",
      },
    ],

    governanceEyebrow: "Governance & oversight",
    governanceTitle: "Audit-grade governance attached to every control record.",
    governanceIntro:
      "Compliance discipline lives at the record level. Retention rules, legal hold, access controls, and audit trail travel with the control evidence into internal audit, external audit, and regulatory review.",
    governanceItems: [
      {
        title: "Retention policies per control program",
        body: "Records carry retention rules that govern how long control evidence is kept and how disposition is handled across programs and control families.",
      },
      {
        title: "Legal hold for matters and investigations",
        body: "Records can be placed on legal hold during litigation, regulatory matters, or active investigations — suspending retention rules for the duration.",
      },
      {
        title: "Access controls and role separation",
        body: "Workspace-scoped role-based permissions separate controls owners, internal audit, legal review, and external auditors on each program.",
      },
      {
        title: "Audit logs across the program",
        body: "Submission, upload, report generation, reviewer access, and download events are recorded on every record and exportable for governance.",
      },
      {
        title: "Chain of custody on control evidence",
        body: "The custody history is part of every control-evidence record so it survives internal audit, external audit, and regulatory handoff.",
      },
      {
        title: "Program workspaces for separation of duties",
        body: "Each program — ISO, SOX-style, privacy, security — has its own workspace with isolated access, retention scope, and governance.",
      },
    ],

    visualCaption:
      "Every control evidence record opens onto the verification surface: integrity state, SHA-256 fingerprint, RFC 3161 and OpenTimestamps timing context, custody history, the report, and a shareable verification package — usable by internal audit, external audit, and regulators without rebuilding the package.",

    reportingEyebrow: "Reporting & verification",
    reportingTitle: "What auditors actually receive.",
    reportingIntro:
      "PROOVRA produces a structured set of reviewer-facing outputs for every control record. Each travels with the control into internal audit, external audit, and regulatory review.",
    reportingItems: [
      {
        title: "Verification Page",
        body: "A reviewer-facing surface that exposes the integrity state, SHA-256 fingerprint, timing context, custody history, and supporting verification materials.",
      },
      {
        title: "Verification Package",
        body: "A bundled package of the control record, the report, and supporting verification materials for external audit and regulatory review.",
      },
      {
        title: "PDF Report",
        body: "A consolidated structured report suitable for audit response, regulatory review, and senior leadership briefing.",
      },
      {
        title: "Audit Trail Export",
        body: "An exportable audit log of access, generation, and review events on each control record, for governance and external audit.",
      },
      {
        title: "Governance Attachment",
        body: "Retention rules, legal hold status, and control-level governance context attached to every record produced.",
      },
    ],

    faqEyebrow: "Frequently asked",
    faqTitle: "Questions compliance and audit teams ask.",
    faqIntro:
      "Common questions from internal audit, controls owners, and compliance officers evaluating PROOVRA for control evidence handling.",
    faqs: [
      {
        q: "Does PROOVRA make us compliant with a specific regulation?",
        a: "No. PROOVRA gives compliance and audit teams a structured evidence layer for the controls they run. Compliance with any specific regulation depends on the program design and execution, not on PROOVRA alone.",
      },
      {
        q: "Can we use PROOVRA for ISO-aligned and SOX-style programs?",
        a: "Yes. Controls owners run ISO-aligned and SOX-style controls on PROOVRA, with evidence records ready for internal and external audit at any time.",
      },
      {
        q: "How does PROOVRA support regulatory review?",
        a: "When a regulator engages, the program produces a verification package and audit trail — instead of rebuilding the response from folders and trackers.",
      },
      {
        q: "What integrity signals are captured?",
        a: "Each control record carries a SHA-256 hash, RFC 3161 timestamp context, OpenTimestamps anchoring where available, and digital signatures on records and reports.",
      },
      {
        q: "How does legal hold work for compliance matters?",
        a: "Records can be placed on legal hold during litigation, regulatory matters, or active investigations — suspending retention rules for the duration.",
      },
      {
        q: "Can external auditors re-check the evidence?",
        a: "Yes. The verification page lets external auditors re-check the integrity state and timing context independently. The SHA-256 hash and OpenTimestamps anchor remain externally re-checkable.",
      },
      {
        q: "How is retention handled across control programs?",
        a: "Workspaces isolate evidence by program. Retention rules attached to each record govern how long control evidence is kept and how disposition is handled.",
      },
      {
        q: "Does PROOVRA replace our GRC platform?",
        a: "No. PROOVRA sits alongside GRC — it handles the verification, integrity, and custody layer for control evidence that needs to stand up under audit-grade review.",
      },
      {
        q: "Can controls owners run continuous controls monitoring?",
        a: "Yes. Outputs from continuous monitoring become evidence records on the control they support, with timing context and a re-checkable integrity signal.",
      },
      {
        q: "Does AI judge whether a control passes?",
        a: "No. Any AI assistance inside the workflow is advisory only — it surfaces observations and prompts to controls owners and audit. Control conclusions remain with the program.",
      },
    ],

    ctaTitle: "Replace audit-prep cycles with a verification surface auditors can re-check.",
    ctaBody:
      "Book a demo to see how a real control moves through PROOVRA — from capture to a verification package external audit and regulators can re-check independently.",
  },

  government: {
    slug: "government",
    industryImage: "/assets/industries/industry-government.png",
    verificationImage: "/assets/verification/goverment-verification.png",

    eyebrow: "For Public Sector & Agencies",
    headline: "Public-sector recordkeeping with",
    headlineHighlight: "oversight built in.",
    subhead:
      "PROOVRA gives public-sector agencies, inspectors, frontline officers, transparency offices, and audit offices a structured way to intake citizen submissions and field captures — photos, videos, captured screens, incident records — preserve them as structured evidence records with integrity signals, custody history, and retention context, and route them through inspection, oversight, audit, and transparency review.",
    proofPoints: [
      "Citizen and field intake with integrity",
      "Retention and transparency built in",
      "Oversight, audit, and public-records ready",
    ],

    challengesEyebrow: "The problem",
    challengesTitle: "Public records cannot live on shared drives.",
    challengesNarrative: [
      "Public-sector evidence — citizen reports, inspection records, incident documentation, field captures — flows through portals, email, ticketing, and shared drives that were never built to carry preservation context. The file survives. The structure around it does not. When oversight, audit, freedom-of-information, or transparency review engages, the preservation posture is uneven and the recordkeeping cannot answer the questions it is asked.",
      "Frontline officers, inspectors, and case workers do careful work. The systems they hand evidence to do not preserve that care. Citizen and contractor submissions add another layer — they arrive through portals that capture the file and a form field, not a structured evidence record. They land in folders that supervisors and oversight reviewers eventually have to answer for at review time.",
    ],
    challenges: [
      {
        title: "Citizen submissions through ad-hoc portals",
        body: "Citizens submit photos, videos, and reports through intake portals that capture the file and a form field — without structured evidence records or integrity signals.",
      },
      {
        title: "Inspection records on shared drives",
        body: "Inspector captures land on shared drives without SHA-256 fingerprints, timing anchors, or custody history a later reviewer can re-check.",
      },
      {
        title: "Incident documentation across teams",
        body: "Incident evidence moves across frontline, supervisor, and oversight teams — each holding a different shape of the same evidence.",
      },
      {
        title: "Field evidence collection without preservation",
        body: "Frontline officers and inspectors capture evidence in the field but lack a structured submission path that preserves integrity context at intake.",
      },
      {
        title: "Transparency requests rebuilt from folders",
        body: "When freedom-of-information or transparency review engages, agencies reconstruct the response from folders, trackers, and verbal narratives.",
      },
      {
        title: "Public-records retention managed ad-hoc",
        body: "Retention rules live in policy documents but not on the records themselves — disposition is reconstructed from memory at audit time.",
      },
      {
        title: "Audit office and oversight reviewing raw files",
        body: "Audit offices and oversight reviewers receive zip bundles and verbal narratives instead of structured verification packages they can re-check.",
      },
      {
        title: "Public accountability needs more than storage",
        body: "Public accountability obligations demand recordkeeping that survives external scrutiny — not just storage of the underlying file.",
      },
    ],

    workflowEyebrow: "How PROOVRA fits the workflow",
    workflowTitle: "Citizen submission to oversight review, on one verification layer.",
    workflowNarrative: [
      "Citizen-portal uploads, inspector field captures, and frontline submissions become structured evidence records bound to the case or matter — not attachments on a ticket. Each record locks in its integrity signals, timing context, custody history, and the retention rules that govern it, so the preservation posture is visible to every reviewer the record eventually reaches.",
      "Inspectors, case officers, supervisors, oversight reviewers, audit offices, and transparency review work from the same verification surface. When oversight engages, the same record carries its context with it — no rebuild, no recordkeeping reconstruction, no folders standing in for evidence handling.",
      "Under the hood, every public-sector record carries SHA-256 integrity signals, timing context with RFC 3161 and OpenTimestamps third-party anchoring where available, and a structured custody history. Agencies can stand up controlled intake links so citizens, inspectors, and field officers submit straight into the verification workflow — with retention rules and audit-trail context attached so oversight, audit, and freedom-of-information review consume one structured posture.",
    ],
    lifecycle: [
      {
        label: "Citizen Submission",
        body: "Citizens, contractors, and reporters submit through a controlled intake link into an agency workspace.",
      },
      {
        label: "Field Intake",
        body: "Inspectors and frontline officers capture field evidence into a case-bound workspace as structured records.",
      },
      {
        label: "Records",
        body: "Each submission becomes a structured public-sector record with retention rules and integrity signals at completion.",
      },
      {
        label: "Verification",
        body: "SHA-256 hash, RFC 3161 timestamp, and OpenTimestamps anchoring travel with the record through review.",
      },
      {
        label: "Oversight Review",
        body: "Supervisors, oversight reviewers, audit offices, and transparency review work from one verification surface.",
      },
      {
        label: "Public Records",
        body: "Verification packages support audit response, freedom-of-information disclosure, and public records retention.",
      },
    ],

    comparisonEyebrow: "Why traditional methods fail",
    comparisonTitle: "Citizen portals and shared drives are not public-records infrastructure.",
    comparisonIntro:
      "Public-sector teams run on intake portals, shared drives, and ticketing. PROOVRA replaces the ad-hoc preservation chain with a structured recordkeeping layer that exists from citizen submission and field intake forward.",
    comparisonRows: [
      {
        traditional: "Citizen portal captures the file and a form field",
        proovra: "Citizen submission becomes a structured evidence record",
      },
      {
        traditional: "Inspector field captures land on shared drives",
        proovra: "Field captures become records with SHA-256 and timestamps",
      },
      {
        traditional: "Incident evidence held separately by each team",
        proovra: "One record shared by frontline, supervisor, and oversight",
      },
      {
        traditional: "Transparency requests rebuilt from folders",
        proovra: "Transparency responses produced from verification packages",
      },
      {
        traditional: "Retention rules in a policy document",
        proovra: "Retention rules attached to every record at intake",
      },
      {
        traditional: "Audit office and oversight handed zip bundles",
        proovra: "Audit and oversight receive verification packages they re-check",
      },
      {
        traditional: "Public accountability answered from memory",
        proovra: "Public accountability answered from structured records",
      },
    ],

    operationsEyebrow: "Platform operations",
    operationsTitle: "How public-sector teams use PROOVRA every day.",
    operationsIntro:
      "PROOVRA fits the operational shape of public-sector work — citizen submission, inspection, incident response, oversight review, audit, transparency. The platform supports frontline workflows without forcing agencies to rebuild around it.",
    operationsItems: [
      {
        title: "Citizen submissions and public complaints",
        body: "Controlled intake links give citizens and contractors a structured submission path; each submission becomes a structured evidence record with integrity signals.",
      },
      {
        title: "Inspections and field evidence collection",
        body: "Inspectors and frontline officers capture field evidence into a case-bound workspace — with timing context and a re-checkable integrity signal attached.",
      },
      {
        title: "Incident documentation and response",
        body: "Incident records combine citizen submissions, field captures, and supervisor review into one verification surface — no separate copies per team.",
      },
      {
        title: "Public records and freedom-of-information",
        body: "When freedom-of-information or transparency review engages, the agency produces a verification package — instead of rebuilding the response from folders.",
      },
      {
        title: "Oversight and audit office review",
        body: "Oversight reviewers and audit offices consume the same verification surface frontline teams use — without rebuilding the package at handoff.",
      },
      {
        title: "Regulatory enforcement and inspections",
        body: "Inspections that lead to regulatory enforcement carry their evidence records with integrity signals into the enforcement workflow.",
      },
      {
        title: "Contractor and partner organization submissions",
        body: "Contractor and partner organizations submit through agency-bound intake links — with the same structured record shape as citizen and field intake.",
      },
      {
        title: "Transparency and public-accountability response",
        body: "Public-accountability obligations answered from structured records and verification packages — not from folders and verbal narratives.",
      },
    ],

    governanceEyebrow: "Governance & oversight",
    governanceTitle: "Public-sector governance attached to every record.",
    governanceIntro:
      "Public-sector discipline lives at the record level. Retention rules, legal hold, access controls, and audit trail travel with the record into inspection, oversight, audit, freedom-of-information, and transparency review.",
    governanceItems: [
      {
        title: "Retention policies for public records",
        body: "Records carry retention rules that govern how long public evidence is kept and how disposition is handled across record types and statutes.",
      },
      {
        title: "Legal hold for matters and enforcement",
        body: "Records can be placed on legal hold during enforcement actions, litigation, or active investigations — suspending retention rules for the duration.",
      },
      {
        title: "Access controls and role separation",
        body: "Workspace-scoped role-based permissions separate frontline officers, supervisors, oversight reviewers, audit offices, and transparency review.",
      },
      {
        title: "Audit logs for transparency and oversight",
        body: "Submission, upload, report generation, reviewer access, and download events are recorded on every record — exportable for oversight and audit.",
      },
      {
        title: "Chain of custody on public-sector evidence",
        body: "The custody history is part of every public-sector record so it survives inspection, oversight, audit, and transparency review.",
      },
      {
        title: "Workspace separation by agency, program, or matter",
        body: "Workspaces isolate evidence by agency, program, or matter — with separate access lists, retention scopes, and governance.",
      },
      {
        title: "Freedom-of-information and public-records support",
        body: "Records carry the metadata and retention context needed to support freedom-of-information responses and public-records review.",
      },
    ],

    visualCaption:
      "Every public-sector record opens onto the verification surface: integrity state, SHA-256 fingerprint, RFC 3161 and OpenTimestamps timing context, custody history, retention rules, the report, and a shareable verification package — usable across frontline operations, oversight, audit, and transparency review.",

    reportingEyebrow: "Reporting & verification",
    reportingTitle: "What oversight reviewers actually receive.",
    reportingIntro:
      "PROOVRA produces a structured set of reviewer-facing outputs for every public-sector record. Each travels with the record into oversight, audit, freedom-of-information, and transparency review.",
    reportingItems: [
      {
        title: "Verification Page",
        body: "A reviewer-facing surface that exposes the integrity state, SHA-256 fingerprint, timing context, custody history, retention context, and supporting verification materials.",
      },
      {
        title: "Verification Package",
        body: "A bundled package of the record, the report, and supporting verification materials for oversight, audit, and external review.",
      },
      {
        title: "PDF Report",
        body: "A consolidated structured report suitable for oversight response, audit, freedom-of-information disclosure, and public-records review.",
      },
      {
        title: "Audit Trail Export",
        body: "An exportable audit log of access, generation, and review events on each record, for oversight and audit offices.",
      },
      {
        title: "Public-Records Archive",
        body: "The verification package and audit trail support public-records retention and long-term recordkeeping obligations.",
      },
    ],

    faqEyebrow: "Frequently asked",
    faqTitle: "Questions public-sector teams ask.",
    faqIntro:
      "Common questions from agencies, inspectors, oversight offices, and transparency teams evaluating PROOVRA for public-sector evidence handling.",
    faqs: [
      {
        q: "Is PROOVRA certified by a government body?",
        a: "PROOVRA does not claim government certification or official admissibility. It is an evidence integrity, verification, and governance platform that supports public-sector recordkeeping with structured records, integrity signals, and oversight-ready verification packages.",
      },
      {
        q: "Can citizens submit evidence directly to the agency?",
        a: "Yes. A controlled intake link lets citizens, contractors, and reporters submit material straight into the agency workspace as structured records with integrity signals captured at submission.",
      },
      {
        q: "How are inspections and field captures handled?",
        a: "Inspectors and frontline officers capture field evidence into a case-bound workspace. Each capture becomes a structured public-sector record with timing context and a re-checkable integrity signal.",
      },
      {
        q: "What integrity signals are captured?",
        a: "Each public-sector record carries a SHA-256 hash, RFC 3161 timestamp context, OpenTimestamps anchoring where available, and digital signatures on records and reports.",
      },
      {
        q: "Does PROOVRA support freedom-of-information responses?",
        a: "Yes. When freedom-of-information or transparency review engages, the agency produces a verification package and audit trail — instead of rebuilding the response from folders.",
      },
      {
        q: "How does PROOVRA help with public accountability?",
        a: "Public-accountability obligations are answered from structured records and verification packages, not from folders and verbal narratives. The verification surface lets oversight re-check the integrity signals independently.",
      },
      {
        q: "How is retention handled across record types?",
        a: "Workspaces isolate evidence by agency, program, or matter. Retention rules attached to each record govern how long public evidence is kept and how disposition is handled across statutes.",
      },
      {
        q: "Can oversight offices re-check the evidence independently?",
        a: "Yes. The verification page lets oversight and audit offices re-check the integrity state and timing context independently. The SHA-256 hash and OpenTimestamps anchor remain externally re-checkable.",
      },
      {
        q: "How does legal hold work for enforcement actions?",
        a: "Records can be placed on legal hold during enforcement actions, litigation, or active investigations — suspending retention rules for the duration of the matter.",
      },
      {
        q: "Does AI judge whether a citizen submission is true?",
        a: "No. Any AI assistance inside the workflow is advisory only — it surfaces observations and prompts to inspectors and reviewers. Decisions about substance remain with the agency.",
      },
    ],

    ctaTitle: "Public-sector recordkeeping with oversight built into every record.",
    ctaBody:
      "Book a demo to see how citizen submissions and field captures move through PROOVRA — from intake to a verification package oversight and transparency review can re-check independently.",
  },
};
