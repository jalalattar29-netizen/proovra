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
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  badgeStyle,
  cardStyle,
  errorBoxStyle,
  ghostButtonStyle,
  headerRowStyle,
  mutedStyle,
  monoStyle,
  pageStyle,
  sectionTitleStyle,
  subtitleStyle,
  titleStyle,
  TOKENS,
} from "../../admin/identity/ui-tokens";

// ---------------------------------------------------------------------------
// Response shape — matches
// services/api/src/services/operations/readiness-posture.service.ts
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
// Runbook links (honest docs under docs/runbooks/).
// ---------------------------------------------------------------------------

const RUNBOOK_LINKS: ReadonlyArray<{ label: string; path: string; summary: string }> = [
  {
    label: "Disaster recovery",
    path: "docs/runbooks/disaster-recovery.md",
    summary:
      "RPO/RTO stated as targets/assumptions (not guarantees), Object Lock + managed-DB-backup posture, artifact regeneration, restore steps.",
  },
  {
    label: "SRE runbooks",
    path: "docs/runbooks/sre-runbooks.md",
    summary:
      "Operator procedures: report/OTS queue backlog, immutable-storage drift, webhook auto-disable, worker heartbeat missing.",
  },
  {
    label: "Pen-test readiness",
    path: "docs/runbooks/pentest-readiness.md",
    summary:
      "Allowed scope, seeded fixtures, environment separation, rate-limit notes, destructive-action exclusions, security contact.",
  },
  {
    label: "Security review",
    path: "docs/runbooks/security-review.md",
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
    <main style={pageStyle} data-testid="operations-readiness-root">
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Production Readiness Posture</h1>
          <p style={subtitleStyle}>
            A truthful, configuration-derived view of backup / preservation
            posture, signing-key management, and runtime resiliency. This
            surface reports only what the platform can verify from its
            configuration. It makes no uptime, SLA, third-party
            security-certification, or penetration-test claims. Where
            something is not configured or cannot be proven, it says so plainly.
          </p>
        </div>
        <button type="button" style={ghostButtonStyle} onClick={load}>
          Refresh
        </button>
      </header>

      {error ? (
        <div style={errorBoxStyle} data-testid="readiness-error">
          {error}
        </div>
      ) : null}

      {!posture ? (
        <p style={{ ...mutedStyle, marginTop: 16 }}>
          {loading ? "Loading posture…" : "No posture loaded."}
        </p>
      ) : (
        <>
          <BackupSection backup={posture.backup} />
          <MfaThrottleSection mfaThrottle={posture.mfaThrottle} />
          <KeySection keys={posture.keys} />
          <ResiliencySection resiliency={posture.resiliency} />
          <KnownLimitationsSection limitations={posture.knownLimitations} />
          <RunbooksSection />
          <p style={{ ...mutedStyle, fontSize: 11, marginTop: 12 }}>
            Generated {posture.generatedAtUtc}
          </p>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Badges — neutral by default; green ONLY for a genuinely verified positive.
// ---------------------------------------------------------------------------

const NEUTRAL = { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" } as const;
const GREEN = { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" } as const;
const AMBER = { bg: "#fef3c7", fg: "#78350f", border: "#fde68a" } as const;
const RED = { bg: "#fef2f2", fg: "#991b1b", border: "#fecaca" } as const;

function Badge({
  tone,
  children,
  testId,
}: {
  tone: typeof NEUTRAL | typeof GREEN | typeof AMBER | typeof RED;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <span style={badgeStyle(tone)} data-testid={testId}>
      {children}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={mutedStyle}>{label}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function BackupSection({ backup }: { backup: ReadinessPosture["backup"] }) {
  return (
    <section style={{ ...cardStyle, marginTop: 16 }} data-testid="backup-section">
      <h3 style={sectionTitleStyle}>Backup &amp; preservation posture</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Row label="S3 Object Lock">
          {backup.objectLockEnabled ? (
            <Badge tone={GREEN} testId="object-lock-enabled">
              Enabled
            </Badge>
          ) : (
            <Badge tone={AMBER} testId="object-lock-disabled">
              Not enabled
            </Badge>
          )}
        </Row>
        <Row label="Object Lock mode">
          <Badge tone={backup.objectLockMode ? NEUTRAL : NEUTRAL}>
            {backup.objectLockMode ?? "Not set"}
          </Badge>
        </Row>
        <Row label="Retention (days)">
          <span style={monoStyle}>
            {backup.objectLockRetainDays ?? "Not set"}
          </span>
        </Row>
        <Row label="Object Lock live status">
          <Badge
            tone={backup.objectLockStatus.mode === "verified" ? GREEN : AMBER}
            testId="object-lock-status"
          >
            {backup.objectLockStatus.mode}
          </Badge>
        </Row>
      </div>

      <div style={{ marginTop: 16 }}>
        <Row label="Database backup">
          {backup.databaseBackup === "managed_platform_assumed" ? (
            <Badge tone={NEUTRAL} testId="db-backup-managed">
              Managed platform (assumed)
            </Badge>
          ) : (
            <Badge tone={RED} testId="db-backup-not-configured">
              Not configured
            </Badge>
          )}
        </Row>
        <p style={{ ...mutedStyle, fontSize: 12, marginTop: 6 }}>
          {backup.databaseBackupReason}
        </p>
      </div>

      <div style={{ marginTop: 16 }}>
        <Row label="Backup provider">
          {backup.databaseBackupProvider ? (
            <Badge tone={NEUTRAL} testId="db-backup-provider">
              {backup.databaseBackupProvider}
            </Badge>
          ) : (
            <Badge tone={AMBER} testId="db-backup-provider-none">
              Not declared
            </Badge>
          )}
        </Row>
        {backup.databaseBackupPolicyUrl ? (
          <p style={{ fontSize: 12, marginTop: 6 }}>
            <a href={backup.databaseBackupPolicyUrl} data-testid="db-backup-policy-link">
              Backup policy / runbook
            </a>
          </p>
        ) : null}
        <Row label="Backups last verified">
          <span data-testid="db-backup-last-verified">
            {backup.databaseBackupLastVerifiedAtUtc ?? "Unknown"}
          </span>
        </Row>
        <Row label="Restore test">
          <span data-testid="db-restore-tested">
            {backup.databaseRestoreTestedAtUtc ?? "Not run"}
          </span>
        </Row>
        <Row label="Launch readiness">
          {backup.databaseBackupLaunchActionRequired ? (
            <Badge tone={RED} testId="db-backup-action-required">
              Action required: verify backups + test restore
            </Badge>
          ) : (
            <Badge tone={GREEN} testId="db-backup-verified">
              Verified + restore tested
            </Badge>
          )}
        </Row>
      </div>

      <div style={{ marginTop: 16 }}>
        <Row label="Artifact regeneration">
          <Badge tone={GREEN} testId="artifact-regen">
            Available
          </Badge>
        </Row>
        <p style={{ ...mutedStyle, fontSize: 12, marginTop: 6 }}>
          {backup.artifactRegeneration.note}
        </p>
      </div>
    </section>
  );
}

function MfaThrottleSection({
  mfaThrottle,
}: {
  mfaThrottle: ReadinessPosture["mfaThrottle"];
}) {
  return (
    <section style={{ ...cardStyle, marginTop: 12 }} data-testid="mfa-throttle-section">
      <h3 style={sectionTitleStyle}>MFA / login throttle</h3>
      <div style={{ marginTop: 16 }}>
        <Row label="Attempt-counter store">
          <Badge
            tone={mfaThrottle.shared ? GREEN : AMBER}
            testId="mfa-throttle-store"
          >
            {mfaThrottle.store}
            {mfaThrottle.shared ? " (shared)" : " (per-instance)"}
          </Badge>
        </Row>
        <Row label="Multi-instance readiness">
          {mfaThrottle.productionReady ? (
            <Badge tone={GREEN} testId="mfa-throttle-ready">
              Production-ready
            </Badge>
          ) : (
            <Badge tone={RED} testId="mfa-throttle-action-required">
              Action required: configure shared store before launch
            </Badge>
          )}
        </Row>
        <p style={{ ...mutedStyle, fontSize: 12, marginTop: 6 }}>
          {mfaThrottle.reason}
        </p>
      </div>
    </section>
  );
}

function KeySection({ keys }: { keys: ReadinessPosture["keys"] }) {
  return (
    <section style={{ ...cardStyle, marginTop: 12 }} data-testid="keys-section">
      <h3 style={sectionTitleStyle}>Key management</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Row label="Signer provider">
          <Badge
            tone={keys.signerProvider === "disabled" ? AMBER : NEUTRAL}
            testId="signer-provider"
          >
            {keys.signerProvider}
          </Badge>
        </Row>
        <Row label="Signing key versioned">
          {keys.keyVersioned ? (
            <Badge tone={GREEN} testId="key-versioned">
              Versioned
            </Badge>
          ) : (
            <Badge tone={AMBER} testId="key-not-versioned">
              Not confirmed
            </Badge>
          )}
        </Row>
      </div>
      {keys.keyVersionUnknownReason ? (
        <p style={{ ...mutedStyle, fontSize: 12, marginTop: 6 }}>
          {keys.keyVersionUnknownReason}
        </p>
      ) : null}
      <p style={{ ...mutedStyle, fontSize: 11, marginTop: 8 }}>
        No key material, KMS ARNs, or IAM details are exposed on this surface.
      </p>
    </section>
  );
}

function statusTone(status: string) {
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
    <section
      style={{ ...cardStyle, marginTop: 12 }}
      data-testid="resiliency-section"
    >
      <h3 style={sectionTitleStyle}>Resiliency</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
        }}
      >
        <div>
          <Row label="Runtime readiness">
            <Badge tone={statusTone(rr.status)} testId="runtime-status">
              {rr.status}
            </Badge>
          </Row>
          <p style={{ ...mutedStyle, fontSize: 12, marginTop: 6 }}>
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
            <Badge tone={statusTone(sd.status)} testId="schema-status">
              {sd.status}
            </Badge>
          </Row>
          <p style={{ ...mutedStyle, fontSize: 12, marginTop: 6 }}>
            {sd.unavailableReason
              ? sd.unavailableReason
              : `${sd.failureCount} of ${sd.checkedCount} expected schema objects missing.`}
          </p>
        </div>
      </div>
    </section>
  );
}

function KnownLimitationsSection({
  limitations,
}: {
  limitations: ReadonlyArray<string>;
}) {
  return (
    <section
      style={{ ...cardStyle, marginTop: 12, background: TOKENS.surfaceMuted }}
      data-testid="known-limitations"
    >
      <h3 style={sectionTitleStyle}>Known limitations (honest disclosure)</h3>
      <p style={mutedStyle}>
        These are real, flagged caveats — not marketing copy. They are stated
        plainly so operators and reviewers can make informed decisions.
      </p>
      <ul style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
        {limitations.map((l) => (
          <li key={l} style={{ marginBottom: 6 }}>
            {l}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunbooksSection() {
  return (
    <section style={{ ...cardStyle, marginTop: 12 }} data-testid="runbooks-section">
      <h3 style={sectionTitleStyle}>Runbooks &amp; checklists</h3>
      <p style={mutedStyle}>
        Operator and reviewer documentation. The authoritative text lives in
        the repository under <code style={monoStyle}>docs/runbooks/</code>.
      </p>
      <ul style={{ marginTop: 8, paddingLeft: 0, listStyle: "none" }}>
        {RUNBOOK_LINKS.map((r) => (
          <li key={r.path} style={{ marginBottom: 10 }}>
            <Link
              href={`/operations/runbooks`}
              style={{ color: TOKENS.link ?? "#2563eb", fontWeight: 600 }}
            >
              {r.label}
            </Link>
            <div style={{ ...mutedStyle, fontSize: 12 }}>{r.summary}</div>
            <code style={{ ...monoStyle, fontSize: 11 }}>{r.path}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
