"use client";

/**
 * Phase A2 (UI) — Settings → AI & Automation.
 *
 * Reads/writes the canonical workspace AI policy (GET/PUT /v1/workspaces/
 * ai-policy). Backend-enforced: saving aiEnabled=false immediately blocks
 * provider calls via the canonical evaluator — this page is a management
 * surface, not the enforcement point. Optimistic concurrency by version.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../../../lib/api";
import { useActiveWorkspaceId } from "../../../../lib/platform-context";
import { AiCapabilityStatusTable } from "../../../../components/ai-copilot/AiCapabilityStatusTable";

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

const TOGGLES: Array<{ key: keyof Policy; label: string; hint: string }> = [
  { key: "supportChatEnabled", label: "Support chat", hint: "Product + evidence-operations assistant (metadata only)." },
  { key: "captureAssistanceEnabled", label: "Capture assistance", hint: "Advisory completeness review during capture." },
  { key: "evidenceCategorizationEnabled", label: "Evidence categorization", hint: "Metadata-based advisory categorization." },
  { key: "semanticSearchEnabled", label: "Semantic search", hint: "Embeddings-based retrieval (derived text; opt-in)." },
  { key: "contentIntelligenceEnabled", label: "Content intelligence", hint: "Derived-text processing (OCR/transcripts) by AI." },
  { key: "caseCopilotEnabled", label: "Case Copilot", hint: "Case preparation assistance with validated citations." },
  { key: "reviewerCopilotEnabled", label: "Reviewer Copilot", hint: "Review preparation; never makes the decision." },
  { key: "rawContentProcessingAllowed", label: "Raw content processing", hint: "Allow raw bytes to purpose-specific extractors." },
  { key: "ocrAllowed", label: "OCR", hint: "Document OCR (Azure Document Intelligence)." },
  { key: "transcriptionAllowed", label: "Transcription", hint: "Audio/video transcription (Deepgram)." },
  { key: "embeddingsAllowed", label: "Embeddings", hint: "Vector embeddings of derived text (OpenAI)." },
];

export default function AiAutomationSettingsPage() {
  const teamId = useActiveWorkspaceId();
  const [envelope, setEnvelope] = useState<PolicyEnvelope | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "conflict" | "denied" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    setStatus("loading");
    try {
      const res = (await apiFetch(`/v1/workspaces/ai-policy?teamId=${teamId}`)) as PolicyEnvelope;
      setEnvelope(res);
      setDraft(res.policy);
      setStatus("idle");
      setMessage(null);
    } catch {
      setStatus("error");
      setMessage("Could not load the workspace AI policy.");
    }
  }, [teamId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!teamId || !draft || !envelope) return;
    setStatus("saving");
    try {
      const res = (await apiFetch(`/v1/workspaces/ai-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId,
          expectedVersion: envelope.hasExplicitPolicy ? envelope.version : null,
          reason: "Settings → AI & Automation update",
          ...draft,
        }),
      })) as PolicyEnvelope;
      setEnvelope(res);
      setDraft(res.policy);
      setStatus("saved");
      setMessage("Saved. Changes take effect immediately — the backend enforces this policy on every AI call.");
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 409) {
        setStatus("conflict");
        setMessage("This policy was changed by someone else. Reload to see the latest version, then re-apply your changes.");
      } else if (err instanceof ApiError && err.statusCode === 403) {
        setStatus("denied");
        setMessage("Only workspace owners/admins can change the AI policy.");
      } else {
        setStatus("error");
        setMessage("The policy could not be saved. Please try again.");
      }
    }
  }

  if (!teamId) {
    return <main style={{ padding: 24 }}><p>Select a workspace to manage AI settings.</p></main>;
  }

  return (
    <main style={{ padding: 24, maxWidth: 980 }}>
      <h1 style={{ marginTop: 0 }}>AI &amp; Automation</h1>
      <p style={{ opacity: 0.75, fontSize: 14 }}>
        Workspace-level AI governance. Disabling AI here immediately prevents backend
        provider calls — enforcement is server-side, not just in this UI. AI is always
        advisory: it never determines truth, authenticity, or admissibility, and never
        blocks capture, reports, packages, or verification.
      </p>

      {message ? (
        <div className={`app-alert ${status === "conflict" || status === "denied" || status === "error" ? "app-alert--warn" : ""}`} role="status">
          {message}
          {status === "conflict" ? (
            <button className="app-btn app-btn--ghost" style={{ marginLeft: 8 }} onClick={() => void load()}>Reload latest</button>
          ) : null}
        </div>
      ) : null}

      {draft ? (
        <>
          <section className="app-card" style={{ marginTop: 16 }}>
            <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={draft.aiEnabled}
                onChange={(e) => setDraft({ ...draft, aiEnabled: e.target.checked })}
              />
              Master AI switch — {draft.aiEnabled ? "AI features may run (per the toggles below)" : "ALL AI disabled for this workspace"}
            </label>
          </section>

          <section className="app-card" style={{ marginTop: 12, opacity: draft.aiEnabled ? 1 : 0.5 }}>
            <h3 style={{ marginTop: 0 }}>Capabilities</h3>
            {TOGGLES.map(({ key, label, hint }) => (
              <label key={key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0" }}>
                <input
                  type="checkbox"
                  disabled={!draft.aiEnabled}
                  checked={Boolean(draft[key])}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                />
                <span>
                  <span style={{ fontWeight: 600 }}>{label}</span>
                  <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>{hint}</span>
                </span>
              </label>
            ))}
          </section>

          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <button className="app-btn app-btn--primary" onClick={() => void save()} disabled={status === "saving"}>
              {status === "saving" ? "Saving…" : "Save AI policy"}
            </button>
            <span style={{ fontSize: 12, opacity: 0.6 }}>
              Policy version {envelope?.version ?? 1}
              {envelope?.lastModifiedAtUtc ? ` · last changed ${new Date(envelope.lastModifiedAtUtc).toLocaleString()}` : ""}
            </span>
          </div>
        </>
      ) : status === "loading" ? (
        <p style={{ opacity: 0.6 }}>Loading policy…</p>
      ) : null}

      <UsageCard teamId={teamId} />

      <div style={{ marginTop: 24 }}>
        <AiCapabilityStatusTable />
      </div>
    </main>
  );
}

/** Phase C8 — workspace AI usage & governance summary. */
function UsageCard({ teamId }: { teamId: string }) {
  const [usage, setUsage] = useState<{
    dayUtc: string;
    monthUtc: string;
    daily: { operations: number; costUsdMicros: string };
    monthly: { operations: number; costUsdMicros: string };
    copilotRuns: number;
    blockedProhibitedClaims: number;
    ledgerAvailable?: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(`/v1/workspaces/ai-usage?teamId=${teamId}`)) as typeof usage;
        if (!cancelled) setUsage(res);
      } catch {
        /* usage is optional */
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  if (!usage) return null;
  const usd = (micros: string) => `$${(Number(micros) / 1_000_000).toFixed(2)}`;
  return (
    <section className="app-card" style={{ marginTop: 16 }} aria-label="AI usage">
      <h3 style={{ marginTop: 0 }}>Usage &amp; governance</h3>
      {usage.ledgerAvailable === false ? (
        <p style={{ fontSize: 13, opacity: 0.7 }}>The durable usage ledger is not active in this environment yet.</p>
      ) : null}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 14 }}>
        <div><strong>Today ({usage.dayUtc})</strong><div>{usage.daily.operations} ops · {usd(usage.daily.costUsdMicros)}</div></div>
        <div><strong>This month ({usage.monthUtc})</strong><div>{usage.monthly.operations} ops · {usd(usage.monthly.costUsdMicros)}</div></div>
        <div><strong>Copilot runs</strong><div>{usage.copilotRuns}</div></div>
        <div><strong>Blocked claims</strong><div>{usage.blockedProhibitedClaims}</div></div>
      </div>
      <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>No prompts or evidence content are stored or shown — bounded counters only.</p>
    </section>
  );
}
