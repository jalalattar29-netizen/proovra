/**
 * PROOVRA Phase 3B — Report section: Intelligence summary.
 *
 * Bounded module that renders document + transcript + confidence
 * + correction + provider summaries inside the evidence report.
 * Provenance-only — never raw OCR / transcript / entity text.
 *
 * Phase 4A Final Closure — `renderIntelligenceSummarySection` is now
 * invoked from `services/worker/src/report-v2/render-html.ts:33`
 * whenever `ReportViewModel.intelligenceSummary` is non-null. The
 * `trustReferences` block is populated by the worker job processor
 * at `services/worker/src/processor.ts` (provisional + finalized
 * report paths) via `buildTrustReferencesForReport({ prisma, teamId })`,
 * which is failure-safe and returns `undefined` for team-less
 * evidence — in which case the section is skipped and the report
 * renders byte-identical to the pre-Phase-4A output.
 */

import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

export type IntelligenceSummarySection = {
  document: {
    totalRecords: number;
    perKind: ReadonlyArray<{ kind: string; count: number }>;
    perProvider: ReadonlyArray<{ provider: string; count: number }>;
    perConfidence: ReadonlyArray<{ band: string; count: number }>;
    correctionCount: number;
  } | null;
  transcript: {
    totalSegments: number;
    totalSpeakers: number;
    totalDurationMs: number;
    perProvider: ReadonlyArray<{ provider: string; count: number }>;
    correctionCount: number;
  } | null;
  confidence: {
    perBand: ReadonlyArray<{ band: string; count: number }>;
    reviewedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    correctedCount: number;
  } | null;
  correctionHistory: {
    totalCorrections: number;
    perKind: ReadonlyArray<{ kind: string; count: number }>;
  } | null;
  providers: ReadonlyArray<{
    provider: string;
    callCount: number;
    estimatedCostUsdMicros: number;
  }>;
  // Phase 3B Enterprise Closure — quality + trend + budget + audit
  // sections. All optional so callers can compose the section
  // incrementally without forcing a schema bump everywhere.
  providerQuality?: ReadonlyArray<{
    provider: string;
    rank: number;
    callCount: number;
    correctionRatePct: number;
    failureRatePct: number;
    confidenceAccuracy: number;
    rankingScore: number;
  }>;
  correctionVersionChain?: {
    totalVersions: number;
    chainCount: number;
  };
  budgetGovernance?: {
    totalBreaches: number;
    softBreaches: number;
    hardBreaches: number;
    blockedCalls: number;
  };
  auditEvents?: {
    totalEvents: number;
    perCategory: ReadonlyArray<{ category: string; count: number }>;
  };
  // Phase 4A — Trust + governance + methodology + AI disclosure +
  // security references. Optional. Each entry is a bounded
  // `(title, slug, version)` triple — never the article body.
  trustReferences?: {
    trustCenter: ReadonlyArray<{ title: string; slug: string; version: number }>;
    methodology: ReadonlyArray<{ title: string; slug: string; version: number }>;
    aiDisclosure: ReadonlyArray<{ title: string; slug: string; version: number }>;
    security: ReadonlyArray<{ title: string; slug: string; version: number }>;
    subprocessors: ReadonlyArray<{ name: string; slug: string; vendor: string }>;
    governance: {
      policyCount: number;
      activeGrants: number;
      crossOrgActive: number;
    };
  };
};

export function renderIntelligenceSummarySection(
  section: IntelligenceSummarySection,
): string {
  const hasAnything =
    (section.document?.totalRecords ?? 0) > 0 ||
    (section.transcript?.totalSegments ?? 0) > 0 ||
    section.providers.length > 0;
  if (!hasAnything) return "";

  const intro = renderCallout({
    tone: "neutral",
    title: "AI-assisted intelligence · governed by reviewer judgement",
    body:
      "PROOVRA's intelligence layer surfaces provider suggestions to " +
      "human reviewers. The summaries below report bounded counts and " +
      "confidence bands — they NEVER reproduce raw OCR, transcript " +
      "text, or extracted entity values. Reviewer corrections are " +
      "appended alongside the provider record and preserved.",
  });

  const documentTable = section.document
    ? `
      <h4>Document intelligence</h4>
      <p class="muted small">${section.document.totalRecords} bounded records · ${section.document.correctionCount} corrections</p>
      ${chipRow(section.document.perKind)}
      ${chipRow(section.document.perProvider)}
      ${chipRow(section.document.perConfidence)}
    `
    : "";

  const transcriptTable = section.transcript
    ? `
      <h4>Transcript intelligence</h4>
      <p class="muted small">${section.transcript.totalSegments} segments · ${section.transcript.totalSpeakers} speakers · ${Math.round(section.transcript.totalDurationMs / 1000)}s · ${section.transcript.correctionCount} corrections</p>
      ${chipRow(section.transcript.perProvider)}
    `
    : "";

  const confidenceTable = section.confidence
    ? `
      <h4>Confidence breakdown</h4>
      <p class="muted small">Reviewed ${section.confidence.reviewedCount} · Accepted ${section.confidence.acceptedCount} · Rejected ${section.confidence.rejectedCount} · Corrected ${section.confidence.correctedCount}</p>
      ${chipRow(section.confidence.perBand)}
    `
    : "";

  const correctionTable = section.correctionHistory
    ? `
      <h4>Correction history</h4>
      <p class="muted small">${section.correctionHistory.totalCorrections} reviewer corrections</p>
      ${chipRow(section.correctionHistory.perKind)}
    `
    : "";

  const providerTable =
    section.providers.length > 0
      ? `
      <h4>Provider summary</h4>
      <table class="redaction-summary-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Calls</th>
            <th>Estimated cost</th>
          </tr>
        </thead>
        <tbody>
          ${section.providers
            .map(
              (p) => `
                <tr>
                  <td><code>${escapeHtml(p.provider)}</code></td>
                  <td>${p.callCount}</td>
                  <td>$${(p.estimatedCostUsdMicros / 1_000_000).toFixed(4)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `
      : "";

  // Phase 3B Enterprise Closure — provider quality summary.
  const providerQualityTable =
    section.providerQuality && section.providerQuality.length > 0
      ? `
      <h4>Provider quality summary</h4>
      <table class="redaction-summary-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Provider</th>
            <th>Calls</th>
            <th>Correction %</th>
            <th>Failure %</th>
            <th>Confidence accuracy</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          ${section.providerQuality
            .map(
              (q) => `
                <tr>
                  <td>#${q.rank}</td>
                  <td><code>${escapeHtml(q.provider)}</code></td>
                  <td>${q.callCount}</td>
                  <td>${q.correctionRatePct}%</td>
                  <td>${q.failureRatePct}%</td>
                  <td>${(q.confidenceAccuracy * 100).toFixed(0)}%</td>
                  <td>${(q.rankingScore * 100).toFixed(0)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `
      : "";

  // Phase 3B Enterprise Closure — correction version chain summary.
  const versionChainBlock = section.correctionVersionChain
    ? `
      <h4>Correction version chain</h4>
      <p class="muted small">${section.correctionVersionChain.chainCount} chains · ${section.correctionVersionChain.totalVersions} immutable versions preserved.</p>
    `
    : "";

  // Phase 3B Enterprise Closure — budget governance summary.
  const budgetBlock = section.budgetGovernance
    ? `
      <h4>Budget governance summary</h4>
      <p class="muted small">${section.budgetGovernance.totalBreaches} breaches (${section.budgetGovernance.softBreaches} soft, ${section.budgetGovernance.hardBreaches} hard) · ${section.budgetGovernance.blockedCalls} blocked provider calls.</p>
    `
    : "";

  // Phase 3B Enterprise Closure — audit events summary.
  const auditBlock = section.auditEvents
    ? `
      <h4>Audit events summary</h4>
      <p class="muted small">${section.auditEvents.totalEvents} bounded lifecycle events.</p>
      ${chipRow(section.auditEvents.perCategory)}
    `
    : "";

  // Phase 4A — Trust + governance references. Bounded slugs +
  // versions only — never article bodies.
  const trustReferencesBlock = section.trustReferences
    ? `
      <h4>Trust &amp; governance references</h4>
      <p class="muted small">
        Trust Center: ${section.trustReferences.trustCenter.length} published sections ·
        Methodology: ${section.trustReferences.methodology.length} ·
        AI Disclosure: ${section.trustReferences.aiDisclosure.length} ·
        Security: ${section.trustReferences.security.length} ·
        Subprocessors: ${section.trustReferences.subprocessors.length} active ·
        Policies: ${section.trustReferences.governance.policyCount} ·
        Delegated grants: ${section.trustReferences.governance.activeGrants} ·
        Cross-org grants: ${section.trustReferences.governance.crossOrgActive}.
      </p>
      ${section.trustReferences.trustCenter.length > 0
        ? `<p class="muted small">${section.trustReferences.trustCenter.map((r) => `<span class="redaction-chip">${escapeHtml(r.title)} (v${r.version})</span>`).join(" ")}</p>`
        : ""}
      ${section.trustReferences.subprocessors.length > 0
        ? `<p class="muted small">Subprocessors: ${section.trustReferences.subprocessors.map((s) => `<span class="redaction-chip">${escapeHtml(s.name)}</span>`).join(" ")}</p>`
        : ""}
    `
    : "";

  return renderPageSection("Intelligence Summary", `
      ${intro}
      ${documentTable}
      ${transcriptTable}
      ${confidenceTable}
      ${correctionTable}
      ${providerTable}
      ${providerQualityTable}
      ${versionChainBlock}
      ${budgetBlock}
      ${auditBlock}
      ${trustReferencesBlock}
      <p class="muted small">
        AI outputs are NEVER ground truth. Reviewer corrections take
        precedence. The bounded standing limitations apply throughout
        — they're surfaced in the executive dashboard footer.
      </p>
    `);
}

/**
 * Phase 4A Closure — build the trustReferences shape from prisma for a
 * given teamId. Returns undefined when teamId is null/undefined so callers
 * can omit the section cleanly.
 *
 * NEVER includes article bodies — only bounded slug + title + version triples.
 */
export async function buildTrustReferencesForReport(input: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any;
  teamId: string | null | undefined;
}): Promise<IntelligenceSummarySection["trustReferences"] | undefined> {
  if (!input.teamId) return undefined;
  const { prisma, teamId } = input;
  try {
    const [trustRows, methodRows, aiRows, secRows, spRows, policyCount, activeGrants, crossOrgActive] =
      await Promise.all([
        prisma.trustCenterArticle.findMany({
          where: { teamId, kind: "TRUST_CENTER", state: "PUBLISHED" },
          select: { title: true, slug: true, version: true },
          orderBy: { slug: "asc" },
        }).catch(() => []),
        prisma.trustCenterArticle.findMany({
          where: { teamId, kind: "METHODOLOGY", state: "PUBLISHED" },
          select: { title: true, slug: true, version: true },
          orderBy: { slug: "asc" },
        }).catch(() => []),
        prisma.trustCenterArticle.findMany({
          where: { teamId, kind: "AI_DISCLOSURE", state: "PUBLISHED" },
          select: { title: true, slug: true, version: true },
          orderBy: { slug: "asc" },
        }).catch(() => []),
        prisma.trustCenterArticle.findMany({
          where: { teamId, kind: "SECURITY", state: "PUBLISHED" },
          select: { title: true, slug: true, version: true },
          orderBy: { slug: "asc" },
        }).catch(() => []),
        prisma.subprocessor.findMany({
          where: { teamId, state: "ACTIVE" },
          select: { name: true, slug: true, vendor: true },
          orderBy: { name: "asc" },
        }).catch(() => []),
        prisma.governancePolicy.count({ where: { teamId, state: "ACTIVE" } }).catch(() => 0),
        prisma.delegatedAdminGrant.count({ where: { teamId, state: "ACTIVE" } }).catch(() => 0),
        prisma.crossOrgReviewGrant.count({ where: { teamId, state: "ACCEPTED" } }).catch(() => 0),
      ]);
    return {
      trustCenter: trustRows as ReadonlyArray<{ title: string; slug: string; version: number }>,
      methodology: methodRows as ReadonlyArray<{ title: string; slug: string; version: number }>,
      aiDisclosure: aiRows as ReadonlyArray<{ title: string; slug: string; version: number }>,
      security: secRows as ReadonlyArray<{ title: string; slug: string; version: number }>,
      subprocessors: spRows as ReadonlyArray<{ name: string; slug: string; vendor: string }>,
      governance: {
        policyCount: policyCount as number,
        activeGrants: activeGrants as number,
        crossOrgActive: crossOrgActive as number,
      },
    };
  } catch {
    return undefined;
  }
}

function chipRow(rows: ReadonlyArray<{ count: number } & Record<string, unknown>>): string {
  if (rows.length === 0) return `<p class="muted small">—</p>`;
  return `<p class="muted small">${rows
    .map(
      (r) =>
        `<span class="redaction-chip">${escapeHtml(String(Object.values(r)[0]))}: ${r.count}</span>`,
    )
    .join(" ")}</p>`;
}
