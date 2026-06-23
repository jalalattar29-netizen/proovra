# Legal Changelog

Last Updated: 2026-06-23

This page provides a version history for PROOVRA's legal and compliance documentation. It is intended to improve transparency around material updates to policies, terms, privacy notices, cookie practices, and related compliance documents.

## 1. PURPOSE

PROOVRA may update legal documents from time to time to reflect:

- product changes
- technical changes
- legal or regulatory developments
- security or compliance improvements
- operational or contractual updates

This page helps users and customers understand when significant changes were introduced.

## 2. CURRENT ACTIVE LEGAL VERSION

Current baseline legal version: **2026-06-23**

This version is currently associated with the following core documents:

- Terms of Service
- Privacy Policy
- Cookie Policy
- Data Processing Addendum (DPA)
- Data Retention Policy
- Subprocessors
- Technical and Organizational Measures (TOMs)
- Security and Responsible Disclosure
- Incident Response Policy
- Transparency Policy
- Law Enforcement Request Policy
- Acceptable Use Policy
- Abuse Reporting
- Copyright and DMCA Policy
- Evidence Handling Policy
- Verification Methodology
- Verification Disclaimer
- AI Use Policy
- Privacy Requests
- Consumer Cancellation and Refund Policy
- Accessibility Statement
- Support Policy
- Impressum

Where required by PROOVRA's implementation, users may be asked to re-accept updated legal terms after a material revision.

## 3. CHANGE HISTORY

### 2026-06-23 — Enterprise hardening pass

Material expansion and hardening of the public legal documentation set.

**Privacy Policy**
- Expanded GDPR data-subject rights section with a full DSR workflow, identity-verification guidance, one-month response target, and up-to-two-month extension framework.
- Added explicit Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen (LDI NRW) supervisory-authority reference.
- Added a controller / processor scenario table with concrete examples.
- Added a dedicated AI-assisted processing section: advisory only; metadata-first; no training on customer evidence content.
- Added explicit international transfers framework with SCCs, UK IDTA, DPF, transfer impact assessments.
- Added security monitoring, fraud prevention, and verification artifact processing section.
- Added account deletion, legal hold, and evidence-preservation implications.

**Cookie Policy**
- Added a structured cookie / technology inventory table aligned with the Subprocessors page.
- Added consent versioning, regional consent handling, and a withdrawal process.

**Data Processing Addendum (DPA)**
- Added Appendix A — detailed processing activities table.
- Added Appendix B — Technical and Organizational Measures (12 sub-areas).
- Added Appendix C — Subprocessors table aligned with the public Subprocessors page.
- Added Appendix D — International transfers (SCCs, UK IDTA, DPF, transfer impact assessments).
- Added Appendix E — Deletion and return of data, with explicit retention exceptions and evidence-integrity preservation.
- Added Appendix F — Audit and information rights with proportionality, confidentiality, and once-per-twelve-month frequency limits.

**Data Retention Policy**
- Added a structured 19-row retention matrix (basis, normal retention, extension conditions).
- Added an evidence-integrity preservation section explaining the separate retention cadence for integrity records.

**Incident Response Policy**
- Added SEV-1..4 severity classification matrix.
- Added Article 33 / 34 GDPR notification references (72-hour aspiration; data-subject notification where likely high-risk).
- Added processor-role notification language.
- Added explicit "as required by applicable law and contractual commitments" framing.

**Abuse Reporting**
- Added acknowledgement, review process, escalation, repeat-abuse handling, and emergency-situation guidance.
- Added "we aim to" language (instead of guarantees) for service-level expectations.

**Law Enforcement Request Policy**
- Added a transparency-reporting section with explicit non-commitment language ("may publish").
- Added preservation, emergency, jurisdiction review, minimum-necessary disclosure, and overbroad-request handling.

**Accessibility Statement**
- Added WCAG 2.2 AA as a design objective (not a certification claim).
- Added an accessibility roadmap and an assistive-technology testing section.

**Subprocessors**
- Rewritten as a real subprocessor register with provider, purpose, data categories, region/transfer scope, role, and status/condition columns.
- Aligned with DPA Appendix C.

**Transparency Policy**
- Expanded into a structured policy covering legal review, minimum-necessary disclosure, jurisdiction review, user notice, preservation, and aggregate reporting principles with non-commitment language.

**Copyright and DMCA Policy**
- Expanded into a full request process: notice requirements, counter-notice, repeat-infringer policy, fraudulent-notice handling, jurisdiction-neutral framing.

**Technical and Organizational Measures (TOMs)**
- Restructured into 13 standard sub-areas mapping to common security frameworks.
- Added explicit evidence-integrity controls (SHA-256, KMS, RFC 3161, OpenTimestamps, hash-chained custody, Object Lock "where configured").
- Added "no certification claim" section.

**Terms of Service**
- Expanded user-responsibility section: rights, permissions, consent, lawful basis, lawful capture and sharing, non-harassment, non-surveillance, no legal advice from PROOVRA, no guarantee of admissibility.
- Added evidence-and-verification limitations cross-reference.
- Added AI-assisted features cross-reference to the AI Use Policy.
- Updated related documents.

**Privacy Matrix — retired**
- The Privacy Matrix page was retired in this iteration because the structured category overview is already covered inside the Privacy Policy. The route `/legal/privacy-matrix` redirects to `/legal/privacy`. Privacy Matrix is no longer listed as an active document.

**New documents added**
- AI Use Policy (`/legal/ai-use-policy`).
- Verification Disclaimer (`/legal/verification-disclaimer`).
- Privacy Requests (`/legal/privacy-requests`).
- Consumer Cancellation and Refund Policy (`/legal/refund-policy`).
- Accessibility Statement (`/legal/accessibility`).

**Support Policy**
- Expanded from a short summary into a full enterprise Support Policy with a contact-channel matrix, a support scope matrix, a severity-and-prioritization model with Critical / High / Normal / Low handling expectations, dedicated enterprise-support, abuse-escalation, security-escalation, legal / privacy / law-enforcement routing, billing-escalation, and availability-disclaimer sections.
- Public Support page (`/support`) and Support Policy (`/legal/support`) are explicitly distinguished and both remain accessible.

**Impressum**
- Updated with website information (public, app, API hosts), a contact matrix (support, legal, privacy, security, sales), an Online Dispute Resolution reference under Art. 14 ODR-VO, a PROOVRA-aligned platform description, a jurisdiction reference cross-linking the Terms of Service, an expanded trademark and copyright notice, an expanded liability-for-content and liability-for-links section, and a related-legal-documents block.

**Subprocessors — additional providers**
- Added five providers to the subprocessor register: Neon (managed PostgreSQL), Upstash (Redis / queue / cache / rate limiting), Grafana / Grafana Cloud (observability — dashboards, metrics, logs), Hetzner (server / cloud infrastructure), and Vercel (web hosting / deployment / edge delivery). Each row reflects conditional activation ("where configured", "where deployed", or "currently used where configured").

**AI Use Policy**
- Added an explicit AI Provider and Raw Evidence Boundary section identifying OpenAI as the AI assistance provider where AI features are enabled and confirming that PROOVRA does not send raw evidence files, images, videos, audio files, PDFs, or full document contents to the AI provider by default. Future content-based AI processing must be disclosed at the workspace or feature level, require workspace authorization, and be recorded in audit or operational logs where supported.

**Cookie Policy**
- Replaced the generic "Reliability provider" and "Analytics provider" rows with named providers — Sentry (error / reliability telemetry), Vercel Analytics, and Cloudflare Web Analytics — each conditional on activation.
- Added an explicit clarification that infrastructure, database, queue, and observability subprocessors (such as Hetzner, Neon, Upstash, AWS, Grafana, Twilio, Resend, MaxMind, and OpenAI) are described on the Subprocessors page and may not set browser cookies.

**Acceptable Use Policy**
- Expanded into a stronger document covering permitted use, user responsibility for lawful capture and upload, an expanded prohibited-content list, a dedicated Evidence-Specific Misuse section, a Verification Surface Misuse section, a Security and Platform Abuse section, an AI Misuse section, an Enforcement Actions ladder (warn → restrict → disable → suspend → terminate → preserve → notify → report) using "may" rather than "will", a Preservation During Investigation section, and a Reporting Misuse routing table.

### 2026-04-06 — Initial versioned legal framework

Initial versioned legal framework introduced or consolidated across the platform, including:

- versioned Terms of Service
- versioned Privacy Policy
- versioned Cookie Policy
- version-aware legal acceptance logging
- cookie consent preference handling
- Data Retention page
- Subprocessors page
- Technical and Organizational Measures (TOMs) page
- Incident Response page
- Legal Changelog page

## 4. MATERIAL VS. NON-MATERIAL CHANGES

PROOVRA may distinguish between:

- **material changes**, such as updates affecting rights, obligations, retention, disclosures, liability, or legal basis
- **non-material changes**, such as wording improvements, formatting, clarifications, or administrative corrections

Where appropriate, material changes may trigger an updated acceptance flow or additional notice.

## 5. HISTORICAL REFERENCE

Older versions may be retained internally for audit, compliance, contractual, or evidentiary purposes. PROOVRA does not guarantee public publication of every historical draft or intermediate revision unless required by law or contract.

## 6. RELATED DOCUMENTS

- Terms of Service
- Privacy Policy
- Cookie Policy
- Data Processing Addendum (DPA)
- Data Retention Policy
- Subprocessors
- Technical and Organizational Measures (TOMs)
- Trust Center

## 7. CONTACT

For legal questions regarding document changes, contact **legal@proovra.com**.
