/**
 * Phase E5 — Trust Center canonical content.
 *
 * SOURCE OF TRUTH for every Trust Center section title, description,
 * bullet point, allowed-claim chip, forbidden-claim chip, AI limitation
 * statement, and limitation/transparency note.
 *
 * Hard rules pinned by `phase-e5-trust-center.test.ts`:
 *
 *   1. Every section's body MUST consume only language that respects
 *      the boundary contract in `claims-matrix.ts`:
 *         - integrity != truth
 *         - verification != legal admissibility
 *         - AI = advisory only
 *      No section invents legal/forensic/court guarantees.
 *
 *   2. Section IDs are stable URL slugs — they back deep-links such as
 *      `/about/trust#chain-of-custody`. Renaming an ID is a breaking
 *      change for any external doc that links into a section.
 *
 *   3. The TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS list is the test-time
 *      grep allow-list. Every regex MUST stay false against the rendered
 *      Trust Center page AND against the existing report-v2 + verify +
 *      AI surfaces.
 *
 *   4. This module ships NO Trust Center claim that contradicts the
 *      actual implementation:
 *         - SHA-256 hashing
 *         - Ed25519 signing (KMS or local-pem)
 *         - RFC 3161 timestamping (when TSA_ENABLED + provider configured)
 *         - OpenTimestamps / Bitcoin anchoring (when OTS available)
 *         - S3 Object Lock retention (when configured)
 *         - Hash-chained custody events with canonical-JSON SHA-256
 *
 *   5. Every "MAY", "WHEN AVAILABLE", "IF CONFIGURED" is preserved
 *      verbatim — these qualifiers are the difference between honest
 *      transparency and an unsupported uptime/availability claim.
 *
 *   6. Strings are reusable across the public Trust Center page, the
 *      authenticated /about/trust deep-link from the Help menu, and the
 *      future on-product Trust drawer (if/when added).
 */

import {
  PROOVRA_ALLOWED_CLAIMS,
  PROOVRA_FORBIDDEN_CLAIMS,
  PROOVRA_REQUIRED_BOUNDARY_PHRASES,
} from "./claims-matrix.js";

// ---------------------------------------------------------------------------
// Section IDs — stable deep-link slugs
// ---------------------------------------------------------------------------

export const TRUST_CENTER_SECTION_IDS = [
  "verification-methodology",
  "chain-of-custody",
  "timestamping-anchoring",
  "evidence-integrity-model",
  "storage-retention",
  "security-signing",
  "automation-auditability",
  "ai-limitations",
  "operational-reliability",
  "transparency-limitations",
] as const;

export type TrustCenterSectionId = (typeof TRUST_CENTER_SECTION_IDS)[number];

// ---------------------------------------------------------------------------
// Section content
// ---------------------------------------------------------------------------

export type TrustCenterSection = {
  id: TrustCenterSectionId;
  title: string;
  summary: string;
  bullets: ReadonlyArray<string>;
  limitations: ReadonlyArray<string>;
};

export const TRUST_CENTER_PAGE_INTRO =
  "This Trust Center explains how PROOVRA operates, what its preservation and verification subsystems record, and — equally important — what it does not claim. Every section below describes the actual implementation. Statements about court acceptance, factual truth, authenticity, or legal admissibility remain external to the platform.";

export const TRUST_CENTER_PAGE_BOUNDARY_CALLOUT =
  "PROOVRA preserves recorded integrity state, custody activity, and reviewer-ready technical materials. It does not independently prove factual truth, authorship, original device-capture authenticity, or legal admissibility. Those determinations remain with the relevant court, investigator, regulator, insurer, employer, or expert process.";

export const TRUST_CENTER_SECTIONS: ReadonlyArray<TrustCenterSection> = [
  {
    id: "verification-methodology",
    title: "Verification methodology",
    summary:
      "When evidence is intake, PROOVRA records a deterministic set of integrity artifacts: per-file SHA-256 hashes, a canonical fingerprint of the record, and an Ed25519 signature over the fingerprint. The public Verify page replays these checks against the recorded state.",
    bullets: [
      "Per-file digests use SHA-256.",
      "The record-level fingerprint is a canonical JSON serialization with sorted keys, hashed with SHA-256 and signed with Ed25519.",
      "Multipart records (more than one file) carry a multipart manifest digest computed from the ordered per-part SHA-256 hashes; the manifest is reproducible.",
      "The Verify page recomputes hash continuity, signature continuity, and custody-chain continuity against the recorded state, and reports a per-check status.",
      "“Core Integrity Verified” means the verification status enum resolved to RECORDED_INTEGRITY_VERIFIED or MATERIALS_AVAILABLE in the current snapshot — not a claim of factual truth or authorship.",
    ],
    limitations: [
      "Verification proves continuity of the recorded state. It does not prove that the underlying material is true, complete, authored by a specific person, captured on a specific device, or admissible in any specific proceeding.",
      "If a check is degraded or skipped (for example because an optional anchor is not configured) the Verify page exposes that state honestly rather than approximating a passing result.",
    ],
  },
  {
    id: "chain-of-custody",
    title: "Chain of custody",
    summary:
      "Custody events form an append-only, hash-chained record of operationally significant actions taken against an evidence record — upload, signature application, timestamp application, report generation, package generation, access, legal hold transitions, and similar lifecycle transitions.",
    bullets: [
      "Each custody event carries a sequence number, event type, UTC timestamp, payload, IP address (when available), user agent (when available), the previous event's hash, and the current event's hash.",
      "Each event hash is the SHA-256 of a canonical JSON serialization including the previous event's hash. Tampering with any prior event breaks the chain at validation time.",
      "Custody events are distinct from operational audit events. The chain only validates what PROOVRA observed; it does not assert what happened outside the platform.",
    ],
    limitations: [
      "A valid custody chain is evidence of continuity within the platform. It is not evidence that no handling occurred outside the platform, nor a substitute for procedural chain-of-custody documentation maintained by the responsible team.",
      "Custody events do not assert authorship, intent, or truth of the underlying material.",
    ],
  },
  {
    id: "timestamping-anchoring",
    title: "Timestamping and anchoring",
    summary:
      "PROOVRA records external time references when supported providers are configured. Two complementary mechanisms may be available: RFC 3161 trusted timestamping and OpenTimestamps anchoring against the Bitcoin blockchain.",
    bullets: [
      "RFC 3161 timestamping (when TSA_ENABLED and a TSA provider is configured) issues a SHA-256 message imprint, sends it to the configured TSA, and stores the returned token (serial number, generation time, base64-encoded token).",
      "OpenTimestamps anchoring (when available) submits the same canonical digest to the OpenTimestamps service; the resulting proof is later upgraded with a Bitcoin transaction id once a block confirms it.",
      "Both mechanisms record an external reference for when the digest existed in its recorded form. They do not assert anything about the content itself.",
      "If a provider is unavailable or disabled, the Verify page reports the status (UNAVAILABLE / FAILED / PENDING) rather than fabricating a successful anchor.",
    ],
    limitations: [
      "An RFC 3161 token attests that a particular digest existed at the time the TSA responded — it does not attest to authorship, capture device, or factual content.",
      "An OpenTimestamps / Bitcoin anchor attests that a digest was submitted before a particular block was mined — it does not, by itself, attest to anything about the underlying material or its real-world meaning.",
      "Timestamping providers are external dependencies. PROOVRA cannot guarantee TSA or OTS availability beyond the contracts of the underlying providers.",
    ],
  },
  {
    id: "evidence-integrity-model",
    title: "Evidence integrity model",
    summary:
      "PROOVRA distinguishes integrity (what the recorded state is, and whether it has remained internally consistent since intake) from authenticity (whether the source material represents what it appears to represent) and from truth (the real-world factual claim). The platform manages the first; the second and third remain external.",
    bullets: PROOVRA_ALLOWED_CLAIMS.map((c) => c),
    limitations: PROOVRA_FORBIDDEN_CLAIMS.map((c) => `PROOVRA does not claim: ${c}`),
  },
  {
    id: "storage-retention",
    title: "Storage and retention",
    summary:
      "Evidence content and generated artifacts are stored in an S3-compatible object store. Retention policy is workspace-configured and can include immutable-retention modes where the underlying storage supports them.",
    bullets: [
      "Content is uploaded to an S3-compatible backend (AWS S3 or R2-compatible) over TLS.",
      "Where workspace policy and the underlying backend support it, objects can be written under S3 Object Lock retention. The retention mode and retain-until timestamp are recorded on the evidence record and surfaced in the verification package.",
      "Reports and verification packages are stored alongside the evidence record under the same workspace bucket; their integrity references the evidence record's fingerprint.",
      "Retention policy is operator-configured per workspace, with admin-level changes audited.",
    ],
    limitations: [
      "S3 Object Lock is an optional feature of the underlying object store. If the storage backend does not support it (or if a workspace has not configured retention), the verification package records STORAGE_PROTECTION_UNAVAILABLE rather than implying that immutability is in effect.",
      "PROOVRA does not make availability or durability guarantees beyond the contracts of the underlying storage provider.",
    ],
  },
  {
    id: "security-signing",
    title: "Security and signing",
    summary:
      "PROOVRA's posture covers signed reports and packages, transport security, encryption at rest at the storage layer, and bounded authentication / authorization surfaces. Standards claims are limited to mechanisms that are actually implemented in code.",
    bullets: [
      "Document signatures are produced with Ed25519 (with SHA-512). The signing backend can be AWS KMS or a local PEM-backed key configured via SIGNING_KEY_BACKEND; the backend is validated at startup. Private key material never leaves the signing process boundary.",
      "All HTTP traffic is served over TLS in production. Webhook deliveries are HTTPS-only and are signed with HMAC-SHA256 using a per-destination secret (Phase E3.2).",
      "Encryption at rest is provided by the storage backend (AWS S3 / R2). PROOVRA does not implement a second-layer envelope encryption above the storage backend.",
      "Authentication supports password + MFA (TOTP / SMS where configured) and SAML 2.0 SP-initiated SSO. SCIM 2.0 endpoints exist for directory integration. MFA policy is enforced per organization (Phase R8.1.3+).",
      "Audit events are recorded to an append-only security event stream. Operator actions, automation lifecycle events, and webhook delivery events are captured (Phases E3 / E3.1 / E3.2 / E3.3).",
    ],
    limitations: [
      "PROOVRA does not currently advertise SOC 2 / ISO 27001 / HIPAA / GDPR / FedRAMP attestations. When formal third-party attestations exist, they will be listed here with the auditor, scope, and report date — not before.",
      "Cryptography is not magic. Hashes prove byte-equality. Signatures prove key-holder consent at signing time. Timestamps prove an external reference existed. None of these prove real-world authorship, intent, or truth.",
    ],
  },
  {
    id: "automation-auditability",
    title: "Automation, auditability, and bounded external collaboration",
    summary:
      "Operational automation runs against a strictly bounded allow-list of triggers and actions. Every rule lifecycle transition, every run, every webhook delivery, and every external intake or external reviewer access emits an audit-grade security event.",
    bullets: [
      "Automation rules are always created disabled and require an explicit enable transition by an OWNER or ADMIN. The trigger and action types come from a fixed allow-list defined in code; rules cannot execute arbitrary scripts.",
      "Webhook deliveries are HTTPS-only, SSRF-checked at three layers (static IP block list + DNS rebinding revalidation + manual redirect handling), HMAC-signed, and bounded to 32 KiB request bodies and a per-team destination cap.",
      "Async retry is bounded to 4 total attempts with backoffs of [5, 30, 300] seconds (≤335 seconds wall-clock total) and auto-disables a destination after 10 consecutive failures.",
      "Operational analytics (Phase E4) traces every visible counter back to the underlying Prisma model + filter; counters are never fabricated and degraded sources are rendered as a missing value rather than a zero.",
      "External intake links and external reviewer grants (Phase E8) are bounded operational surfaces. Tokens are hashed in the database (never stored raw), scoped to a single intake link or a single evidence/case/package, expiring, revocable, and rate-limited where the surface is publicly reachable. Anti-enumeration is preserved — unknown, revoked, and expired tokens all surface an identical deny code.",
      "External participants never become implicit team members and never inherit workspace permissions. The capability registry has zero external-participant input; external access is a separate, narrowly-scoped path that never enters the internal permission resolver.",
    ],
    limitations: [
      "Automation provides operational reach, not investigative authority. A webhook delivery confirms that an outbound HTTP request occurred — it does not confirm what the receiving system did with the payload.",
      "Analytics counters are operational signal, not legal evidence. They are not snapshots and may change as the underlying records change.",
      "External intake and external review surfaces are bounded operational tools, not a public sharing platform. PROOVRA does not provide permanent share links, public evidence browsing, anonymous uploads outside a scoped intake link, or storage URLs that escape the backend boundary.",
    ],
  },
  {
    id: "ai-limitations",
    title: "AI usage and limitations",
    summary:
      "AI features in PROOVRA are advisory only. They assist with metadata review, reviewer guidance, and bounded operational summarization. They do not determine truth, authenticity, authorship, or admissibility, and they never mutate evidence, custody, governance, or automation state.",
    bullets: [
      "Every AI response is filtered through a server-side policy layer that strips a fixed list of unsafe phrasings before the response reaches a user surface.",
      "AI assistance can suggest reviewer steps, surface metadata patterns, and provide quality-control checks. It is never authoritative.",
      "AI output never modifies evidence content, custody events, signatures, timestamps, automation rules, webhook destinations, retention policy, or any integrity artifact.",
      "AI runs against structured-output schemas (JSON-schema strict mode). The provider returns a discriminated-status result (ok / blocked / disabled / error); the platform validates the schema before showing any AI output to the user.",
      "AI surfaces have NO tool calls, NO function calls, NO agent loops, and NO streaming. Each AI call is a bounded, complete, schema-validated response.",
      "AI input never includes raw evidence file bytes, signed storage URLs, secrets, or tokens. Filenames are redacted before being sent to the provider. Cost guards short-circuit per-user and per-evidence before any provider call.",
      "AI features are OPTIONAL. The platform fully operates with AI disabled — every workflow has a deterministic non-AI path; the noop provider returns 'disabled' status, and downstream surfaces render the deterministic result.",
    ],
    limitations: [
      "AI assistance is advisory only. It does not determine factual truth, authorship, authenticity, or legal admissibility.",
      "AI cannot substitute for human reviewer judgment, expert opinion, or legal counsel.",
      "AI features may be unavailable (cost guard, disabled-state fallback, model outage); when unavailable, the platform falls back to the non-AI workflow rather than substituting a fabricated answer.",
      "AI is never an autonomous operator. It never approves or rejects reviews, never releases legal holds, never deletes evidence, never finalizes records, never enables or disables automation rules, and never grants or revokes external access.",
      "AI is never a forensic engine, legal advisor, or admissibility scorer. Risk scores, confidence-in-truth ratings, and admissibility ratings are explicitly out of scope for the platform.",
    ],
  },
  {
    id: "operational-reliability",
    title: "Operational reliability and continuity",
    summary:
      "PROOVRA's reliability and continuity posture is honest rather than aspirational. Where mechanisms exist, they are bounded, observable, and surfaced in operational analytics. Where guarantees are not measured and published, the platform makes no claim. Phase E6 documents the actual restore and degraded-mode behaviour against the running code; the runbooks live in the repository under `docs/operations/runbooks/`.",
    bullets: [
      "Background work (webhook delivery, retry sweeps, scheduled cleanups) runs in bounded retry runtimes with measured budgets and DB-level idempotency.",
      "Operational dashboards (Phase E4) surface counts of runs, deliveries, retries, and auto-disabled destinations from real source tables — no synthetic uptime score is rendered.",
      "When a subsystem is unavailable, downstream surfaces render a degraded state (typically a “—” with an explanation) rather than substituting a fabricated success value.",
      "Restore procedures (Phase E6) are executable runbooks for: database restore, object storage restore validation, worker restart, automation runtime recovery, webhook delivery retry recovery, signing-key recovery, degraded-mode startup, report and verification-package regeneration, and audit and custody continuity validation.",
      "Critical lifecycle state (webhook deliveries, automation runs, custody events, security events, retention metadata) is DB-backed and survives a process restart. In-process timers are recovered by the bounded sweep cycle on the next worker tick.",
      "Signing keys are managed through AWS KMS or operator-controlled local-PEM. Each historical record carries its `signingKeyId` and `signingKeyVersion` snapshot so verification continuity does not depend on the current active key — provided operators retain the historical public material.",
    ],
    limitations: [
      "PROOVRA does not advertise an SLA, uptime guarantee, or response-time guarantee beyond any contract a customer separately holds. Where measurements exist, they are operational signal — not contractual commitments.",
      "The deployment architecture is single-region by default; storage durability is provider-managed. Cross-region replication and cross-zone active-active topologies are not part of the platform's advertised capabilities.",
      "PROOVRA does not provide automatic failover of application components. Recovery is operator-driven against documented runbooks.",
      "External providers (PostgreSQL host, S3 / R2, KMS, TSA, OpenTimestamps, email transport) carry their own availability. PROOVRA's continuity is bounded by the reliability of these dependencies.",
      "Restore-rehearsal cadence is operator-driven and recorded in the rehearsal log. Without rehearsal, backup is assumed rather than proven.",
    ],
  },
  {
    id: "transparency-limitations",
    title: "Transparency and limitations",
    summary:
      "This section enumerates what PROOVRA explicitly does NOT do. Enterprise reviewers should treat anything outside this list as not asserted.",
    bullets: [
      "PROOVRA records technical integrity artifacts. It is not a forensic acquisition tool and does not provide device-attested controlled capture.",
      "Verification reports and packages are reviewer-ready technical materials. They are not legal opinions, expert reports, or court-admissible determinations.",
      "Limitations are first-class. The Verify page, report-v2, verification package, and this Trust Center all carry explicit “does not prove X” boundary statements.",
    ],
    limitations: [
      "Jurisdictional rules vary. Admissibility, weight, and acceptance of any digital record remain governed by the rules of the relevant forum and the judgment of the relevant decision-maker.",
      "Timestamp, anchor, and storage providers may change. Where a record references a third-party TSA / OTS / object store, that reference's verifiability is contingent on the third party.",
      "Human reviewer judgment is required for any decision with real-world consequences. PROOVRA is a recording and verification surface — not a substitute for the reviewer.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Forbidden phrase patterns that any Trust Center / report / verify / AI
// surface MUST NOT match. The contract tests grep these patterns against
// the rendered Trust Center page + the existing safe surfaces.
//
// This list is INTENTIONALLY broader than the existing
// PROOVRA_FORBIDDEN_SURFACE_PATTERNS in claims-matrix.ts — it catches the
// extra "marketing-style" trust theatre that the prior surfaces happen
// not to use, but that a future hand could easily slip in.
// ---------------------------------------------------------------------------

export const TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS = [
  /\bcourt[- ]?ready\b/i,
  /\bcourt[- ]?certified\b/i,
  /\bcourt[- ]?grade\b/i,
  /\blegally\s*valid\b/i,
  /\blegal\s*proof\b/i,
  /\btamper[- ]?proof\b/i,
  /\bunhackable\b/i,
  /\bmilitary[- ]?grade\b/i,
  /\bbank[- ]?grade\b/i,
  /\b100%\s+secure\b/i,
  /\bperfectly\s+secure\b/i,
  /\bguarantees?\s+(?:authenticity|admissibility|court\s+acceptance)\b/i,
  // NOTE: the bare "proves factual truth" / "proves authorship" shape is
  // pinned by `PROOVRA_FORBIDDEN_SURFACE_PATTERNS` in `claims-matrix.ts`.
  // The Trust Center page-level forbidden list intentionally OMITS that
  // pattern because every safe surface (Verify, report-v2, AI policy,
  // and this Trust Center) legitimately renders the negation form ("does
  // not prove factual truth") as a boundary statement — matching the bare
  // verb on those surfaces produces false positives. The marketing-claim
  // shape is still blocked by the matrix-level guard.
  /\bSOC\s*2\s+(?:compliant|certified)\b/i,
  /\bISO\s*27001\s+(?:compliant|certified)\b/i,
  /\bHIPAA\s+(?:compliant|certified)\b/i,
  /\bGDPR\s+(?:compliant|certified)\b/i,
  /\bFedRAMP\s+(?:authorised|authorized)\b/i,
  /\bforensic\s+(?:authority|grade)\b/i,
  /\bexpert\s+witness\b/i,
  /\b99\.999*%\s+uptime\b/i,
  /\b100%\s+(?:reliable|uptime)\b/i,
  /\bzero\s+downtime\s+(?:guaranteed|promised)\b/i,
  /\btruth\s+engine\b/i,
  /\bAI[- ]?verified\b/i,
  /\bAI[- ]?authenticated\b/i,
  /\bAI[- ]?certified\b/i,
] as const;

// ---------------------------------------------------------------------------
// Required boundary phrases — Trust Center page MUST surface these.
// ---------------------------------------------------------------------------

export const TRUST_CENTER_REQUIRED_PHRASES = [
  ...PROOVRA_REQUIRED_BOUNDARY_PHRASES,
  // The page-level boundary callout must appear.
  "Those determinations remain with the relevant court",
  // The AI limitations section must explicitly state advisory-only.
  "AI assistance is advisory only",
] as const;

// ---------------------------------------------------------------------------
// Helper: deterministic deep-link to a section.
// ---------------------------------------------------------------------------

export function trustCenterDeepLink(id: TrustCenterSectionId): string {
  return `/about/trust#${id}`;
}
