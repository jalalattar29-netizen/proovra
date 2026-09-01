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
  "security-review",
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
 * Whether a slug has a runbook to open.
 *
 * Most `runbookSlug` values emitted by incidents are labels rather than
 * document references — they name a condition, and no markdown exists for
 * them. A surface that links every slug unconditionally sends the operator to
 * a 404 mid-incident, so link only when this returns true and render the slug
 * as plain text otherwise.
 */
export function hasRunbook(slug: string | null | undefined): boolean {
  return typeof slug === "string" && RUNBOOK_SLUGS.has(slug);
}
