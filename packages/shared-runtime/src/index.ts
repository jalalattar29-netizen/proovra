/**
 * @proovra/shared-runtime — Prisma-using business logic that
 * both services/api and services/worker import.
 *
 * This package replaces the direct cross-imports between api and
 * worker that violated the service boundary (Phase 31.21 audit).
 *
 * Both hosts MUST call `registerPrisma(prisma)` at process startup
 * before any function from this package is invoked.
 */

export { registerPrisma, getRegisteredPrisma } from "./prisma-registry.js";
// The ONE durable reconciliation-run authority: DB-enforced per-lock-key
// exclusion, a lease, and terminal transitions. Both hosts start runs.
export * from "./reconciliation-run.js";
// THE workspace read-scope authority for the two mixed-ownership models
// (Evidence, Case). It lives here because BOTH hosts read those populations:
// the API for every page, the Worker for org-health refresh, archive-tier
// sweeps and graph reconciliation. A background job that reads a smaller
// population than the page it feeds is the disagreement this ends.
export * from "./workspace-scope.js";
// The Search-shaped face of that authority. Every entry point that can
// start a Search reconciliation resolves through it.
export * from "./search-index-reconciliation.js";
// The Operations-shaped face of the SAME run authority. Scheduled discovery of
// a workspace's operational conditions, plus the readiness contract that
// decides whether "workspace operations are clear" may be said at all.
export * from "./workspace-operations-reconciliation.js";

export * from "./signing/index.js";

export * from "./media-intelligence/index.js";
export * from "./graph/index.js";
export * from "./ops/index.js";
export * from "./notifications/index.js";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat/member occupancy
// authority, shared by API and worker so their arithmetic cannot diverge.
export * from "./billing/seat-occupancy.js";
// PHASE 12 CORRECTIVE PASS §4 (SEC-004, 2026-08-06) — the ONE secrets
// authority. It lived in services/api, so the Worker could not use it and the
// two processes of one deployment could resolve secrets from different
// stores. Both now call the same `initSecretsAuthority` and report the same
// readiness contract.
export * from "./config/secrets-authority.js";
export * from "./config/secrets-recording-provider.js";

// THE evidence analysis revision — the one server-owned answer to
// "has anything that can affect this Copilot operation changed since the
// operator selected this evidence?". It lives here rather than in
// @proovra/shared precisely because the browser bundle cannot import this
// package: a client may CARRY a revision and may never compute one.
export * from "./evidence-analysis-revision.js";

// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the ONE physical evidence
// destruction executor. It lives here, not in either service, because BOTH had
// their own: four independent destroyers, two of which certified destructions
// they never performed. Every trigger in both processes now calls this.
export * from "./evidence-destruction/executor.js";
export * from "./evidence-destruction/approval.js";
