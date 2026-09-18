# How Direct Web Capture Works

Last Updated: 2026-09-18

This page explains how PROOVRA's Direct Web Capture channel preserves a rendered web page through the PROOVRA browser extension, what it records, how integrity is established after ingestion, and — importantly — what capture does and does not establish.

It is a "how it works" disclosure for users, legal professionals, investigators, journalists, insurers, auditors, and enterprise reviewers who need to understand this specific capture channel. It is not an installation page, and installing or using the extension is always initiated by the user.

This page is read together with the Evidence Handling Policy, the Verification Methodology, the Verification Disclaimer, the Privacy Policy, the Data Retention Policy, the Security and Responsible Disclosure policy, and the Trust Center.

## 1. WHAT DIRECT WEB CAPTURE IS

Direct Web Capture is the channel in which the PROOVRA browser extension preserves a rendered web page directly, rather than a user uploading a screenshot or file after the fact.

When you capture a page:

- the extension opens a **server-issued capture session** before the capture begins;
- PROOVRA participates in the capture and independently checks the bytes it receives;
- the platform records **how and when** the page entered the evidence lifecycle.

Because PROOVRA's own capture adapter produces the bytes under a session that the server issued in advance, Direct Web Capture is a *direct-capture* channel. This is different from uploading material that PROOVRA did not observe being produced. It does not, by itself, prove anything about the page's content (see Section 6).

## 2. WHAT IS RECORDED

Depending on the workflow and the page, Direct Web Capture may record technical context such as:

- the page URL captured
- the capture timestamp (the server establishes the authoritative time)
- the rendered content of the page as the extension received it
- capture-session identifiers that bind the capture to the server-issued session
- technical metadata produced during processing (for example content type and size)
- cryptographic digests of each captured artifact

The capture records a **representation** of the page as PROOVRA acquired it. Web pages are dynamic; the recorded representation reflects what the extension received at capture time, together with any limitations PROOVRA detected.

## 3. HOW INTEGRITY IS ESTABLISHED AFTER INGESTION

After the capture bytes reach PROOVRA, the canonical evidence lifecycle applies. In particular:

- PROOVRA **independently recomputes the digest** of every captured artifact on the server, rather than trusting a digest declared by the client;
- integrity is **established when the capture session is completed** on the server;
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

The PROOVRA browser extension is built to request only the permissions it needs to perform a user-initiated capture (least privilege). It requests **no broad host access**.

| Permission | Why it is requested |
|---|---|
| activeTab | Lets the extension act on the tab the user is currently viewing, only when the user triggers a capture — not a standing grant across sites. |
| scripting | Runs the capture routine in the active page to collect the rendered representation at capture time. |
| storage | Holds local extension state, such as capture-session context between steps. |
| identity | Signs the user in to their own PROOVRA account so the capture is bound to a server-issued session for that account. |

These permissions describe capability, not intent: the extension uses them only in service of a capture the user starts. Exact permission behavior is governed by the published extension manifest and the browser's own permission model.

## 6. THE TRUST BOUNDARY — WHAT CAPTURE DOES NOT ESTABLISH

PROOVRA records how and when material was received and preserved. It does not establish that the content is true, who authored it, the identity of people shown, or that events occurred as depicted. Legal admissibility and evidentiary weight require separate review.

For Direct Web Capture specifically:

- **Content is not proven true.** A web capture preserves the representation PROOVRA acquired. It does not establish that the page's content is true, who authored it, or that a website or account is genuine.
- **Server origin is not proven.** PROOVRA does not prove that the captured bytes were served by the website's own servers. A locally modified page or a look-alike site cannot be ruled out.
- **Page state at capture is not guaranteed.** A web page can change while it is being captured, and its appearance can be altered in the browser before capture. PROOVRA records the representation it received and any limitations it detected, not a guaranteed untouched original.

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
