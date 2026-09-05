"use client";

/**
 * Phase 8 — Enterprise Production Readiness posture (SCOPE F / I / J).
 *
 * Platform-admin surface that renders the TRUTHFUL posture rollup from
 *   GET /v1/operations/readiness
 * (services/api/src/routes/operations-readiness.routes.ts).
 *
 * Sections:
 *   1. Backup & preservation posture — Object Lock, honest DB-backup
 *      label, artifact regeneration.
 *   2. Key management — signer provider + versioning (NO secrets).
 *   3. Resiliency — runtime readiness rollup + schema drift summary.
 *   4. Known limitations — the honest caveats verbatim from the backend.
 *   5. Runbooks & checklists — links to the honest docs under
 *      docs/runbooks/.
 *
 * Hard rules:
 *   * NO fabricated positives. Database backup renders a neutral
 *     "Managed platform (assumed)" / "Not configured" badge — never a
 *     green "backed up".
 *   * NO fake uptime / SLA / certification / penetration-test claims.
 *   * Errors flow through toSafeUserError (the only sanctioned
 *     error-display path).
 *   * Gated by <PageRouteGate routeId="operations.readiness">. Backend
 *     requirePlatformAdmin remains the authoritative boundary.
 *
 * Phase 7C — premium visual pass. Restyled to the shared design system
 * (PageShell / PageHeader / PageSection + Card / Badge / Button). Every
 * posture field, data-testid, and honest copy string is preserved
 * verbatim; badge tones map 1:1 onto the previous neutral/green/amber/red
 * semantics so no positive is fabricated.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
  PageSection,
} from "../../../../../components/ui";
import { Card } from "../../../../../components/ui/Card";
import { Badge, type BadgeTone } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { formatUserDateTime } from "../../../../../lib/date";


// ---------------------------------------------------------------------------
// Response shape — matches
// services/api/src/services/admin/platform/readiness-posture.service.ts
// ---------------------------------------------------------------------------

type ObjectLockStatus =
  | {
      mode: "verified";
      bucket: string;
      defaultMode: "GOVERNANCE" | "COMPLIANCE" | null;
      defaultRetainDays: number | null;
      checkedAtUtc: string;
    }
  | { mode: "claimed-but-unsupported"; bucket: string; reason: string; checkedAtUtc: string }
  | { mode: "disabled"; checkedAtUtc: string }
  | { mode: "skipped"; reason: string; checkedAtUtc: string };

type ReadinessPosture = {
  generatedAtUtc: string;
  backup: {
    objectLockEnabled: boolean;
    objectLockMode: "GOVERNANCE" | "COMPLIANCE" | null;
    objectLockRetainDays: number | null;
    objectLockStatus: ObjectLockStatus;
    databaseBackup: "managed_platform_assumed" | "not_configured";
    databaseBackupReason: string;
    databaseBackupProvider: string | null;
    databaseBackupPolicyUrl: string | null;
    databaseBackupLastVerifiedAtUtc: string | null;
    databaseRestoreTestedAtUtc: string | null;
    databaseBackupLaunchActionRequired: boolean;
    artifactRegeneration: { reportRegenAvailable: true; note: string };
  };
  mfaThrottle: {
    store: "redis" | "memory";
    shared: boolean;
    productionReady: boolean;
    reason: string;
  };
  keys: {
    signerProvider: "aws-kms" | "local-pem" | "disabled" | "unknown";
    keyVersioned: boolean;
    keyVersionUnknownReason: string | null;
  };
  resiliency: {
    runtimeReadinessSummary: {
      status: string;
      ranAtUtc: string;
      subsystemCount: number;
      degradedSubsystems: ReadonlyArray<string>;
      unavailableReason: string | null;
    };
    schemaDriftSummary: {
      status: string;
      driftFingerprint: string | null;
      failureCount: number;
      checkedCount: number;
      unavailableReason: string | null;
    };
  };
  knownLimitations: ReadonlyArray<string>;
};

// ---------------------------------------------------------------------------
// Runbook links.
//
// These used to print a REPOSITORY PATH — "docs/runbooks/disaster-recovery.md"
// — under a link that went to the runbook INDEX rather than the runbook. So an
// operator reading this page during an incident got a filename they cannot
// open and a link that made them search a list for it.
//
// Every one of these four is a real slug in the generated catalog, and the
// in-app reader at /admin/platform/runbooks/:slug renders the text. The link
// now goes there and the path is gone from the page.
// ---------------------------------------------------------------------------

const RUNBOOK_LINKS: ReadonlyArray<{ label: string; slug: string; summary: string }> = [
  {
    label: "Disaster recovery",
    slug: "disaster-recovery",
    summary:
      "RPO/RTO stated as targets/assumptions (not guarantees), Object Lock + managed-DB-backup posture, artifact regeneration, restore steps.",
  },
  {
    label: "SRE runbooks",
    slug: "sre-runbooks",
    summary:
      "Operator procedures: report/OTS queue backlog, immutable-storage drift, webhook auto-disable, worker heartbeat missing.",
  },
  {
    label: "Pen-test readiness",
    slug: "pentest-readiness",
    summary:
      "Allowed scope, seeded fixtures, environment separation, rate-limit notes, destructive-action exclusions, security contact.",
  },
  {
    label: "Security review",
    slug: "security-review",
    summary:
      "Procurement / security-review checklist linking the honest legal docs; no certification claimed unless separately verified.",
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OperationsReadinessPage() {
  return (
    <PageRouteGate routeId="operations.readiness">
      <OperationsReadinessContent />
    </PageRouteGate>
  );
}

function OperationsReadinessContent() {
  const [posture, setPosture] = useState<ReadinessPosture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch("/v1/operations/readiness", { method: "GET" })
      .then((r: { posture: ReadinessPosture }) => setPosture(r.posture))
      .catch((err: unknown) =>
        setError(
          toSafeUserError(err, {
            message: "Could not load production readiness posture.",
          }).message,
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <PageShell
      data-testid="operations-readiness-root"
      header={
        <PageHeader
          eyebrow="Operations"
          title="Production Readiness Posture"
          subtitle="A truthful, configuration-derived view of backup / preservation posture, signing-key management, and runtime resiliency. This surface reports only what the platform can verify from its configuration. It makes no uptime, SLA, third-party security-certification, or penetration-test claims. Where something is not configured or cannot be proven, it says so plainly."
          primaryAction={
            <Button variant="secondary" onClick={load} loading={loading}>
              Refresh
            </Button>
          }
        />
      }
      >
      {error ? (
        <Card variant="status" tone="risk" data-testid="readiness-error">
          <div style={{ color: "var(--status-risk-fg)" }}>{error}</div>
        </Card>
      ) : null}

      {!posture ? (
        <Card>
          <p className="adm-help">
            {loading ? "Loading posture…" : "No posture loaded."}
          </p>
        </Card>
      ) : (
        <>
          <BackupSection backup={posture.backup} />
          <MfaThrottleSection mfaThrottle={posture.mfaThrottle} />
          <KeySection keys={posture.keys} />
          <ResiliencySection resiliency={posture.resiliency} />
          <KnownLimitationsSection limitations={posture.knownLimitations} />
          <RunbooksSection />
          <p className="adm-help" style={{ fontSize: 11 }}>
            {/* This printed the raw ISO string with milliseconds and a Z —
                `2026-09-05T15:28:59.807Z` — on a page an operator reads to
                decide whether the platform is ready to launch. Every other
                timestamp in the console goes through the shared formatter. */}
            Generated {formatUserDateTime(posture.generatedAtUtc)}
          </p>
        </>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Badge tones — neutral by default; GREEN (verified) ONLY for a genuinely
// verified positive. These map 1:1 onto the previous local palette so no
// honest state changes.
//   NEUTRAL → "neutral"   GREEN → "verified"
//   AMBER   → "pending"   RED   → "risk"
// ---------------------------------------------------------------------------

const NEUTRAL: BadgeTone = "neutral";
const GREEN: BadgeTone = "verified";
const AMBER: BadgeTone = "pending";
const RED: BadgeTone = "risk";

function PostureBadge({
  tone,
  children,
  testId,
}: {
  tone: BadgeTone;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Badge tone={tone} data-testid={testId}>
      {children}
    </Badge>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="adm-help">{label}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function BackupSection({ backup }: { backup: ReadinessPosture["backup"] }) {
  return (
    <PageSection
      title="Backup & preservation posture"
      description="Object Lock, honest database-backup label, and artifact regeneration."
    >
      <Card data-testid="backup-section">
        <div style={gridStyle}>
          <Row label="S3 Object Lock">
            {backup.objectLockEnabled ? (
              <PostureBadge tone={GREEN} testId="object-lock-enabled">
                Enabled
              </PostureBadge>
            ) : (
              <PostureBadge tone={AMBER} testId="object-lock-disabled">
                Not enabled
              </PostureBadge>
            )}
          </Row>
          <Row label="Object Lock mode">
            <PostureBadge tone={NEUTRAL}>
              {backup.objectLockMode ?? "Not set"}
            </PostureBadge>
          </Row>
          <Row label="Retention (days)">
            <span className="adm-mono">
              {backup.objectLockRetainDays ?? "Not set"}
            </span>
          </Row>
          <Row label="Object Lock live status">
            <PostureBadge
              tone={backup.objectLockStatus.mode === "verified" ? GREEN : AMBER}
              testId="object-lock-status"
            >
              {backup.objectLockStatus.mode}
            </PostureBadge>
          </Row>
        </div>

        <div style={{ marginTop: 16 }}>
          <Row label="Database backup">
            {backup.databaseBackup === "managed_platform_assumed" ? (
              <PostureBadge tone={NEUTRAL} testId="db-backup-managed">
                Managed platform (assumed)
              </PostureBadge>
            ) : (
              <PostureBadge tone={RED} testId="db-backup-not-configured">
                Not configured
              </PostureBadge>
            )}
          </Row>
          <p className="adm-help" style={{ fontSize: 12, marginTop: 6 }}>
            {backup.databaseBackupReason}
          </p>
        </div>

        <div style={{ marginTop: 16 }}>
          <Row label="Backup provider">
            {backup.databaseBackupProvider ? (
              <PostureBadge tone={NEUTRAL} testId="db-backup-provider">
                {backup.databaseBackupProvider}
              </PostureBadge>
            ) : (
              <PostureBadge tone={AMBER} testId="db-backup-provider-none">
                Not declared
              </PostureBadge>
            )}
          </Row>
          {backup.databaseBackupPolicyUrl ? (
            <p style={{ fontSize: 12, marginTop: 6 }}>
              <a href={backup.databaseBackupPolicyUrl} data-testid="db-backup-policy-link">
                Backup policy / runbook
              </a>
            </p>
          ) : null}
          {/* THREE LABEL-TO-VALUE TREATMENTS IN ONE CARD.
              Every other posture fact in this card is a badge; these two were
              bare 15px text, so "Unknown" and "Not run" read as HEADINGS
              rather than as the states they are — the two states on the card
              that most need to look like states. A verified date is a fact and
              stays plain; the ABSENCE of one is a posture and takes the
              neutral badge its peers use. */}
          <Row label="Backups last verified">
            {backup.databaseBackupLastVerifiedAtUtc ? (
              <span data-testid="db-backup-last-verified">
                {formatUserDateTime(backup.databaseBackupLastVerifiedAtUtc)}
              </span>
            ) : (
              <PostureBadge tone={NEUTRAL} testId="db-backup-last-verified">
                Unknown
              </PostureBadge>
            )}
          </Row>
          <Row label="Restore test">
            {backup.databaseRestoreTestedAtUtc ? (
              <span data-testid="db-restore-tested">
                {formatUserDateTime(backup.databaseRestoreTestedAtUtc)}
              </span>
            ) : (
              <PostureBadge tone={NEUTRAL} testId="db-restore-tested">
                Not run
              </PostureBadge>
            )}
          </Row>
          <Row label="Launch readiness">
            {backup.databaseBackupLaunchActionRequired ? (
              <PostureBadge tone={RED} testId="db-backup-action-required">
                Action required: verify backups + test restore
              </PostureBadge>
            ) : (
              <PostureBadge tone={GREEN} testId="db-backup-verified">
                Verified + restore tested
              </PostureBadge>
            )}
          </Row>
        </div>

        <div style={{ marginTop: 16 }}>
          <Row label="Artifact regeneration">
            <PostureBadge tone={GREEN} testId="artifact-regen">
              Available
            </PostureBadge>
          </Row>
          <p className="adm-help" style={{ fontSize: 12, marginTop: 6 }}>
            {backup.artifactRegeneration.note}
          </p>
        </div>
      </Card>
    </PageSection>
  );
}

function MfaThrottleSection({
  mfaThrottle,
}: {
  mfaThrottle: ReadinessPosture["mfaThrottle"];
}) {
  return (
    <PageSection title="MFA / login throttle">
      <Card data-testid="mfa-throttle-section">
        <div>
          <Row label="Attempt-counter store">
            <PostureBadge
              tone={mfaThrottle.shared ? GREEN : AMBER}
              testId="mfa-throttle-store"
            >
              {mfaThrottle.store}
              {mfaThrottle.shared ? " (shared)" : " (per-instance)"}
            </PostureBadge>
          </Row>
          <div style={{ marginTop: 12 }}>
            <Row label="Multi-instance readiness">
              {mfaThrottle.productionReady ? (
                <PostureBadge tone={GREEN} testId="mfa-throttle-ready">
                  Production-ready
                </PostureBadge>
              ) : (
                <PostureBadge tone={RED} testId="mfa-throttle-action-required">
                  Action required: configure shared store before launch
                </PostureBadge>
              )}
            </Row>
          </div>
          <p className="adm-help" style={{ fontSize: 12, marginTop: 6 }}>
            {mfaThrottle.reason}
          </p>
        </div>
      </Card>
    </PageSection>
  );
}

function KeySection({ keys }: { keys: ReadinessPosture["keys"] }) {
  return (
    <PageSection title="Key management">
      <Card data-testid="keys-section">
        <div style={gridStyle}>
          <Row label="Signer provider">
            <PostureBadge
              tone={keys.signerProvider === "disabled" ? AMBER : NEUTRAL}
              testId="signer-provider"
            >
              {keys.signerProvider}
            </PostureBadge>
          </Row>
          <Row label="Signing key versioned">
            {keys.keyVersioned ? (
              <PostureBadge tone={GREEN} testId="key-versioned">
                Versioned
              </PostureBadge>
            ) : (
              <PostureBadge tone={AMBER} testId="key-not-versioned">
                Not confirmed
              </PostureBadge>
            )}
          </Row>
        </div>
        {keys.keyVersionUnknownReason ? (
          <p className="adm-help" style={{ fontSize: 12, marginTop: 6 }}>
            {keys.keyVersionUnknownReason}
          </p>
        ) : null}
        <p className="adm-help" style={{ fontSize: 11, marginTop: 8 }}>
          No key material, KMS ARNs, or IAM details are exposed on this surface.
        </p>
      </Card>
    </PageSection>
  );
}

function statusTone(status: string): BadgeTone {
  const s = status.toUpperCase();
  if (s === "HEALTHY") return GREEN;
  if (s === "DEGRADED") return AMBER;
  if (s === "CRITICAL") return RED;
  return NEUTRAL;
}

function ResiliencySection({
  resiliency,
}: {
  resiliency: ReadinessPosture["resiliency"];
}) {
  const rr = resiliency.runtimeReadinessSummary;
  const sd = resiliency.schemaDriftSummary;
  return (
    <PageSection title="Resiliency">
      <Card data-testid="resiliency-section">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 16,
          }}
        >
          <div>
            <Row label="Runtime readiness">
              <PostureBadge tone={statusTone(rr.status)} testId="runtime-status">
                {rr.status}
              </PostureBadge>
            </Row>
            <p className="adm-help" style={{ fontSize: 12, marginTop: 6 }}>
              {rr.unavailableReason
                ? rr.unavailableReason
                : `${rr.subsystemCount} subsystems checked${
                    rr.degradedSubsystems.length > 0
                      ? `; degraded: ${rr.degradedSubsystems.join(", ")}`
                      : "; none degraded"
                  }.`}
            </p>
          </div>
          <div>
            <Row label="Schema drift">
              <PostureBadge tone={statusTone(sd.status)} testId="schema-status">
                {sd.status}
              </PostureBadge>
            </Row>
            <p className="adm-help" style={{ fontSize: 12, marginTop: 6 }}>
              {sd.unavailableReason
                ? sd.unavailableReason
                : `${sd.failureCount} of ${sd.checkedCount} expected schema objects missing.`}
            </p>
          </div>
        </div>
      </Card>
    </PageSection>
  );
}

function KnownLimitationsSection({
  limitations,
}: {
  limitations: ReadonlyArray<string>;
}) {
  return (
    <PageSection title="Known limitations (honest disclosure)">
      <Card variant="admin" data-testid="known-limitations">
        {/* An empty list needs its own sentence, and on THIS section more than
            any other.
            The list came back empty and the page still printed "These are
            real, flagged caveats" above nothing — which reads as a section
            that failed to load, on the one surface whose whole purpose is
            being believed. "None currently flagged" is a different statement
            from silence, and it is the true one. */}
        {limitations.length === 0 ? (
          <p style={{ fontSize: 13 }}>
            No limitations are currently flagged. This is the backend reporting
            an empty list, not a section that failed to load.
          </p>
        ) : (
          <>
            <p className="adm-help">
              These are real, flagged caveats — not marketing copy. They are
              stated plainly so operators and reviewers can make informed
              decisions.
            </p>
            <ul style={{ marginTop: 8, paddingInlineStart: 18, fontSize: 13 }}>
              {limitations.map((l) => (
                <li key={l} style={{ marginBottom: 6 }}>
                  {l}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </PageSection>
  );
}

function RunbooksSection() {
  return (
    <PageSection title="Runbooks & checklists">
      <Card data-testid="runbooks-section">
        <p className="adm-help">
          Operator and reviewer documentation. Each opens in the console.
        </p>
        <ul style={{ marginTop: 8, paddingInlineStart: 0, listStyle: "none" }}>
          {RUNBOOK_LINKS.map((r) => (
            <li key={r.slug} style={{ marginBottom: 10 }}>
              <Link
                href={`/admin/platform/runbooks/${r.slug}`}
                className="adm-link"
              >
                {r.label}
              </Link>
              <div className="adm-help" style={{ fontSize: 12 }}>{r.summary}</div>
            </li>
          ))}
        </ul>
      </Card>
    </PageSection>
  );
}

