# PHASE E5 — Trust Center

**Status:** CLOSED
**Closure date:** 2026-05-25
**Test suite:** `services/api/test/phase-e5-trust-center.test.ts`
**Content module:** `packages/shared-evidence-presentation/src/trust-center-content.ts`
**Frontend page:** `apps/web/app/about/trust/page.tsx`
**Public route:** `/about/trust`

---

## 1. Intent

Phase E5 ships PROOVRA's first consolidated, enterprise-readable Trust
Center. The goal is operational transparency: explain exactly how the
platform works, what it records, what it verifies, and — equally
important — what it does not claim.

The phase is deliberately NOT a marketing surface. It is read by:

- enterprise procurement reviewers,
- security & compliance reviewers,
- legal reviewers,
- prospective and existing customers verifying the platform's posture
  before relying on its output.

It must therefore be calm, technically accurate, and explicit about
limitations. Every section was written against the actual code, not
against aspirational positioning.

---

## 2. Entry-gate report

Before any code change, the four parallel audit agents inventoried
trust/integrity/AI/security wording across:

- the Verify page (`apps/web/app/verify/**`),
- report-v2 sections (cover, integrity-proof, legal-interpretation,
  executive-summary, legal-limitations, custody),
- the verification package generator,
- AI assistant components + the server-side AI policy,
- governance / security / onboarding pages,
- public marketing pages.

The result: **zero forbidden trust-theatre wording found anywhere**.
Every safe surface already carries defensive negation ("does not prove
factual truth", "does not independently establish authenticity") and the
existing `packages/shared-evidence-presentation/src/claims-matrix.ts`
guard module already enumerates `PROOVRA_ALLOWED_CLAIMS` /
`PROOVRA_FORBIDDEN_CLAIMS` / `PROOVRA_FORBIDDEN_SURFACE_PATTERNS` /
`PROOVRA_REQUIRED_BOUNDARY_PHRASES`.

Implication: Phase E5 is purely additive. No surgical wording fixes are
required to existing surfaces. The Trust Center adds (a) a content
module reusing the claims-matrix vocabulary, (b) a public Trust Center
page that consumes it, and (c) cross-surface contract tests that pin
trust-language alignment going forward.

### Trust language audit table

| Surface | Risk | Action |
| ------- | ---- | ------ |
| Verify token page | SAFE — defensive negation present | No change |
| Verify demo page | SAFE | No change |
| Report-v2 cover | SAFE | No change |
| Report-v2 integrity-proof | SAFE | No change |
| Report-v2 legal-interpretation | SAFE | No change |
| Report-v2 executive-summary | SAFE | No change |
| Report-v2 legal-limitations | SAFE | No change |
| Report-v2 custody | SAFE | No change |
| AI capture assistant | SAFE — advisory-only disclaimer | No change |
| AI chat widget | SAFE | No change |
| AI policy service | SAFE — 37-pattern blocklist enforced | No change |
| Governance hub + sub-pages | SAFE | No change |
| Security Center | SAFE — explicit "no certified / no fraud-proof" guard | No change |
| Onboarding | SAFE | No change |
| Pricing / About / public pages | SAFE | No change |

### Deferred items assigned to E5

**None.** No §6 row in `MASTER_PHASE_REGISTRY.md` lists E5 in
`Deferred to`.

---

## 3. Canonical terminology

The Trust Center distinguishes the four concepts that customers most
often conflate:

| Concept | What PROOVRA does | What PROOVRA does NOT claim |
| ------- | ----------------- | --------------------------- |
| **Integrity** | Records SHA-256 hashes, signed fingerprints, hash-chained custody, optional TSA / OTS / Object Lock metadata. Verifies continuity of the recorded state. | Does not prove that the underlying material is true, complete, or authentic at source. |
| **Authenticity** | (Not claimed.) | Not determined by the platform. Requires external evaluation (reviewer judgment, expert opinion, device-attested capture tools where applicable). |
| **Truth / factual claims** | (Not claimed.) | Not determined by the platform. Real-world meaning is external. |
| **Legal admissibility** | (Not claimed.) | Jurisdiction- and process-dependent. Decided by the relevant court / regulator / investigator / insurer. |

The canonical vocabulary lives in
`packages/shared-evidence-presentation/src/trust-center-content.ts` and
reuses the already-existing constants from `claims-matrix.ts`. Three
shared lists are pinned by tests:

- `PROOVRA_ALLOWED_CLAIMS` — five statements the platform may make.
- `PROOVRA_FORBIDDEN_CLAIMS` — eleven statements it never makes.
- `PROOVRA_REQUIRED_BOUNDARY_PHRASES` — two phrases ("recorded integrity
  state" / "does not independently prove factual truth") that must
  appear on user-facing trust surfaces.

A new list — `TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS` — extends the
guard to also block twenty-five additional marketing-theatre shapes
("court-ready", "tamper-proof", "unhackable", "military-grade", "SOC 2
compliant", "ISO 27001 compliant", "HIPAA compliant", "GDPR compliant",
"FedRAMP authorised", "99.999% uptime", "AI verified", "AI certified",
etc.). The contract test runs every pattern against both the new Trust
Center page AND every previously-safe surface, so future edits can't
silently introduce a forbidden phrase on any of them.

---

## 4. Trust Center IA

The page lives under `/about/trust` — i.e. nested in the existing
`/about/` public surface, NOT as a new root navigation item. The 32.8
canonical primaries (home / capture / evidence / cases / reports /
search) are unchanged and the test suite asserts they remain exactly
six.

Ten sections, in fixed order, each a sibling card with deep-link
support (`/about/trust#<section-id>`):

1. `verification-methodology`
2. `chain-of-custody`
3. `timestamping-anchoring`
4. `evidence-integrity-model`
5. `storage-retention`
6. `security-signing`
7. `automation-auditability`
8. `ai-limitations`
9. `operational-reliability`
10. `transparency-limitations`

Every section ships:

- a one-paragraph summary,
- a "what is recorded" bullet list,
- a clearly-styled "Limitations" sub-block (amber-tinted, separated
  from the body) so the boundary is first-class rather than buried.

The page also surfaces a section index at the top and a related-docs
panel at the bottom linking to the existing detailed legal pages
(`/legal/verification-methodology`, `/legal/security`, etc.). The Trust
Center is a SUMMARY — it does not duplicate the legal text.

---

## 5. Verification methodology section

The methodology section names the actual cryptographic primitives used,
not aspirational ones:

- per-file SHA-256,
- record-level fingerprint via canonical-JSON SHA-256 + Ed25519
  signature,
- multipart manifest digest computed from ordered per-part hashes
  (reproducible),
- public Verify page replays each check against the recorded snapshot
  and reports a per-check status,
- "Core Integrity Verified" means the verification status enum
  resolved to `RECORDED_INTEGRITY_VERIFIED` or `MATERIALS_AVAILABLE` in
  the current snapshot. It is NOT a claim of factual truth or
  authorship.

---

## 6. Chain of custody section

Custody events form an append-only, hash-chained record of operational
actions. Each event carries:

- sequence number,
- event type,
- UTC timestamp,
- payload (operational metadata),
- IP address (when available),
- user agent (when available),
- previous event's hash (sha256),
- current event's hash (sha256 over canonical JSON).

The section explicitly distinguishes:

- a valid custody chain → continuity of platform-observed activity,
- vs. a procedural chain-of-custody → external documentation
  maintained by the responsible team, which the platform does not
  generate or substitute for.

---

## 7. Security and signing section

The section names the implemented signing posture:

- **Ed25519** with **SHA-512** signing, via `SIGNING_KEY_BACKEND` =
  `aws-kms` OR `local-pem`, validated at startup, private key material
  never leaves the signing process.
- HTTPS / TLS in production for all transport.
- Webhook deliveries HTTPS-only with **HMAC-SHA256** signing
  (Phase E3.2), bounded to 32 KiB request bodies and a per-team
  destination cap.
- Encryption at rest provided by the storage backend (AWS S3 / R2). No
  second-layer envelope encryption is claimed beyond the backend.
- Authentication: password + MFA (TOTP / SMS where configured), SAML
  2.0 SP-initiated SSO, SCIM 2.0 endpoints for directory integration.
  MFA policy enforced per organization (Phase R8.1.3+).
- Audit events recorded to an append-only security event stream
  (Phases E3 / E3.1 / E3.2 / E3.3).

The limitations sub-block explicitly states that PROOVRA does NOT
currently advertise SOC 2 / ISO 27001 / HIPAA / GDPR / FedRAMP
attestations, and that any future attestation will be listed only when
the auditor, scope, and report date are real.

---

## 8. AI limitations section

The AI section aligns with `services/api/src/services/ai/ai-policy.ts`:

- AI assistance is advisory only.
- AI does not determine factual truth, authorship, authenticity, or
  legal admissibility.
- AI output never modifies evidence content, custody events,
  signatures, or any integrity artifact.
- Every AI response passes through a server-side policy that strips a
  fixed list of unsafe phrasings before reaching a user surface.

These exact phrasings are reused across the Trust Center, the AI
assistant component disclaimers, and the AI chat widget — no drift.

---

## 9. Operational reliability section

The reliability section is honest rather than aspirational:

- bounded retry runtimes with measured budgets (Phase E3.3),
- operational analytics surfaces real counts from real source tables
  (Phase E4); no synthetic uptime score is rendered,
- when a subsystem is unavailable, downstream surfaces render a
  degraded state — never a fabricated success value.

The limitations sub-block explicitly states that PROOVRA does NOT
advertise an SLA, uptime guarantee, or response-time guarantee beyond
contracts a customer separately holds.

---

## 10. Transparency and limitations section

The final section is the most important:

- PROOVRA is NOT a forensic acquisition tool. It does not provide
  device-attested controlled capture.
- Verification reports and packages are reviewer-ready technical
  materials, NOT legal opinions or court-admissible determinations.
- Jurisdictional rules vary. Admissibility, weight, and acceptance
  remain governed by the relevant forum.
- Timestamp / anchor / storage providers are external dependencies.
- Human reviewer judgment is required for any decision with real-world
  consequences.

---

## 11. Frontend implementation

`apps/web/app/about/trust/page.tsx` is a **server component** (no
`"use client"`) — the page contains no client interactivity beyond
`Link`. It:

- imports `TRUST_CENTER_SECTIONS`, `TRUST_CENTER_PAGE_INTRO`, and
  `TRUST_CENTER_PAGE_BOUNDARY_CALLOUT` from the shared content module
  (no hard-coded copy);
- renders one `SectionCard` per section via `.map`;
- uses calm enterprise styling (no marketing hero, no animated counters,
  no fake compliance badges);
- exposes `data-trust-section-*` test hooks on every block;
- links DOWN to the existing legal pages rather than duplicating them.

The page is added to the footer's existing "Trust & Verification"
column as the top entry — readers reach the Trust Center first, and
the deeper legal docs second.

---

## 12. Cross-product wording alignment

Phase E5 introduces a single source of truth (the content module) and
a cross-surface contract test that runs every
`TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS` regex against:

- the Trust Center page itself,
- the content module body,
- the Verify token page,
- the Verify demo page,
- report-v2 cover / integrity-proof / legal-interpretation /
  legal-limitations sections,
- the AI capture assistant,
- the AI chat widget,
- the AI policy service.

The blocklist arrays inside ai-policy.ts are sanitised before grep so
the test does not trip on the regexes that DEFINE the blocklist. Any
future PR that introduces a forbidden phrase on any of these surfaces
fails the test.

---

## 13. Architecture invariants preserved

- 32.8 IA: root nav still exactly the 6 canonical primaries
  (asserted by Test 6).
- No new client-state / queue / pubsub library.
- No new Prisma migration (this phase is content + page + tests only).
- No capture / custody / finalize / signing / timestamp / report /
  package mutation — file-size pins on the five protected core files
  remain green (asserted by Test 9).
- No new automation / auth / runtime behaviour (asserted by Test 7).
- No `eval` / `new Function` / runtime fetch in the page or content
  module (asserted by Test 7).
- No new feature flag (the page is unconditional, public).

---

## 14. Test inventory

`services/api/test/phase-e5-trust-center.test.ts` covers 10 test
groups:

1. Section IDs stable + canonical (5 cases).
2. Required boundary phrases present (4 cases + per-required-phrase
   parametrised cases).
3. Forbidden phrases NOT present in Trust Center page + content body
   (parametrised over `TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS`).
4. Cross-surface alignment — same forbidden patterns false on 9 safe
   surfaces (parametrised).
5. Page consumes the shared content module (4 cases).
6. IA preservation — page at `/about/trust`, 32.8 primaries still 6,
   footer link, legal-doc cross-links (4 cases).
7. No automation / auth / runtime / mutation behaviour introduced
   (4 cases).
8. Content alignment with existing claims-matrix guard (2 cases).
9. File-size pins on protected core files (5 cases).
10. Documentation + registry updated (2 cases).

Total: **~330 cases** (most growth comes from parametrisation across
the 9 safe surfaces × the forbidden pattern list).

---

## 15. CR1.7 closure summary

- **Entry-gate checklist:** completed in writing before any code edit.
- **Files added:**
  - `packages/shared-evidence-presentation/src/trust-center-content.ts`
    (new, source of truth).
  - `apps/web/app/about/trust/page.tsx` (new, public page).
  - `services/api/test/phase-e5-trust-center.test.ts` (new, ~330 cases).
  - `docs/product/PHASE_E5_TRUST_CENTER.md` (this file).
- **Files modified:**
  - `packages/shared-evidence-presentation/src/index.ts` — re-exports
    the new content module.
  - `apps/web/components/Footer.tsx` — adds Trust Center as the top
    entry in the existing "Trust & Verification" column.
  - `docs/recovery/MASTER_PHASE_REGISTRY.md` — Phase E5 row added.
- **No new DEFs opened.** Phase E5 is self-contained.
- **No DEFs resolved.** No prior phase deferred trust-language work
  to E5.
- **No migration drift allow-list update required** — Phase E5 does
  not ship a Prisma migration.
- **Inverse-pin flips:** none.

---

## 16. Remaining risks

- The Trust Center is honest about what PROOVRA does and does not do.
  Future edits MUST keep the page in sync with the actual codebase. If
  the platform gains a real attestation (SOC 2 Type 2, ISO 27001), the
  attestation must be listed only when the auditor, scope, and report
  date are real.
- The forbidden-phrase list is broader than the `claims-matrix.ts`
  list. New surfaces that consume the claims matrix will only be
  guarded by the matrix's narrower list unless they're added to the
  E5 cross-surface test array.

---

## 17. Out of scope (deliberate)

- A trust score / authenticity score / admissibility score (would
  contradict the boundary contract).
- Embedded compliance badges (no SOC 2 / ISO / HIPAA / GDPR badges
  until they are real).
- Marketing hero / animated counters / "trust theatre" styling.
- New root navigation item.
- Public API documentation portal (a future, separate phase if needed).
- Customer-facing audit log viewer (a future, separate phase).

---

## 18. Next safe phase

Phase E6 (if planned) should focus on a bounded next-step in the
enterprise-readiness scorecard, NOT on expanding the Trust Center. The
Trust Center is intentionally finished as a v1 surface — its value
comes from being calm, accurate, and stable, not from constant churn.

Candidate scopes for E6:
- Customer-facing audit log viewer (bounded, capability-gated).
- Public status page (real metrics only, no fabricated uptime).
- SCIM 2.0 directory sync hardening (close DEF-002-adjacent items).
- Live IdP pilot rehearsal (resolves DEF-002 when the pilot completes).

The Trust Center remains a single-source-of-truth surface; any further
trust-language work for newly-added subsystems goes into the existing
content module rather than spawning sibling pages.
