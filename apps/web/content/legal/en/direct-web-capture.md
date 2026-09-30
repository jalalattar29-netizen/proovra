# How Direct Web Capture Works

Last Updated: 2026-10-01

This page explains how PROOVRA's Direct Web Capture channel preserves a rendered web page through the PROOVRA browser extension, what it records, how integrity is established after ingestion, and — importantly — what capture does and does not establish.

It is a "how it works" disclosure for users, legal professionals, investigators, journalists, insurers, auditors, and enterprise reviewers who need to understand this specific capture channel. It is not an installation page, and installing or using the extension is always initiated by the user.

This page is read together with the Evidence Handling Policy, the Verification Methodology, the Verification Disclaimer, the Privacy Policy, the Data Retention Policy, the Security and Responsible Disclosure policy, and the Trust Center.

## 1. WHAT DIRECT WEB CAPTURE IS

Direct Web Capture is the channel in which the PROOVRA browser extension preserves a rendered web page directly, rather than a user uploading a screenshot or file after the fact.

When you capture a page:

- the extension, running in your browser, takes screenshots of the page and a sanitized copy of its structure;
- it then opens a **capture session** with PROOVRA for your account and uploads what it captured, together with a manifest describing the capture;
- PROOVRA **independently recomputes the digest** of every uploaded artifact and records **when it received** the capture.

The capture itself happens in your browser. PROOVRA does not observe the page being captured: it receives the bytes the extension reports it captured, and the record states that the capture is client-attested. What distinguishes this channel from an ordinary upload is that the bytes come from PROOVRA's own extension, through a session bound to your account, rather than from a file chosen after the fact. It does not, by itself, prove anything about the page's content (see Section 6).

## 2. WHAT IS RECORDED

Depending on the workflow and the page, Direct Web Capture may record technical context such as:

- the page URL captured
- the time PROOVRA received the capture (server time), alongside the capture start and end times the extension reports from your device clock
- screenshots of the visible area, or of the page in scrolled tiles, and a sanitized copy of the page's structure
- capture-session identifiers that bind the upload to the capture session
- technical metadata produced during processing (for example content type and size)
- cryptographic digests of each captured artifact
- the limitations the extension detected (for example a page that changed during capture, frames or media it could not include, or a capture cut short), and what the sanitizer removed

The capture records a **representation** of the page as the extension captured it. It is not a complete archive of the page or the website: embedded frames, shadow content, protected media and resources loaded from elsewhere may be missing, and scripts are removed from the structural copy. Before the structural copy is stored, the extension removes executable content and clears values it recognizes as secrets of your own session (for example password and one-time-code fields, anti-forgery tokens in page metadata, and credential or signature parameters in links); it cannot guarantee that every secret on a page is recognized. Web pages are dynamic; the recorded representation reflects what the extension captured at capture time, together with any limitations it detected.

## 3. HOW INTEGRITY IS ESTABLISHED AFTER INGESTION

After the capture bytes reach PROOVRA, the canonical evidence lifecycle applies. In particular:

- PROOVRA **independently recomputes the digest** of every captured artifact on the server, rather than trusting a digest declared by the client;
- the recorded integrity state is **established when the capture session is completed** on the server — it covers the bytes from the moment PROOVRA received them, not how they were produced in the browser;
- from that point the material is treated like any other Evidence Record — hashing, custody events, signature and timestamp context where enabled, retention, and legal hold all follow the Evidence Handling Policy and the Verification Methodology.

Server-side digest recomputation means the recorded integrity state does not depend on the extension or the browser being trusted.

## 4. USER-INITIATED CAPTURE AND PRIVACY

Direct Web Capture is always **user-initiated**. The extension acts only when the user triggers a capture; it does not perform hidden or background surveillance and does not silently monitor browsing.

Privacy limitations to understand:

- A capture preserves whatever the page displayed at the moment of capture, which may include personal data visible on the page. Deciding whether it is lawful and appropriate to capture a given page remains the user's responsibility.
- The user is responsible for having a lawful basis for capture and for obtaining any consent required under applicable recording, surveillance, privacy, and personality-rights laws.
- Metadata supplied by the browser or the page may be incomplete, unavailable, or altered before capture. PROOVRA does not guarantee metadata completeness or real-world accuracy.

See the Privacy Policy and the Evidence Handling Policy for the full framework on responsibility and data handling.

## 5. EXTENSION PERMISSIONS

The PROOVRA browser extension is built to request only the permissions it needs to perform a user-initiated capture (least privilege). It requests **no broad host access**: its only host access is to PROOVRA's own API and to the PROOVRA storage location the capture is uploaded to.

| Permission | Why it is requested |
|---|---|
| activeTab | Lets the extension act on the tab the user is currently viewing, only when the user triggers a capture — not a standing grant across sites. |
| scripting | Runs the capture routine in the active page to collect the rendered representation at capture time. |
| storage | Holds the sign-in for the current browser session and the status of a capture in progress, so a reopened extension window can show it. |
| identity | Signs the user in to their own PROOVRA account so the capture is uploaded through a capture session for that account. |
| Host access to PROOVRA's API and upload storage | Lets the extension call PROOVRA and upload the capture. It does not grant access to the pages you visit. |

These permissions describe capability, not intent: the extension uses them only in service of a capture the user starts. Exact permission behavior is governed by the published extension manifest and the browser's own permission model.

## 6. THE TRUST BOUNDARY — WHAT CAPTURE DOES NOT ESTABLISH

PROOVRA records how and when material was received and preserved. It does not establish that the content is true, who authored it, the identity of people shown, or that events occurred as depicted. Legal admissibility and evidentiary weight require separate review.

For Direct Web Capture specifically:

- **Content is not proven true.** A web capture preserves the representation PROOVRA acquired. It does not establish that the page's content is true, who authored it, or that a website or account is genuine.
- **Server origin is not proven.** PROOVRA does not prove that the captured bytes were served by the website's own servers. A locally modified page or a look-alike site cannot be ruled out.
- **Page state at capture is not guaranteed.** A web page can change while it is being captured, and its appearance can be altered in the browser before capture. PROOVRA records the representation it received and the limitations the extension detected, not a guaranteed untouched original.
- **The capture is client-attested.** The extension reports what it captured and when; PROOVRA verifies the bytes it received, not the browser that produced them.

Capture does **not** guarantee legal admissibility. Whether any authority, court, insurer, employer, regulator, or counterparty accepts a record remains external to the platform and may require independent legal, expert, or procedural analysis. [Counsel review required] before this page or a capture record is characterized as satisfying any specific evidentiary standard or rule of admissibility in a given jurisdiction.

## 7. WHAT PROOVRA DOES NOT DO

Through Direct Web Capture, PROOVRA does not:

- verify that the captured page's content is accurate or truthful
- prove who authored the page or that a website or account is genuine
- prove that the bytes were served by the website's own servers
- determine legal admissibility, evidentiary weight, or court acceptance
- provide legal advice

Those determinations remain external to the platform.

## 8. RELATED DOCUMENTS

- Evidence Handling Policy
- Verification Methodology
- Verification Disclaimer
- Privacy Policy
- Data Retention Policy
- Security and Responsible Disclosure
- Acceptable Use Policy
- Trust Center

## 9. CONTACT

For questions regarding Direct Web Capture: **legal@proovra.com**
