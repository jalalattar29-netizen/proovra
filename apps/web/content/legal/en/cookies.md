# Cookie Policy

Last Updated: 2026-06-23

This Cookie Policy explains how PROOVRA ("PROOVRA", "we", "us", or "our") uses cookies and similar technologies on our websites and web-based Services, and how you can control them.

PROOVRA is a digital evidence operations platform. This policy is read together with the Privacy Policy.

## 1. WHAT ARE COOKIES?

Cookies are small text files (or similar technologies such as local storage, session storage, and pixel-style markers) that store or access information on your device. They may support functions such as:

- session continuity
- login and authentication
- preference storage
- security
- service performance
- analytics and diagnostics

For simplicity, this policy refers to all such technologies as "cookies."

## 2. COOKIE CATEGORIES

PROOVRA categorizes cookies along five operational lines.

### 2.1 Strictly Necessary

Cookies required for the operation, security, and core functionality of the Services. They support authentication and session management, account login, fraud prevention, infrastructure stability, security-related controls, and navigation required for core service operation. Strictly necessary cookies may be used without consent where permitted by applicable law because they are strictly necessary for the requested service.

### 2.2 Security

Cookies and technologies used for platform security, including session-token integrity, CSRF mitigation, rate-limit telemetry, abuse prevention, MFA continuity, and account-recovery security. These are treated as part of the strictly-necessary set.

### 2.3 Preferences

Cookies that remember choices such as language settings, interface preferences, and consent state. Where required by law, these are used only after valid consent unless they are strictly necessary for a function you requested.

### 2.4 Analytics

Technologies that may help us understand page visits, feature usage, error patterns, and performance and reliability issues. Where required by law, these technologies are used only after valid consent.

### 2.5 Marketing

PROOVRA does not rely on advertising tracking as a core service function. If marketing or referral tracking is introduced in the future, it will be described in an updated policy and, where required, activated only after valid consent.

## 3. COOKIE / TECHNOLOGY INVENTORY

The table below describes the cookies and technologies the platform may set or rely on. Specific cookie names, providers, and durations may evolve with platform configuration. Where a row references a third-party provider, that provider's own policy may apply in addition to this one.

| Cookie / Technology | Provider | Purpose | Category | Duration |
|---|---|---|---|---|
| Session token (authenticated user) | PROOVRA | Authenticated session continuity, login state, workspace context | Strictly necessary | Session, or up to the configured session lifetime |
| MFA continuity token (where enabled) | PROOVRA | Maintain MFA-validated session state | Strictly necessary | Up to the MFA session lifetime |
| CSRF / anti-forgery token | PROOVRA | Protect form submissions and state-changing requests against cross-site request forgery | Strictly necessary / Security | Session |
| Workspace context cookie | PROOVRA | Remember the active workspace for an authenticated user | Strictly necessary | Up to 1 year |
| Consent state cookie | PROOVRA | Record cookie consent choices and policy version | Preferences / Required for consent management | Up to 12 months |
| Locale / language preference | PROOVRA | Remember interface language choice | Preferences | Up to 12 months |
| Rate-limit / abuse-prevention markers | PROOVRA | Identify abuse, credential stuffing, and platform misuse | Strictly necessary / Security | Short-lived |
| OAuth state cookie | PROOVRA | Maintain integrity of an OAuth sign-in handshake | Strictly necessary | Until OAuth handshake completes |
| Google OAuth session | Google | Federated authentication where the user signs in with Google | Strictly necessary (where the user chooses Google sign-in) | Governed by Google |
| Apple OAuth session | Apple | Federated authentication where the user signs in with Apple | Strictly necessary (where the user chooses Apple sign-in) | Governed by Apple |
| Stripe checkout interaction | Stripe | Process billing and payment interactions inside the Stripe checkout surface | Strictly necessary (for paid checkout only) | Governed by Stripe |
| PayPal checkout interaction (where enabled) | PayPal | Process billing interactions in the PayPal checkout surface | Strictly necessary (for paid checkout only) | Governed by PayPal |
| Cloudflare-related technologies (where deployed) | Cloudflare | Edge security, bot detection, and infrastructure protection | Strictly necessary / Security | Governed by Cloudflare |
| Reliability / error-reporting telemetry (where enabled) | Sentry | Detect crashes, performance regressions, and service errors | Analytics / Reliability | Governed by Sentry / limited by PROOVRA configuration |
| Vercel Analytics or web analytics (where enabled) | Vercel | Aggregated page and performance analytics where the Vercel deployment surface is used and analytics is enabled | Analytics | Governed by Vercel configuration |
| Cloudflare Web Analytics (where enabled) | Cloudflare | Aggregated website analytics and performance telemetry where Cloudflare Web Analytics is enabled | Analytics | Governed by Cloudflare configuration |

The current Subprocessors page lists which third-party providers are presently engaged for the platform.

Not every subprocessor sets browser cookies. Infrastructure, database, queue, and observability providers — such as Hetzner (server / cloud infrastructure), Neon (managed PostgreSQL), Upstash (Redis / queue / cache / rate limiting), AWS (storage, KMS, Rekognition, Secrets Manager), Grafana / Grafana Cloud (observability, metrics, logs), Twilio (communications), Resend (email delivery), MaxMind (geo intelligence), and OpenAI (AI assistance where enabled) — process service-side data or operational metadata without setting cookies in the user's browser. They are described on the [Subprocessors](/legal/subprocessors) page, not in this cookie inventory.

## 4. LEGAL BASIS FOR COOKIES

Where EU, EEA, UK, or Swiss law applies:

- strictly necessary and security cookies may be used where required for the requested service
- non-essential cookies or similar technologies (preferences-as-consent, analytics, marketing) are used only where valid consent has been obtained

For other regions, PROOVRA follows the cookie and tracking rules of the applicable jurisdiction.

## 5. THIRD-PARTY TECHNOLOGIES

Some cookies or similar technologies may be set or supported by third-party providers, including:

- authentication providers (for example, Google and Apple where the user chooses federated sign-in)
- payment providers (for example, Stripe; PayPal where enabled)
- infrastructure, edge, or monitoring providers (for example, Cloudflare or similar edge providers where deployed)
- analytics, reliability, or error-reporting providers (see Subprocessors for the current set)

Those providers may process limited technical data according to their own policies and contractual arrangements. See the Subprocessors page for the current list.

## 6. CONSENT MANAGEMENT

### 6.1 Consent Preference Center

Where implemented, users may manage optional cookie preferences through the cookie preference center. Choices are recorded with a consent version identifier so that the platform can track which policy version a user accepted.

### 6.2 Consent Versioning

When this Cookie Policy or the underlying consent options change materially, the consent version identifier is updated, and users may be re-prompted to renew consent for new categories or providers.

### 6.3 Withdrawing Consent

You may withdraw consent for non-essential cookies at any time by:

- using the cookie preference center where implemented
- changing your browser settings to refuse non-essential cookies
- contacting **privacy@proovra.com** for assistance

Withdrawing consent does not affect the lawfulness of processing already carried out on the basis of prior consent.

### 6.4 Regional Consent Handling

PROOVRA seeks to respect the cookie consent requirements applicable in each jurisdiction. Users in the EU/EEA, UK, and Switzerland receive a consent prompt for non-essential cookies. Users in other regions may see a different prompt or notice consistent with local law.

## 7. BROWSER CONTROLS

You may control cookies through:

- browser settings (clearing cookies, blocking third-party cookies, blocking cookies for specific sites)
- consent banner or cookie preference controls, where implemented
- device or browser privacy settings

Blocking strictly necessary cookies may prevent parts of the Services from functioning correctly, including login, MFA, and core navigation.

## 8. DO NOT TRACK

Some browsers offer "Do Not Track" or "Global Privacy Control" signals. Because no uniform standard applies across all systems, PROOVRA may not respond uniformly to such signals. PROOVRA continues to honour explicit consent choices made through the cookie preference center.

## 9. RETENTION

Cookies may persist for different periods depending on their purpose:

- session cookies end when the session ends
- persistent cookies may remain for a limited period until expiry or deletion
- preference cookies are retained for the period required to remember the choice and to support re-consent prompts when the policy version changes

Retention periods are reviewed and limited where practicable.

## 10. CHANGES TO THIS POLICY

We may update this Cookie Policy from time to time. If material changes are made, the updated version will be posted on this page with an updated effective date, and the consent version identifier may be updated. Please also see the Legal Changelog.

## 11. RELATED DOCUMENTS

- Privacy Policy
- Privacy Requests
- Data Processing Addendum (DPA)
- Subprocessors
- Technical and Organizational Measures (TOMs)
- Data Retention Policy
- Legal Changelog

## 12. CONTACT

For cookie-related questions, contact **legal@proovra.com** or **privacy@proovra.com**.
