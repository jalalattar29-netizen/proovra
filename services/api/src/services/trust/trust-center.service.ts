/**
 * PROOVRA Phase 4A — Trust Center service.
 *
 * Versioned + auditable trust article store. Articles cover four
 * bounded kinds:
 *
 *   * TRUST_CENTER (15 sections — Platform Trust, Verification
 *     Methodology, Evidence Integrity, Trusted Timestamping,
 *     OpenTimestamps, Chain of Custody, Provenance, Security
 *     Controls, AI Governance, Reliability, Data Processing,
 *     Privacy, Subprocessors, Governance, Transparency).
 *   * METHODOLOGY (9 sections — how verification works, etc.).
 *   * AI_DISCLOSURE (12 sections — models, providers, data sent /
 *     not sent, etc.).
 *   * SECURITY (18 sections — auth / RBAC / MFA / SAML / SCIM / ...).
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * `publishArticle` writes a new TrustCenterArticleVersion row
 *     for every transition — append-only history.
 *   * Bounded `kind` + `section` + `state` vocabulary from
 *     `@proovra/shared/trust-and-governance.ts`.
 *   * NEVER PII in the bounded summary / body — content describes
 *     platform implementation, never tenant data.
 */

import type { PrismaClient } from "@prisma/client";
import {
  AI_DISCLOSURE_SECTIONS,
  METHODOLOGY_SECTIONS,
  SECURITY_SECTIONS,
  TRUST_ARTICLE_DRIFT_STATES,
  TRUST_ARTICLE_KINDS,
  TRUST_ARTICLE_STATES,
  TRUST_CENTER_SECTIONS,
  type AiDisclosureSection,
  type MethodologySection,
  type SecuritySection,
  type TrustArticleDriftState,
  type TrustArticleKind,
  type TrustArticleProjection,
  type TrustArticleState,
  type TrustArticleVersionProjection,
  type TrustCenterSection,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { AI_LEGAL_DISCLAIMER } from "../ai/ai-policy.js";
import { emitTrustArticleEvent } from "./trust-and-governance-audit.service.js";

export type UpsertArticleInput = {
  prisma?: PrismaClient;
  teamId: string;
  kind: TrustArticleKind;
  section: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  publish?: boolean;
  authoredByUserId: string;
  implementationReferences?: ReadonlyArray<string>;
  policyTags?: ReadonlyArray<string>;
};

export type UpsertArticleResult =
  | { ok: true; articleId: string; version: number; state: TrustArticleState }
  | { ok: false; denial: "POLICY_REJECTED" };

export async function upsertTrustArticle(
  input: UpsertArticleInput,
): Promise<UpsertArticleResult> {
  if (!(TRUST_ARTICLE_KINDS as ReadonlyArray<string>).includes(input.kind)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (!validateSection(input.kind, input.section)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const state: TrustArticleState = input.publish ? "PUBLISHED" : "DRAFT";
  const now = new Date();
  // Capture the prior version (if any) BEFORE the upsert so we can
  // emit TRUST_ARTICLE_SUPERSEDED with bounded {fromVersion, toVersion}
  // payload when the upsert produces a new revision.
  const existingPriorVersion = await prisma.trustCenterArticle.findFirst({
    where: {
      teamId: input.teamId,
      kind: input.kind,
      slug: input.slug,
    },
    select: { version: true },
  });
  const prevVersion = existingPriorVersion?.version ?? null;
  const article = await prisma.trustCenterArticle.upsert({
    where: {
      teamId_kind_slug: {
        teamId: input.teamId,
        kind: input.kind,
        slug: input.slug,
      },
    },
    create: {
      teamId: input.teamId,
      kind: input.kind,
      section: input.section,
      slug: input.slug,
      title: input.title.slice(0, 200),
      summary: input.summary.slice(0, 600),
      body: input.body,
      state,
      version: 1,
      authoredByUserId: input.authoredByUserId,
      publishedAtUtc: state === "PUBLISHED" ? now : null,
      implementationReferences: (input.implementationReferences ??
        []) as never,
      policyTags: (input.policyTags ?? []) as never,
    },
    update: {
      title: input.title.slice(0, 200),
      summary: input.summary.slice(0, 600),
      body: input.body,
      state,
      version: { increment: 1 },
      publishedAtUtc: state === "PUBLISHED" ? now : undefined,
      implementationReferences: (input.implementationReferences ??
        []) as never,
      policyTags: (input.policyTags ?? []) as never,
    },
    select: { id: true, version: true, state: true },
  });
  await prisma.trustCenterArticleVersion.create({
    data: {
      teamId: input.teamId,
      articleId: article.id,
      version: article.version,
      title: input.title.slice(0, 200),
      summary: input.summary.slice(0, 600),
      body: input.body,
      state,
      authoredByUserId: input.authoredByUserId,
      publishedAtUtc: state === "PUBLISHED" ? now : null,
      implementationReferences: (input.implementationReferences ??
        []) as never,
      policyTags: (input.policyTags ?? []) as never,
    },
  });
  // Emit audit lifecycle event — best-effort, never blocks the write.
  const isFirstVersion = article.version === 1;
  void emitTrustArticleEvent({
    prisma,
    teamId: input.teamId,
    articleId: article.id,
    code: isFirstVersion ? "TRUST_ARTICLE_CREATED" : "TRUST_ARTICLE_UPDATED",
    actorUserId: input.authoredByUserId,
  }).catch(() => {});
  // Any version > 1 supersedes a prior one — emit the bounded
  // SUPERSEDED audit event with {fromVersion, toVersion} payload so
  // the audit federator can render the version transition chain.
  if (!isFirstVersion && prevVersion !== null) {
    void emitTrustArticleEvent({
      prisma,
      teamId: input.teamId,
      articleId: article.id,
      code: "TRUST_ARTICLE_SUPERSEDED",
      actorUserId: input.authoredByUserId,
      payload: { fromVersion: prevVersion, toVersion: article.version },
    }).catch(() => {});
  }
  if (state === "PUBLISHED") {
    void emitTrustArticleEvent({
      prisma,
      teamId: input.teamId,
      articleId: article.id,
      code: "TRUST_ARTICLE_PUBLISHED",
      actorUserId: input.authoredByUserId,
    }).catch(() => {});
  }

  return {
    ok: true,
    articleId: article.id,
    version: article.version,
    state: article.state as TrustArticleState,
  };
}

export async function listTrustArticles(input: {
  prisma?: PrismaClient;
  teamId: string;
  kind?: TrustArticleKind;
  state?: TrustArticleState;
}): Promise<ReadonlyArray<TrustArticleProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.trustCenterArticle.findMany({
    where: {
      teamId: input.teamId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: [{ kind: "asc" }, { section: "asc" }],
  });
  return rows.map(projectArticle);
}

export async function getTrustArticleBySlug(input: {
  prisma?: PrismaClient;
  teamId: string;
  kind: TrustArticleKind;
  slug: string;
}): Promise<TrustArticleProjection | null> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.trustCenterArticle.findFirst({
    where: { teamId: input.teamId, kind: input.kind, slug: input.slug },
  });
  return row ? projectArticle(row) : null;
}

export async function listTrustArticleVersions(input: {
  prisma?: PrismaClient;
  teamId: string;
  articleId: string;
}): Promise<ReadonlyArray<TrustArticleVersionProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.trustCenterArticleVersion.findMany({
    where: { teamId: input.teamId, articleId: input.articleId },
    orderBy: { version: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    articleId: r.articleId,
    version: r.version,
    title: r.title ?? "",
    summary: r.summary ?? "",
    body: r.body,
    state: (r.state ?? "DRAFT") as TrustArticleState,
    authoredByUserId: r.authoredByUserId ?? "",
    createdAtUtc: r.createdAt.toISOString(),
    publishedAtUtc: r.publishedAtUtc?.toISOString() ?? null,
  }));
}

/**
 * Idempotent seed of every required section for every kind. The
 * platform always reports the full catalog so the Trust Center UI
 * never shows holes — sections start in DRAFT until an operator
 * publishes them or this seed re-runs with publish=true.
 */
export async function ensureTrustCenterSeed(input: {
  prisma?: PrismaClient;
  teamId: string;
  systemUserId: string;
  publish?: boolean;
}): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const seed of SEED_ARTICLES) {
    const existing = await (input.prisma ?? defaultPrisma).trustCenterArticle.findFirst({
      where: { teamId: input.teamId, kind: seed.kind, slug: seed.slug },
      select: { id: true, version: true },
    });
    const result = await upsertTrustArticle({
      prisma: input.prisma,
      teamId: input.teamId,
      kind: seed.kind,
      section: seed.section,
      slug: seed.slug,
      title: seed.title,
      summary: seed.summary,
      body: seed.body,
      publish: input.publish ?? true,
      authoredByUserId: input.systemUserId,
      implementationReferences: seed.implementationReferences,
      policyTags: seed.policyTags,
    });
    if (!result.ok) continue;
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSection(kind: TrustArticleKind, section: string): boolean {
  switch (kind) {
    case "TRUST_CENTER":
      return (TRUST_CENTER_SECTIONS as ReadonlyArray<string>).includes(section);
    case "METHODOLOGY":
      return (METHODOLOGY_SECTIONS as ReadonlyArray<string>).includes(section);
    case "AI_DISCLOSURE":
      return (AI_DISCLOSURE_SECTIONS as ReadonlyArray<string>).includes(section);
    case "SECURITY":
      return (SECURITY_SECTIONS as ReadonlyArray<string>).includes(section);
  }
}

function projectArticle(r: {
  id: string;
  kind: string;
  section: string;
  slug: string;
  title: string;
  summary: string | null;
  body: string | null;
  state: string;
  version: number;
  publishedAtUtc: Date | null;
  updatedAt: Date;
  implementationReferences: unknown;
  policyTags: unknown;
  driftState?: string | null;
}): TrustArticleProjection {
  return {
    id: r.id,
    kind: r.kind as TrustArticleKind,
    section: r.section,
    slug: r.slug,
    title: r.title,
    summary: r.summary ?? "",
    body: r.body ?? "",
    state: r.state as TrustArticleState,
    version: r.version,
    publishedAtUtc: r.publishedAtUtc?.toISOString() ?? null,
    updatedAtUtc: r.updatedAt.toISOString(),
    implementationReferences: Array.isArray(r.implementationReferences)
      ? (r.implementationReferences as ReadonlyArray<string>)
      : [],
    policyTags: Array.isArray(r.policyTags)
      ? (r.policyTags as ReadonlyArray<string>)
      : [],
    driftState: normalizeDriftStateForProjection(r.driftState),
  };
}

function normalizeDriftStateForProjection(
  value: string | null | undefined,
): TrustArticleDriftState | undefined {
  if (!value) return undefined;
  return (TRUST_ARTICLE_DRIFT_STATES as ReadonlyArray<string>).includes(value)
    ? (value as TrustArticleDriftState)
    : undefined;
}

// Compile-time guard.
function _assertStatesIntact(): void {
  const _x: TrustArticleState = "PUBLISHED";
  void _x;
  void TRUST_ARTICLE_STATES;
  const _s: TrustCenterSection = "PLATFORM_TRUST";
  void _s;
  const _m: MethodologySection = "HOW_VERIFICATION_WORKS";
  void _m;
  const _ai: AiDisclosureSection = "MODELS_USED";
  void _ai;
  const _sec: SecuritySection = "AUTHENTICATION";
  void _sec;
}
void _assertStatesIntact;

// ---------------------------------------------------------------------------
// Seed data — bounded honest content. Sourced from the actual
// implementation; no marketing language; every claim is anchored
// to an `implementationReferences` path the auditor can open.
// ---------------------------------------------------------------------------

type SeedArticle = {
  kind: TrustArticleKind;
  section: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  implementationReferences: ReadonlyArray<string>;
  policyTags: ReadonlyArray<string>;
};

const SEED_ARTICLES: ReadonlyArray<SeedArticle> = [
  // -------- TRUST_CENTER --------
  {
    kind: "TRUST_CENTER",
    section: "PLATFORM_TRUST",
    slug: "platform-trust",
    title: "Platform trust posture",
    summary:
      "PROOVRA's bounded value: capture, verification, provenance, review, redaction, governance. We delegate provider-tier extraction to vendors with bounded adapters.",
    body:
      "PROOVRA is an evidence operations platform. Every operation is workspace-anchored, every state transition is recorded, every paid provider call is budget-gated, every reviewer correction is append-only. Bounded provenance is the contract.",
    implementationReferences: [
      "services/api/src/services/intelligence/media-intelligence.service.ts",
      "services/api/src/services/intelligence/provider-budget.service.ts",
      "services/api/src/services/intelligence/intelligence-activity.service.ts",
    ],
    policyTags: ["TRUST_POSTURE"],
  },
  {
    kind: "TRUST_CENTER",
    section: "VERIFICATION_METHODOLOGY",
    slug: "verification-methodology",
    title: "Verification methodology",
    summary:
      "Every evidence artifact carries a SHA-256 hash, an OpenTimestamps proof, a custody event chain, and a verification package. The verify page renders the chain offline.",
    body:
      "Verification is anchored by: (1) cryptographic file hash, (2) trusted timestamp via OpenTimestamps, (3) custody event chain, (4) signed verification package. Each step is reproducible by an external auditor with bounded inputs.",
    implementationReferences: [
      "services/worker/src/jobs/verification-package",
      "services/api/src/routes/verify.routes.ts",
      "services/api/src/services/custody-events.service.ts",
    ],
    policyTags: ["VERIFICATION"],
  },
  {
    kind: "TRUST_CENTER",
    section: "EVIDENCE_INTEGRITY",
    slug: "evidence-integrity",
    title: "Evidence integrity",
    summary:
      "Originals are immutable. Object-locked storage. Cryptographic hashes computed at capture. Derivatives are tracked separately.",
    body:
      "Evidence rows record the original file SHA-256 at capture, and storage is configured with Object Lock so the bytes cannot be silently replaced. Reviewer corrections and redactions produce DERIVATIVES — the original remains intact.",
    implementationReferences: [
      "services/api/prisma/schema.prisma#Evidence",
      "services/api/src/services/storage.service.ts",
      "services/api/src/services/redaction",
    ],
    policyTags: ["INTEGRITY", "OBJECT_LOCK"],
  },
  {
    kind: "TRUST_CENTER",
    section: "TRUSTED_TIMESTAMPING",
    slug: "trusted-timestamping",
    title: "Trusted timestamping",
    summary:
      "Every original capture is timestamped at upload + anchored via OpenTimestamps for independent verification.",
    body:
      "The platform records UTC timestamps on every evidence row, every custody event, every workflow state. OpenTimestamps proofs are produced for the file hash so a third party can attest the file existed at the timestamped moment.",
    implementationReferences: [
      "services/worker/src/jobs/ots-anchoring",
      "services/api/src/services/custody-events.service.ts",
    ],
    policyTags: ["TIMESTAMP"],
  },
  {
    kind: "TRUST_CENTER",
    section: "OPEN_TIMESTAMPS",
    slug: "open-timestamps",
    title: "OpenTimestamps",
    summary:
      "Public, vendor-agnostic blockchain anchoring. Proofs are verifiable using the upstream `opentimestamps-client`.",
    body:
      "We use OpenTimestamps because it is open standard, public, vendor-agnostic, and verifiable offline against the public Bitcoin blockchain. Proof files are shipped inside the verification package ZIP.",
    implementationReferences: [
      "services/worker/src/jobs/ots-anchoring",
      "services/worker/src/jobs/verification-package",
    ],
    policyTags: ["TIMESTAMP", "OTS"],
  },
  {
    kind: "TRUST_CENTER",
    section: "CHAIN_OF_CUSTODY",
    slug: "chain-of-custody",
    title: "Chain of custody",
    summary:
      "Every access, every transition, every export writes a bounded custody event row. The chain is append-only.",
    body:
      "Custody events record evidence_id, actor_user_id, event_type, occurred_at_utc, plus a bounded payload. There is no delete path. The chain is rendered into the verification package and into the reviewer / portal surfaces.",
    implementationReferences: [
      "services/api/prisma/schema.prisma#CustodyEvent",
      "services/api/src/services/custody-events.service.ts",
    ],
    policyTags: ["CUSTODY"],
  },
  {
    kind: "TRUST_CENTER",
    section: "PROVENANCE",
    slug: "provenance",
    title: "Provenance",
    summary:
      "Capture device attestations (App Attest / Play Integrity), signed canonical-JSON envelopes, server-verified Ed25519 signatures.",
    body:
      "Mobile captures carry a bounded TrustEnvelope: device key + attestation + canonical-JSON-signed body. The server verifies the Ed25519 signature against the registered device key before accepting the capture.",
    implementationReferences: [
      "packages/shared/src/canonical-json.ts",
      "services/api/src/services/device-attestation.service.ts",
      "services/api/src/services/capture-signature.service.ts",
    ],
    policyTags: ["PROVENANCE", "DEVICE_TRUST"],
  },
  {
    kind: "TRUST_CENTER",
    section: "SECURITY_CONTROLS",
    slug: "security-controls",
    title: "Security controls",
    summary:
      "Authentication, authorization, RBAC, MFA, SAML, SCIM, KMS encryption, object lock, audit logging — see the Security Documentation Center.",
    body:
      "Defence in depth. RBAC governs every server-side operation. MFA + SAML governs identity. SCIM governs provisioning. KMS governs encryption. Object Lock governs evidence immutability.",
    implementationReferences: [
      "services/api/src/middleware/auth.ts",
      "services/api/src/services/access-grants.service.ts",
      "services/api/src/services/saml",
    ],
    policyTags: ["SECURITY"],
  },
  {
    kind: "TRUST_CENTER",
    section: "AI_GOVERNANCE",
    slug: "ai-governance",
    title: "AI governance",
    summary:
      "Provider-tier extraction (Azure DI / Deepgram / OpenAI / Rekognition) gated by budget + audit + reviewer corrections. AI output is never ground truth.",
    body:
      "Every paid provider call passes through `runProviderOperation`: budget gate → adapter dispatch → bounded ingest → usage event → lifecycle event. Reviewer corrections are append-only; the final confidence band is fused from provider + reviewer bands. See the AI Disclosure Center.",
    implementationReferences: [
      "services/api/src/services/intelligence/media-intelligence.service.ts",
      "services/api/src/services/intelligence/reviewer-correction.service.ts",
      "services/api/src/services/intelligence/intelligence-activity.service.ts",
    ],
    policyTags: ["AI_GOVERNANCE"],
  },
  {
    kind: "TRUST_CENTER",
    section: "RELIABILITY",
    slug: "reliability",
    title: "Reliability",
    summary:
      "Operational status surfaced via the in-platform Status Page; Better Stack integration available when bound. Honest degradation when not.",
    body:
      "Status components include API, Verification, Capture, Reports, AI Services, Azure, Deepgram, AWS, Background Workers, Queue Health, Storage Health. Incidents include investigating / identified / monitoring / resolved + postmortem.",
    implementationReferences: [
      "services/api/src/services/trust/status-page.service.ts",
    ],
    policyTags: ["RELIABILITY"],
  },
  {
    kind: "TRUST_CENTER",
    section: "DATA_PROCESSING",
    slug: "data-processing",
    title: "Data processing",
    summary:
      "All evidence is processed in the customer's workspace. Provider calls send only the bounded bytes required for the requested operation. See Subprocessors.",
    body:
      "Data is workspace-anchored on every read and write. Provider calls send only the bytes required for the requested operation (e.g. Azure DI receives the document; Deepgram receives the audio). No cross-tenant aggregation.",
    implementationReferences: [
      "services/api/src/services/intelligence/providers",
      "services/api/src/services/intelligence/media-intelligence.service.ts",
    ],
    policyTags: ["DATA_PROCESSING"],
  },
  {
    kind: "TRUST_CENTER",
    section: "PRIVACY",
    slug: "privacy",
    title: "Privacy",
    summary:
      "Reviewer corrections, audit events, and executive metrics surface bounded counts + ids + bands. Raw OCR / transcript / entity text never reaches manifests or dashboards.",
    body:
      "Privacy is enforced by the data contract: every executive surface and every audit row is bounded. Raw provider payloads are stored on the per-record `payload` JSONB column and never republished into manifests, audit, executive or report surfaces.",
    implementationReferences: [
      "packages/shared/src/media-intelligence-platform.ts",
      "services/api/src/services/intelligence/audit-transparency.service.ts",
    ],
    policyTags: ["PRIVACY", "BOUNDED_PROVENANCE"],
  },
  {
    kind: "TRUST_CENTER",
    section: "SUBPROCESSORS",
    slug: "subprocessors",
    title: "Subprocessor registry",
    summary:
      "AWS, Azure, Deepgram, OpenAI, Better Stack, Sentry, Cloudflare. Each with purpose, region, data categories, state, effective date — see the Subprocessors page.",
    body:
      "The Subprocessor Registry is the authoritative list. Every entry is versioned; every change writes a SubprocessorVersion row with a `changeSummary` for audit.",
    implementationReferences: [
      "services/api/src/services/trust/subprocessor.service.ts",
    ],
    policyTags: ["SUBPROCESSOR"],
  },
  {
    kind: "TRUST_CENTER",
    section: "GOVERNANCE",
    slug: "governance",
    title: "Governance",
    summary:
      "Organizations → Departments → Workspaces. Delegated admin tiers. Policy registry with org / dept / workspace assignment + inheritance + override.",
    body:
      "Phase 4A added tiered delegated admin (Global / Org / Department / Workspace / Reviewer Lead / Security Officer / Compliance Officer), department isolation, policy inheritance, and access reviews. See the Governance Dashboard.",
    implementationReferences: [
      "services/api/src/services/governance/delegated-admin.service.ts",
      "services/api/src/services/governance/governance-policy.service.ts",
      "services/api/src/services/governance/access-review.service.ts",
    ],
    policyTags: ["GOVERNANCE"],
  },
  {
    kind: "TRUST_CENTER",
    section: "TRANSPARENCY",
    slug: "transparency",
    title: "Transparency",
    summary:
      "Federated audit timeline across six bounded sources. Failure reasons surfaced. Budget breaches surfaced. Reviewer correction lifecycle surfaced.",
    body:
      "The Audit & Transparency Center federates provider usage, reviewer corrections, redaction activity, policy audit, video timeline, external review activity, and the canonical intelligence_activity_events table — surfacing bounded counts + ids + labels for every operator action.",
    implementationReferences: [
      "services/api/src/services/intelligence/audit-transparency.service.ts",
    ],
    policyTags: ["TRANSPARENCY"],
  },

  // -------- METHODOLOGY --------
  {
    kind: "METHODOLOGY",
    section: "HOW_VERIFICATION_WORKS",
    slug: "how-verification-works",
    title: "How verification works",
    summary:
      "Hash → trusted timestamp → custody chain → verification package. Every step reproducible offline.",
    body: "See the Verification Methodology section in the Trust Center for the bounded chain.",
    implementationReferences: ["services/api/src/routes/verify.routes.ts"],
    policyTags: ["METHODOLOGY"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_HASHING_WORKS",
    slug: "how-hashing-works",
    title: "How hashing works",
    summary:
      "SHA-256 is computed at upload. The bounded hex digest is recorded on the evidence row and shipped in the manifest.",
    body: "Evidence.fileSha256 stores the digest at capture. Re-hashing the original file at any time reproduces the same value.",
    implementationReferences: ["services/api/src/services/storage.service.ts"],
    policyTags: ["HASH"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_TRUSTED_TIMESTAMPS_WORK",
    slug: "how-trusted-timestamps-work",
    title: "How trusted timestamps work",
    summary:
      "Server records UTC timestamps for every transition; OpenTimestamps anchors the file hash to public blockchain.",
    body: "Every timestamp is UTC; every anchoring proof is offline-verifiable.",
    implementationReferences: ["services/worker/src/jobs/ots-anchoring"],
    policyTags: ["TIMESTAMP"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_OTS_WORKS",
    slug: "how-ots-works",
    title: "How OpenTimestamps works",
    summary:
      "OTS aggregates hashes into a Merkle tree, anchors the tree root on Bitcoin, then issues a `.ots` proof file per hash.",
    body: "The proof can be verified using the upstream `opentimestamps-client` against the public Bitcoin blockchain.",
    implementationReferences: ["services/worker/src/jobs/ots-anchoring"],
    policyTags: ["OTS"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_PROVENANCE_WORKS",
    slug: "how-provenance-works",
    title: "How provenance works",
    summary:
      "Mobile captures sign a canonical-JSON TrustEnvelope. The server verifies the signature against the registered device key.",
    body: "Canonical-JSON ensures byte-identical serialisation across runtimes; Ed25519 signs the bytes.",
    implementationReferences: [
      "packages/shared/src/canonical-json.ts",
      "services/api/src/services/capture-signature.service.ts",
    ],
    policyTags: ["PROVENANCE"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_VERIFICATION_PACKAGES_WORK",
    slug: "how-verification-packages-work",
    title: "How verification packages work",
    summary:
      "Verification packages are signed ZIPs containing manifests + proofs + bounded provenance. Offline-verifiable.",
    body: "Verification package manifests include trust, governance, methodology, AI disclosure, subprocessor, provider, confidence, correction history, and correction version chain entries.",
    implementationReferences: ["services/worker/src/jobs/verification-package"],
    policyTags: ["VERIFICATION_PACKAGE"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_TRUST_DECISIONS_WORK",
    slug: "how-trust-decisions-work",
    title: "How trust decisions work",
    summary:
      "Trust classes derive from device attestation strength + signature verification result + custody continuity.",
    body: "Bounded trust classes are projected into reviewer / portal / verify surfaces so the human can see why a piece of evidence is trusted.",
    implementationReferences: ["services/api/src/services/provenance.service.ts"],
    policyTags: ["TRUST_DECISIONS"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_REDACTION_WORKS",
    slug: "how-redaction-works",
    title: "How redaction works",
    summary:
      "Detection → reviewer decision → approval → derivative. Bounded detection providers; reviewer overrides every decision.",
    body: "Redaction derivatives never modify the original — derivatives are separate files with their own custody events.",
    implementationReferences: ["services/api/src/services/redaction"],
    policyTags: ["REDACTION"],
  },
  {
    kind: "METHODOLOGY",
    section: "HOW_INTELLIGENCE_WORKS",
    slug: "how-intelligence-works",
    title: "How intelligence works",
    summary:
      "Vendor-agnostic adapter pattern (Azure / Deepgram / OpenAI / Rekognition) with budget gating + reviewer correction version chain.",
    body: "Every paid provider call passes through `runProviderOperation`; every reviewer correction is append-only with explicit version chain.",
    implementationReferences: [
      "services/api/src/services/intelligence/media-intelligence.service.ts",
    ],
    policyTags: ["INTELLIGENCE"],
  },

  // -------- AI_DISCLOSURE --------
  {
    kind: "AI_DISCLOSURE",
    section: "MODELS_USED",
    slug: "models-used",
    title: "Models used",
    summary:
      "Azure Document Intelligence (OCR / layout / tables / forms); Deepgram (ASR / diarisation); OpenAI (entity extraction / document summary / text embeddings when SEMANTIC_SEARCH_ENABLED + opt-in outbound); AWS Rekognition (faces / text / labels). Local REGEX_PII fallback when OpenAI is not bound.",
    body:
      "Models are selected per operation by the provider adapter (services/api/src/services/intelligence/providers). Bounded REGEX_PII fallback runs locally when OpenAI is not configured so PII detection remains useful in air-gapped deployments. Embedding models (text-embedding-3-small by default) are gated behind both SEMANTIC_SEARCH_ENABLED=true and SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true; both default to false. Model selections are pinned per provider and recorded on every usage event so operators can audit which model produced which output.",
    implementationReferences: [
      "services/api/src/services/intelligence/providers",
      "services/api/src/services/search/embedding-provider.ts",
    ],
    policyTags: ["MODELS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "PROVIDERS_USED",
    slug: "providers-used",
    title: "Providers used",
    summary:
      "Bounded ProviderAdapter set: AZURE_DOCUMENT_INTELLIGENCE, DEEPGRAM_TRANSCRIPT, OPENAI_ENTITY_EXTRACTION, OPENAI_DOCUMENT_SUMMARY, OPENAI_EMBEDDINGS (opt-in), AWS_REKOGNITION_FACES, AWS_REKOGNITION_TEXT, AWS_REKOGNITION_LABELS, MANUAL_OPERATOR. Every call is recorded in provider_usage_events.",
    body:
      "Every provider is registered as a bounded ProviderAdapter with a typed request/response contract. The orchestrator never bypasses the adapter — there is no ad-hoc provider call path. Each call writes a provider_usage_events row with provider, operation, status, cost_usd_micros, latency_ms, and a correlation id. The Provider Status surface (/v1/intelligence/providers/health) reports the live binding state per provider. Operators can disable a provider per-workspace via policy (DISABLED_BY_POLICY state) or globally via env unset.",
    implementationReferences: [
      "packages/shared/src/media-intelligence-platform.ts",
      "services/api/src/services/intelligence/providers/provider-adapter.ts",
    ],
    policyTags: ["PROVIDERS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "DATA_SENT",
    slug: "data-sent",
    title: "Data sent to providers",
    summary:
      "Only the bytes required for the requested operation (e.g. Azure DI receives the document file; Deepgram receives the audio file; AWS Rekognition receives the image). The adapter abstracts the request shape so the orchestrator never serialises tenant metadata into the payload.",
    body:
      "Bounded per operation. Azure DI receives the document file + region-pinned endpoint. Deepgram receives the audio bytes + a bounded model parameter. OpenAI entity-extraction receives the OCR or transcript text (never the raw file, never identifiers). OpenAI embeddings receive chunked text only when SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true. AWS Rekognition receives the image bytes. Across all providers, payloads never include reviewer identities, custody events, organization names, policy state, version chains, or any cross-workspace data. Provider TLS endpoints are pinned at the adapter layer.",
    implementationReferences: [
      "services/api/src/services/intelligence/providers",
      "services/api/src/services/search/embedding-provider.ts",
    ],
    policyTags: ["DATA_BOUNDARY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "DATA_NOT_SENT",
    slug: "data-not-sent",
    title: "Data NOT sent to providers",
    summary:
      "Reviewer identities, custody events, audit events, executive metrics, organization hierarchies, departments, governance policies, version chains, capability matrix, delegated-admin grants, access-review decisions, billing state. Governance state stays inside PROOVRA.",
    body:
      "Providers receive only the bytes required to perform the requested extraction. Everything that constitutes governance state — who reviewed what, who corrected what, who escalated what, which department owns the case, which retention policy applies, who is in the org tree — never leaves the platform. Cross-workspace aggregation never happens at the provider layer; each call is workspace-scoped. The audit-transparency federator reads exclusively from PROOVRA's own tables; no provider has visibility into another tenant's data.",
    implementationReferences: [
      "services/api/src/services/intelligence/providers",
      "services/api/src/services/intelligence/audit-transparency.service.ts",
    ],
    policyTags: ["DATA_BOUNDARY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "CONFIDENCE_MODEL",
    slug: "confidence-model",
    title: "Confidence model",
    summary:
      "Provider raw confidence is mapped to a bounded band (LOW / MEDIUM / HIGH / VERY_HIGH) via classifyIntelligenceConfidence. Cut-offs: >=0.95 VERY_HIGH, >=0.8 HIGH, >=0.5 MEDIUM, else LOW. Reviewer override always wins. The final fused band is what surfaces on executive + reviewer + reporting surfaces.",
    body:
      "Provider vendors emit confidence on different scales with different semantics; the bounded band normalises them so an Azure HIGH means the same thing to a reviewer as a Deepgram HIGH. The reviewer's accept / reject / correct decision is the source of truth — if a reviewer corrects an AI output, the final band defers to the reviewer band regardless of the provider band. Confidence bands are never represented as legal certainty: they are signals to prioritise review effort, never to bypass it.",
    implementationReferences: [
      "packages/shared/src/media-intelligence-platform.ts",
      "services/api/src/services/intelligence/reviewer-correction.service.ts",
    ],
    policyTags: ["CONFIDENCE"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "HUMAN_REVIEW_MODEL",
    slug: "human-review-model",
    title: "Human review model",
    summary:
      "Every AI / provider output flows into the Reviewer Workspace. Reviewers accept, reject, or correct each output. AI output is NEVER ground truth — the reviewer decision is. Corrections are append-only with explicit version chain so the history is reproducible.",
    body:
      "The Reviewer Workspace renders the AI output alongside the original evidence, the bounded confidence band, the provider that produced the output, and the reviewer's prior decisions on related items. The reviewer's verdict writes a ReviewerCorrection row with versionNumber + parentCorrectionId + supersedesCorrectionId — there is no in-place mutation. Disagreement workflow (challenge -> second review -> supervisor -> resolution) is supported via the reviewer-disagreement.service.ts. QC sampling assigns randomised double-review to measure accuracy. The fused final confidence band always defers to the latest reviewer correction.",
    implementationReferences: [
      "services/api/src/services/intelligence/reviewer-correction.service.ts",
      "services/api/src/services/reviewer/reviewer-disagreement.service.ts",
    ],
    policyTags: ["HUMAN_REVIEW"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "CORRECTION_MODEL",
    slug: "correction-model",
    title: "Correction model",
    summary:
      "Correction lifecycle: DRAFT -> ACCEPTED, REVERTED via a new row, or SUPERSEDED via a new row that back-links the prior. No row is ever mutated to destroy history. Every transition emits a CORRECTION_* lifecycle event for the Audit & Transparency Center.",
    body:
      "The reviewer-correction.service.ts writes each correction as an append-only row with a versionNumber + parentCorrectionId for the immediate predecessor + supersedesCorrectionId for the original. A revert appends a REVERTED row referencing the row being reverted; a supersede appends a new row referencing the prior. The full chain is reconstructable for any item by walking versionNumber + parent links. The version chain is included in the verification package manifest so an external auditor can reproduce the decision trail offline. CORRECTION_CREATED / CORRECTION_ACCEPTED / CORRECTION_REVERTED / CORRECTION_SUPERSEDED lifecycle codes federate into the audit centre.",
    implementationReferences: [
      "services/api/src/services/intelligence/reviewer-correction.service.ts",
    ],
    policyTags: ["CORRECTION"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "LIMITATIONS",
    slug: "limitations",
    title: "Limitations",
    summary:
      "AI is never ground truth. The reviewer is. AI provides signals — confidence bands, candidate entities, suggested redactions — that prioritise human attention; it never substitutes for human judgement on factual truth, authorship, identity, or legal admissibility.",
    body: `AI assistance throughout PROOVRA carries the standing disclaimer: "${AI_LEGAL_DISCLAIMER}" — enforced server-side by the applyAiPolicy gate in services/api/src/services/ai/ai-policy.ts which blocks outputs containing forbidden language patterns (e.g. "this proves what happened", "legally admissible", "the person in the image is", "definitively shows"). The bounded INTELLIGENCE_PROVENANCE_LIMITATIONS list surfaces on every executive footer. Confidence bands describe model self-assessment, not external truth. Provider drift in confidence semantics is monitored by intelligence-quality.service.ts.`,
    implementationReferences: [
      "services/api/src/services/ai/ai-policy.ts",
      "packages/shared/src/media-intelligence-platform.ts",
    ],
    policyTags: ["LIMITATIONS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "KNOWN_RISKS",
    slug: "known-risks",
    title: "Known risks",
    summary:
      "Provider outages; provider drift in confidence semantics; reviewer fatigue; misuse of bounded outputs as ground truth; prompt-injection vectors in OCR / transcript content; hallucination in document summaries.",
    body:
      "Mitigations: (1) budget gates prevent runaway spend on a misbehaving provider, (2) audit federation captures every call so anomalies are reviewable, (3) per-provider quality rankings (intelligence-quality.service.ts) detect drift over time, (4) reviewer correction analytics surface systematic provider error patterns, (5) standing-limitations chips on every executive surface reinforce that AI is signal not truth, (6) the applyAiPolicy gate blocks AI outputs that drift into forbidden ground-truth language. Prompt injection in OCR / transcript content is mitigated by the bounded REGEX_PII fallback and by treating all extracted text as untrusted before reviewer confirmation.",
    implementationReferences: [
      "services/api/src/services/intelligence/intelligence-quality.service.ts",
      "services/api/src/services/ai/ai-policy.ts",
    ],
    policyTags: ["RISK"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "PROVIDER_STATUS",
    slug: "provider-status",
    title: "Provider status",
    summary:
      "Live probe state per provider is exposed via /v1/intelligence/providers/health and surfaced on the Intelligence Platform landing. Bounded states: READY, NOT_CONFIGURED, DISABLED_BY_POLICY, RATE_LIMITED, BUDGET_EXCEEDED, ERROR. Providers can be deliberately disabled without removing the rest of the trust/audit trail.",
    body:
      "Each ProviderAdapter exposes a probe that reports its current binding state. The orchestrator never asserts READY by default — NOT_CONFIGURED is the honest verdict when credentials are absent. DISABLED_BY_POLICY surfaces when a governance policy has switched the provider off for the workspace. RATE_LIMITED + BUDGET_EXCEEDED degrade callers gracefully; ERROR surfaces the last bounded error code for operator triage. Disabling a provider stops future calls; it does not delete the existing provider_usage_events, intelligence_activity_events, or reviewer correction history already recorded for prior work. The status feeds the Intelligence Platform landing card so reviewers know in advance whether AI assistance will be available before they start a case.",
    implementationReferences: [
      "services/api/src/services/intelligence/providers/provider-adapter.ts",
      "services/api/src/services/intelligence/provider-usage.service.ts",
      "services/api/src/services/intelligence/intelligence-activity.service.ts",
    ],
    policyTags: ["PROVIDER_STATUS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "AI_ACTIVITY_TRANSPARENCY",
    slug: "ai-activity-transparency",
    title: "AI activity transparency",
    summary:
      "Every provider call writes a provider_usage_events row + an intelligence_activity_events lifecycle row. The Audit & Transparency Center federates both alongside reviewer corrections, redaction activity, policy audit, video timeline, and external review activity. The stored audit trail is metadata-first: bounded identifiers, statuses, cost, failure reason, and timestamps.",
    body:
      "Operators can answer 'when did this provider call happen, who initiated it, did it succeed, why did it fail, what did it cost' from one place. The federation surfaces bounded counts, ids, and labels — never raw provider payloads, provider API secrets, or cross-workspace joins. provider_usage_events stores provider, operation, unit, cost, decision, evidence/case/project linkage, initiator, failure reason, and occurred_at_utc; intelligence_activity_events stores bounded lifecycle codes plus optional bounded payload JSON. Date-range filtering + trend math (executive-metrics service) lets operators detect anomalies and quality drift over time. The verification package includes a snapshot of the relevant audit slice so external auditors can reproduce the activity trail offline.",
    implementationReferences: [
      "services/api/src/services/intelligence/audit-transparency.service.ts",
      "services/api/src/services/intelligence/provider-usage.service.ts",
      "services/api/src/services/intelligence/intelligence-activity.service.ts",
      "services/api/src/services/intelligence/intelligence-verification-manifest.service.ts",
    ],
    policyTags: ["AI_TRANSPARENCY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "COST_TRANSPARENCY",
    slug: "cost-transparency",
    title: "Cost transparency",
    summary:
      "Per-call cost is recorded in USD micros on every provider_usage_events row. Budgets enforce CASE / PROJECT / TEAM / WORKSPACE / PROVIDER scopes with bounded enforcement modes. Breaches federate to the audit centre and surface on the Budget Center.",
    body:
      "The provider-budget.service.ts honours scopeTargetId so a per-project budget never accidentally blocks an unrelated project. Threshold status is surfaced as bounded chips (HEALTHY / APPROACHING / EXCEEDED) on the executive dashboard. Operators see per-scope spend, remaining, projected burn, and breach history. The Phase 16 semantic-search budget (semantic-budget.service.ts) extends the same model to embedding spend, enforcing per-workspace caps before any outbound call. Cost transparency is honesty-first: PROOVRA does not silently absorb breaches — operators see the verdict and decide whether to raise the cap or block the workload.",
    implementationReferences: [
      "services/api/src/services/intelligence/provider-budget.service.ts",
      "services/api/src/services/search/semantic-budget.service.ts",
    ],
    policyTags: ["COST_TRANSPARENCY"],
  },

  // -------- AI_DISCLOSURE (additions: Phase 15/16 semantic search disclosure) --------
  {
    kind: "AI_DISCLOSURE",
    section: "DATA_SENT",
    slug: "semantic-search-embeddings",
    title: "Semantic search embeddings",
    summary:
      "When SEMANTIC_SEARCH_ENABLED=true and a provider is configured, text chunks extracted from documents and transcripts are embedded into vectors for cosine-similarity retrieval. Embeddings are NEVER sent outbound unless SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND=true. Per-workspace budget gates apply. On failure the search degrades to keyword-only.",
    body:
      "services/api/src/services/search/embedding-provider.ts hosts three providers: DisabledStub (default — returns null on every call), LocalDeterministic (test-only hash-based vectors), and OpenAIEmbeddingProvider (gated). The hybrid retriever (services/api/src/services/search/evidence-search.service.ts) blends keyword + vector ranking via pgvector $queryRaw when embeddings are available; when not, it silently falls back to keyword-only and surfaces a 'semantic search disabled' chip in the UI. Embeddings are workspace-scoped — there is no cross-tenant vector pool. The semantic-budget.service.ts enforces per-workspace embedding spend caps before any outbound call.",
    implementationReferences: [
      "services/api/src/services/search/embedding-provider.ts",
      "services/api/src/services/intelligence/semantic.service.ts",
      "services/api/src/services/search/semantic-budget.service.ts",
    ],
    policyTags: ["SEMANTIC_SEARCH", "DATA_BOUNDARY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "DATA_NOT_SENT",
    slug: "outbound-flag-default",
    title: "Outbound content default",
    summary:
      "SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND defaults to FALSE. Outbound content (sending chunk text to an external embedding provider like OpenAI) requires explicit operator opt-in. The default posture is air-gapped semantic disabled — operators must affirmatively enable outbound traffic, and disabling it preserves keyword search plus existing local audit history.",
    body:
      "The dual-gate (SEMANTIC_SEARCH_ENABLED + SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND) is enforced INSIDE every provider implementation that would talk to an external service (embedding-provider.ts:261 and :545) — not relied on at a single call site, so accidentally enabling one without the other still blocks outbound traffic. Operators who run on-prem or air-gapped deployments can leave outbound disabled and either run keyword-only or wire a local embedding model in future. When outbound is disabled, the system records the disabled posture honestly rather than pretending semantic AI is available. This default reflects PROOVRA's posture: customer data does not leave the platform without an explicit operator decision documented in env config + audit logs.",
    implementationReferences: [
      "services/api/src/services/search/embedding-provider.ts",
      "services/api/src/services/search/evidence-search.service.ts",
    ],
    policyTags: ["SEMANTIC_SEARCH", "OUTBOUND_DEFAULT"],
  },

  // -------- SECURITY --------
  {
    kind: "SECURITY",
    section: "AUTHENTICATION",
    slug: "authentication",
    title: "Authentication",
    summary:
      "Session-based authentication via signed JWTs with rotation, adaptive auth risk scoring, and per-session inventory + revocation. MFA + SAML SSO available; portal sessions are token-bound.",
    body:
      "The middleware/auth.ts layer validates JWT tokens with a workspace-scoped secret on every request. The Phase 19 session-revocation.service.ts pathway lets operators or adaptive-auth signals invalidate a session immediately (revoke event emits a SecurityEvent and clears the AuthenticatedSession row). The adaptive-auth.service.ts engine can quarantine or revoke sessions automatically when risk signals fire. Session inventory (session-inventory.service.ts) lists active sessions for a user and supports bulk revoke from the operator surface. External reviewer portal sessions are issued per invitation token with bounded scope.",
    implementationReferences: [
      "services/api/src/middleware/auth.ts",
      "services/api/src/services/identity-security/session-revocation.service.ts",
      "services/api/src/services/access-control/adaptive-auth.service.ts",
      "services/api/src/services/access-control/session-inventory.service.ts",
    ],
    policyTags: ["AUTH"],
  },
  {
    kind: "SECURITY",
    section: "AUTHORIZATION",
    slug: "authorization",
    title: "Authorization",
    summary:
      "RBAC + delegated-admin tiers + per-resource capability checks. Every route requires an explicit capability check; server-side enforcement is the source of truth. Administrative actions are further bounded by access reviews and scope-aware revocation pathways.",
    body:
      "Capabilities are computed from the user's workspace role, delegated admin tier (Global / Org / Department / Workspace / Reviewer Lead / Security Officer / Compliance Officer), department scope membership, and per-resource permissions. The rbac-engine.service.ts evaluates capability requirements against the resolved actor context; identity/rbac.service.ts surfaces the role-to-capability projection that drives the UI's visibility hints. UI hints are never trusted: every mutation re-checks server-side. Access reviews act as the administrative backstop: REVOKED decisions propagate into delegated-admin grants and external-reviewer assignments so over-broad access can be removed through an append-only review workflow. Denied requests emit a bounded denial code so operators can audit who attempted what.",
    implementationReferences: [
      "services/api/src/services/access-control/rbac-engine.service.ts",
      "services/api/src/services/identity/rbac.service.ts",
      "services/api/src/services/governance/delegated-admin.service.ts",
      "services/api/src/services/governance/access-review.service.ts",
    ],
    policyTags: ["AUTHZ"],
  },
  {
    kind: "SECURITY",
    section: "RBAC",
    slug: "rbac",
    title: "Role-based access control",
    summary:
      "Workspace roles + reviewer roles + external-portal roles + 7 delegated-admin tiers. Capability projection drives the UI; the server re-enforces on every mutation.",
    body:
      "The platform-context navigation-registry.ts pins every nav entry to a capability key; the buildNavigationProjection emitter computes a per-actor capability set from the role matrix + delegated admin grants + department scope envelope. The 7 delegated-admin tiers (GLOBAL_ADMIN, ORG_ADMIN, DEPARTMENT_ADMIN, WORKSPACE_ADMIN, REVIEWER_LEAD, SECURITY_OFFICER, COMPLIANCE_OFFICER) are enforced server-side via hasDelegatedTier and apply to every Phase 4A governance mutation route. Department isolation narrows the read scope so users see evidence only for their department membership (or unrestricted if they hold a workspace-wide tier).",
    implementationReferences: [
      "services/api/src/services/platform-context/navigation-registry.ts",
      "services/api/src/services/governance/delegated-admin.service.ts",
    ],
    policyTags: ["RBAC"],
  },
  {
    kind: "SECURITY",
    section: "MFA",
    slug: "mfa",
    title: "Multi-factor authentication",
    summary:
      "In-house RFC 6238 TOTP (Time-based One-Time Password) for the operator workspace, compatible with Google Authenticator, 1Password, Authy, and other standard authenticator apps. Recovery codes are supported. External reviewer portal sessions track mfaSatisfiedAtUtc independently.",
    body:
      "MFA is implemented natively in services/api/src/services/security/mfa-totp.ts — pinned parameters are HMAC-SHA1 / 6 digits / 30-second period with a +/-1 step verification window. Secrets are generated with crypto.randomBytes (160 bits), encoded as RFC 4648 Base32 for manual entry, and rendered as otpauth:// URIs for QR-code provisioning. Verification uses timingSafeEqual to prevent timing-attack disclosure. Recovery codes are managed by mfa-recovery.ts and consumed atomically with audit-event emission. The external reviewer portal session-service.ts grants the mfa_satisfied flag separately and emits portal session events. SAML SSO is supported for external reviewer grants (see saml-assertion.service.ts) but PROOVRA does not currently delegate workspace MFA to an external IdP — verification happens in-process against the encrypted-at-rest TOTP secret.",
    implementationReferences: [
      "services/api/src/services/security/mfa-totp.ts",
      "services/api/src/services/security/mfa-recovery.ts",
      "services/api/src/services/security/mfa.service.ts",
      "services/api/src/services/external-review/portal-session.service.ts",
    ],
    policyTags: ["MFA", "status:implemented"],
  },
  {
    kind: "SECURITY",
    section: "SAML",
    slug: "saml",
    title: "SAML federation",
    summary:
      "SAML SSO supported for external reviewer grants. Identity is validated server-side.",
    body: "External reviewer role assignments bind to ssoConnectionId + allowedDomains + ssoSubjectHash.",
    implementationReferences: [
      "services/api/src/services/security/saml-assertion.service.ts",
      "services/api/src/services/security/saml-authn-request.service.ts",
      "services/api/src/services/security/saml-metadata.service.ts",
      "services/api/src/services/security/saml-user-mapping.service.ts",
      "services/api/src/services/security/saml-cert.service.ts",
      "services/api/src/services/security/saml-mapping.service.ts",
    ],
    policyTags: ["SAML"],
  },
  {
    kind: "SECURITY",
    section: "SCIM",
    slug: "scim",
    title: "SCIM provisioning",
    summary:
      "SCIM 2.0 user + group provisioning routes, token management, drift preview/reconciliation, and sync-failure replay exist in the product today. Availability remains configuration-dependent and the supported subset is intentionally bounded.",
    body:
      "PROOVRA exposes token-authenticated `/v2/scim` routes for Users and Groups, backed by scoped `ScimProvisioningToken` credentials, soft deprovisioning, and audit emission. Operators manage tokens, reconciliation preview/execute, and sync-failure replay from the SCIM Operations Center. The implementation is intentionally bounded rather than full-RFC-complete: PATCH support is limited, provisioning still requires operator configuration, and workspace readiness can remain disabled until the org explicitly enables the posture.",
    implementationReferences: [
      "services/api/src/routes/scim.routes.ts",
      "services/api/src/services/access-control/scim.service.ts",
      "services/api/src/services/access-control/scim-groups.service.ts",
      "services/api/src/services/access-control/scim-reconciliation.service.ts",
      "apps/web/app/(app)/admin/identity/scim/page.tsx",
    ],
    policyTags: ["SCIM", "status:partial"],
  },
  {
    kind: "SECURITY",
    section: "ENCRYPTION",
    slug: "encryption",
    title: "Encryption",
    summary:
      "Evidence + derivatives persist to an S3-compatible storage provider (AWS S3, Cloudflare R2, or Google Cloud Storage) over TLS; at-rest encryption is supplied by the storage provider per its bucket configuration. Production endpoints are TLS-enforced.",
    body:
      "PROOVRA does not currently configure per-tenant KMS keys or PROOVRA-managed SSE-KMS headers in the application layer — the storage layer relies on the provider's default at-rest encryption (S3 SSE-S3 by default on AWS; R2 + GCS encrypt at rest by default). In-transit security is enforced: storage.ts rejects http:// endpoints in production unless S3_ALLOW_INSECURE=true is set explicitly. Operators who require customer-managed keys must configure them at the bucket level outside PROOVRA. The KMS section of this Security Center documents the deferred-Signer/KMS posture honestly.",
    implementationReferences: [
      "services/api/src/storage.ts",
      "services/api/.env.example",
    ],
    policyTags: ["ENCRYPTION", "status:partial"],
  },
  {
    kind: "SECURITY",
    section: "KMS",
    slug: "kms",
    title: "Key management posture",
    summary:
      "Signing keys are surfaced through a canonical signer registry, and AWS KMS-backed signing is supported for evidence fingerprints and package manifests when `SIGNER_PROVIDER=aws_kms`. Storage-level customer-managed keys remain an operator-owned infrastructure choice outside the app.",
    body:
      "The signer-registry.service.ts read-model surfaces the active signer (provider, keyId, keyVersion, kmsKeyArn when applicable) plus rotation history derived from signer_staged / signer_promoted / signer_retired / signer_revoked audit events. kms-signer.ts performs AWS KMS Ed25519 signing without exposing private key material. PROOVRA does not currently manage bucket-level SSE-KMS or other storage CMKs in the application layer: operators who need that posture configure it at the storage provider.",
    implementationReferences: [
      "services/api/src/services/operations/signer-registry.service.ts",
      "services/api/src/signing/kms-signer.ts",
      "services/api/src/signing/signer.ts",
      "docs/security/signer-governance.md",
    ],
    policyTags: ["KMS", "status:partial"],
  },
  {
    kind: "SECURITY",
    section: "AUDIT_LOGGING",
    slug: "audit-logging",
    title: "Audit logging",
    summary:
      "Append-only audit federation across seven bounded sources: provider usage, reviewer corrections, redaction activity, policy audit, video timeline, external review activity, intelligence lifecycle. Trust + governance lifecycle events emit alongside.",
    body:
      "The audit-transparency.service.ts federator unifies bounded counts + ids + labels from intelligence_activity_events, provider_usage_events, reviewer_corrections, redaction_activity, policy_audit, video_timeline, and external_review_activity. The Phase 4A trust + governance lifecycle codes (TRUST_ARTICLE_CREATED / SUPERSEDED / PUBLISHED, DELEGATED_ADMIN_GRANTED / REVOKED, POLICY_BLOCK / VIOLATION, ACCESS_REVIEW_DECIDED, etc.) emit through the same emitter so operators can answer who-did-what-when from one place. Every audit row is append-only; there is no delete path. SecurityEvent rows additionally capture identity-security events (login, MFA, step-up, quarantine, revoke, webhook signature failure).",
    implementationReferences: [
      "services/api/src/services/intelligence/audit-transparency.service.ts",
      "services/api/src/services/trust/trust-and-governance-audit.service.ts",
      "services/api/src/services/security/security-event.service.ts",
    ],
    policyTags: ["AUDIT"],
  },
  {
    kind: "SECURITY",
    section: "EVIDENCE_IMMUTABILITY",
    slug: "evidence-immutability",
    title: "Evidence immutability",
    summary:
      "Originals are persisted once and never overwritten. When the storage bucket has S3 Object Lock configured, PROOVRA applies bounded retention + legal-hold semantics through the operations/object-lock-status.service.ts; otherwise immutability is enforced by the application contract (no overwrite/replace API path exists).",
    body:
      "An original evidence file is uploaded via storage.ts to a content-addressable key, its SHA-256 is recorded on the Evidence row at capture, and OpenTimestamps anchoring fixes the digest to a public-blockchain proof. Reviewer corrections + redactions produce DERIVATIVES — separate Evidence rows with their own custody events — so the original bytes remain intact and re-hash-verifiable. The bootstrap/object-lock-verification.ts probe reports whether the configured bucket actually has Object Lock enabled; the Status Page surfaces an honest verdict rather than asserting Object Lock when it is not configured.",
    implementationReferences: [
      "services/api/src/storage.ts",
      "services/api/src/services/operations/object-lock-status.service.ts",
      "services/api/src/services/evidence-complete.service.ts",
      "services/api/src/bootstrap/object-lock-verification.ts",
    ],
    policyTags: ["IMMUTABILITY"],
  },
  {
    kind: "SECURITY",
    section: "OBJECT_LOCK",
    slug: "object-lock",
    title: "S3 Object Lock",
    summary:
      "S3 Object Lock is supported when the configured storage bucket has it enabled (S3-Compliance or S3-Governance mode). PROOVRA does not silently assert Object Lock — bootstrap probes the bucket and surfaces the verdict honestly via the status page DEPENDENCY_HEALTH component.",
    body:
      "The bootstrap/object-lock-verification.ts script runs at API startup and calls GetObjectLockConfigurationCommand against the evidence bucket; the result feeds the operations/object-lock-status.service.ts read-model. When enabled, PROOVRA applies retention via PutObjectRetentionCommand and legal holds via PutObjectLegalHoldCommand (storage.ts wraps these). Retention windows are typically configured at the bucket policy level by operators. When Object Lock is NOT enabled (e.g. Cloudflare R2 today, or buckets without compliance-mode), the status page reports the gap rather than masking it.",
    implementationReferences: [
      "services/api/src/bootstrap/object-lock-verification.ts",
      "services/api/src/services/operations/object-lock-status.service.ts",
      "services/api/src/storage.ts",
    ],
    policyTags: ["OBJECT_LOCK"],
  },
  {
    kind: "SECURITY",
    section: "ACCESS_CONTROLS",
    slug: "access-controls",
    title: "Access controls",
    summary:
      "Workspace anchoring at every read + write. Capability-keyed navigation. Server-side authorisation on every route. Department scope constrains what a user can see inside a workspace. Rate limits (rate-limit.ts) gate sensitive endpoints. UI hints are never trusted: the server re-checks every mutation.",
    body:
      "Every API route accepts a teamId from the authenticated session — there is no client-supplied workspace selector. Capability checks run via the rbac-engine.service.ts before any data is read or written, and the navigation projection only emits entries the actor's capability set covers. Department isolation narrows the read scope per resolveUserDepartmentScope so users see evidence only for their department membership unless they hold an unrestricted (org/global) tier. This is PROOVRA's in-code tenant boundary: work is anchored to a workspace first, then optionally narrowed again by department scope. Rate limits (services/rate-limit.ts) use either Redis or an in-process memory bucket to throttle abusive endpoints, with cooldown for Redis outages.",
    implementationReferences: [
      "services/api/src/middleware/auth.ts",
      "services/api/src/services/access-control/rbac-engine.service.ts",
      "services/api/src/services/governance/department-scope.service.ts",
      "services/api/src/services/rate-limit.ts",
    ],
    policyTags: ["ACCESS"],
  },
  {
    kind: "SECURITY",
    section: "MONITORING",
    slug: "monitoring",
    title: "Monitoring",
    summary:
      "Sentry for error telemetry, Better Stack for uptime probes, OpenTelemetry signals for bounded spans (capture, intelligence, storage). The in-platform Status Page surfaces 13 component verdicts including OPERATIONAL / DEGRADED / DOWN / UNKNOWN.",
    body:
      "Errors flow to Sentry (when SENTRY_DSN is bound). Better Stack handles external uptime probing for public surfaces. OTEL spans are emitted from the observability/otel.ts wrapper used across capture + storage + intelligence; the worker emits its own bounded spans under the OTEL_SERVICE_NAME=worker namespace. The status-page.service.ts internal probes (DB, Redis, S3, queue, worker) plus external subprocessor probes feed the 13-component matrix; the page never asserts OPERATIONAL by default — UNKNOWN is the honest default when a probe is not configured or its upstream is unreachable.",
    implementationReferences: [
      "services/api/src/services/trust/status-page.service.ts",
      "services/api/src/services/observability/otel.ts",
      "services/api/src/services/trust/status-probes.service.ts",
      "services/api/src/services/observability/provider.ts",
      "services/worker/src/health.ts",
    ],
    policyTags: ["MONITORING"],
  },
  {
    kind: "SECURITY",
    section: "INCIDENT_RESPONSE",
    slug: "incident-response",
    title: "Incident response",
    summary:
      "Incidents tracked in the Status Page incident table with a bounded state machine: INVESTIGATING -> IDENTIFIED -> MONITORING -> RESOLVED, with optional POSTMORTEM_DRAFT and POSTMORTEM_PUBLISHED follow-ups. Updates are append-only and emit STATUS_INCIDENT_UPDATED lifecycle codes.",
    body:
      "Operators create an incident with title + severity (INFO / MINOR / MAJOR / CRITICAL) + affected component keys; each update appends an immutable StatusIncidentUpdate row. The state machine prevents backward transitions and emits a STATUS_INCIDENT_CREATED / STATUS_INCIDENT_UPDATED audit event per change. Maintenance windows are tracked separately with scheduled / in-progress / completed / cancelled states. The public status page projects the recent 60-day incident history alongside live component health.",
    implementationReferences: [
      "services/api/src/services/trust/status-page.service.ts",
    ],
    policyTags: ["INCIDENT"],
  },
  {
    kind: "SECURITY",
    section: "DISASTER_RECOVERY",
    slug: "disaster-recovery",
    title: "Disaster recovery",
    summary:
      "Disaster-recovery posture is operator-configurable at the infrastructure layer — multi-AZ storage, cross-region replication, and backup cadence are bucket-policy and database-provider decisions. PROOVRA does not enforce specific RPO/RTO targets in code today; the operations/recovery-validation.service.ts surfaces honest verdicts from infrastructure probes.",
    body:
      "Storage immutability + OTS anchoring give a strong recover-from-leak posture for evidence: an original hash is independently verifiable against the public Bitcoin blockchain regardless of which copy survives. Database backups, multi-AZ deployment, and cross-region replication are operator choices (e.g. AWS RDS automated backups, S3 cross-region replication). The recovery-validation.service.ts probes whether configured backup endpoints are reachable + whether the most recent backup is within the operator-declared SLA window, and surfaces the verdict on the operations dashboard. Specific RPO / RTO numbers depend on the chosen infrastructure tier and should be agreed per-customer in writing.",
    implementationReferences: [
      "services/api/src/services/operations/recovery-validation.service.ts",
    ],
    policyTags: ["DR", "status:partial"],
  },
  {
    kind: "SECURITY",
    section: "RETENTION",
    slug: "retention",
    title: "Retention",
    summary:
      "Retention policies are first-class, versioned lifecycle objects with workspace / regulatory / evidence-type / case scope, inheritance, and append-only history. Reconciliation workers enforce the configured windows while active holds suspend destructive outcomes.",
    body:
      "Operators create and version retention policies through retention-engine.service.ts, and lifecycle-orchestrator.service.ts remains the canonical writer of `Evidence.lifecycleState`. The governance reconciliation workers evaluate elapsed evidence, legal holds, and immutable retention before any destruction transition is attempted. There is no hidden global default: if a workspace does not configure an applicable policy, evidence persists until explicit operator action.",
    implementationReferences: [
      "services/api/src/services/governance-lifecycle/retention-engine.service.ts",
      "services/api/src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
      "services/api/src/services/lifecycle/legal-hold.service.ts",
      "services/worker/src/governance/retention-reconciliation.worker.ts",
    ],
    policyTags: ["RETENTION"],
  },
  {
    kind: "SECURITY",
    section: "DELETION",
    slug: "deletion",
    title: "Deletion",
    summary:
      "Deletion runs through bounded lifecycle workflows: retention-policy evaluation, legal-hold gates, destruction reviews, destruction certificates, and lifecycle-ledger tombstoning. Originals under Object Lock cannot be deleted until retention eligibility is satisfied.",
    body:
      "Destructive outcomes are gated twice: first by lifecycle-orchestrator.service.ts and then again by the destruction orchestrator worker at execution time. The worker emits a destruction certificate plus lineage hash, preserves tombstone rows, and records the DESTROYED transition through the lifecycle ledger rather than mutating history in place. Storage payload deletion is delegated to the existing purge processor, but the governance execution row captures the boundary and failure state so operators can audit the outcome end to end.",
    implementationReferences: [
      "services/api/src/services/governance-lifecycle/lifecycle-orchestrator.service.ts",
      "services/api/src/services/lifecycle/legal-hold.service.ts",
      "services/worker/src/governance/destruction-orchestrator.worker.ts",
      "services/worker/src/governance/immutable-storage-reconciliation.worker.ts",
    ],
    policyTags: ["DELETION"],
  },
  {
    kind: "SECURITY",
    section: "SECURITY_CONTACTS",
    slug: "security-contacts",
    title: "Security contacts",
    summary:
      "Report security issues to security@proovra.com. We acknowledge within 1 business day and provide remediation timeline updates. Coordinated disclosure is welcomed; please allow reasonable time for triage before public disclosure.",
    body:
      "PROOVRA accepts vulnerability reports via security@proovra.com. Reports should include a clear reproduction path, affected endpoints/components, and any proof-of-concept material. We commit to: (1) acknowledging receipt within 1 business day, (2) providing a triage verdict + severity within 5 business days, (3) regular status updates until resolution, (4) credit to the reporter on a published advisory if desired. We do not currently operate a paid bug-bounty programme; coordinated-disclosure researchers are listed in advisory acknowledgements with consent.",
    implementationReferences: ["packages/shared/src/index.ts"],
    policyTags: ["CONTACTS"],
  },

  // -------- SECURITY (additions: undisclosed controls with proven implementation) --------
  {
    kind: "SECURITY",
    section: "KMS",
    slug: "signer-registry",
    title: "Signer registry",
    summary:
      "Canonical read-model that surfaces the current signing key + rotation history for four bounded signing purposes (report PDF, verification package, export manifest, custody event). The active signer is derived from env config; the history is derived from append-only SecurityEvent rows.",
    body:
      "services/api/src/services/operations/signer-registry.service.ts exposes a deterministic SignerRecord for each purpose: provider (aws_kms | local_pem | disabled), keyId, keyVersion, kmsKeyArn (when applicable), algorithm, status (active / staged / retiring / retired / revoked / degraded), activatedAt, retiredAt. The rotation history comes from signer_staged / signer_promoted / signer_retired / signer_revoked audit events; the active state comes from env (SIGNER_PROVIDER, SIGNING_KEY_ID, SIGNING_KEY_VERSION, PACKAGE_SIGNING_KEY_ID, PACKAGE_SIGNING_KEY_VERSION, KMS_KEY_ID). Historical artefacts (Report.pdfSignerKeyId, VerificationPackage signing fields) are never mutated when keys rotate — the registry tracks FUTURE signing only so existing signed outputs remain reproducibly verifiable. Private key material is never returned by any API.",
    implementationReferences: [
      "services/api/src/services/operations/signer-registry.service.ts",
      "docs/security/signer-governance.md",
    ],
    policyTags: ["SIGNER", "KMS"],
  },
  {
    kind: "SECURITY",
    section: "MONITORING",
    slug: "webhook-hmac",
    title: "Webhook signature verification",
    summary:
      "Inbound webhooks are signature-verified before any payload parsing; failures emit a SecurityEvent (severity HIGH, bounded reason category) + bump the webhook_signature_failures_total metric. Outbound delivery signs each request with HMAC and sends the digest as X-Proovra-Signature.",
    body:
      "Inbound: services/api/src/services/security/webhook-signature-audit.service.ts wraps provider-specific verifiers (Stripe, etc.) and classifies failures into a bounded WebhookSignatureFailureReason vocabulary — missing_signature, invalid_signature, timestamp_out_of_range, replay_detected, malformed_payload, secret_misconfigured. Both signature-verification failures and replay rejections bump dedicated counters so operators can detect floods. The wrapper never leaks the secret, the raw signature, the payload bytes, or sensitive headers into logs. Outbound: integrations/webhooks.service.ts + packaging/webhooks/webhook-platform.service.ts sign each request with HMAC and emit the digest as the X-Proovra-Signature header (v1=<hex> format) so subscribers can verify authenticity + payload integrity.",
    implementationReferences: [
      "services/api/src/services/security/webhook-signature-audit.service.ts",
      "services/api/src/services/integrations/webhooks.service.ts",
      "services/api/src/services/packaging/webhooks/webhook-platform.service.ts",
    ],
    policyTags: ["WEBHOOK", "HMAC"],
  },
  {
    kind: "SECURITY",
    section: "ACCESS_CONTROLS",
    slug: "rate-limits",
    title: "API rate limiting",
    summary:
      "Per-route rate limits via services/rate-limit.ts using either Redis (when REDIS_URL is set) or an in-process memory bucket. Window + limit are configurable per route; the bucket reports allowed / remaining / resetAtMs to callers. Redis outages auto-degrade with cooldown.",
    body:
      "The rate-limit.ts module is the single allow/deny primitive. Routes call into it with their own key + window + limit (no global single-bucket — sensitive endpoints like login, MFA verification, invitation token redemption, and external-portal token exchange set their own bounds). On a Redis transport error the module marks Redis unavailable for RATE_LIMIT_REDIS_COOLDOWN_MS (default 15s) and falls back to the in-process memory bucket so the API stays responsive while alerting fires. Keys are normalised + capped at 512 chars to prevent unbounded key proliferation.",
    implementationReferences: [
      "services/api/src/services/rate-limit.ts",
    ],
    policyTags: ["RATE_LIMIT"],
  },
  {
    kind: "SECURITY",
    section: "AUTHENTICATION",
    slug: "session-revocation",
    title: "Session revocation",
    summary:
      "Operators and adaptive-auth signals can immediately revoke an authenticated session via the Phase 19 revokeSession() pathway. Revocation invalidates the AuthenticatedSession row, emits a SecurityEvent, and the next request from the revoked session is rejected by the auth middleware.",
    body:
      "services/api/src/services/identity-security/session-revocation.service.ts.revokeSession() marks the AuthenticatedSession row revoked + emits a session_revoked SecurityEvent with bounded reason. The middleware/auth.ts validator rejects revoked sessions on the next request. Three production callers: (1) the /v1/identity-security/sessions/:id/revoke route for operator-initiated revoke, (2) services/access-control/adaptive-auth.service.ts which auto-revokes on high-risk signals, (3) services/access-control/session-inventory.service.ts which supports bulk revoke from the operator session-inventory surface. External reviewer portal sessions revoke via the parallel portal-session.service.ts pathway.",
    implementationReferences: [
      "services/api/src/services/identity-security/session-revocation.service.ts",
      "services/api/src/services/access-control/adaptive-auth.service.ts",
      "services/api/src/services/access-control/session-inventory.service.ts",
    ],
    policyTags: ["SESSION"],
  },
  {
    kind: "SECURITY",
    section: "EVIDENCE_IMMUTABILITY",
    slug: "verification-package-signing",
    title: "Verification package signing",
    summary:
      "Verification packages are signed ZIPs containing manifests (trust, governance, methodology, AI disclosure, subprocessor, provider, confidence, correction chain) + OTS proofs + custody chain. The worker emits the package; the signer-registry tracks which key signed which package version.",
    body:
      "services/worker/src/verification-package-trust-and-governance.ts assembles the five trust + governance manifests (built by services/api/src/services/trust/trust-verification-manifest.service.ts on the API side for preview) plus the per-evidence manifests, packages them into a ZIP, and signs the archive with the active verification_package signer (per the signer-registry). The output is offline-verifiable — an external auditor with the file, the OTS proof, and the public signing key can confirm every claim without contacting PROOVRA. Schema versions are pinned (PROOVRA_TRUST_MANIFEST_V1, PROOVRA_GOVERNANCE_MANIFEST_V1, PROOVRA_METHODOLOGY_MANIFEST_V1, PROOVRA_AI_DISCLOSURE_MANIFEST_V1, PROOVRA_SUBPROCESSOR_MANIFEST_V1) so consumers can validate shape compatibility. Historical packages stay valid when keys rotate — the signer-registry preserves retired keys for verification.",
    implementationReferences: [
      "services/worker/src/verification-package-trust-and-governance.ts",
      "services/api/src/services/trust/trust-verification-manifest.service.ts",
      "services/api/src/services/operations/signer-registry.service.ts",
    ],
    policyTags: ["VERIFICATION_PACKAGE", "SIGNING"],
  },
];
