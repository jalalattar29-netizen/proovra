/**
 * PROOVRA Phase 4B Final Closure — Report section: Lifecycle Summary (I2).
 *
 * Bounded module that renders retention policies, legal holds, archive tiers,
 * transfer status, destruction status, and lifecycle violations inside the
 * evidence report. Provenance-only — never raw reasons, never PII.
 *
 * Section position: AFTER intelligence-summary, BEFORE custody.
 *
 * Data is loaded via projectLifecycleDashboard + the 7 manifest builders
 * from lifecycle-manifest.service.ts. Every field is bounded to
 * counts + ids + chips only. Workspace-anchored on teamId.
 */

import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export type LifecycleSummaryData = {
  /** Retention — policy count + active templates (bounded). */
  retention: {
    totalPolicies: number;
    activePolicies: number;
    overridePolicies: number;
    /** Per-template counts: e.g. { GDPR_7Y: 2, CUSTOM: 1 } */
    templateBreakdown: Record<string, number>;
    /** Most-recent active policy — name + years only. */
    activePolicy: { policyId: string; policyName: string; years: number } | null;
  };
  /** Legal holds — active/released/expired counts + per-kind breakdown. */
  legalHolds: {
    totalActive: number;
    totalReleased: number;
    totalExpired: number;
    byKind: Record<string, number>;
  };
  /** Archive — per-tier evidence counts + estimated costs. */
  archive: {
    countByTier: Record<string, number>;
    costEstimateUsdMicrosByTier: Record<string, number>;
    totalTransitions: number;
  };
  /** Transfer — most-recent transfer state + counterparty org slug. */
  transfer: {
    transferId: string;
    state: string;
    toOrganizationSlug: string;
    evidenceCount: number;
    createdAt: string;
    completedAtUtc: string | null;
  } | null;
  /** Destruction — most-recent request state + certificate hash. */
  destruction: {
    requestId: string;
    state: string;
    evidenceCount: number;
    certifiedAtUtc: string | null;
    /** Bounded SHA-256 hex — never the full certificate body. */
    certificateHash: string | null;
  } | null;
  /** Violations — per-code counts from activity events. */
  violations: ReadonlyArray<{ code: string; count: number }>;
  /** Total violation events across all codes. */
  totalViolations: number;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load the bounded lifecycle projection for a given team. All sub-calls
 * are wrapped in .catch() so a missing model or empty table never blocks
 * the report pipeline. Returns null when teamId is absent so callers can
 * skip the section cleanly.
 */
export async function loadLifecycleSummary(input: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any;
  teamId: string | null | undefined;
}): Promise<LifecycleSummaryData | null> {
  if (!input.teamId) return null;
  const { prisma, teamId } = input;

  try {
    // Retention
    const [totalPolicies, activePolicies, overridePolicies, templateGroups, activePolicy] =
      await Promise.all([
        prisma.retentionPolicyConfig.count({ where: { teamId } }).catch(() => 0),
        prisma.retentionPolicyConfig.count({ where: { teamId, state: "ACTIVE" } }).catch(() => 0),
        prisma.retentionPolicyConfig.count({ where: { teamId, isOverride: true } }).catch(() => 0),
        prisma.retentionPolicyConfig
          .groupBy({
            by: ["template"],
            where: { teamId, state: "ACTIVE" },
            _count: { _all: true },
          })
          .catch(() => [] as Array<{ template: string; _count: { _all: number } }>),
        prisma.retentionPolicyConfig
          .findFirst({
            where: { teamId, state: "ACTIVE" },
            orderBy: { createdAt: "desc" },
            select: { id: true, name: true, years: true },
          })
          .catch(() => null),
      ]);

    const templateBreakdown: Record<string, number> = {};
    for (const g of templateGroups) {
      templateBreakdown[g.template] = g._count._all;
    }

    const retention = {
      totalPolicies: totalPolicies as number,
      activePolicies: activePolicies as number,
      overridePolicies: overridePolicies as number,
      templateBreakdown,
      activePolicy: activePolicy
        ? {
            policyId: (activePolicy as { id: string; name: string; years: number }).id,
            policyName: (activePolicy as { id: string; name: string; years: number }).name,
            years: (activePolicy as { id: string; name: string; years: number }).years,
          }
        : null,
    };

    // Legal holds
    const [totalActive, totalReleased, totalExpired, kindGroups] = await Promise.all([
      prisma.legalHold.count({ where: { teamId, state: "ACTIVE" } }).catch(() => 0),
      prisma.legalHold.count({ where: { teamId, state: "RELEASED" } }).catch(() => 0),
      prisma.legalHold.count({ where: { teamId, state: "EXPIRED" } }).catch(() => 0),
      prisma.legalHold
        .groupBy({
          by: ["kind"],
          where: { teamId, state: "ACTIVE" },
          _count: { _all: true },
        })
        .catch(() => [] as Array<{ kind: string; _count: { _all: number } }>),
    ]);

    const byKind: Record<string, number> = {};
    for (const g of kindGroups) {
      byKind[g.kind] = g._count._all;
    }

    const legalHolds = {
      totalActive: totalActive as number,
      totalReleased: totalReleased as number,
      totalExpired: totalExpired as number,
      byKind,
    };

    // Archive — per-tier
    const archiveTiers = ["HOT", "WARM", "COLD", "DEEP_ARCHIVE"] as const;
    const countByTier: Record<string, number> = { HOT: 0, WARM: 0, COLD: 0, DEEP_ARCHIVE: 0 };
    const costEstimateUsdMicrosByTier: Record<string, number> = {
      HOT: 0,
      WARM: 0,
      COLD: 0,
      DEEP_ARCHIVE: 0,
    };

    const archiveRows = await prisma.archiveTierTransition
      .findMany({
        where: { teamId },
        orderBy: { transitionedAtUtc: "desc" },
        take: 5000,
        select: { evidenceId: true, toTier: true, costEstimateUsdMicros: true },
      })
      .catch(() => []);

    const seenEvidence = new Set<string>();
    for (const row of archiveRows as Array<{
      evidenceId: string;
      toTier: string;
      costEstimateUsdMicros: bigint | number;
    }>) {
      if (!seenEvidence.has(row.evidenceId)) {
        seenEvidence.add(row.evidenceId);
        const tier = row.toTier as (typeof archiveTiers)[number];
        if (tier in countByTier) {
          countByTier[tier]++;
          costEstimateUsdMicrosByTier[tier] += Number(row.costEstimateUsdMicros);
        }
      }
    }

    const totalTransitions = await prisma.archiveTierTransition
      .count({ where: { teamId } })
      .catch(() => 0);

    const archive = {
      countByTier,
      costEstimateUsdMicrosByTier,
      totalTransitions: totalTransitions as number,
    };

    // Transfer — most recent
    const recentTransfer = await prisma.chainTransfer
      .findFirst({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          toOrganizationSlug: true,
          state: true,
          evidenceIds: true,
          createdAt: true,
          completedAtUtc: true,
        },
      })
      .catch(() => null);

    const transfer = recentTransfer
      ? {
          transferId: (
            recentTransfer as {
              id: string;
              toOrganizationSlug: string;
              state: string;
              evidenceIds: unknown;
              createdAt: Date;
              completedAtUtc: Date | null;
            }
          ).id,
          state: (recentTransfer as { state: string }).state,
          toOrganizationSlug: (recentTransfer as { toOrganizationSlug: string }).toOrganizationSlug,
          evidenceCount: Array.isArray(
            (recentTransfer as { evidenceIds: unknown }).evidenceIds,
          )
            ? ((recentTransfer as { evidenceIds: unknown[] }).evidenceIds as unknown[]).length
            : 0,
          createdAt: (recentTransfer as { createdAt: Date }).createdAt.toISOString(),
          completedAtUtc:
            (recentTransfer as { completedAtUtc: Date | null }).completedAtUtc?.toISOString() ??
            null,
        }
      : null;

    // Destruction — most recent
    const recentDestruction = await prisma.destructionRequest
      .findFirst({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          state: true,
          evidenceIds: true,
          certifiedAtUtc: true,
          certificate: { select: { certificateHash: true, evidenceCount: true } },
        },
      })
      .catch(() => null);

    const destruction = recentDestruction
      ? {
          requestId: (
            recentDestruction as {
              id: string;
              state: string;
              evidenceIds: unknown;
              certifiedAtUtc: Date | null;
              certificate: { certificateHash: string; evidenceCount: number } | null;
            }
          ).id,
          state: (recentDestruction as { state: string }).state,
          evidenceCount:
            (recentDestruction as { certificate: { evidenceCount: number } | null }).certificate
              ?.evidenceCount ??
            (Array.isArray((recentDestruction as { evidenceIds: unknown }).evidenceIds)
              ? ((recentDestruction as { evidenceIds: unknown[] }).evidenceIds as unknown[]).length
              : 0),
          certifiedAtUtc:
            (
              recentDestruction as { certifiedAtUtc: Date | null }
            ).certifiedAtUtc?.toISOString() ?? null,
          certificateHash:
            (
              recentDestruction as {
                certificate: { certificateHash: string } | null;
              }
            ).certificate?.certificateHash ?? null,
        }
      : null;

    // Violations — per code from intelligence_activity_events
    const violationRows = await prisma.intelligenceActivityEvent
      .groupBy({
        by: ["eventCode"],
        where: {
          teamId,
          eventCode: {
            in: [
              "POLICY_VIOLATION_RETENTION",
              "POLICY_VIOLATION_LEGAL_HOLD",
              "POLICY_VIOLATION_ARCHIVE",
              "POLICY_VIOLATION_DESTRUCTION",
              "POLICY_VIOLATION_TRANSFER",
              "LIFECYCLE_VIOLATION",
            ],
          },
        },
        _count: { _all: true },
      })
      .catch(() => [] as Array<{ eventCode: string; _count: { _all: number } }>);

    const violations = (
      violationRows as Array<{ eventCode: string; _count: { _all: number } }>
    ).map((r) => ({ code: r.eventCode, count: r._count._all }));

    const totalViolations = violations.reduce((s, v) => s + v.count, 0);

    return {
      retention,
      legalHolds,
      archive,
      transfer,
      destruction,
      violations,
      totalViolations,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the lifecycle summary section as an HTML string. Returns "" when
 * data is null so callers can use `.filter(Boolean)` cleanly.
 */
export function renderLifecycleSummarySection(data: LifecycleSummaryData | null): string {
  if (!data) return "";

  const hasContent =
    data.retention.totalPolicies > 0 ||
    data.legalHolds.totalActive > 0 ||
    data.archive.totalTransitions > 0 ||
    data.transfer !== null ||
    data.destruction !== null;

  if (!hasContent) return "";

  const intro = renderCallout({
    tone: "neutral",
    title: "Evidence Lifecycle Governance · workspace-anchored bounded summary",
    body:
      "PROOVRA records bounded lifecycle signals — retention policies, legal holds, archive " +
      "tier transitions, transfers, and destruction governance — for every evidence workspace. " +
      "This section reports counts + bounded ids only. No raw reasons, no PII.",
  });

  // Retention block
  const retentionBlock = `
    <h4 data-verify-lifecycle-section="retention">Retention Policies</h4>
    <p class="muted small">${data.retention.totalPolicies} configured · ${data.retention.activePolicies} active · ${data.retention.overridePolicies} override${
      data.retention.activePolicy
        ? ` · Active policy: <strong>${escapeHtml(data.retention.activePolicy.policyName)}</strong> (${data.retention.activePolicy.years} yr)`
        : ""
    }</p>
    ${
      Object.keys(data.retention.templateBreakdown).length > 0
        ? `<p class="muted small">${Object.entries(data.retention.templateBreakdown)
            .map(
              ([tmpl, cnt]) =>
                `<span class="redaction-chip">${escapeHtml(tmpl)}: ${cnt}</span>`,
            )
            .join(" ")}</p>`
        : ""
    }
  `;

  // Legal holds block
  const holdBlock = `
    <h4 data-verify-lifecycle-section="legal-hold">Legal Holds</h4>
    <p class="muted small">${data.legalHolds.totalActive} active · ${data.legalHolds.totalReleased} released · ${data.legalHolds.totalExpired} expired</p>
    ${
      Object.keys(data.legalHolds.byKind).length > 0
        ? `<p class="muted small">${Object.entries(data.legalHolds.byKind)
            .map(
              ([kind, cnt]) =>
                `<span class="redaction-chip">${escapeHtml(kind)}: ${cnt}</span>`,
            )
            .join(" ")}</p>`
        : ""
    }
  `;

  // Archive tiers block
  const archiveTiers = ["HOT", "WARM", "COLD", "DEEP_ARCHIVE"] as const;
  const archiveBlock = `
    <h4 data-verify-lifecycle-section="archive">Archive Tiers</h4>
    <p class="muted small">${data.archive.totalTransitions} total transitions</p>
    <p class="muted small">${archiveTiers
      .filter((t) => (data.archive.countByTier[t] ?? 0) > 0)
      .map(
        (t) =>
          `<span class="redaction-chip">${t}: ${data.archive.countByTier[t]} evidence · $${(
            (data.archive.costEstimateUsdMicrosByTier[t] ?? 0) / 1_000_000
          ).toFixed(4)}</span>`,
      )
      .join(" ")}</p>
  `;

  // Transfer block
  const transferBlock = data.transfer
    ? `
    <h4 data-verify-lifecycle-section="transfer">Transfer Status</h4>
    <p class="muted small">
      Most recent: <span class="redaction-chip">${escapeHtml(data.transfer.state)}</span>
      · To: <code>${escapeHtml(data.transfer.toOrganizationSlug)}</code>
      · ${data.transfer.evidenceCount} evidence item${data.transfer.evidenceCount !== 1 ? "s" : ""}
      ${data.transfer.completedAtUtc ? `· Completed ${data.transfer.completedAtUtc.slice(0, 10)}` : ""}
    </p>
  `
    : "";

  // Destruction block
  const destructionBlock = data.destruction
    ? `
    <h4 data-verify-lifecycle-section="destruction">Destruction Status</h4>
    <p class="muted small">
      State: <span class="redaction-chip">${escapeHtml(data.destruction.state)}</span>
      · ${data.destruction.evidenceCount} evidence item${data.destruction.evidenceCount !== 1 ? "s" : ""}
      ${data.destruction.certifiedAtUtc ? `· Certified ${data.destruction.certifiedAtUtc.slice(0, 10)}` : ""}
      ${
        data.destruction.certificateHash
          ? `· Certificate hash: <code>${escapeHtml(data.destruction.certificateHash.slice(0, 16))}…</code>`
          : ""
      }
    </p>
  `
    : "";

  // Violations block
  const violationsBlock =
    data.totalViolations > 0
      ? `
    <h4>Lifecycle Violations</h4>
    <p class="muted small">${data.totalViolations} bounded violation events.</p>
    <p class="muted small">${data.violations
      .map((v) => `<span class="redaction-chip">${escapeHtml(v.code)}: ${v.count}</span>`)
      .join(" ")}</p>
  `
      : "";

  return renderPageSection(
    "Evidence Lifecycle Summary",
    `
      ${intro}
      ${retentionBlock}
      ${holdBlock}
      ${archiveBlock}
      ${transferBlock}
      ${destructionBlock}
      ${violationsBlock}
      <p class="muted small">
        Lifecycle signals are workspace-anchored and bounded. They reflect the
        governance state recorded by PROOVRA — not external legal determinations.
      </p>
    `,
  );
}
