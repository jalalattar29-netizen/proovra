"use client";

/**
 * Phase F — Destruction Certificate viewer.
 *
 * Renders the canonical destruction certificate body for an EXECUTED
 * destruction review (consumed from
 * `GET /v1/governance/destruction-reviews/:id/certificate`). The
 * certificate is OPERATIONAL TRACEABILITY — never a legal admissibility
 * statement, never a cryptographic proof of erasure.
 *
 * The component renders the backend's `caveats` array verbatim so the
 * caveat copy stays under governance review, not frontend whim.
 *
 * Hard rules:
 *   * No mutation actions.
 *   * Renders the cert body as canonical JSON for operator download
 *     (Blob URL). The download is the artifact, not a separate API.
 *   * Vocabulary stays operational. Never claims authenticity, legal
 *     admissibility, or compliance attestation.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";

type CertificateResponse = {
  certificate: {
    reviewId: string;
    evidenceId: string;
    teamId: string;
    executedAtUtc: string | null;
    decidedAtUtc: string | null;
    decidedByUserId: string | null;
    reason: string;
    decisionNote: string | null;
    retentionPolicyId: string | null;
    retentionPolicyVersion: number | null;
    certificateHash: string | null;
    lifecycleEventId: string | null;
    lineageHash: string | null;
    reviewCreatedAt: string;
    eventSummary: string | null;
  };
  caveats: ReadonlyArray<string>;
};

export function DestructionCertificate({
  reviewId,
  teamId,
}: {
  reviewId: string;
  teamId: string | null;
}) {
  const [data, setData] = useState<CertificateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/v1/governance/destruction-reviews/${encodeURIComponent(
          reviewId,
        )}/certificate?teamId=${encodeURIComponent(teamId)}`,
      );
      const json = (await res.json()) as CertificateResponse;
      setData(json);
    } catch (err) {
      const e = err as { message?: string; statusCode?: number };
      if (e.statusCode === 409) {
        setError(
          "Destruction certificates are only generated once a review is EXECUTED.",
        );
      } else {
        setError(e.message ?? "Could not load destruction certificate.");
      }
    } finally {
      setLoading(false);
    }
  }, [reviewId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const downloadUrl = useMemo(() => {
    if (!data) return null;
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }, [data]);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  if (loading) {
    return (
      <div data-destruction-cert-loading style={panelStyle}>
        Loading destruction certificate…
      </div>
    );
  }
  if (error) {
    return (
      <div data-destruction-cert-error role="alert" style={panelStyle}>
        <strong>Destruction certificate unavailable</strong>
        <p style={mutedStyle}>{error}</p>
      </div>
    );
  }
  if (!data) return null;

  return (
    <section
      data-destruction-certificate
      data-review-id={data.certificate.reviewId}
      style={{ ...panelStyle, padding: "0.85rem 1rem" }}
    >
      <header style={{ marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>Destruction certificate</strong>
        <p style={{ ...mutedStyle, margin: "4px 0 0" }}>
          Operational traceability record. Not a legal admissibility statement.
        </p>
      </header>

      <dl
        data-destruction-cert-body
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          fontSize: 13,
          marginBottom: 12,
        }}
      >
        <dt style={labelStyle}>Review</dt>
        <dd>
          <code>{data.certificate.reviewId}</code>
        </dd>

        <dt style={labelStyle}>Evidence</dt>
        <dd>
          <code>{data.certificate.evidenceId}</code>
        </dd>

        <dt style={labelStyle}>Executed at</dt>
        <dd>{formatDate(data.certificate.executedAtUtc)}</dd>

        <dt style={labelStyle}>Decided at</dt>
        <dd>{formatDate(data.certificate.decidedAtUtc)}</dd>

        <dt style={labelStyle}>Decided by</dt>
        <dd>
          {data.certificate.decidedByUserId ? (
            <code>{data.certificate.decidedByUserId}</code>
          ) : (
            <span style={mutedStyle}>not recorded</span>
          )}
        </dd>

        <dt style={labelStyle}>Reason</dt>
        <dd>{data.certificate.reason}</dd>

        {data.certificate.decisionNote ? (
          <>
            <dt style={labelStyle}>Decision note</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>
              {data.certificate.decisionNote}
            </dd>
          </>
        ) : null}

        {data.certificate.retentionPolicyId ? (
          <>
            <dt style={labelStyle}>Retention policy</dt>
            <dd>
              <code>{data.certificate.retentionPolicyId}</code>
              {data.certificate.retentionPolicyVersion != null
                ? ` (version ${data.certificate.retentionPolicyVersion})`
                : ""}
            </dd>
          </>
        ) : null}

        <dt style={labelStyle}>Certificate hash</dt>
        <dd>
          {data.certificate.certificateHash ? (
            <code style={{ fontSize: 11 }}>
              {data.certificate.certificateHash}
            </code>
          ) : (
            <span style={mutedStyle}>not recorded</span>
          )}
        </dd>

        <dt style={labelStyle}>Lineage hash</dt>
        <dd>
          {data.certificate.lineageHash ? (
            <code style={{ fontSize: 11 }}>
              {typeof data.certificate.lineageHash === "string"
                ? data.certificate.lineageHash
                : JSON.stringify(data.certificate.lineageHash)}
            </code>
          ) : (
            <span style={mutedStyle}>not chained</span>
          )}
        </dd>

        <dt style={labelStyle}>Lifecycle event</dt>
        <dd>
          {data.certificate.lifecycleEventId ? (
            <code>{data.certificate.lifecycleEventId}</code>
          ) : (
            <span style={mutedStyle}>none</span>
          )}
        </dd>
      </dl>

      {downloadUrl ? (
        <p style={{ marginBottom: 12 }}>
          <a
            href={downloadUrl}
            download={`destruction-certificate-${data.certificate.reviewId}.json`}
            data-destruction-cert-download
            style={{
              fontSize: 13,
              padding: "6px 12px",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              textDecoration: "none",
              color: "#0f172a",
              background: "#f1f5f9",
              display: "inline-block",
            }}
          >
            Download certificate JSON
          </a>
        </p>
      ) : null}

      <details
        data-destruction-cert-caveats
        style={{
          border: "1px solid #fde68a",
          background: "#fffbeb",
          borderRadius: 6,
          padding: "0.5rem 0.75rem",
        }}
      >
        <summary
          style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}
        >
          Important operational caveats ({data.caveats.length})
        </summary>
        <ul
          style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5 }}
        >
          {data.caveats.map((c, idx) => (
            <li key={idx} data-destruction-cert-caveat>
              {c}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}

const panelStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  padding: "0.75rem 1rem",
} as const;

const labelStyle = {
  fontWeight: 600,
  color: "#475569",
} as const;

const mutedStyle = {
  color: "#94a3b8",
} as const;
