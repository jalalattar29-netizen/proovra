# Incident Response Policy

Last Updated: 2026-06-23

This Incident Response Policy describes how PROOVRA identifies, classifies, assesses, contains, investigates, remediates, and communicates about security incidents affecting the Services.

It is intended to explain the platform's operational incident-response posture in a way that supports customer trust, evidence-integrity preservation, security review, and compliance with applicable legal obligations.

## 1. PURPOSE

PROOVRA maintains incident-response procedures intended to:

- protect the confidentiality, integrity, and availability of personal data and customer evidence
- preserve the evidentiary value of integrity records (hashes, signatures, custody events, timestamp tokens) during and after an incident
- communicate with customers, data subjects, and regulators where required by law or contract
- learn from incidents and improve controls

## 2. DEFINITIONS

For the purpose of this policy:

- **Event** — an observable occurrence in a system.
- **Security incident** — an event, or set of events, that adversely affects, or has a reasonable likelihood of adversely affecting, the confidentiality, integrity, or availability of the Services or of personal data processed in connection with the Services.
- **Personal data breach** — a security incident leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data transmitted, stored, or otherwise processed.

## 3. INCIDENT LIFECYCLE

PROOVRA's incident-response process is designed around the following phases.

1. **Detection and intake** — alerts from monitoring tools, reports from customers, reports from security researchers (see the Security and Responsible Disclosure policy), reports from subprocessors, or reports through abuse-reporting paths.
2. **Validation and triage** — confirm that an event is genuine and warrants response; assess scope and category.
3. **Severity classification** — assign a severity level using the matrix in Section 4.
4. **Containment** — limit further impact through measures consistent with Section 6.
5. **Technical investigation** — identify root cause, affected systems, affected data, and timeline.
6. **Eradication and remediation** — remove the cause of the incident; apply technical and configuration fixes.
7. **Service recovery** — restore affected services to normal operation.
8. **Customer and regulatory communication** — notify customers and authorities where required by law or contract (see Section 7).
9. **Post-incident review** — root-cause analysis, lessons learned, control improvements (see Section 10).

## 4. SEVERITY CLASSIFICATION

PROOVRA classifies incidents along the following scale. Classification is initial and may evolve as the investigation progresses.

| Severity | Description | Initial response objective |
|---|---|---|
| **SEV-1 — Critical** | Confirmed or highly likely material compromise of customer personal data, evidence integrity, or signing-key material; or a service-wide outage materially impairing core operation | Immediate containment; engage on-call response; begin customer-impact assessment |
| **SEV-2 — High** | Confirmed unauthorized access to a limited subset of customer data; significant degradation of core operation; suspected key-material compromise pending validation | Rapid containment; engaged response; investigate scope |
| **SEV-3 — Medium** | Localized unauthorized access without confirmed personal-data exposure; partial service degradation; suspected abuse warranting active response | Contain; investigate; remediate; communicate where appropriate |
| **SEV-4 — Low** | Isolated, non-personal-data event; minor service issue; suspicious activity warranting documentation but not active remediation | Document; monitor; remediate per normal change cadence |

## 5. TRIAGE AND ESCALATION

Triage is performed by the on-call responder. Escalation is triggered when:

- the suspected scope includes customer personal data
- the suspected scope includes signing-key material or other evidence-integrity material
- the incident may meet a regulatory or contractual notification threshold
- the incident materially impairs core service operation
- a customer reports an incident with potential cross-customer impact

Escalation paths may include the engineering lead, the security and privacy contacts, executive leadership, and external counsel where appropriate.

## 6. CONTAINMENT AND REMEDIATION

Where appropriate, PROOVRA may:

- restrict affected systems, sessions, or credentials
- rotate secrets, signing keys, or access controls
- isolate components
- deploy mitigations or fixes
- increase monitoring on related surfaces
- preserve logs and forensic records relevant to investigation
- coordinate with subprocessors involved in the incident

PROOVRA aims to take containment actions promptly, proportionate to the assessed severity. Containment may take precedence over service-feature continuity where confidentiality, integrity, or signing-key safety is at risk.

## 7. CUSTOMER AND REGULATORY NOTIFICATION

### 7.1 Customer Notification

PROOVRA aims to notify affected customers of qualifying personal data breaches **without undue delay** after becoming aware of the breach, with information reasonably necessary to enable the customer to comply with its own notification obligations. Notification may be delivered through the customer's primary contact, through the workspace owner, or through other channels reflected in the customer record.

### 7.2 GDPR Notification

Where PROOVRA acts as a controller and a personal data breach is likely to result in a risk to the rights and freedoms of natural persons, PROOVRA aims to notify the competent supervisory authority **without undue delay** and, where feasible, within the **72-hour** window described in Article 33 GDPR. Where notification cannot be made within 72 hours, the reasons for delay will be documented in line with applicable law.

Where the breach is likely to result in a **high risk** to the rights and freedoms of natural persons, PROOVRA aims to notify affected data subjects in accordance with Article 34 GDPR, except where the conditions for exemption under that article apply.

### 7.3 Processor-Role Notification

Where PROOVRA acts as a processor for customer-controlled data, PROOVRA notifies the customer without undue delay after becoming aware of a qualifying breach affecting that data, with information reasonably necessary to enable the customer (as controller) to meet its own notification obligations. PROOVRA does not independently notify supervisory authorities or data subjects on the customer's behalf except where the customer has instructed PROOVRA to do so.

### 7.4 Notification Content

Notifications, where issued, aim to include (subject to the information available at the time):

- a description of the nature of the breach
- the categories and approximate number of data subjects and records affected
- the likely consequences
- the measures taken or proposed to address the breach and to mitigate adverse effects
- a point of contact for further information

PROOVRA may supplement initial notifications as additional facts become known.

### 7.5 No Fixed Time Commitments

PROOVRA does not guarantee specific notification times beyond those required by applicable law and contractual commitments. Notifications are issued **as required by applicable law and contractual commitments** and within the timeframes described above.

## 8. EVIDENCE PRESERVATION

Where relevant, PROOVRA seeks to preserve security logs, audit records, custody events, signing operations, and technical evidence reasonably necessary to investigate and document an incident, consistent with the Data Retention Policy and applicable law. Evidence-integrity material related to customer records is protected on a separate retention cadence to support audit and reviewer inspection.

## 9. SUBPROCESSOR INCIDENTS

Where an incident involves a subprocessor, PROOVRA coordinates with that subprocessor to obtain information reasonably necessary for investigation and notification. PROOVRA's notification obligations to customers do not depend on the subprocessor's notifications to PROOVRA, but the timing of customer notification may be affected by the information available at the time.

## 10. POST-INCIDENT REVIEW AND CONTINUOUS IMPROVEMENT

Following significant incidents, PROOVRA performs a post-incident review that may include:

- timeline reconstruction
- root-cause analysis
- impact assessment
- lessons learned
- corrective actions for detection, containment, and recovery
- updates to controls, procedures, training, or documentation
- changes to security or privacy posture where warranted

PROOVRA may share summary findings with affected customers under appropriate confidentiality, where reasonable.

## 11. CUSTOMER COOPERATION

PROOVRA may request reasonable cooperation from affected customers, including timely confirmation of contact details, secure communication channels, and information necessary to scope the incident.

## 12. CONTACT

- Security reports: **security@proovra.com**
- Legal and privacy: **legal@proovra.com** / **privacy@proovra.com**
- Support: **support@proovra.com**

## 13. RELATED DOCUMENTS

- Security and Responsible Disclosure
- Technical and Organizational Measures (TOMs)
- Data Processing Addendum (DPA)
- Privacy Policy
- Privacy Requests
- Data Retention Policy
- Transparency Policy
- Law Enforcement Request Policy
- Trust Center
