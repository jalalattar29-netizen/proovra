/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Every runbook's metadata, WITHOUT the bodies.
 *
 * Import this for the catalog list and the sidebar. Importing
 * `catalog.generated.ts` for those shipped the whole 125 KB corpus to the
 * client: the master page measured 51.9 kB of JS against 3.1 kB for the
 * reader, which prerenders its body into static HTML and ships none of it.
 *
 * Source: docs/runbooks/*.md
 * Generator: apps/web/scripts/generate-runbook-catalog.mjs
 */

export type RunbookCategory =
  | "Governance & lifecycle"
  | "Storage & integrity"
  | "Reviewer Ops"
  | "Workers & queues"
  | "Identity & security"
  | "Integrations & notifications"
  | "Operator procedures"
  ;

export type RunbookIndexEntry = {
  slug: string;
  title: string;
  category: RunbookCategory;
  subsystems: readonly string[];
  summary: string;
};

export const RUNBOOK_CATEGORY_ORDER: readonly RunbookCategory[] = [
  "Governance & lifecycle",
  "Storage & integrity",
  "Reviewer Ops",
  "Workers & queues",
  "Identity & security",
  "Integrations & notifications",
  "Operator procedures",
];

export const RUNBOOK_INDEX: readonly RunbookIndexEntry[] = [
  {
    slug: "audit-chain-drift",
    title: "Audit chain drift",
    category: "Storage & integrity",
    subsystems: ["audit","integrity"],
    summary: "Failure modes: FM-AUD-001, FM-AUD-002.",
  },
  {
    slug: "database-readiness-failure",
    title: "Database readiness failure",
    category: "Workers & queues",
    subsystems: ["database","readiness"],
    summary: "/readyz returns 503 with reason: \"db_unreachable\".",
  },
  {
    slug: "disaster-recovery",
    title: "Disaster Recovery (DR) — posture, targets, and restore procedure",
    category: "Governance & lifecycle",
    subsystems: ["backup","recovery"],
    summary: "Honesty note. This document describes the DR posture **as",
  },
  {
    slug: "export-blocked",
    title: "Compliance export blocked",
    category: "Governance & lifecycle",
    subsystems: ["governance","export"],
    summary: "Failure modes: FM-EXP-001 (PENDING_DESTRUCTION export), FM-EXP-002 (review gate), FM-EXP-003 (hold precedence).",
  },
  {
    slug: "failed-report-generation",
    title: "Failed report generation",
    category: "Workers & queues",
    subsystems: ["reports","queue"],
    summary: "BullMQ reportQueue job moved to failed state; row visible in reportDlqQueue.",
  },
  {
    slug: "failed-verification-package",
    title: "Failed verification package generation",
    category: "Workers & queues",
    subsystems: ["packages","anchor"],
    summary: "Verification-package job failed in worker logs (verification-package entry).",
  },
  {
    slug: "hold-override",
    title: "Legal hold override",
    category: "Governance & lifecycle",
    subsystems: ["governance","legal_hold"],
    summary: "Failure modes: FM-HOLD-001 (direct hold), FM-HOLD-002 (case hold), FM-HOLD-003 (hold placed during destruction).",
  },
  {
    slug: "immutable-drift",
    title: "Immutable storage drift",
    category: "Storage & integrity",
    subsystems: ["storage","immutability"],
    summary: "Failure modes: FM-RET-001 (immutable retention bypass).",
  },
  {
    slug: "lifecycle-bypass",
    title: "Suspected lifecycle bypass",
    category: "Governance & lifecycle",
    subsystems: ["governance","lifecycle"],
    summary: "Failure modes: FM-LIFE-001 (direct ACTIVE → DESTROYED), FM-LIFE-002 (re-transition out of DESTROYED).",
  },
  {
    slug: "observability-degraded",
    title: "Observability degraded",
    category: "Workers & queues",
    subsystems: ["observability","metrics"],
    summary: "Failure modes: FM-OBS-001 (sink throws).",
  },
  {
    slug: "ots-degradation",
    title: "OTS / Bitcoin anchor degradation",
    category: "Storage & integrity",
    subsystems: ["ots","anchor"],
    summary: "Failure modes: FM-OTS-001 (ANCHORED without proof), FM-OTS-002 (empty proof bytes).",
  },
  {
    slug: "pentest-readiness",
    title: "Penetration-test readiness",
    category: "Identity & security",
    subsystems: ["security"],
    summary: "Guidance for an authorized penetration test / security assessment of",
  },
  {
    slug: "privacy-leak",
    title: "Suspected privacy / privileged-data leak",
    category: "Governance & lifecycle",
    subsystems: ["privacy","governance"],
    summary: "Failure modes: FM-PRIV-001 (lifecycle ledger), FM-PRIV-002 (worker notifications), FM-OBS-003 (metrics labels).",
  },
  {
    slug: "production-diagnostic-handoff",
    title: "Production diagnostic — operator handoff",
    category: "Operator procedures",
    subsystems: ["diagnostics","database"],
    summary: "Audience: an operator with shell access to the PROOVRA production host and",
  },
  {
    slug: "retention-precedence",
    title: "Retention precedence wrong",
    category: "Governance & lifecycle",
    subsystems: ["governance","retention"],
    summary: "Failure mode: FM-RET-002.",
  },
  {
    slug: "reviewer-escalation-backlog",
    title: "Reviewer escalation backlog",
    category: "Reviewer Ops",
    subsystems: ["reviewer","escalation"],
    summary: "Slug: reviewer-escalation-backlog",
  },
  {
    slug: "reviewer-escalation-storm",
    title: "Reviewer escalation storm",
    category: "Reviewer Ops",
    subsystems: ["reviewer","escalation"],
    summary: "Slug: reviewer-escalation-storm",
  },
  {
    slug: "reviewer-inactivity",
    title: "Reviewer inactivity",
    category: "Reviewer Ops",
    subsystems: ["reviewer"],
    summary: "Slug: reviewer-inactivity",
  },
  {
    slug: "reviewer-queue-stuck",
    title: "Reviewer queue stuck",
    category: "Reviewer Ops",
    subsystems: ["reviewer","queue"],
    summary: "Slug: reviewer-queue-stuck",
  },
  {
    slug: "reviewer-sla-breach",
    title: "Reviewer SLA breach",
    category: "Reviewer Ops",
    subsystems: ["reviewer","sla"],
    summary: "Slug: reviewer-sla-breach",
  },
  {
    slug: "search-index-degraded",
    title: "Search index reconciliation failing",
    category: "Storage & integrity",
    subsystems: ["search","reconciliation"],
    summary: "Nothing evidential is affected. Evidence records, their hashes, their",
  },
  {
    slug: "security-review",
    title: "Security review / procurement checklist",
    category: "Identity & security",
    subsystems: ["security"],
    summary: "A checklist for procurement and security-review teams. It links the",
  },
  {
    slug: "signing-backlog",
    title: "Evidence awaiting signing",
    category: "Storage & integrity",
    subsystems: ["signing","evidence"],
    summary: "Evidence records in this workspace are status = UPLOADED, unsigned, and older",
  },
  {
    slug: "sre-runbooks",
    title: "SRE runbooks — operator procedures",
    category: "Operator procedures",
    subsystems: ["sre"],
    summary: "Operator procedures for the most common operational conditions. Each",
  },
  {
    slug: "storage-write-failure",
    title: "Storage write failure",
    category: "Storage & integrity",
    subsystems: ["storage","s3"],
    summary: "Worker logs report S3 PutObject / HeadObject / GetObject errors.",
  },
  {
    slug: "stuck-upload",
    title: "Stuck upload",
    category: "Workers & queues",
    subsystems: ["upload"],
    summary: "operational_incidents row with category=UPLOAD and fingerprint starting upload: is open.",
  },
  {
    slug: "suspicious-login-burst",
    title: "Suspicious login burst",
    category: "Identity & security",
    subsystems: ["identity","security"],
    summary: "Phase 19 SecurityEvents: suspicious_login_detected, impossible_travel_signal, service_account_risk_detected, contributor_risk_detected, high_risk_action_blocked, step_up_denied rising.",
  },
  {
    slug: "tsa-timestamp-failure",
    title: "RFC3161 timestamp failure",
    category: "Storage & integrity",
    subsystems: ["tsa","evidence_integrity"],
    summary: "There is no retry, and its absence is a design decision rather than a gap.",
  },
  {
    slug: "twilio-outage",
    title: "Twilio outage / sustained failure",
    category: "Integrations & notifications",
    subsystems: ["twilio","notifications"],
    summary: "operational_incidents row with fingerprint containing communication_message_failed or verification_check_failed.",
  },
  {
    slug: "webhook-invalid-signature-burst",
    title: "Webhook invalid signature burst",
    category: "Integrations & notifications",
    subsystems: ["webhooks"],
    summary: "Operational incident with fingerprint containing webhook:security_event:communication_webhook_invalid_signature.",
  },
  {
    slug: "worker-wedged",
    title: "Worker wedged / queue not draining",
    category: "Workers & queues",
    subsystems: ["worker","queue"],
    summary: "Failure modes: FM-Q-001 (duplicate delivery), FM-Q-002 (startup race).",
  },
  {
    slug: "workflow-intake-abuse",
    title: "Workflow intake abuse burst",
    category: "Integrations & notifications",
    subsystems: ["workflow","intake"],
    summary: "/v1/ops/metrics → workflow_intake_abuse_total counter rising.",
  },
  {
    slug: "workflow-stuck",
    title: "Stuck workflow instance",
    category: "Workers & queues",
    subsystems: ["workflow","queue"],
    summary: "EvidenceWorkflowInstance rows in SUBMITTED or NEEDS_REVIEW for an unusually long period (configurable; default operator-facing threshold: 7 days).",
  },
];
