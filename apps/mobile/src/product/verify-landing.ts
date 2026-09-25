/**
 * PUBLIC VERIFY LANDING (T-14) — the web /verify page (VerifyHero,
 * VerifyMaterialsSection, VerifyOpensSection, VerifyBoundariesSection,
 * VerifyUseCasesSection, VerifyFinalCta), verbatim, for the native verify
 * screen before a token is entered. Copy only: no fetch, no React.
 */

export const VERIFY_HERO = {
  eyebrow: "Public Verify",
  title: "Review digital evidence through a verification-first record.",
  titleAccent: "No account required.",
  body:
    "Open a PROOVRA verification token or public verification ID to inspect recorded integrity state, custody context, timing context, access activity, and supporting verification materials where available.",
  chips: ["Read-only verification", "No account required", "Reviewer-facing record", "Public verification token"],
  boundaryLead: "Boundary notice.",
  boundary:
    "PROOVRA verifies recorded technical and workflow materials. It does not determine factual truth, authorship, identity, legal admissibility, or evidentiary weight.",
  helpers: [
    "Inspect recorded integrity and custody context.",
    "Review available reports, timestamps, signatures, and supporting materials.",
    "Use for external review, compliance review, claims review, or independent technical inspection.",
  ],
} as const;

export const VERIFY_TOKEN_CARD = {
  title: "Enter verification token",
  subtitle: "Paste the token from a PROOVRA report or shared verification record.",
  label: "Verification token or public verification ID",
  placeholder: "Paste token here",
  emptyError: "Enter a verification token to continue.",
  help: "This opens a read-only verification view. It does not modify the evidence record.",
  submit: "Open verification",
} as const;

export const VERIFY_MATERIALS = {
  title: "Verification Materials May Include",
  body:
    "A public verification record may expose selected review materials depending on what was recorded, shared, and supported for the evidence record.",
  items: ["SHA-256 Fingerprints", "Chain of Custody", "Timestamp Context", "Digital Signatures", "Verification Reports", "Access Activity"],
} as const;

export const VERIFY_OPENS = {
  title: "What Public Verify opens.",
  body: "A reviewer-facing read of the recorded evidence record. Public Verify exposes the materials shared on that record — nothing more.",
  cards: [
    { title: "Integrity state", body: "Review whether the inspected record matches the recorded fingerprint and integrity materials." },
    { title: "Custody context", body: "Inspect custody events, access activity, review activity, and handling context where available." },
    { title: "Timing context", body: "Review timestamp, OpenTimestamps, or anchoring context where enabled and recorded." },
    { title: "Review materials", body: "Open reviewer-facing reports, verification summaries, and supporting materials where shared." },
    { title: "Access boundaries", body: "See only the materials made available through the public verification route." },
    { title: "Technical details", body: "Inspect hashes, signatures, metadata, storage-protection indicators, and verification status where available." },
  ],
} as const;

export const VERIFY_BOUNDARIES = {
  eyebrow: "What PROOVRA does not decide",
  title: "Public verification exposes context.",
  titleAccent: "It does not decide outcomes.",
  body:
    "Public verification exposes recorded technical and operational context. Final factual, legal, procedural, or expert conclusions remain the responsibility of qualified reviewers.",
  outOfScopeLabel: "Out of scope",
  outOfScope: ["Factual truth", "Authorship", "Identity", "Legal admissibility", "Evidentiary weight", "Court acceptance", "Whether a real-world event happened"],
} as const;

export const VERIFY_USE_CASES = {
  eyebrow: "For reviewers and organizations",
  title: "Built for review across functions.",
  cards: [
    { title: "Legal review", body: "Inspect verification context during matter assessment or external disclosure." },
    { title: "Compliance review", body: "Walk through recorded materials when audit or governance inquiries arise." },
    { title: "Claims review", body: "Examine evidence in insurance, warranty, or liability assessment workflows." },
    { title: "Internal investigations", body: "Use the read-only view during internal escalation or post-incident handling." },
    { title: "External disclosure", body: "Share a reviewer-facing record without granting account access." },
    { title: "Technical verification", body: "Inspect hashes, signatures, and verification materials independently." },
  ],
} as const;

export const VERIFY_FINAL_CTA = {
  title: "Start reviewing a verification record.",
  body: "Review a PROOVRA verification token online.",
} as const;
