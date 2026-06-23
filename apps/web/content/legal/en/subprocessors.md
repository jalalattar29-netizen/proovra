# Subprocessors

Last Updated: 2026-06-23

This page identifies the third-party service providers PROOVRA may engage to support delivery of the digital evidence operations platform. It is intended to improve visibility into the infrastructure and service-provider layer supporting evidence capture, preservation, hashing, signing, timestamping, custody, verification, reporting, and reviewer workflows.

This page is read together with the Privacy Policy, the Data Processing Addendum (DPA — Appendix C in particular), the Cookie Policy, the Technical and Organizational Measures (TOMs), and the Security and Responsible Disclosure policy.

## 1. SUBPROCESSOR REGISTER

The register below identifies each provider, the service area it supports, its purpose, the categories of personal data that may be processed, the region or transfer scope, the provider's role, and the current activation status. Where a provider is listed as **where enabled**, **where configured**, or **where deployed**, the provider is not necessarily active in every deployment; activation depends on platform configuration, plan capabilities, region, and customer choice. PROOVRA seeks to keep this register aligned with actual production usage.

| Provider | Service area | Purpose | Data categories | Region / transfer scope | Role | Status / condition |
|---|---|---|---|---|---|---|
| Amazon Web Services (AWS) — S3, KMS, Rekognition, Secrets Manager | Cloud infrastructure, object storage, key management, optional vision processing | Storage of uploaded evidence content and metadata; KMS-backed signing-key operations where configured; vision processing only where AI features are enabled; secret material storage where configured | Uploaded content; account data; logs; signing-key identifiers; structured workspace context | EU region(s) where configured; additional AWS regions may apply depending on deployment | Processor | Currently used for storage and signing where configured |
| Hetzner | Server / cloud infrastructure | Hosting server environment, compute resources, and infrastructure layer where deployed | Application data, logs, request metadata, operational metadata depending on deployment | Germany / EU where configured | Processor | Where deployed |
| Cloudflare — R2 (S3-compatible storage) and Edge | Object storage alternative; edge security, DNS, CDN, bot/DDoS protection, TLS edge termination | Production object storage where deployed on R2; request metadata, IPs, and edge-security signals where the edge layer is deployed | Uploaded content (R2 deployment only); request metadata; IP address; TLS handshake metadata | Cloudflare global edge; storage region selected on R2 where configured | Processor | Where deployed |
| Neon | Managed PostgreSQL database | Managed relational database for account data, workspace metadata, evidence metadata, audit and custody records, billing references, and application state where configured as the production database | Account data; workspace metadata; case and evidence metadata; custody and audit events; configuration metadata | Selected region(s), EU where configured; additional regions depending on provider and account configuration | Processor | Currently used where configured as the production database |
| Upstash | Redis, queue, cache, rate limiting | Cache, queue coordination, rate limiting, and operational job metadata where configured | Cache keys; queue and job metadata; rate-limit markers; operational metadata. PROOVRA seeks to avoid storing raw evidence content here. | Selected Upstash region(s) | Processor | Where configured |
| Grafana / Grafana Cloud | Observability — dashboards, metrics, logs | Operational monitoring, dashboards, reliability visibility, and alerting where configured | Operational metrics; logs; service status; request metadata where included; minimal account or workspace identifiers where present in logs | Provider-specific regions | Processor | Where configured |
| Vercel | Web hosting, deployment, edge delivery | Hosting the public marketing surface or frontend deployment, build logs, request metadata, and edge delivery where deployed | Request metadata; deployment logs; IP address; user-agent; page or request telemetry where enabled | Vercel-supported regions; global edge where deployed | Processor | Where deployed |
| Stripe | Billing and checkout | Process billing transactions for paid plans; manage subscription and webhook state | Billing identifiers; transaction metadata; minimal payer profile data routed through the checkout surface | Stripe-supported regions; SCCs apply for non-EEA transfers where required | Independent controller for payment processing; processor for routed billing metadata where applicable | Currently used for paid plans |
| PayPal | Billing and checkout | Process billing transactions where PayPal checkout is enabled | Billing identifiers; transaction metadata | PayPal-supported regions; SCCs apply for non-EEA transfers where required | Independent controller for payment processing | Where enabled for the deployment |
| Google (OAuth) | Federated sign-in | Federated sign-in where the user chooses Google sign-in | OAuth identifiers; minimal profile data (email, name) | Google-supported regions | Independent controller for the OAuth surface | Currently used for users who choose Google sign-in |
| Apple (Sign in with Apple) | Federated sign-in | Federated sign-in where the user chooses Apple sign-in | OAuth identifiers; minimal profile data | Apple-supported regions | Independent controller for the OAuth surface | Currently used for users who choose Apple sign-in |
| OpenAI | AI assistance | Advisory metadata-first AI assistance for capture, chat, and verification-result interpretation where AI features are enabled | Operational metadata; structured workspace context; verification result codes; minimal text necessary for the requested feature | OpenAI-supported regions; SCCs apply for non-EEA transfers where required | Processor | Where AI features are enabled for the workspace |
| Twilio | Communications | SMS, WhatsApp, and verification messaging where the Communications feature is configured | Phone number; message metadata; verification metadata | Twilio-supported regions; SCCs apply for non-EEA transfers where required | Processor | Where configured |
| Resend | Email delivery | Send transactional and policy emails (account, security, billing, legal, lead notifications) in production | Email addresses; message metadata; minimal message body required for the transactional email | Resend-supported regions; SCCs apply for non-EEA transfers where required | Processor | Where configured (production email path) |
| Sentry | Error and reliability monitoring | Detect crashes, errors, and performance regressions across API, worker, web, and mobile surfaces | Diagnostic telemetry; error traces; minimal request context; account identifiers only where included; user-agent metadata | Sentry-supported regions | Processor | Where enabled (Sentry DSN configured) |
| MaxMind | Geo intelligence | Geo-IP enrichment for adaptive authentication and abuse signals where the geo feature is enabled | IP address; derived geographic context | Provider-specific regions; SCCs apply for non-EEA transfers where required | Processor | Where Adaptive Auth / Geo Intelligence is enabled |

A provider is included in this register only where it is actually engaged for the platform or where activation is explicitly conditional on configuration. PROOVRA does not list providers it does not use. PROOVRA seeks to give reasonable advance notice of changes to the register where commercially practicable.

## 2. CONDITIONAL PROVIDERS AND DEPLOYMENT-SPECIFIC USE

Some providers are used only for specific deployments, plans, regions, or features. For example, payment providers are engaged only for paid checkout, OAuth providers only where the user selects that sign-in method, AI providers only where AI assistance is enabled, communications providers only where messaging or verification workflows are configured, geo providers only where adaptive authentication uses geographic signals, and edge/CDN providers only where that edge layer is deployed. If a provider is not active for a customer's deployment or workspace, that provider may not process that customer's personal data.

Some providers also operate at different layers depending on configuration. For example, AWS may serve as the production storage and KMS provider in one deployment while Cloudflare R2 may serve as the production storage provider in another deployment. The Subprocessor Register reflects all providers that may be engaged across PROOVRA's supported deployment options.

## 3. AI PROVIDER BOUNDARY

PROOVRA's AI features are bounded as follows:

- AI assistance is advisory only. AI output is a review aid, not a determination of truth, authorship, identity, intent, liability, or admissibility.
- The current AI design is metadata-first: requests sent to AI providers are scoped to operational metadata, structured workspace context, and verification result codes, rather than full evidence content.
- Customer evidence content is not sent to AI providers by default. Where a feature requires limited content access (for example, transcription or content-grounded assistance), that access is gated to the feature scope and is intended to be disclosed to the workspace.
- Customer evidence content is not used to train general-purpose AI models. PROOVRA seeks contractual or technical assurances from AI providers consistent with this position.
- If a future content-based AI capability is introduced, that capability must be disclosed and authorized at the workspace or feature level before activation.

See the AI Use Policy for the full position on AI features.

## 4. LOGGING AND TELEMETRY MINIMIZATION

PROOVRA seeks to avoid sending the following to monitoring and telemetry providers (including error monitoring, observability, and analytics surfaces):

- raw evidence content
- secrets, API keys, signing-key material, and OAuth tokens
- payment card numbers and payment authentication data
- unnecessary sensitive personal data

Logs and telemetry that are sent may include:

- request metadata (method, route, status code, latency)
- error traces and stack frames
- account, workspace, and request identifiers
- timestamps
- operational status codes
- user-agent strings

Diagnostic data is used for reliability, security, incident response, and abuse prevention. PROOVRA continues to improve log minimization as the platform evolves; perfect log minimization cannot be guaranteed in every error path.

## 5. ROLE NOTES

- Where a provider is listed as a **processor**, that provider processes personal data on PROOVRA's instructions to deliver the service that PROOVRA has contracted for, subject to data-protection obligations consistent with the DPA.
- Where a provider is listed as an **independent controller**, that provider determines the means and purposes of its own processing for that surface (for example, a federated sign-in flow that a user chooses to use, or a payment surface handed off to a payment processor's checkout). The provider's own privacy notice applies in addition to PROOVRA's policies.

## 6. TRANSFER MECHANISMS

For providers operating outside the EEA, UK, or Switzerland in a country that has not been recognised as providing an adequate level of protection, PROOVRA seeks to rely on appropriate transfer safeguards, including Standard Contractual Clauses (SCCs), the UK International Data Transfer Addendum, the EU-US Data Privacy Framework (DPF) where applicable, and supplementary technical and organizational measures where assessed as required. See DPA Appendix D for the full transfer framework.

## 7. CHANGE NOTICE

PROOVRA may update this register from time to time to reflect:

- additions of new subprocessors
- removal of subprocessors no longer in use
- changes to processing purpose
- changes to transfer mechanisms

Material changes are recorded in the Legal Changelog. PROOVRA seeks to give reasonable advance notice of intended changes to the subprocessor list where commercially practicable.

## 8. CUSTOMER OBJECTIONS

Where the DPA is in force between PROOVRA and a customer, the customer may object to a new subprocessor on reasonable data-protection grounds, in which case the parties will work in good faith to reach an acceptable resolution. See the DPA for the full process.

## 9. NO INVENTED CERTIFICATIONS

This register reflects PROOVRA's current best understanding of the providers it engages. PROOVRA does not claim certifications, accreditations, or audit outcomes on behalf of any provider. Each provider's own published certifications and assurances are the authoritative source for that provider's compliance posture.

## 10. RELATED DOCUMENTS

- Privacy Policy
- Cookie Policy
- Data Processing Addendum (DPA) — see Appendix C
- Technical and Organizational Measures (TOMs)
- Data Retention Policy
- Security and Responsible Disclosure
- Incident Response Policy
- AI Use Policy
- Trust Center

## 11. CONTACT

For subprocessor-related questions, contact **legal@proovra.com**.
