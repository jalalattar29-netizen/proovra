"use client";

/**
 * PHASE 12 VERTICAL C — Verification references + package preview.
 *
 * Two canonical operations that had no product consumer:
 *
 *   GET /v1/trust/verify-references              — the published trust,
 *       methodology, AI-disclosure and security articles (titles, slugs,
 *       versions) plus the active subprocessors that a verifier can cite.
 *       Article BODIES are never part of this projection.
 *   GET /v1/trust/verification-package/preview   — the exact manifest the
 *       worker writes into the offline verification package, built by the
 *       CANONICAL package authority (`buildVerificationPackagePreview`) —
 *       the same builder the emitted ZIP uses.
 *
 * The preview is a read. It takes no client-declared storage key, it is
 * workspace-scoped on the server, and authorizing it emits NO delivery or
 * download event — looking at what a package would contain is not the same
 * act as receiving one.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../../lib/api";
import { useTenantGuard } from "../../../../../../../lib/platform-context";
import { Button } from "../../../../../../../components/ui/Button";
import { Card } from "../../../../../../../components/ui/Card";
import { Badge } from "../../../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../../../components/ui/EmptyState";
import {
  classifyTrustPhase,
  mutedStyle,
  type TrustFailure,
} from "./_shared";

type ArticleRef = { title: string; slug: string; version: number };
type SubprocessorRef = { name: string; slug: string; vendor: string };

type References = {
  trustCenter: ArticleRef[];
  methodology: ArticleRef[];
  aiDisclosure: ArticleRef[];
  security: ArticleRef[];
  subprocessors: SubprocessorRef[];
};

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; references: References }
  | TrustFailure;

const PREVIEW_KINDS = [
  { key: "trust", label: "Trust" },
  { key: "governance", label: "Governance" },
  { key: "methodology", label: "Methodology" },
  { key: "ai-disclosure", label: "AI disclosure" },
  { key: "subprocessor", label: "Subprocessors" },
] as const;

const GROUPS: Array<{ key: keyof References; label: string }> = [
  { key: "trustCenter", label: "Trust Center" },
  { key: "methodology", label: "Methodology" },
  { key: "aiDisclosure", label: "AI disclosure" },
  { key: "security", label: "Security" },
];

export function VerificationReferencesSection() {
  const { stamp, isStale } = useTenantGuard();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [previewKind, setPreviewKind] =
    useState<(typeof PREVIEW_KINDS)[number]["key"]>("trust");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const res = (await apiFetch("/v1/trust/verify-references", {
        method: "GET",
      })) as { references?: References };
      if (isStale(captured)) return;
      setPhase({
        kind: "ready",
        references: res.references ?? {
          trustCenter: [],
          methodology: [],
          aiDisclosure: [],
          security: [],
          subprocessors: [],
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setPhase(
        classifyTrustPhase(err, {
          deniedTitle: "You can't see what verifiers can cite",
          deniedDetail:
            "Your role in this workspace does not allow reading the published verification references. Nothing was loaded.",
          errorMessage: "Could not load the verification references.",
        }),
      );
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPreview = useCallback(async () => {
    const captured = stamp();
    setPreviewBusy(true);
    setPreviewNote(null);
    setPreview(null);
    try {
      const res = (await apiFetch(
        `/v1/trust/verification-package/preview?kind=${encodeURIComponent(previewKind)}`,
        { method: "GET" },
      )) as { kind?: string; manifest?: unknown };
      if (isStale(captured)) return;
      setPreview(JSON.stringify(res.manifest ?? null, null, 2));
    } catch (err) {
      if (isStale(captured)) return;
      const failure = classifyTrustPhase(err, {
        deniedTitle: "You can't preview the verification package",
        deniedDetail:
          "Previewing package contents requires trust-governance access in this workspace. Nothing was generated and nothing was delivered.",
        errorMessage: "Could not build the preview.",
      });
      setPreviewNote(failure.detail);
    } finally {
      setPreviewBusy(false);
    }
  }, [previewKind, stamp, isStale]);

  return (
    <Card
      variant="admin"
      padding="comfortable"
      title="What a verifier can check"
      data-testid="trust-verify-references"
    >
      <p style={{ ...mutedStyle, marginTop: 0, maxWidth: 720 }}>
        The published documents and vendor list that anyone verifying your
        evidence can cite, at the exact versions currently live. Article text
        stays out of this list on purpose — a verifier cites a version, not a
        copy.
      </p>

      {phase.kind === "loading" ? (
        <p style={mutedStyle} data-testid="trust-verify-references-loading">
          Reading published references…
        </p>
      ) : null}

      {phase.kind === "denied" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="trust-verify-references-denied"
        >
          <strong style={{ fontSize: 14 }}>{phase.title}</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
            {phase.detail}
          </p>
        </Card>
      ) : null}

      {phase.kind === "error" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="trust-verify-references-error"
        >
          <strong style={{ fontSize: 14 }}>That didn&apos;t load</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>{phase.detail}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </Card>
      ) : null}

      {phase.kind === "ready" ? (
        <>
          {GROUPS.every((g) => (phase.references[g.key] as ArticleRef[]).length === 0) &&
          phase.references.subprocessors.length === 0 ? (
            <EmptyState
              compact
              framed
              title="Nothing is published yet"
              purpose="Publish your trust documents and vendor list so anyone verifying your evidence has something citable."
            />
          ) : (
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                marginTop: 12,
              }}
            >
              {GROUPS.map((g) => {
                const rows = phase.references[g.key] as ArticleRef[];
                return (
                  <div
                    key={g.key}
                    data-reference-group={g.key}
                    style={{
                      border: "1px solid rgba(15, 23, 42, 0.10)",
                      borderRadius: 8,
                      padding: 10,
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <strong style={{ fontSize: 13 }}>{g.label}</strong>
                      <Badge tone={rows.length > 0 ? "verified" : "neutral"} subtle>
                        {rows.length} published
                      </Badge>
                    </div>
                    <ul style={{ ...mutedStyle, margin: "6px 0 0", paddingLeft: 18 }}>
                      {rows.slice(0, 8).map((r) => (
                        <li key={r.slug}>
                          {r.title} <span style={{ opacity: 0.7 }}>v{r.version}</span>
                        </li>
                      ))}
                      {rows.length === 0 ? <li>Nothing published</li> : null}
                    </ul>
                  </div>
                );
              })}
              <div
                data-reference-group="subprocessors"
                style={{
                  border: "1px solid rgba(15, 23, 42, 0.10)",
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>Vendors in use</strong>
                  <Badge
                    tone={phase.references.subprocessors.length > 0 ? "verified" : "neutral"}
                    subtle
                  >
                    {phase.references.subprocessors.length} active
                  </Badge>
                </div>
                <ul style={{ ...mutedStyle, margin: "6px 0 0", paddingLeft: 18 }}>
                  {phase.references.subprocessors.slice(0, 8).map((s) => (
                    <li key={s.slug}>
                      {s.name} <span style={{ opacity: 0.7 }}>· {s.vendor}</span>
                    </li>
                  ))}
                  {phase.references.subprocessors.length === 0 ? (
                    <li>None listed</li>
                  ) : null}
                </ul>
              </div>
            </div>
          )}
        </>
      ) : null}

      <h3 style={{ fontSize: 13.5, margin: "18px 0 6px" }}>
        Preview what ships in a verification package
      </h3>
      <p style={{ ...mutedStyle, margin: "0 0 8px", maxWidth: 720 }}>
        This is the exact manifest the platform writes into an offline
        verification package, produced by the same builder that writes the real
        one. Previewing it records nothing and delivers nothing.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={previewKind}
          onChange={(e) =>
            setPreviewKind(e.target.value as (typeof PREVIEW_KINDS)[number]["key"])
          }
          data-testid="trust-package-preview-kind"
          style={{
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid rgba(15, 23, 42, 0.18)",
            fontSize: 12.5,
            background: "transparent",
            color: "inherit",
          }}
        >
          {PREVIEW_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          loading={previewBusy}
          disabled={previewBusy}
          onClick={() => void loadPreview()}
          data-testid="trust-package-preview-load"
        >
          Show manifest
        </Button>
      </div>

      {previewNote ? (
        <p
          style={{ ...mutedStyle, color: "#92400e", marginTop: 8 }}
          data-testid="trust-package-preview-note"
        >
          {previewNote}
        </p>
      ) : null}

      {preview ? (
        <pre
          data-testid="trust-package-preview"
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 8,
            border: "1px solid rgba(15, 23, 42, 0.10)",
            background: "rgba(15, 23, 42, 0.04)",
            fontSize: 11,
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {preview}
        </pre>
      ) : null}
    </Card>
  );
}
