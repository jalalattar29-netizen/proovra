/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * The runbook slugs, and nothing else.
 *
 * Import this — never `catalog.generated.ts` — anywhere that only needs to
 * know whether a slug resolves. The full catalog carries every runbook body.
 *
 * Source: docs/runbooks/*.md
 * Generator: apps/web/scripts/generate-runbook-catalog.mjs
 */

export const RUNBOOK_SLUGS: ReadonlySet<string> = new Set([
  "audit-chain-drift",
  "database-readiness-failure",
  "disaster-recovery",
  "export-blocked",
  "failed-report-generation",
  "failed-verification-package",
  "hold-override",
  "immutable-drift",
  "lifecycle-bypass",
  "observability-degraded",
  "ots-degradation",
  "pentest-readiness",
  "privacy-leak",
  "production-diagnostic-handoff",
  "retention-precedence",
  "reviewer-escalation-backlog",
  "reviewer-escalation-storm",
  "reviewer-inactivity",
  "reviewer-queue-stuck",
  "reviewer-sla-breach",
  "search-index-degraded",
  "security-review",
  "signing-backlog",
  "sre-runbooks",
  "storage-write-failure",
  "stuck-upload",
  "suspicious-login-burst",
  "tsa-timestamp-failure",
  "twilio-outage",
  "webhook-invalid-signature-burst",
  "worker-wedged",
  "workflow-intake-abuse",
  "workflow-stuck",
]);

/**
 * Emitted condition slugs that a runbook covers under a different name.
 *
 * A slug that is deliberately label-only is absent from here, and its
 * absence is what stops a surface rendering it as a link. See
 * docs/runbooks/RUNBOOK-SLUG-CLASSIFICATION.md for every decision.
 */
export const RUNBOOK_ALIASES: Readonly<Record<string, string>> = {
  "coordination-backlog": "reviewer-escalation-backlog",
  "evidence-integrity": "tsa-timestamp-failure",
  "evidence-integrity-recovery": "tsa-timestamp-failure",
  "high-risk-session-surge": "suspicious-login-burst",
  "idp-outage-response": "twilio-outage",
  "ots-anchoring": "ots-degradation",
  "package-generation-denied": "export-blocked",
  "package-pipeline": "failed-verification-package",
  "queue-failed-jobs": "worker-wedged",
  "queue-inventory-unavailable": "observability-degraded",
  "queue-outage": "worker-wedged",
  "report-generation-failure": "failed-report-generation",
  "report-pipeline": "failed-report-generation",
  "reviewer-ops": "reviewer-queue-stuck",
  "runtime-adaptive-block": "suspicious-login-burst",
  "search-index": "search-index-degraded",
  "signing-pipeline": "signing-backlog",
  "worker-heartbeat-stale": "worker-wedged",
};

/** Slugs deliberately classified as label-only. Recorded, never resolved. */
export const RUNBOOK_LABEL_ONLY: ReadonlySet<string> = new Set([
  "billing-provider-authorization",
  "operational-seeding",
  "retry-storm",
  "telemetry-sampler",
  "worker-heartbeat",
]);

/** The runbook slug to OPEN for an emitted slug, or null. */
export function resolveRunbookSlug(
  slug: string | null | undefined,
): string | null {
  if (typeof slug !== "string" || slug === "") return null;
  if (RUNBOOK_SLUGS.has(slug)) return slug;
  const aliased = RUNBOOK_ALIASES[slug];
  return aliased && RUNBOOK_SLUGS.has(aliased) ? aliased : null;
}

/**
 * Whether a slug has a runbook to open.
 *
 * Most `runbookSlug` values emitted by incidents are labels rather than
 * document references — they name a condition, and no markdown exists for
 * them. A surface that links every slug unconditionally sends the operator to
 * a 404 mid-incident, so link only when this returns true and render the slug
 * as plain text otherwise.
 */
export function hasRunbook(slug: string | null | undefined): boolean {
  return resolveRunbookSlug(slug) !== null;
}
