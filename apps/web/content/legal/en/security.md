# Security & Responsible Disclosure Policy – Proovra

Last Updated: 08.02.2026

Proovra is designed for trust-sensitive workflows involving digital evidence preservation and verification.

This page describes our security approach and how security researchers can responsibly report vulnerabilities.

---

# 1. SECURITY PRINCIPLES

Our security program focuses on protecting:

- confidentiality of user and account data
- integrity of evidence artifacts (hashes, signatures, custody logs)
- availability and reliability of the Services

We design the platform to minimize unauthorized access, tampering, and misuse.

---

# 2. TECHNICAL AND ORGANIZATIONAL MEASURES

Security controls may include:

- encryption in transit (TLS)
- encryption at rest where applicable
- least-privilege access control
- audit logging for sensitive operations
- environment separation (development / staging / production)
- secure cryptographic key management
- monitoring and anomaly detection
- abuse prevention and rate limiting
- routine dependency updates and security patching

Security practices evolve continuously as the platform develops.

---

# 3. EVIDENCE INTEGRITY MODEL

Proovra provides cryptographic integrity verification mechanisms.

These include:

- hashes that detect file alterations
- signatures generated at completion time
- custody timeline events recording system activity

Important:

Integrity verification confirms that **data has not changed since signing**, but it does **not prove authorship, context, or truthfulness of content**.

---

# 4. CUSTOMER SECURITY RESPONSIBILITIES

Users share responsibility for protecting their accounts and evidence.

Users should:

- protect account credentials and devices
- enable strong authentication practices
- restrict team permissions appropriately
- avoid sharing verification links publicly unless intended
- report suspicious activity immediately

---

# 5. RESPONSIBLE VULNERABILITY DISCLOSURE

We welcome responsible disclosure of security vulnerabilities.

If you discover a vulnerability, please report it to:

security@proovra.com

Please include:

- vulnerability description
- potential impact
- reproduction steps
- affected endpoints or URLs
- proof-of-concept if safe to share

---

# 6. RESPONSIBLE RESEARCH GUIDELINES

When testing or reporting vulnerabilities, we ask that you:

- avoid accessing data belonging to other users
- avoid actions that may disrupt service availability
- avoid modifying or deleting data
- limit testing to what is necessary to demonstrate the issue
- allow reasonable time for remediation before public disclosure

---

# 7. SAFE HARBOR

If you follow this policy and act in good faith, Proovra will not pursue legal action related to your security research.

This safe harbor applies only to activities consistent with this policy.

---

# 8. SECURITY INCIDENT RESPONSE

In the event of a security incident affecting user data, Proovra will:

- investigate the incident
- mitigate potential impact
- comply with applicable notification obligations
- notify affected users where required by law

---

# 9. RESPONSE TIMELINE

While timelines may vary, we generally aim to:

- acknowledge vulnerability reports within a reasonable timeframe
- investigate and prioritize based on risk severity
- communicate status updates during remediation

---

# 10. CONTACT

Security Reports  
security@proovra.com

General Support  
support@proovra.com