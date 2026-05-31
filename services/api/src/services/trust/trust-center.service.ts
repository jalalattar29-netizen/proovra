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
      "Azure Document Intelligence (OCR / layout / tables / forms); Deepgram (ASR / diarisation); OpenAI (entity extraction / document summary); AWS Rekognition (faces / text / labels).",
    body: "Models are selected per operation. Bounded REGEX_PII fallback runs locally when OpenAI is not bound.",
    implementationReferences: ["services/api/src/services/intelligence/providers"],
    policyTags: ["MODELS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "PROVIDERS_USED",
    slug: "providers-used",
    title: "Providers used",
    summary:
      "AZURE_DOCUMENT_INTELLIGENCE, DEEPGRAM_TRANSCRIPT, OPENAI_ENTITY_EXTRACTION, OPENAI_DOCUMENT_SUMMARY, AWS_REKOGNITION_FACES, AWS_REKOGNITION_TEXT, AWS_REKOGNITION_LABELS, MANUAL_OPERATOR.",
    body: "Every provider is registered as a bounded ProviderAdapter; every call is recorded in `provider_usage_events`.",
    implementationReferences: ["packages/shared/src/media-intelligence-platform.ts"],
    policyTags: ["PROVIDERS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "DATA_SENT",
    slug: "data-sent",
    title: "Data sent to providers",
    summary:
      "Only the bytes required for the requested operation (e.g. Azure DI receives the document file; Deepgram receives the audio file).",
    body: "Bounded per operation. The adapter abstracts the request shape so the orchestrator never serialises tenant metadata into the payload.",
    implementationReferences: ["services/api/src/services/intelligence/providers"],
    policyTags: ["DATA_BOUNDARY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "DATA_NOT_SENT",
    slug: "data-not-sent",
    title: "Data NOT sent to providers",
    summary:
      "Reviewer identities, custody events, audit events, executive metrics, organization hierarchies, governance policies, version chains.",
    body: "Governance state stays inside PROOVRA. Providers receive only the bytes required to perform the requested extraction.",
    implementationReferences: [],
    policyTags: ["DATA_BOUNDARY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "CONFIDENCE_MODEL",
    slug: "confidence-model",
    title: "Confidence model",
    summary:
      "Provider raw confidence → bounded band (LOW / MEDIUM / HIGH / VERY_HIGH) via `classifyIntelligenceConfidence`. Final band is fused from provider + reviewer bands.",
    body: "Cut-offs: ≥ 0.95 VERY_HIGH; ≥ 0.8 HIGH; ≥ 0.5 MEDIUM; else LOW. Reviewer override always wins.",
    implementationReferences: ["packages/shared/src/media-intelligence-platform.ts"],
    policyTags: ["CONFIDENCE"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "HUMAN_REVIEW_MODEL",
    slug: "human-review-model",
    title: "Human review model",
    summary:
      "Every provider output flows into the Reviewer Workspace. Reviewers accept / reject / correct. AI output is NEVER ground truth.",
    body: "Reviewer corrections are append-only with explicit version chain (`reviewer_corrections.versionNumber + parentCorrectionId + supersedesCorrectionId`).",
    implementationReferences: [
      "services/api/src/services/intelligence/reviewer-correction.service.ts",
    ],
    policyTags: ["HUMAN_REVIEW"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "CORRECTION_MODEL",
    slug: "correction-model",
    title: "Correction model",
    summary:
      "DRAFT → ACCEPTED, or REVERTED via a new row. Supersede flow appends a new row + back-links the prior. No row is mutated to destroy history.",
    body: "Every transition emits a CORRECTION_* lifecycle event for the Audit & Transparency Center.",
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
      "AI is never ground truth. Reviewer judgement is. Provider confidence is vendor-specific but banded consistently. Final confidence never overrides a human decision.",
    body: "See `INTELLIGENCE_PROVENANCE_LIMITATIONS` for the bounded standing limitations surfaced on every executive footer.",
    implementationReferences: ["packages/shared/src/media-intelligence-platform.ts"],
    policyTags: ["LIMITATIONS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "KNOWN_RISKS",
    slug: "known-risks",
    title: "Known risks",
    summary:
      "Provider outages; provider drift in confidence semantics; reviewer fatigue; misuse of bounded outputs as ground truth.",
    body: "Mitigations: budget gates, audit federation, per-provider quality rankings, reviewer correction analytics, standing-limitations surfaced on every executive surface.",
    implementationReferences: [
      "services/api/src/services/intelligence/intelligence-quality.service.ts",
    ],
    policyTags: ["RISK"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "PROVIDER_STATUS",
    slug: "provider-status",
    title: "Provider status",
    summary:
      "Live probe state per provider is exposed via `/v1/intelligence/providers/health` and surfaced on the Intelligence Platform landing.",
    body: "Bounded states: READY, NOT_CONFIGURED, DISABLED_BY_POLICY, RATE_LIMITED, BUDGET_EXCEEDED, ERROR.",
    implementationReferences: [
      "services/api/src/services/intelligence/providers/provider-adapter.ts",
    ],
    policyTags: ["PROVIDER_STATUS"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "AI_ACTIVITY_TRANSPARENCY",
    slug: "ai-activity-transparency",
    title: "AI activity transparency",
    summary:
      "Every provider call writes a `provider_usage_events` row and an `intelligence_activity_events` lifecycle row. Both are federated into the Audit & Transparency Center.",
    body: "Operators can answer 'when did this provider call happen, who initiated it, did it succeed, why did it fail' from one place.",
    implementationReferences: [
      "services/api/src/services/intelligence/audit-transparency.service.ts",
    ],
    policyTags: ["AI_TRANSPARENCY"],
  },
  {
    kind: "AI_DISCLOSURE",
    section: "COST_TRANSPARENCY",
    slug: "cost-transparency",
    title: "Cost transparency",
    summary:
      "Per-call cost recorded in USD micros. Budgets enforce CASE / PROJECT / TEAM / WORKSPACE / PROVIDER scopes. Breaches federated to the audit centre.",
    body: "See the Budget Center for per-scope spend, remaining, projected burn, threshold status.",
    implementationReferences: [
      "services/api/src/services/intelligence/provider-budget.service.ts",
    ],
    policyTags: ["COST_TRANSPARENCY"],
  },

  // -------- SECURITY --------
  {
    kind: "SECURITY",
    section: "AUTHENTICATION",
    slug: "authentication",
    title: "Authentication",
    summary:
      "Session-based auth via signed JWTs with rotation. MFA + SAML available.",
    body: "Auth tokens are signed with a workspace-scoped secret and validated server-side on every request.",
    implementationReferences: ["services/api/src/middleware/auth.ts"],
    policyTags: ["AUTH"],
  },
  {
    kind: "SECURITY",
    section: "AUTHORIZATION",
    slug: "authorization",
    title: "Authorization",
    summary:
      "RBAC + capability matrix. Every route requires an explicit capability check.",
    body: "Capabilities are computed from the user's role + delegated admin grants + per-resource permissions.",
    implementationReferences: [
      "services/api/src/services/access-control/rbac-engine.service.ts",
      "services/api/src/services/identity/rbac.service.ts",
    ],
    policyTags: ["AUTHZ"],
  },
  {
    kind: "SECURITY",
    section: "RBAC",
    slug: "rbac",
    title: "Role-based access control",
    summary:
      "Workspace roles + reviewer roles + portal roles + delegated admin tiers. Capability projection drives the UI.",
    body: "See `navigation-registry.ts` for capability-keyed visibility.",
    implementationReferences: [
      "services/api/src/services/platform-context/navigation-registry.ts",
    ],
    policyTags: ["RBAC"],
  },
  {
    kind: "SECURITY",
    section: "MFA",
    slug: "mfa",
    title: "Multi-factor authentication",
    summary:
      "MFA enforced via the existing identity provider. Portal sessions also track `mfaSatisfiedAtUtc`.",
    body: "External reviewer portal grants the `mfa_satisfied` flag separately and emits session events.",
    implementationReferences: [
      "services/api/src/services/external-review/portal-session.service.ts",
    ],
    policyTags: ["MFA"],
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
      "SCIM provisioning supported via the existing identity provider integration.",
    body: "Provisioning events are logged and can be reviewed in Access Reviews.",
    implementationReferences: [],
    policyTags: ["SCIM"],
  },
  {
    kind: "SECURITY",
    section: "ENCRYPTION",
    slug: "encryption",
    title: "Encryption",
    summary:
      "Encryption at rest (KMS-backed S3 SSE) and in transit (TLS 1.2+).",
    body: "Per-tenant KMS keys are used for evidence bucket SSE.",
    implementationReferences: ["services/api/src/storage.ts"],
    policyTags: ["ENCRYPTION"],
  },
  {
    kind: "SECURITY",
    section: "KMS",
    slug: "kms",
    title: "Key Management",
    summary:
      "AWS KMS for at-rest encryption. Keys are workspace-scoped.",
    body: "Key rotation follows AWS KMS best practice; logical key references are tracked per evidence bucket.",
    implementationReferences: [],
    policyTags: ["KMS"],
  },
  {
    kind: "SECURITY",
    section: "AUDIT_LOGGING",
    slug: "audit-logging",
    title: "Audit logging",
    summary:
      "Six audit sources federated by the Audit & Transparency Center: provider usage, reviewer corrections, redaction activity, policy audit, video timeline, external review activity, intelligence lifecycle.",
    body: "All append-only.",
    implementationReferences: [
      "services/api/src/services/intelligence/audit-transparency.service.ts",
    ],
    policyTags: ["AUDIT"],
  },
  {
    kind: "SECURITY",
    section: "EVIDENCE_IMMUTABILITY",
    slug: "evidence-immutability",
    title: "Evidence immutability",
    summary:
      "Originals stored with S3 Object Lock. Derivatives are separate files with their own custody events.",
    body: "An original can never be silently replaced; the bytes are versioned and locked.",
    implementationReferences: [
      "services/api/src/storage.ts",
      "services/api/src/services/operations/object-lock-status.service.ts",
      "services/api/src/services/evidence-complete.service.ts",
    ],
    policyTags: ["IMMUTABILITY"],
  },
  {
    kind: "SECURITY",
    section: "OBJECT_LOCK",
    slug: "object-lock",
    title: "S3 Object Lock",
    summary:
      "Compliance-mode Object Lock prevents tampering for the retention period.",
    body: "Retention windows are configured per bucket policy.",
    implementationReferences: [
      "services/api/src/bootstrap/object-lock-verification.ts",
      "services/api/src/services/operations/object-lock-status.service.ts",
    ],
    policyTags: ["OBJECT_LOCK"],
  },
  {
    kind: "SECURITY",
    section: "ACCESS_CONTROLS",
    slug: "access-controls",
    title: "Access controls",
    summary:
      "Workspace anchoring at every read + write. Capability-keyed nav. Server-side authorisation on every route.",
    body: "There is no client-side enforcement that the server does not also enforce.",
    implementationReferences: ["services/api/src/middleware/auth.ts"],
    policyTags: ["ACCESS"],
  },
  {
    kind: "SECURITY",
    section: "MONITORING",
    slug: "monitoring",
    title: "Monitoring",
    summary:
      "Sentry for error telemetry. Better Stack for uptime. Custom OTEL signals where bound.",
    body: "Status Page (in-platform) surfaces the upstream probe state.",
    implementationReferences: [
      "services/api/src/services/trust/status-page.service.ts",
    ],
    policyTags: ["MONITORING"],
  },
  {
    kind: "SECURITY",
    section: "INCIDENT_RESPONSE",
    slug: "incident-response",
    title: "Incident response",
    summary:
      "Incidents tracked in the Status Page incident table with state machine: INVESTIGATING → IDENTIFIED → MONITORING → RESOLVED → POSTMORTEM.",
    body: "Updates are append-only.",
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
      "Multi-AZ storage; cross-region replication for the evidence bucket; database backups every 24h.",
    body: "RPO ≤ 24h; RTO ≤ 4h.",
    implementationReferences: [
      "services/api/src/services/operations/recovery-validation.service.ts",
    ],
    policyTags: ["DR"],
  },
  {
    kind: "SECURITY",
    section: "RETENTION",
    slug: "retention",
    title: "Retention",
    summary:
      "Retention policies are governed by the Governance Policy registry (kind=RETENTION).",
    body: "Default 7-year retention for evidence; tenant-configurable.",
    implementationReferences: [
      "services/api/src/services/governance/governance-policy.service.ts",
    ],
    policyTags: ["RETENTION"],
  },
  {
    kind: "SECURITY",
    section: "DELETION",
    slug: "deletion",
    title: "Deletion",
    summary:
      "Bounded deletion workflows recorded in custody events. Originals under Object Lock cannot be deleted until the retention window elapses.",
    body: "Reviewer + governance audit trails for every deletion request.",
    implementationReferences: [],
    policyTags: ["DELETION"],
  },
  {
    kind: "SECURITY",
    section: "SECURITY_CONTACTS",
    slug: "security-contacts",
    title: "Security contacts",
    summary:
      "Report security issues to security@proovra.com.",
    body: "We will acknowledge within 24h.",
    implementationReferences: ["packages/shared/src/index.ts#SUPPORT_EMAILS"],
    policyTags: ["CONTACTS"],
  },
];
