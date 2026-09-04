"use client";

/**
 * AI & ASSISTANCE, FOR A MEMBER WHO CANNOT CHANGE IT.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * The privileged Settings → AI read requires `intelligence.read`, which VIEWER
 * does not hold — so a VIEWER opened this page and got "could not load". They
 * could not learn whether AI was on in a workspace they belong to.
 *
 * Granting VIEWER `intelligence.read` was not an option: it gates twenty-six
 * endpoints including executive metrics, provider budgets and reviewer quality
 * scores. So the server grew a narrow read behind `governance.policy.read` — a
 * permission every membership role already holds — and this renders it.
 *
 * Transparency is not authority. There are no toggles here, and no disabled
 * ones either: a greyed-out switch invites a click and then refuses it, which
 * is a worse answer than a sentence saying who decides.
 *
 * =============================================================================
 * WHAT IT SHOWS
 * =============================================================================
 * Four cards, each answering one question and not repeating the others:
 *
 *   AI assistance          — is it available to me, and who decides
 *   AI features            — which capabilities, and their effective state
 *   How AI uses your data  — the processing boundary
 *   Workspace AI policy    — the governing authority
 *
 * Every value comes from the server's resolved projection. Nothing here infers
 * availability from a plan name or a role string.
 */

import Link from "next/link";

import { AppStatusText } from "../../../../components/app-primitives";
import {
  aiStatusCopy,
  managedByCopy,
  resolveManagedBy,
  type AiAssistanceStatus,
} from "../../../../lib/ai/assistanceStatus";

export type AiAssistanceFeature = {
  id: string;
  label: string;
  description: string;
  state: "ENABLED" | "DISABLED" | "UNAVAILABLE" | "NOT_INCLUDED";
};

export type AiAssistanceSettings = {
  status: AiAssistanceStatus;
  available: boolean;
  enabled: boolean;
  features: AiAssistanceFeature[];
  processing: {
    mode: string;
    rawEvidenceSentByDefault: boolean;
    decisions: string;
  };
};

/** Feature state → the word shown, and its canonical tone. */
const FEATURE_STATE: Record<
  AiAssistanceFeature["state"],
  { label: string; tone: "green" | "slate" | "amber" }
> = {
  ENABLED: { label: "Enabled", tone: "green" },
  DISABLED: { label: "Disabled", tone: "slate" },
  UNAVAILABLE: { label: "Unavailable", tone: "amber" },
  NOT_INCLUDED: { label: "Not included", tone: "slate" },
};

const label: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink-primary, #0f172a)",
};
const helper: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "var(--app-ink-secondary, #667085)",
};

/**
 * A label/value line that wraps instead of clipping.
 *
 * `minInlineSize: 0` on both halves: these sit in flex rows, and a flex item
 * defaults to `min-width: auto`, so a long value ("Managed by workspace
 * administrators") pushes the row past the card at 320px rather than wrapping.
 */
function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
        padding: "7px 0",
        minInlineSize: 0,
      }}
    >
      <span style={{ ...label, fontWeight: 500, minInlineSize: 0 }}>{name}</span>
      <span style={{ minInlineSize: 0, textAlign: "end" }}>{children}</span>
    </div>
  );
}

export function AiReadOnlyView({
  data,
  workspaceKind,
  canManage,
}: {
  data: AiAssistanceSettings;
  workspaceKind: "PERSONAL" | "ORGANIZATION" | null;
  /*
   * From the platform-context envelope's SETTINGS_MANAGE capability — the same
   * server projection the write gate honours.
   *
   * NOT read from `data`: the status endpoint deliberately says nothing about
   * authority, so authority has exactly one source and two answers cannot
   * disagree. `null` (envelope loading or degraded) fails closed to read-only.
   */
  canManage: boolean | null;
}) {
  const copy = aiStatusCopy(data.status);
  const managedBy = resolveManagedBy({
    status: data.status,
    workspaceKind,
    canManage,
  });

  return (
    <div className="set-stack" data-cc-ai-readonly style={{ minInlineSize: 0 }}>
      {/* ---------------------------------------------------------------
          A — AI ASSISTANCE
          --------------------------------------------------------------- */}
      <section className="set-card" style={{ minInlineSize: 0 }} data-cc-ai-card="assistance">
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
          <span style={label}>AI assistance</span>
          <AppStatusText tone={copy.tone} size="sm" data-cc-ai-status-label={copy.label}>
            {copy.label}
          </AppStatusText>
        </div>
        <p style={helper}>
          AI-assisted features in PROOVRA are advisory only and do not determine
          factual truth, authenticity, or legal admissibility.
        </p>
        <p style={helper} data-cc-ai-status-detail>
          {copy.detail}
        </p>
      </section>

      {/* ---------------------------------------------------------------
          B — AI FEATURES
          Effective state, not theoretical capability.
          --------------------------------------------------------------- */}
      <section className="set-card" style={{ minInlineSize: 0 }} data-cc-ai-card="features">
        <span style={label}>AI features</span>
        <div style={{ marginTop: 6 }}>
          {data.features.map((f) => {
            const s = FEATURE_STATE[f.state];
            return (
              <div
                key={f.id}
                style={{
                  padding: "8px 0",
                  borderBlockStart: "1px solid var(--border-soft, rgba(15,23,42,0.08))",
                  minInlineSize: 0,
                }}
                data-cc-ai-feature={f.id}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 8,
                    minInlineSize: 0,
                  }}
                >
                  <span style={{ ...label, fontWeight: 500, minInlineSize: 0 }}>{f.label}</span>
                  <AppStatusText tone={s.tone} size="sm" data-cc-ai-feature-state={f.state}>
                    {s.label}
                  </AppStatusText>
                </div>
                <p style={{ ...helper, marginTop: 2 }}>{f.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------------
          C — HOW AI USES YOUR DATA
          The policy's own wording. No provider name, no model, no
          environment detail, and no no-training claim stronger than the
          AI Use Policy already makes — that one is config- and
          contract-dependent and belongs where it is qualified.
          --------------------------------------------------------------- */}
      <section className="set-card" style={{ minInlineSize: 0 }} data-cc-ai-card="data">
        <span style={label}>How AI uses your data</span>
        <div style={{ marginTop: 4 }}>
          <Row name="Processing mode">
            <span style={{ fontSize: 12.5, color: "var(--ink-primary, #0f172a)" }}>
              Metadata first
            </span>
          </Row>
          <Row name="Raw evidence content">
            <span style={{ fontSize: 12.5, color: "var(--ink-primary, #0f172a)" }}>
              Not sent to the AI provider by default
            </span>
          </Row>
          <Row name="AI decisions">
            <span style={{ fontSize: 12.5, color: "var(--ink-primary, #0f172a)" }}>
              Advisory only
            </span>
          </Row>
        </div>
        <Link
          href="/settings/legal/ai-use-policy"
          style={{
            display: "inline-block",
            marginTop: 8,
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--info, #2563eb)",
          }}
          data-cc-ai-policy-link
        >
          View AI Use Policy →
        </Link>
      </section>

      {/* ---------------------------------------------------------------
          D — GOVERNANCE
          Who decides. Never claims an organization-level lock, because
          PROOVRA has none: the policy row is keyed by workspace, so an
          ORGANIZATION workspace's row IS that organization's policy.
          --------------------------------------------------------------- */}
      <section className="set-card" style={{ minInlineSize: 0 }} data-cc-ai-card="governance">
        <span style={label}>Workspace AI policy</span>
        <div style={{ marginTop: 4 }}>
          <Row name="Effective state">
            <AppStatusText tone={copy.tone} size="sm">
              {copy.label}
            </AppStatusText>
          </Row>
          <Row name="Managed by">
            <span
              style={{ fontSize: 12.5, color: "var(--ink-primary, #0f172a)" }}
              data-cc-ai-managed-by={managedBy}
            >
              {managedByCopy(managedBy)}
            </span>
          </Row>
        </div>
        <p style={helper}>
          You can see this policy but cannot change it. Ask a workspace
          administrator if it needs to be different.
        </p>
      </section>
    </div>
  );
}
