# AI Use Policy

Last Updated: 2026-06-23

This AI Use Policy explains how PROOVRA uses artificial intelligence ("AI") features inside the platform, the limitations of those features, and the safeguards that apply to evidence content.

This policy applies to AI-assisted features that may be available in PROOVRA where configured and where enabled for a workspace. AI features are optional and may be disabled at the workspace level.

## 1. ADVISORY ONLY

AI assistance in PROOVRA is **advisory only**.

AI features may help reviewers prepare materials, surface missing context, organize records, or summarize structured fields. They do not determine factual truth, authorship, identity, intent, liability, or legal admissibility, and they are not a substitute for human review or expert assessment.

AI output is informational. It may be incorrect, incomplete, or inconsistent across runs. Reviewers are expected to verify the recorded evidence content and the underlying integrity signals independently of any AI output.

## 2. METADATA-FIRST PROCESSING

Where AI assistance is enabled, the first iteration processes **operational metadata and structured workspace context** rather than evidence content. Operational metadata may include:

- evidence record identifiers
- record titles and structured tags
- workspace and case identifiers
- custody event types
- verification result codes and signal status
- reviewer assignment metadata

AI processing of evidence content (uploaded files, captured material, embedded media) is **not enabled by default**. Where evidence-content processing is later introduced for a specific feature, it will be clearly disclosed at the workspace level, will require workspace authorization, and will respect the same boundary commitments described in this policy.

## 3. AI PROVIDER AND RAW EVIDENCE BOUNDARY

Where AI assistance is enabled, PROOVRA may use **OpenAI** as an AI assistance provider, as identified on the [Subprocessors](/legal/subprocessors) page. In the current metadata-first design, PROOVRA does not send raw evidence files, images, videos, audio files, PDFs, or full document contents to the AI provider by default. AI requests are designed to use:

- operational metadata
- structured workspace context
- custody-event types
- verification-result codes
- limited text necessary for the requested assistance

If a future feature introduces content-based AI processing, it must be disclosed at the feature or workspace level, require appropriate workspace authorization, and be recorded in audit or operational logs where supported. Any such expansion will also respect the no-training boundary described in the next section.

## 4. NO TRAINING ON CUSTOMER EVIDENCE CONTENT

PROOVRA does not use customer evidence content to train general-purpose AI models.

Where AI features rely on third-party AI providers, PROOVRA configures those providers to disable training on customer content, where the provider supports such configuration. Aggregated, de-identified operational metrics may be used to maintain, secure, and improve the service.

## 5. HUMAN REVIEW

Decisions that affect a case, a claim, a workspace policy, a retention outcome, a legal hold, or any external stakeholder are not made automatically by AI. AI may surface suggestions; the operator or reviewer is the decision-maker.

Where AI output is shown to a reviewer, it is labelled clearly as AI-generated and includes a reminder that the output is advisory.

## 6. PROHIBITED CLAIMS

AI output in PROOVRA must not be presented as:

- a determination of factual truth
- a determination of authorship, identity, or intent
- a determination of legal admissibility or court acceptance
- a forensic conclusion
- an attestation of authenticity for a real-world event

Reports, verification pages, and reviewer surfaces that include AI-assisted content carry the relevant boundary language alongside that content.

## 7. AVAILABILITY AND FALLBACK

AI assistance is not guaranteed to be available at all times. AI features depend on third-party providers, model availability, configuration, quota, and operational status.

When AI assistance is unavailable, PROOVRA continues to operate without AI. Verification, custody, reporting, and reviewer workflows do not depend on AI to function. Integrity signals (hash matching, timestamp context, custody chain) are computed independently of AI.

## 8. PRIVACY

AI processing follows the same data protection principles described in the Privacy Policy and the Data Processing Addendum.

Where a third-party AI provider is used, the provider is listed in the Subprocessors page along with its purpose, data categories, and transfer mechanism.

## 9. RELATED POLICIES

For context, see also:

- [Verification Methodology](/legal/verification-methodology)
- [Verification Disclaimer](/legal/verification-disclaimer)
- [Evidence Handling Policy](/legal/evidence-handling)
- [Privacy Policy](/legal/privacy)
- [Subprocessors](/legal/subprocessors)
- [Trust Center](/trust)
