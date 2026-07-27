"use client";

/**
 * Settings → AI (2026-07-17 Settings remediation, §9).
 *
 * ONE route, FOUR context-correct views resolved by the canonical
 * user-visible AI capability resolver (`deriveAiSettingsMode`):
 *
 *   personal-assistance   — concise USER-FACING "AI assistance" page:
 *                           usage against the plan's monthly allowance,
 *                           master control, the LAUNCHED personal features
 *                           only (support assistant, capture assistance,
 *                           evidence categorization), a data-use summary,
 *                           and a transparency link. NO internal stubs,
 *                           NO provider diagnostics, NO dollar costs, NO
 *                           enterprise data-class governance.
 *   personal-not-included — honest FREE-plan surface: no editable
 *                           controls, a plain statement + billing link.
 *   org-governance        — ORGANIZATION Admin/Owner governance view:
 *                           the full canonical policy (capabilities +
 *                           data-class controls), usage & cost, and the
 *                           runtime capability disclosure. Same backend
 *                           policy row + evaluator — never a second model.
 *   org-readonly          — ORGANIZATION Member/Reviewer: concise
 *                           read-only policy summary. No editing.
 *
 * Enforcement stays server-side in every mode: the AI policy evaluator
 * gates every provider call and the PUT policy route requires workspace
 * OWNER/ADMIN regardless of what renders here.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch, ApiError } from "../../../../lib/api";
import {
  useActiveWorkspaceId,
  usePlatformContext,
  WorkspaceContextBanner,
  useWorkspaceContextSafety,
} from "../../../../lib/platform-context";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { AiCapabilityStatusTable } from "../../../../components/ai-copilot/AiCapabilityStatusTable";
import {
  LAUNCHED_PERSONAL_AI_FEATURES,
  deriveAiSettingsMode,
} from "../../../../lib/ai/aiAssistanceView";

type Policy = {
  aiEnabled: boolean;
  supportChatEnabled: boolean;
  captureAssistanceEnabled: boolean;
  evidenceCategorizationEnabled: boolean;
  semanticSearchEnabled: boolean;
  contentIntelligenceEnabled: boolean;
  reviewerCopilotEnabled: boolean;
  caseCopilotEnabled: boolean;
  rawContentProcessingAllowed: boolean;
  ocrAllowed: boolean;
  transcriptionAllowed: boolean;
  embeddingsAllowed: boolean;
};

type PolicyEnvelope = {
  policy: Policy;
  version: number;
  hasExplicitPolicy: boolean;
  lastModifiedByUserId: string | null;
  lastModifiedAtUtc: string | null;
};

type Usage = {
  dayUtc: string;
  monthUtc: string;
  allowance?: {
    plan: string;
    monthlyOperations: number | null;
    consumed: number;
    remaining: number | null;
  } | null;
  daily: { operations: number; costUsdMicros: string };
  monthly: { operations: number; costUsdMicros: string };
  copilotRuns: number;
  blockedProhibitedClaims: number;
  ledgerAvailable?: boolean;
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--ink-primary, #0f172a)",
};

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

/** "Resets on 1 August 2026" from the usage month key ("2026-07"). */
function resetDateLabel(monthUtc: string): string | null {
  const m = monthUtc.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
  try {
    return next.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return null;
  }
}

export function AiSection() {
  const teamId = useActiveWorkspaceId();
  const { envelope } = usePlatformContext();

  // PHASE 2 (2026-07-21) — canonical workspace-kind classification. The
  // active workspace's kind comes from the envelope's canonical
  // contextOptions (PERSONAL / OWNED / ORGANIZATION), not from the legacy
  // activeSpace.type binary. OWNED workspaces are SELF-SERVICE (managed by
  // the workspace owner/admins, not an Enterprise org policy), so they take
  // the self-managed branch alongside PERSONAL.
  const activeContext = envelope?.contextOptions?.activeContext;
  const canonicalKind =
    activeContext && activeContext.workspaceId === teamId
      ? activeContext.kind
      : envelope?.activeSpace?.type === "ORGANIZATION"
        ? "ORGANIZATION"
        : "PERSONAL";
  const isOrg = canonicalKind === "ORGANIZATION";
  const activeOrg = isOrg
    ? (envelope?.organizations ?? []).find(
        (o) => o.id === envelope?.activeSpace?.id,
      )
    : null;
  const mode = deriveAiSettingsMode({
    workspaceKind: isOrg ? "ORGANIZATION" : "PERSONAL",
    monthlyAllowance: envelope?.planFeatures?.aiAssistanceMonthlyOperations,
    orgRole: (activeOrg?.role ?? null) as
      | "OWNER"
      | "ADMIN"
      | "MEMBER"
      | "VIEWER"
      | null,
  });

  const [envelopeState, setEnvelopeState] = useState<PolicyEnvelope | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [status, setStatus] = useState<
    "idle" | "loading" | "saving" | "saved" | "conflict" | "denied" | "error"
  >("loading");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setStatus("loading");
    try {
      const res = (await apiFetch(
        `/v1/workspaces/ai-policy?teamId=${teamId}`,
      )) as PolicyEnvelope;
      setEnvelopeState(res);
      setDraft(res.policy);
      setStatus("idle");
      setMessage(null);
    } catch {
      setStatus("error");
      setMessage("Could not load the AI settings for this workspace.");
    }
    try {
      const u = (await apiFetch(
        `/v1/workspaces/ai-usage?teamId=${teamId}`,
      )) as Usage;
      setUsage(u);
    } catch {
      /* usage is optional */
    }
  }, [teamId]);

  useEffect(() => {
    if (mode !== "personal-not-included") void load();
  }, [load, mode]);

  const dirty = useMemo(() => {
    if (!draft || !envelopeState) return false;
    return (Object.keys(draft) as Array<keyof Policy>).some(
      (k) => draft[k] !== envelopeState.policy[k],
    );
  }, [draft, envelopeState]);

  // PHASE 7 §10.1/§10.3 — register the unsaved AI-policy edit as dirty
  // work (blocks silent workspace switch) + guard the save against a
  // mid-flight tenant change.
  const { runGuarded } = useWorkspaceContextSafety({
    isDirty: dirty,
    dirtyLabel: "Unsaved AI settings",
  });

  const save = useCallback(async () => {
    if (!teamId || !draft || !envelopeState || !dirty) return;
    setStatus("saving");
    setMessage(null);
    try {
      await runGuarded(
        () =>
          apiFetch(`/v1/workspaces/ai-policy`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              teamId,
              expectedVersion: envelopeState.hasExplicitPolicy
                ? envelopeState.version
                : null,
              reason: "Settings → AI update",
              ...draft,
            }),
          }) as Promise<PolicyEnvelope>,
        (res) => {
          setEnvelopeState(res);
          setDraft(res.policy);
          setStatus("saved");
          setMessage("Saved. Changes take effect immediately.");
        },
      );
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        setStatus("conflict");
        setMessage(
          "These settings were changed elsewhere. Reload to see the latest, then re-apply your changes.",
        );
      } else if (err instanceof ApiError && err.statusCode === 403) {
        setStatus("denied");
        setMessage("Only workspace owners or admins can change AI settings.");
      } else {
        setStatus("error");
        setMessage("The settings could not be saved. Please try again.");
      }
    }
  }, [teamId, draft, envelopeState, dirty, runGuarded]);

  if (!teamId) {
    return <p style={muted}>Select a workspace to manage its AI settings.</p>;
  }

  // ---------------------------------------------------------------------
  // PERSONAL — AI not included (FREE): honest, control-free surface.
  // ---------------------------------------------------------------------
  if (mode === "personal-not-included") {
    return (
      <Card
        variant="admin"
        padding="comfortable"
        data-cc-ai-not-included
        style={{ maxWidth: 640 }}
      >
        <p style={muted}>
          AI assistance is not included in your plan. Plans with AI
          assistance include a monthly operation allowance for advisory
          features like the support assistant and capture assistance.
        </p>
        <div className="mt-4">
          <Link href="/billing">
            <Button variant="secondary" size="sm">
              See plans
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  // ---------------------------------------------------------------------
  // ORGANIZATION — governance (Admin/Owner) and read-only (Member).
  // ---------------------------------------------------------------------
  if (mode === "org-governance" || mode === "org-readonly") {
    return (
      <OrgAiView
        mode={mode}
        draft={draft}
        setDraft={setDraft}
        envelopeState={envelopeState}
        usage={usage}
        status={status}
        message={message}
        dirty={dirty}
        onSave={save}
        onReload={load}
      />
    );
  }

  // ---------------------------------------------------------------------
  // PERSONAL — AI assistance (PAYG / PRO / TEAM).
  // ---------------------------------------------------------------------
  const allowance = usage?.allowance ?? null;
  const reset = usage ? resetDateLabel(usage.monthUtc) : null;

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 720 }} data-cc-ai-personal>
        {/* PHASE 7 §10.5 — AI policy is workspace-scoped; show the owning
            workspace/org so a policy change lands in the intended context. */}
        <WorkspaceContextBanner action="AI settings for" />
        <p style={{ ...muted, maxWidth: 680 }}>
          Control the AI-assisted features available in your Personal Space.
          AI provides advisory support only and never determines truth,
          authenticity, or admissibility.
        </p>
        {message ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border px-3 py-2 text-[12px]"
            style={
              status === "conflict" || status === "denied" || status === "error"
                ? {
                    borderColor: "rgba(179,38,30,0.35)",
                    background: "rgba(179,38,30,0.06)",
                    color: "#8f1d16",
                  }
                : {
                    borderColor: "rgba(47,125,91,0.35)",
                    background: "rgba(47,125,91,0.07)",
                    color: "#215e44",
                  }
            }
          >
            {message}
            {status === "conflict" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void load()}
                style={{ marginLeft: 8 }}
              >
                Reload latest
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* USAGE — plan allowance from the enforcement ledger. No internal
            dollar costs, no copilot counters. */}
        <Card variant="admin" padding="comfortable" data-cc-ai-usage-card>
          <h2 style={sectionTitle}>Monthly usage</h2>
          {allowance ? (
            <>
              <div className="grid gap-1.5 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span style={muted}>Current plan</span>
                  <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                    {allowance.plan === "PAYG"
                      ? "Pay per evidence"
                      : allowance.plan.charAt(0) +
                        allowance.plan.slice(1).toLowerCase()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span style={muted}>Monthly allowance</span>
                  <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                    {allowance.monthlyOperations === null
                      ? "Custom"
                      : `${allowance.monthlyOperations} operations`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span style={muted}>Used</span>
                  <span
                    style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}
                    data-cc-ai-usage-consumed
                  >
                    {allowance.monthlyOperations === null
                      ? `${allowance.consumed} operations`
                      : `${allowance.consumed} of ${allowance.monthlyOperations}`}
                  </span>
                </div>
                {allowance.remaining !== null ? (
                  <div className="flex items-center justify-between gap-3">
                    <span style={muted}>Remaining</span>
                    <span style={{ color: "var(--ink-primary, #0f172a)" }}>
                      {allowance.remaining}
                    </span>
                  </div>
                ) : null}
                {reset ? (
                  <div className="flex items-center justify-between gap-3">
                    <span style={muted}>Resets on</span>
                    <span style={{ color: "var(--ink-primary, #0f172a)" }}>{reset}</span>
                  </div>
                ) : null}
              </div>
              {allowance.monthlyOperations !== null &&
              allowance.monthlyOperations > 0 ? (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={allowance.monthlyOperations}
                  aria-valuenow={Math.min(
                    allowance.consumed,
                    allowance.monthlyOperations,
                  )}
                  aria-label="Monthly AI operations used"
                  style={{
                    marginTop: 12,
                    height: 8,
                    borderRadius: 999,
                    background: "rgba(15,23,42,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(
                        100,
                        (allowance.consumed / allowance.monthlyOperations) * 100,
                      )}%`,
                      borderRadius: 999,
                      background: "#4F46E5",
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p style={muted}>Usage is unavailable right now.</p>
          )}
        </Card>

        {/* MASTER CONTROL */}
        <Card variant="admin" padding="comfortable" data-cc-ai-master-card>
          <h2 style={sectionTitle}>AI assistance</h2>
          <label
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              fontSize: 13,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            <input
              type="checkbox"
              checked={draft?.aiEnabled ?? false}
              disabled={!draft || status === "saving"}
              onChange={(e) =>
                draft && setDraft({ ...draft, aiEnabled: e.target.checked })
              }
              data-cc-ai-master-toggle
            />
            <span>
              <strong>Enable AI assistance in this workspace</strong>
              <span style={{ ...muted, display: "block", marginTop: 2 }}>
                Turning this off stops every AI-assisted feature immediately —
                enforcement is server-side on each request, not just in this
                page.
              </span>
            </span>
          </label>
        </Card>

        {/* AVAILABLE FEATURES — launched personal features only. */}
        <Card variant="admin" padding="comfortable" data-cc-ai-features-card>
          <h2 style={sectionTitle}>Available features</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {LAUNCHED_PERSONAL_AI_FEATURES.map((f) => (
              <label
                key={f.key}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  fontSize: 13,
                  color: "var(--ink-primary, #0f172a)",
                  opacity: draft?.aiEnabled ? 1 : 0.55,
                }}
                data-cc-ai-feature={f.key}
              >
                <input
                  type="checkbox"
                  checked={Boolean(draft?.[f.key])}
                  disabled={!draft || !draft.aiEnabled || status === "saving"}
                  onChange={(e) =>
                    draft && setDraft({ ...draft, [f.key]: e.target.checked })
                  }
                  aria-describedby={`ai-feature-${f.key}`}
                />
                <span>
                  <strong>{f.label}</strong>
                  <span
                    id={`ai-feature-${f.key}`}
                    style={{ ...muted, display: "block", marginTop: 2 }}
                  >
                    {f.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        {/* DATA USE SUMMARY */}
        <Card variant="admin" padding="comfortable" data-cc-ai-data-use-card>
          <h2 style={sectionTitle}>How AI uses your data</h2>
          <ul style={{ ...muted, margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>These features use metadata only — never your evidence files.</li>
            <li>
              AI output is advisory only. It never determines authenticity,
              truth, or admissibility, and never blocks capture, reports, or
              verification.
            </li>
            <li>Each feature runs only when you have it enabled here.</li>
          </ul>
          <div className="mt-3">
            <Link
              href="/trust-center/ai-disclosure"
              style={{
                fontSize: 13,
                color: "var(--ink-primary, #0f172a)",
                fontWeight: 600,
                textDecoration: "underline",
              }}
              data-cc-ai-transparency-link
            >
              Review AI transparency and subprocessors →
            </Link>
          </div>
        </Card>

        <div>
          <Button
            variant="secondary"
            onClick={() => void save()}
            loading={status === "saving"}
            disabled={status === "saving" || !dirty}
            data-cc-ai-save
          >
            Save changes
          </Button>
        </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ORGANIZATION views — governance (edit) and member (read-only summary).
// ---------------------------------------------------------------------------

const GOVERNANCE_TOGGLES: Array<{ key: keyof Policy; label: string; hint: string }> = [
  { key: "supportChatEnabled", label: "Support assistant", hint: "Product + evidence-operations assistant (metadata only)." },
  { key: "captureAssistanceEnabled", label: "Capture assistance", hint: "Advisory completeness review during capture." },
  { key: "evidenceCategorizationEnabled", label: "Evidence categorization", hint: "Metadata-based advisory categorization." },
  { key: "semanticSearchEnabled", label: "Semantic search", hint: "Embeddings-based retrieval (derived text; opt-in)." },
  { key: "contentIntelligenceEnabled", label: "Content intelligence", hint: "Derived-text processing (OCR/transcripts) by AI." },
  { key: "caseCopilotEnabled", label: "Case Copilot", hint: "Case preparation assistance with validated citations." },
  { key: "reviewerCopilotEnabled", label: "Reviewer Copilot", hint: "Review preparation; never makes the decision." },
  { key: "rawContentProcessingAllowed", label: "Raw content processing", hint: "Allow raw bytes to purpose-specific extractors." },
  { key: "ocrAllowed", label: "OCR", hint: "Document text extraction." },
  { key: "transcriptionAllowed", label: "Transcription", hint: "Audio/video transcription." },
  { key: "embeddingsAllowed", label: "Embeddings", hint: "Vector embeddings of derived text." },
];

function OrgAiView({
  mode,
  draft,
  setDraft,
  envelopeState,
  usage,
  status,
  message,
  dirty,
  onSave,
  onReload,
}: {
  mode: "org-governance" | "org-readonly";
  draft: Policy | null;
  setDraft: (p: Policy) => void;
  envelopeState: PolicyEnvelope | null;
  usage: Usage | null;
  status: string;
  message: string | null;
  dirty: boolean;
  onSave: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const canEdit = mode === "org-governance";
  const usd = (micros: string) => `$${(Number(micros) / 1_000_000).toFixed(2)}`;

  return (
      <div
        style={{ display: "grid", gap: 14, maxWidth: 860 }}
        data-cc-ai-org={mode}
      >
        <p style={{ ...muted, maxWidth: 720 }}>
          {canEdit
            ? "Organization-level AI policy for this workspace. Disabling a capability immediately prevents backend provider calls — enforcement is server-side. AI stays advisory: it never determines truth, authenticity, or admissibility."
            : "Your organization's AI policy for this workspace. These settings are managed by your organization's workspace admins."}
        </p>
        {message ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: "rgba(15,23,42,0.15)",
              background: "var(--surface-card, #ffffff)",
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            {message}
            {status === "conflict" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onReload()}
                style={{ marginLeft: 8 }}
              >
                Reload latest
              </Button>
            ) : null}
          </div>
        ) : null}

        {draft ? (
          <>
            <Card variant="admin" padding="comfortable" data-cc-ai-org-master>
              <h2 style={sectionTitle}>Master AI policy</h2>
              {canEdit ? (
                <label
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--ink-primary, #0f172a)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={draft.aiEnabled}
                    disabled={status === "saving"}
                    onChange={(e) =>
                      setDraft({ ...draft, aiEnabled: e.target.checked })
                    }
                  />
                  AI capabilities may run in this workspace (per the policy
                  below)
                </label>
              ) : (
                <p style={{ ...muted, display: "flex", alignItems: "center", gap: 8 }}>
                  AI in this workspace is{" "}
                  <Badge tone={draft.aiEnabled ? "verified" : "neutral"} subtle>
                    {draft.aiEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <span>— managed by your organization.</span>
                </p>
              )}
            </Card>

            <Card variant="admin" padding="comfortable" data-cc-ai-org-capabilities>
              <h2 style={sectionTitle}>Capabilities &amp; data classes</h2>
              <div style={{ display: "grid", gap: 8, opacity: draft.aiEnabled ? 1 : 0.55 }}>
                {GOVERNANCE_TOGGLES.map(({ key, label, hint }) =>
                  canEdit ? (
                    <label
                      key={key}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        fontSize: 13,
                        color: "var(--ink-primary, #0f172a)",
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={!draft.aiEnabled || status === "saving"}
                        checked={Boolean(draft[key])}
                        onChange={(e) =>
                          setDraft({ ...draft, [key]: e.target.checked })
                        }
                      />
                      <span>
                        <span style={{ fontWeight: 600 }}>{label}</span>
                        <span style={{ ...muted, display: "block" }}>{hint}</span>
                      </span>
                    </label>
                  ) : (
                    <div
                      key={key}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        fontSize: 13,
                        color: "var(--ink-primary, #0f172a)",
                      }}
                    >
                      <span>{label}</span>
                      <Badge tone={draft[key] ? "verified" : "neutral"} subtle>
                        {draft[key] ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                  ),
                )}
              </div>
            </Card>

            {canEdit ? (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <Button
                  variant="secondary"
                  onClick={() => void onSave()}
                  loading={status === "saving"}
                  disabled={status === "saving" || !dirty}
                  data-cc-ai-org-save
                >
                  Save AI policy
                </Button>
                <span style={muted}>
                  Policy version {envelopeState?.version ?? 1}
                  {envelopeState?.lastModifiedAtUtc
                    ? ` · last changed ${new Date(envelopeState.lastModifiedAtUtc).toLocaleString()}`
                    : ""}
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <p style={muted} aria-live="polite">
            Loading policy…
          </p>
        )}

        {/* Usage & governance counters — an ORGANIZATION admin surface
            (cost visibility is a governance duty here, unlike the personal
            assistance page). */}
        {canEdit && usage ? (
          <Card variant="admin" padding="comfortable" data-cc-ai-org-usage>
            <h2 style={sectionTitle}>Usage &amp; governance</h2>
            {usage.ledgerAvailable === false ? (
              <p style={muted}>
                The durable usage ledger is not active in this environment yet.
              </p>
            ) : null}
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
              <div>
                <strong>This month ({usage.monthUtc})</strong>
                <div style={muted}>
                  {usage.monthly.operations} operations · {usd(usage.monthly.costUsdMicros)}
                </div>
              </div>
              <div>
                <strong>Today ({usage.dayUtc})</strong>
                <div style={muted}>
                  {usage.daily.operations} operations · {usd(usage.daily.costUsdMicros)}
                </div>
              </div>
              <div>
                <strong>Copilot runs</strong>
                <div style={muted}>{usage.copilotRuns}</div>
              </div>
              <div>
                <strong>Blocked claims</strong>
                <div style={muted}>{usage.blockedProhibitedClaims}</div>
              </div>
            </div>
            <p style={{ ...muted, marginTop: 8 }}>
              No prompts or evidence content are stored or shown here.
            </p>
          </Card>
        ) : null}

        {/* Runtime capability disclosure — governance/audit surface for
            org admins only. Personal users never see this table. */}
        {canEdit ? (
          <div data-cc-ai-org-disclosure>
            <AiCapabilityStatusTable />
          </div>
        ) : null}

        <div>
          <Link
            href="/trust-center/ai-disclosure"
            style={{
              fontSize: 13,
              color: "var(--ink-primary, #0f172a)",
              fontWeight: 600,
              textDecoration: "underline",
            }}
            data-cc-ai-transparency-link
          >
            Review AI transparency and subprocessors →
          </Link>
        </div>
      </div>
  );
}
