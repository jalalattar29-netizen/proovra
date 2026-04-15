# Security & Responsible Disclosure Policy

Last Updated: 06.04.2026

PROOVRA is designed for trust-sensitive workflows involving digital evidence preservation, integrity verification, and controlled review.

This page describes our security posture at a practical level, together with how researchers can responsibly report vulnerabilities affecting the platform.

## 1. SECURITY OBJECTIVES

Our security program is designed to support:

- confidentiality of account and service data
- integrity of evidence artifacts and verification materials
- availability and reliability of the Services
- resilience against unauthorized access, tampering, and abuse

## 2. TECHNICAL AND ORGANIZATIONAL MEASURES

Security controls may include, depending on system role and environment:

- encryption in transit
- encryption at rest where applicable
- access control and least-privilege principles
- audit logging for sensitive events
- environment separation
- secure secret and key management practices
- monitoring, alerting, and anomaly detection
- abuse prevention and rate limiting
- dependency management and patching
- backup and recovery controls where applicable

Security practices evolve over time.

## 3. EVIDENCE INTEGRITY MODEL

Proovra provides technical integrity-verification mechanisms, which may include:

- file hashing
- fingerprint hashing
- digital signatures
- custody event records
- verification reports
- timestamp-related evidence where enabled
- OpenTimestamps-related evidence where enabled

These mechanisms are designed to support tamper detection and later technical verification.

## 4. IMPORTANT LIMITATIONS

Integrity verification does **not**, by itself, prove:

- authorship
- factual truth
- legal admissibility
- lawful provenance
- absence of pre-capture manipulation

Those questions may require external evidence, human review, and legal analysis.

## 5. CUSTOMER SECURITY RESPONSIBILITIES

Users remain responsible for:

- protecting credentials and devices
- using strong authentication practices
- managing team permissions carefully
- controlling distribution of reports and verification links
- reporting suspected compromise or misuse promptly

## 6. RESPONSIBLE VULNERABILITY DISCLOSURE

We welcome good-faith reports of security vulnerabilities.

Please report security issues to:

security@proovra.com

Please include, where possible:

- a clear description of the issue
- affected URL, endpoint, feature, or workflow
- impact assessment
- reproduction steps
- proof of concept, only where safe and lawful

## 7. RESEARCH RULES

When testing or reporting, please:

- avoid accessing data belonging to other users
- avoid modifying, deleting, or exfiltrating data
- avoid disrupting service availability
- avoid social engineering, phishing, spam, or physical attacks
- limit testing to what is reasonably necessary to demonstrate the issue
- give us reasonable time to investigate and remediate before public disclosure

## 8. SAFE HARBOR

If you act in good faith, follow this policy, avoid harming users or the Services, and promptly report the issue to us, we do not intend to pursue legal action solely for your compliant security research.

This safe harbor does not apply to unlawful conduct, data exfiltration, extortion, disruption, or conduct outside this policy.

## 9. INCIDENT RESPONSE

In the event of a security incident affecting personal data or service security, Proovra may:

- investigate and contain the issue
- mitigate risks
- preserve evidence and logs
- notify affected users or customers where required
- comply with legal notification obligations

## 10. RESPONSE EXPECTATIONS

Response times depend on severity and operational context, but we generally aim to:

- acknowledge reports within a reasonable timeframe
- assess severity and prioritize remediation
- communicate status where appropriate

## 11. CONTACT

Security reports: security@proovra.com  
General support: support@proovra.com