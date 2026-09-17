export const PROOVRA_ALLOWED_CLAIMS = [
  "PROOVRA preserves recorded integrity state after intake.",
  "PROOVRA records custody and access activity.",
  "PROOVRA supports technical verification of recorded hashes, signatures, and package materials.",
  "PROOVRA can provide reviewer-ready technical materials.",
  "TSA, OTS, and Object Lock are supporting technical signals when available and verified.",
] as const;

export const PROOVRA_FORBIDDEN_CLAIMS = [
  "PROOVRA proves factual truth.",
  "PROOVRA proves authorship.",
  "PROOVRA proves identity.",
  "PROOVRA proves legal admissibility.",
  "PROOVRA proves evidentiary weight.",
  "PROOVRA proves original device capture authenticity.",
  "PROOVRA guarantees court acceptance.",
  "PROOVRA guarantees anti-tamper capture at source.",
  "PROOVRA equals Cellebrite-style forensic acquisition.",
  "PROOVRA equals Truepic-style device-attested controlled capture.",
  "AI determines authenticity, admissibility, or truth.",
] as const;

export const PROOVRA_FORBIDDEN_SURFACE_PATTERNS = [
  /\bauthenticity verified\b/i,
  /\bevidence truth verified\b/i,
  /\bproves factual truth\b/i,
  /\bproves authorship\b/i,
  /\bproves identity\b/i,
  /\blegally admissible\b/i,
  /\badmissible in court\b/i,
  /\bguarantees legal admissibility\b/i,
  /\bguarantees court acceptance\b/i,
  /\bguarantees anti-tamper capture(?: at source)?\b/i,
  /\btruepic-style\b/i,
  /\bcellebrite-style\b/i,
  /\bai (?:verified|certified|determined) (?:the )?evidence\b/i,
  // UC-0 — acquisition overclaims. An acquisition statement says which channel
  // received the bytes; it never makes the content, the device or the capture
  // "verified", "authentic" or tamper-proof. The retired public labels
  // ("Class A — Verified at source", "Class B — Browser captured") are here so
  // they cannot return.
  /\bverified at source\b/i,
  /\bbrowser captured\b/i,
  /\bverified capture\b/i,
  /\bcaptured and verified\b/i,
  /\bunfakeable\b/i,
  /\btamper-?proof\b/i,
  /\bauthentic screenshot\b/i,
  /\bproves the message was sent\b/i,
] as const;

/**
 * UC-0 — the acquisition claims PROOVRA may make. Every surface states
 * acquisition through `resolveEvidenceAcquisition` (@proovra/shared), whose
 * statements are these facts, plus ACQUISITION_GLOBAL_QUALIFIER.
 */
export const PROOVRA_ALLOWED_ACQUISITION_CLAIMS = [
  "Uploaded to PROOVRA by a signed-in account.",
  "Submitted to PROOVRA through a secure intake link.",
  "Submitted through the PROOVRA mobile app in a server-issued capture session.",
  "How this record entered PROOVRA was not recorded when it was created.",
] as const;

export const PROOVRA_REQUIRED_BOUNDARY_PHRASES = [
  "recorded integrity state",
  "does not independently prove factual truth",
] as const;

export const PROOVRA_MULTIPART_REVIEWER_EXPLANATION =
  "This evidence record contains multiple preserved files. The root integrity digest is computed from the ordered SHA-256 hashes of the included evidence parts. No single original-file hash represents the whole record.";

export const PROOVRA_MULTIPART_RECOMPUTATION_NOTE =
  "Each part still has its own SHA-256. The multipart manifest digest can be recomputed from the ordered per-part hashes.";

export const PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE =
  "This verifies recorded integrity, not factual truth or original device capture authenticity.";
