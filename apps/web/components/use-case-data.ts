export type UseCaseSectionCard = {
  eyebrow: string;
  title: string;
  body: string;
};

export type UseCasePageContent = {
  slug: string;
  eyebrow: string;
  title: string;
  highlight: string;
  description: string;
  heroBullets: string[];

  challengeTitle: string;
  challengeBody: string;

  workflowTitle: string;
  workflowBody: string;
  workflowSteps: UseCaseSectionCard[];

  inspectTitle: string;
  inspectBody: string;
  inspectCards: UseCaseSectionCard[];

  outputTitle: string;
  outputBody: string;
  outputCards: UseCaseSectionCard[];

  betterTitle: string;
  betterBody: string;
  betterCards: UseCaseSectionCard[];

  closingTitle: string;
  closingBody: string;
};

export const USE_CASES: Record<string, UseCasePageContent> = {
  lawyers: {
    slug: "lawyers",
    eyebrow: "For Legal Teams",
    title: "Stronger evidence handling for",
    highlight: "legal review and disputes.",
    description:
      "PROOVRA helps legal professionals preserve digital material as a review-ready evidence record with integrity context, timestamp visibility, custody history, and structured verification output.",
    heroBullets: [
      "Verification-first workflow",
      "Structured review trail",
      "Built for disputed material",
    ],

    challengeTitle: "Why legal teams need more than ordinary files",
    challengeBody:
      "Screenshots, attachments, and forwarded files are often easy to question later. Legal review needs clearer preservation context, stronger integrity visibility, and a structured way to present what was recorded and how it was handled.",

    workflowTitle: "How legal teams use PROOVRA",
    workflowBody:
      "Collect, preserve, review, and present digital material with a cleaner verification workflow instead of relying only on disconnected files or screenshots.",
    workflowSteps: [
      {
        eyebrow: "Collect",
        title: "Create a structured evidence record",
        body: "Upload or capture the relevant material and preserve it as a dedicated evidence record rather than treating it as a loose file.",
      },
      {
        eyebrow: "Preserve",
        title: "Record integrity and timing context",
        body: "Preserve the evidence state, timestamp information, and supporting metadata so later review can inspect what existed at completion.",
      },
      {
        eyebrow: "Review",
        title: "Inspect through a verification workflow",
        body: "Legal reviewers can inspect the summary, review trail, report, and technical materials without relying only on narrative explanation.",
      },
      {
        eyebrow: "Present",
        title: "Share a clearer report package",
        body: "Use the verification page and report output to support review, briefing, escalation, and dispute handling.",
      },
    ],

    inspectTitle: "What legal reviewers can inspect",
    inspectBody:
      "The system is designed to make later scrutiny easier by exposing a cleaner verification layer around the material.",
    inspectCards: [
      {
        eyebrow: "Integrity",
        title: "Recorded integrity state",
        body: "Inspect whether the evidence record still matches the recorded completion state and whether later mismatch was detected.",
      },
      {
        eyebrow: "Custody",
        title: "Review trail",
        body: "See key lifecycle events around creation, upload completion, reporting, and later review-related actions.",
      },
      {
        eyebrow: "Timing",
        title: "Timestamp visibility",
        body: "Review timestamp-related status and supporting timing context where available.",
      },
    ],

    outputTitle: "What the system produces",
    outputBody:
      "The product stays focused on review readiness rather than raw storage alone.",
    outputCards: [
      {
        eyebrow: "Verification",
        title: "Public or controlled verification view",
        body: "A dedicated verification page helps external or internal reviewers inspect the evidence state more clearly.",
      },
      {
        eyebrow: "Report",
        title: "Structured PDF report",
        body: "A generated report helps package the evidence record, review trail, and supporting verification materials.",
      },
      {
        eyebrow: "Technical",
        title: "Technical materials for experts",
        body: "Hashes, signatures, and related materials can remain available for deeper technical or forensic review.",
      },
    ],

    betterTitle: "Why this is better than ordinary screenshots or loose files",
    betterBody:
      "Ordinary files are easy to circulate but often weak under later challenge. PROOVRA adds a verification-first layer that keeps the evidence record easier to inspect and harder to dismiss casually.",
    betterCards: [
      {
        eyebrow: "Reviewability",
        title: "More defensible review flow",
        body: "Instead of presenting only the file itself, you present the file together with its recorded integrity and review context.",
      },
      {
        eyebrow: "Clarity",
        title: "Cleaner reviewer experience",
        body: "Verification output is easier to read than asking reviewers to interpret a raw file without surrounding context.",
      },
      {
        eyebrow: "Dispute resistance",
        title: "Stronger under challenge",
        body: "The platform supports later scrutiny better than ordinary screenshots that lack preservation and verification context.",
      },
    ],

    closingTitle: "Built for counsel, case review, and dispute-sensitive workflows",
    closingBody:
      "Use PROOVRA when digital material may later need structured review, internal escalation, or legal scrutiny.",
  },

  insurance: {
    slug: "insurance",
    eyebrow: "For Insurance & Claims",
    title: "Reduce disputed submissions with",
    highlight: "review-ready evidence records.",
    description:
      "PROOVRA helps insurance, claims, and risk teams preserve submitted digital material with clearer integrity context, review trail visibility, and report output for later assessment.",
    heroBullets: [
      "Claims review support",
      "Tamper detection context",
      "Better than plain uploads",
    ],

    challengeTitle: "Why claims teams need stronger evidence handling",
    challengeBody:
      "Claims teams often receive files that are easy to forward but difficult to assess later. Ordinary uploads can lack preservation context, timestamp visibility, and a defensible review trail when a submission becomes disputed.",

    workflowTitle: "How insurance and risk teams use PROOVRA",
    workflowBody:
      "Preserve submitted material in a way that supports later review, escalation, and challenge handling.",
    workflowSteps: [
      {
        eyebrow: "Intake",
        title: "Receive and structure the submission",
        body: "Convert uploaded material into a dedicated evidence record tied to a clearer verification workflow.",
      },
      {
        eyebrow: "Preserve",
        title: "Record integrity and timing state",
        body: "Preserve the recorded state of the submission with timing and supporting verification context.",
      },
      {
        eyebrow: "Assess",
        title: "Review with better context",
        body: "Claims reviewers can inspect what was preserved, what the report shows, and whether the record stayed consistent after completion.",
      },
      {
        eyebrow: "Escalate",
        title: "Support later challenge review",
        body: "Use the report and verification page when disputes, fraud concerns, or secondary review arise.",
      },
    ],

    inspectTitle: "What reviewers can inspect",
    inspectBody:
      "PROOVRA is designed to help claims and risk teams review evidence with more structure and less ambiguity.",
    inspectCards: [
      {
        eyebrow: "Integrity",
        title: "Post-submission mismatch visibility",
        body: "Inspect whether the preserved evidence state still matches the recorded completion state.",
      },
      {
        eyebrow: "Trail",
        title: "Reviewable handling history",
        body: "See a clearer sequence of important evidence events instead of relying on scattered operational notes.",
      },
      {
        eyebrow: "Report",
        title: "Claim review support output",
        body: "Use the verification page and report as supporting review material when a claim becomes sensitive or disputed.",
      },
    ],

    outputTitle: "What the system produces",
    outputBody:
      "The output is designed to support operational review, not just file storage.",
    outputCards: [
      {
        eyebrow: "Verification",
        title: "Verification page",
        body: "A dedicated review surface for integrity state, evidence summary, and preserved materials.",
      },
      {
        eyebrow: "PDF",
        title: "Structured report",
        body: "A report that can travel internally with the claim or be reviewed by stakeholders later.",
      },
      {
        eyebrow: "Support",
        title: "Technical review materials",
        body: "Optional deeper materials remain available for expert, fraud, or escalation review.",
      },
    ],

    betterTitle: "Why this is better than ordinary file intake",
    betterBody:
      "Ordinary intake systems may store files but still leave the review process weak. PROOVRA adds preservation, verification, and review-readiness so later disputes are easier to manage.",
    betterCards: [
      {
        eyebrow: "Fraud resistance",
        title: "Better challenge handling",
        body: "Stronger integrity context helps teams respond more clearly when submissions are questioned.",
      },
      {
        eyebrow: "Operational clarity",
        title: "Cleaner internal review",
        body: "Claims teams get a more structured way to inspect material and share it internally.",
      },
      {
        eyebrow: "Escalation readiness",
        title: "Useful beyond first-line review",
        body: "The same evidence record can support supervisors, investigators, or legal teams later.",
      },
    ],

    closingTitle: "Built for claims scrutiny, fraud review, and risk-sensitive workflows",
    closingBody:
      "Use PROOVRA when digital evidence may need to stand up to later challenge, not just initial intake.",
  },

  investigations: {
    slug: "investigations",
    eyebrow: "For Investigations",
    title: "Preserve digital material with a",
    highlight: "clearer investigative review trail.",
    description:
      "PROOVRA helps investigation teams preserve evidence records, review integrity state, and maintain a cleaner trail for later case handling, escalation, and internal scrutiny.",
    heroBullets: [
      "Case-ready structure",
      "Review-sensitive workflow",
      "Better custody visibility",
    ],

    challengeTitle: "Why investigation workflows need structure",
    challengeBody:
      "Investigative material often changes hands, moves across teams, and becomes sensitive later. Plain files alone rarely provide enough review context, preservation detail, or structured output for serious follow-up.",

    workflowTitle: "How investigation teams use PROOVRA",
    workflowBody:
      "Move from raw collection to preservation, review, and escalation using one evidence-oriented workflow.",
    workflowSteps: [
      {
        eyebrow: "Collect",
        title: "Create the case record",
        body: "Capture or upload material into a dedicated evidence record rather than leaving it as a disconnected file.",
      },
      {
        eyebrow: "Preserve",
        title: "Record integrity and supporting state",
        body: "Preserve what was recorded at completion so later reviewers can inspect whether the evidence state stayed consistent.",
      },
      {
        eyebrow: "Review",
        title: "Inspect the review trail",
        body: "Reviewers can inspect custody-related events, verification details, and supporting materials inside one workflow.",
      },
      {
        eyebrow: "Escalate",
        title: "Support internal or external review",
        body: "The same evidence record can support management, legal, compliance, or specialist investigative review later.",
      },
    ],

    inspectTitle: "What investigators and reviewers can inspect",
    inspectBody:
      "The goal is a clearer investigation workflow, not just another upload screen.",
    inspectCards: [
      {
        eyebrow: "State",
        title: "Integrity summary",
        body: "Inspect whether the evidence record still matches the recorded state captured at completion.",
      },
      {
        eyebrow: "History",
        title: "Chain of custody context",
        body: "See a clearer sequence of important record events relevant to later review.",
      },
      {
        eyebrow: "Support",
        title: "Technical and report output",
        body: "Use technical materials and structured reports when a deeper review is required.",
      },
    ],

    outputTitle: "What the system produces",
    outputBody:
      "PROOVRA supports investigative workflows with structured outputs that travel better than raw files alone.",
    outputCards: [
      {
        eyebrow: "Case review",
        title: "Verification page",
        body: "A reviewer-facing page for integrity state, evidence summary, and supporting inspection.",
      },
      {
        eyebrow: "Documentation",
        title: "Structured report",
        body: "A report format that supports case discussion, internal escalation, and audit-style review.",
      },
      {
        eyebrow: "Deep review",
        title: "Technical materials",
        body: "Detailed materials stay available when more advanced technical review becomes necessary.",
      },
    ],

    betterTitle: "Why this is better than folders, screenshots, and ad hoc file sharing",
    betterBody:
      "Investigations often suffer when evidence handling is fragmented. PROOVRA gives teams one review-ready structure that is easier to preserve, inspect, and escalate.",
    betterCards: [
      {
        eyebrow: "Consistency",
        title: "One workflow across the case",
        body: "Preserve evidence in a consistent format instead of mixing screenshots, notes, and scattered uploads.",
      },
      {
        eyebrow: "Traceability",
        title: "Clearer review trail",
        body: "Important events remain visible in a more structured way for later investigators and reviewers.",
      },
      {
        eyebrow: "Escalation",
        title: "Built for sensitive follow-up",
        body: "The same record can support internal review, legal follow-up, or external scrutiny later.",
      },
    ],

    closingTitle: "Built for incident review, internal investigations, and sensitive case handling",
    closingBody:
      "Use PROOVRA when evidence handling needs to stay organized, inspectable, and stronger under later scrutiny.",
  },

  journalism: {
    slug: "journalism",
    eyebrow: "For Journalism",
    title: "Preserve source material with",
    highlight: "later-verifiable integrity context.",
    description:
      "PROOVRA helps journalists and editorial teams preserve digital source material as a structured evidence record with integrity visibility, timestamp context, and review-ready verification output.",
    heroBullets: [
      "Source material preservation",
      "Verification-first review",
      "Editorial scrutiny support",
    ],

    challengeTitle: "Why source material needs stronger preservation",
    challengeBody:
      "In journalism, source files may later be challenged, re-examined, or reviewed internally. Ordinary files and screenshots do not always carry enough context to support careful editorial or external scrutiny.",

    workflowTitle: "How journalism teams use PROOVRA",
    workflowBody:
      "Preserve source material, keep later review possible, and support editorial confidence without turning the workflow into a technical burden.",
    workflowSteps: [
      {
        eyebrow: "Preserve",
        title: "Create a source evidence record",
        body: "Store source material as a structured evidence record instead of relying only on file copies and message history.",
      },
      {
        eyebrow: "Record",
        title: "Preserve integrity and timing context",
        body: "Keep the recorded evidence state, timing context, and related verification materials available for later review.",
      },
      {
        eyebrow: "Review",
        title: "Support editorial scrutiny",
        body: "Editors and reviewers can inspect the evidence summary, review trail, and report rather than depending only on trust or memory.",
      },
      {
        eyebrow: "Share carefully",
        title: "Use controlled verification output",
        body: "Share a report or verification view when internal or external review requires clearer preservation context.",
      },
    ],

    inspectTitle: "What editors and reviewers can inspect",
    inspectBody:
      "The system helps source material remain reviewable without making the first layer overly technical.",
    inspectCards: [
      {
        eyebrow: "Integrity",
        title: "Recorded integrity status",
        body: "Inspect whether the preserved source record still matches the recorded completion state.",
      },
      {
        eyebrow: "Timing",
        title: "Timestamp-related context",
        body: "Review timing information and timestamp status where available.",
      },
      {
        eyebrow: "Review",
        title: "Human-readable verification output",
        body: "Use a verification page and report to support editorial or later external scrutiny.",
      },
    ],

    outputTitle: "What the system produces",
    outputBody:
      "PROOVRA supports journalists with verification outputs that are easier to review than raw files alone.",
    outputCards: [
      {
        eyebrow: "Verification",
        title: "Verification page",
        body: "A dedicated page for checking the evidence state and preserved review materials.",
      },
      {
        eyebrow: "Report",
        title: "Structured report output",
        body: "A report format that supports internal editorial review and recordkeeping.",
      },
      {
        eyebrow: "Technical",
        title: "Technical materials",
        body: "More technical materials remain available for specialist verification or deeper inspection.",
      },
    ],

    betterTitle: "Why this is better than storing source files in ordinary folders",
    betterBody:
      "Ordinary file storage may preserve a copy, but it does not necessarily preserve a review-ready verification structure. PROOVRA keeps the evidence state easier to inspect later.",
    betterCards: [
      {
        eyebrow: "Editorial confidence",
        title: "Clearer source review",
        body: "Editors get a more structured basis for assessing preserved source material.",
      },
      {
        eyebrow: "Preservation",
        title: "Better than screenshots alone",
        body: "Screenshots can be useful, but they rarely provide the full preservation and verification context needed later.",
      },
      {
        eyebrow: "Scrutiny",
        title: "Built for later challenge",
        body: "The workflow remains more useful when source material is questioned after publication or during review.",
      },
    ],

    closingTitle: "Built for editorial scrutiny, source preservation, and review-sensitive reporting",
    closingBody:
      "Use PROOVRA when source material may need careful later review, not just short-term storage.",
  },

  compliance: {
    slug: "compliance",
    eyebrow: "For Compliance & Audit",
    title: "Maintain",
    highlight: "traceable, review-ready evidence records.",
    description:
      "PROOVRA helps compliance, audit, and internal control teams preserve digital evidence with integrity context, timestamp visibility, custody history, and structured output for later review.",
    heroBullets: [
      "Audit-ready structure",
      "Review trail visibility",
      "Built for internal scrutiny",
    ],

    challengeTitle: "Why compliance teams need more than file storage",
    challengeBody:
      "Internal review, audit, and compliance workflows often depend on digital material that may need to be examined later. Ordinary files may be stored, but they still lack a stronger verification layer and cleaner review trail.",

    workflowTitle: "How compliance teams use PROOVRA",
    workflowBody:
      "Preserve, review, and document digital evidence in a way that supports later internal or regulatory scrutiny.",
    workflowSteps: [
      {
        eyebrow: "Collect",
        title: "Create an evidence record",
        body: "Turn uploaded material into a dedicated evidence record for review-sensitive workflows.",
      },
      {
        eyebrow: "Preserve",
        title: "Record integrity and preservation context",
        body: "Preserve the recorded evidence state, timestamp-related context, and supporting metadata for later inspection.",
      },
      {
        eyebrow: "Review",
        title: "Inspect through a structured workflow",
        body: "Reviewers can inspect integrity state, custody history, and report output in one place.",
      },
      {
        eyebrow: "Document",
        title: "Support audit and escalation",
        body: "Use verification pages and reports to support internal audit, compliance review, or regulatory-facing preparation.",
      },
    ],

    inspectTitle: "What audit and compliance reviewers can inspect",
    inspectBody:
      "The product is designed to make internal evidence handling more traceable and easier to review later.",
    inspectCards: [
      {
        eyebrow: "Traceability",
        title: "Review trail and custody context",
        body: "Important handling events can be reviewed more clearly across the record lifecycle.",
      },
      {
        eyebrow: "Integrity",
        title: "Recorded evidence state",
        body: "Inspect whether the preserved record still matches the state captured at completion.",
      },
      {
        eyebrow: "Reporting",
        title: "Structured verification output",
        body: "A report and verification page support later audit, escalation, and cross-functional review.",
      },
    ],

    outputTitle: "What the system produces",
    outputBody:
      "PROOVRA supports review-sensitive governance workflows with structured outputs rather than loose evidence storage.",
    outputCards: [
      {
        eyebrow: "Verification",
        title: "Verification page",
        body: "A dedicated inspection surface for evidence summary, integrity state, and related materials.",
      },
      {
        eyebrow: "Report",
        title: "Structured PDF report",
        body: "A clearer report format for audit-style review, internal findings, and escalation support.",
      },
      {
        eyebrow: "Technical",
        title: "Technical support materials",
        body: "Additional technical details stay available when specialist review is needed.",
      },
    ],

    betterTitle: "Why this is better than ordinary attachments and shared folders",
    betterBody:
      "Shared folders may hold files, but they do not automatically provide a defensible review structure. PROOVRA makes digital evidence easier to preserve, review, and explain later.",
    betterCards: [
      {
        eyebrow: "Governance",
        title: "Better internal review discipline",
        body: "A structured evidence workflow supports stronger process discipline than ad hoc file handling.",
      },
      {
        eyebrow: "Audit readiness",
        title: "Cleaner audit support",
        body: "The report and verification flow help teams prepare for follow-up questions and later checks.",
      },
      {
        eyebrow: "Cross-functional use",
        title: "Useful across legal, compliance, and audit",
        body: "The same record can support multiple review stakeholders without recreating the evidence package.",
      },
    ],

    closingTitle: "Built for audit evidence, internal controls, and review-sensitive compliance workflows",
    closingBody:
      "Use PROOVRA when digital material needs to remain traceable, reviewable, and stronger under later scrutiny.",
  },
};