"use client";

/**
 * Phase 6 — Authenticated admin UI for workflow intake links.
 *
 * Workspace ADMIN+ can:
 *   - list intake links for the current workspace
 *   - create a new intake link (raw URL is shown ONCE and never re-fetched)
 *   - copy the link to the clipboard from the one-shot reveal
 *   - revoke an active link
 *   - view link status (ACTIVE / REVOKED / EXPIRED), usage count, expiry
 *
 * Privacy:
 *   - The raw token / URL is held in component state ONLY while the success
 *     dialog is open. Closing the dialog discards it.
 *   - The list endpoint never returns the token; only the projection shape.
 *   - No workspace internals are surfaced — this is administrative metadata
 *     about who/where/when of intake links, not about evidence content.
 *
 * Feature flag:
 *   - The page itself loads regardless, but the API returns 503 when
 *     WORKFLOW_INTAKE_LINKS_ENABLED is not set. We render a friendly
 *     "feature disabled" state in that case so admins know to enable it.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { apiFetch } from "../../../lib/api";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { OperationalBreadcrumb } from "../../../components/navigation/OperationalBreadcrumb";
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { validateE164 } from "../../../lib/phone/e164";
import { IntakeLinkDeliveryDrawer } from "../../../components/intake-links/IntakeLinkDeliveryDrawer";

type LinkRow = {
  id: string;
  teamId: string;
  workflowTemplateSlug: string;
  workflowTemplateVersion: number;
  intakeMode: string;
  caseId: string | null;
  recipientLabel: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  maxUses: number;
  usedCount: number;
  maxFileCountPerSession: number | null;
  maxBytesPerSession: string | null;
  allowedAcceptedKinds: string[];
  consentPolicyVersion: string | null;
  status: string;
  expiresAtUtc: string;
  revokedAtUtc: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkflowTemplateRow = {
  id: string;
  slug: string;
  source: string;
  version: number;
  name: string;
  description: string;
  planMode: string;
  intakeModes: string[];
  archived: boolean;
};

type CurrentTeamSummary = { id: string; name: string } | null;

// Phase IA-self-serve-completion — mode label "Pseudonymous" replaced
// with plain-language "Alias". The underlying API value
// `EXTERNAL_PSEUDONYMOUS` is unchanged so the backend contract is
// preserved; only the user-facing label was confusing for lawyers and
// journalists.
const INTAKE_MODES = [
  { value: "EXTERNAL_ONE_TIME", label: "One-time link (single contributor, single submission)" },
  { value: "EXTERNAL_REUSABLE", label: "Reusable link (multiple submissions)" },
  { value: "EXTERNAL_ANONYMOUS", label: "Anonymous — no identity recorded" },
  { value: "EXTERNAL_PSEUDONYMOUS", label: "Alias — contributor chooses a name to display" },
];

const ACCEPTED_KIND_OPTIONS: Array<"PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT"> = [
  "PHOTO",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
];

// Phase 38.10 — wrap in canonical PageRouteGate.
export default function IntakeLinksPage() {
  return (
    <PageRouteGate routeId="workspace.intake_links">
      <IntakeLinksPageInner />
    </PageRouteGate>
  );
}

function IntakeLinksPageInner() {
  const [currentTeam, setCurrentTeam] = useState<CurrentTeamSummary>(null);
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [rawTokenReveal, setRawTokenReveal] = useState<{
    rawToken: string;
    intakeUrl: string;
    linkId: string;
    recipientPhone: string | null;
  } | null>(null);
  const [deliveryDrawerLinkId, setDeliveryDrawerLinkId] = useState<string | null>(
    null,
  );
  const { confirm } = useConfirmAction();

  // Phase IA-home-final — the Home "Request & collect" widget deep-links
  // here to OPEN a real flow, not just navigate:
  //   ?new=1       → auto-open the create-intake-link modal
  //   ?linkId=<id> → auto-open that link's delivery drawer
  // Applied once on mount so manual closes aren't re-triggered.
  const searchParams = useSearchParams();
  const [appliedDeepLink, setAppliedDeepLink] = useState(false);
  useEffect(() => {
    if (appliedDeepLink) return;
    if (searchParams.get("new") === "1") {
      setShowCreate(true);
      setAppliedDeepLink(true);
      return;
    }
    const linkId = searchParams.get("linkId");
    if (linkId) {
      setDeliveryDrawerLinkId(linkId);
      setAppliedDeepLink(true);
    }
  }, [searchParams, appliedDeepLink]);

  // Phase IA-intake-personal-space-fix — accept BOTH PERSONAL and
  // ORGANIZATION active spaces. The original guard required
  // `workspace.scope === "TEAM"`, which left PRO/TEAM users on their
  // Personal Space staring at "Switch to a workspace" even though the
  // backend's `prisma.teamMember` lookup works fine for a personal
  // workspace (it's stored as a Team row with the user as OWNER).
  //
  // We read the canonical `activeSpace` field directly — it's the
  // post-tenant-model source of truth. The legacy `workspace.scope`
  // field is deprecated and should not be consulted here.
  const ctxEnvelope = usePlatformContext().envelope;
  useEffect(() => {
    if (!ctxEnvelope) return;
    // Prefer the canonical `activeSpace`. Fall back to the legacy
    // `workspace` envelope when the backend hasn't projected
    // `activeSpace` yet (older deployments).
    const active = ctxEnvelope.activeSpace;
    if (active?.id) {
      const name =
        active.type === "PERSONAL"
          ? "Personal Space"
          : active.displayName ?? "Team workspace";
      setCurrentTeam({ id: active.id, name });
      return;
    }
    const ws = ctxEnvelope.workspace;
    if (ws.status === "active" && ws.id) {
      const name =
        ws.scope === "PERSONAL"
          ? "Personal Space"
          : ws.name ?? "Team workspace";
      setCurrentTeam({ id: ws.id, name });
      return;
    }
    setCurrentTeam(null);
  }, [ctxEnvelope]);

  // Load links once we know the workspace.
  useEffect(() => {
    if (!currentTeam) return;
    let cancelled = false;
    apiFetch(
      `/v1/workflow/intake-links?teamId=${encodeURIComponent(currentTeam.id)}`,
      { method: "GET" },
    )
      .then((res: { links: LinkRow[] }) => {
        if (cancelled) return;
        setLinks(res.links ?? []);
        setFeatureDisabled(false);
      })
      .catch((err: { code?: string; statusCode?: number; message?: string }) => {
        if (cancelled) return;
        if (err?.statusCode === 503 || err?.code === "FEATURE_DISABLED") {
          setFeatureDisabled(true);
          setLinks([]);
          return;
        }
        setError(err?.message ?? "Unable to load intake links.");
      });
    return () => {
      cancelled = true;
    };
  }, [currentTeam?.id]);

  // Load workflow templates for the workspace.
  useEffect(() => {
    if (!currentTeam) return;
    let cancelled = false;
    apiFetch(
      `/v1/workflow/templates?teamId=${encodeURIComponent(currentTeam.id)}`,
      { method: "GET" },
    )
      .then((res: { templates: WorkflowTemplateRow[] }) => {
        if (cancelled) return;
        setTemplates(res.templates ?? []);
      })
      .catch(() => {
        setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTeam?.id]);

  const eligibleTemplates = useMemo(() => {
    if (!templates) return [];
    return templates.filter(
      (t) =>
        !t.archived &&
        t.intakeModes.some(
          (m) =>
            m === "EXTERNAL_ONE_TIME" ||
            m === "EXTERNAL_REUSABLE" ||
            m === "EXTERNAL_ANONYMOUS" ||
            m === "EXTERNAL_PSEUDONYMOUS",
        ),
    );
  }, [templates]);

  async function revokeLink(linkId: string) {
    const ok = await confirm({
      title: "Revoke this intake link?",
      description:
        "Anyone holding the link will be denied access. This cannot be undone.",
      confirmLabel: "Revoke link",
      tone: "danger",
      testId: "intake-link-revoke",
    });
    if (!ok) return;
    try {
      const res: { link: LinkRow } = await apiFetch(
        `/v1/workflow/intake-links/${linkId}/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: null }),
        },
      );
      setLinks((prev) =>
        prev ? prev.map((l) => (l.id === linkId ? res.link : l)) : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Unable to revoke link.");
    }
  }

  function intakeUrlFromToken(rawToken: string): string {
    const base =
      typeof window !== "undefined" && window.location
        ? `${window.location.protocol}//${window.location.host}`
        : "";
    return `${base}/intake/${encodeURIComponent(rawToken)}`;
  }

  if (featureDisabled) {
    // PRODUCTION FIX: previously the feature-disabled panel rendered the
    // literal env-var names (WORKFLOW_INTAKE_LINKS_ENABLED +
    // WORKFLOW_INTAKE_TOKEN_SECRET) directly to operators. That leaked
    // deployment-internal variable names into the user-facing UI. The
    // backend already returns a structured FEATURE_DISABLED error with a
    // bounded reason; render an operator-readable "Configuration
    // required" panel instead and route admins to the setup docs.
    // Phase IA-self-serve-completion — replaced operator-facing
    // infrastructure jargon with plain-language copy a self-serve
    // user can act on. A lawyer or journalist who hits this state
    // needs to know who to contact, not which env vars to set.
    return (
      <main style={pageStyle} data-testid="intake-links-feature-disabled">
        <h1 style={titleStyle}>External intake links</h1>
        <div style={infoBoxStyle}>
          <strong>Not enabled yet</strong>
          <p style={{ marginTop: 8 }}>
            External intake links aren't turned on for your account yet.
            Contact your IT administrator or your PROOVRA support contact
            to enable this feature for your workspace.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <OperationalBreadcrumb
        routeId="workspace.intake_links"
        items={[{ label: "Intake links" }]}
      />
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={titleStyle}>External Intake Links</h1>
          <p style={mutedStyle}>
            Secure, expiring links that let people outside your workspace
            submit evidence into a specific workflow.
          </p>
        </div>
        {currentTeam ? (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => setShowCreate(true)}
            disabled={!currentTeam}
          >
            New intake link
          </button>
        ) : null}
      </header>

      {!currentTeam ? (
        <div style={infoBoxStyle} data-intake-links-loading>
          Loading workspace…
        </div>
      ) : null}

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {currentTeam && links !== null ? (
        links.length === 0 ? (
          <div style={infoBoxStyle} data-intake-links-empty>
            Create a secure intake link to request evidence from a
            client, source, witness, or contributor.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, marginTop: 24 }}>
            {links.map((l) => (
              <li key={l.id} style={cardStyle}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {l.recipientLabel ?? l.workflowTemplateSlug}
                  </div>
                  <div style={mutedStyle}>
                    Workflow: <strong>{l.workflowTemplateSlug}</strong> ·{" "}
                    Mode: <strong>{l.intakeMode}</strong> ·{" "}
                    Used {l.usedCount} / {l.maxUses} ·{" "}
                    Status:{" "}
                    <span
                      style={{
                        color:
                          l.status === "ACTIVE"
                            ? "#15803d"
                            : l.status === "REVOKED"
                              ? "#b91c1c"
                              : "#92400e",
                      }}
                    >
                      {l.status}
                    </span>
                  </div>
                  <div style={mutedStyle}>
                    Expires {new Date(l.expiresAtUtc).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={secondaryButtonStyle}
                    onClick={() => setDeliveryDrawerLinkId(l.id)}
                    data-intake-link-delivery={l.id}
                  >
                    Delivery
                  </button>
                  {l.status === "ACTIVE" ? (
                    <button
                      type="button"
                      style={dangerButtonStyle}
                      onClick={() => revokeLink(l.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {showCreate && currentTeam ? (
        <CreateLinkModal
          team={currentTeam}
          templates={eligibleTemplates}
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false);
            setRawTokenReveal({
              rawToken: created.rawToken,
              intakeUrl: intakeUrlFromToken(created.rawToken),
              linkId: created.link.id,
              recipientPhone: created.link.recipientPhone,
            });
            setLinks((prev) => (prev ? [created.link, ...prev] : [created.link]));
          }}
        />
      ) : null}

      {rawTokenReveal ? (
        <RawTokenRevealModal
          intakeUrl={rawTokenReveal.intakeUrl}
          rawToken={rawTokenReveal.rawToken}
          linkId={rawTokenReveal.linkId}
          recipientPhone={rawTokenReveal.recipientPhone}
          onClose={() => setRawTokenReveal(null)}
        />
      ) : null}

      {deliveryDrawerLinkId && currentTeam ? (
        <IntakeLinkDeliveryDrawer
          linkId={deliveryDrawerLinkId}
          teamId={currentTeam.id}
          onClose={() => setDeliveryDrawerLinkId(null)}
        />
      ) : null}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Create modal
// -----------------------------------------------------------------------------

function CreateLinkModal({
  team,
  templates,
  onClose,
  onCreated,
}: {
  team: { id: string; name: string };
  templates: WorkflowTemplateRow[];
  onClose: () => void;
  onCreated: (result: { link: LinkRow; rawToken: string }) => void;
}) {
  const [slug, setSlug] = useState(templates[0]?.slug ?? "");
  const [intakeMode, setIntakeMode] = useState("EXTERNAL_ONE_TIME");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [maxFileCount, setMaxFileCount] = useState<number | "">(10);
  const [allowedKinds, setAllowedKinds] = useState<Set<string>>(
    new Set(ACCEPTED_KIND_OPTIONS),
  );
  const [consentText, setConsentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // E.164 validation for the phone field. Empty is allowed (optional);
  // non-empty must canonicalize. The canonicalized value is what we send
  // to the backend so Twilio always receives a well-formed number.
  const phoneValidation =
    recipientPhone.trim().length === 0
      ? { ok: true as const, canonical: "" }
      : validateE164(recipientPhone);
  const phoneCanonical =
    phoneValidation.ok && phoneValidation.canonical.length > 0
      ? phoneValidation.canonical
      : null;
  const phoneError =
    !phoneValidation.ok &&
    (phoneValidation.reason === "missing_plus"
      ? "Include the country code, e.g. +14155550123"
      : phoneValidation.reason === "invalid_length"
        ? "That doesn't look like a valid international number"
        : null);

  const selectedTemplate = templates.find((t) => t.slug === slug);
  const eligibleModes = selectedTemplate
    ? INTAKE_MODES.filter((m) => selectedTemplate.intakeModes.includes(m.value))
    : INTAKE_MODES;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const expiresAtUtc = new Date(
        Date.now() + expiresInHours * 3600 * 1000,
      ).toISOString();

      const body = {
        teamId: team.id,
        workflowTemplateSlug: slug,
        intakeMode,
        recipientLabel: recipientLabel || null,
        recipientEmail: recipientEmail || null,
        recipientPhone: phoneCanonical,
        maxUses: intakeMode === "EXTERNAL_REUSABLE" ? 1000 : 1,
        maxFileCountPerSession: maxFileCount === "" ? null : maxFileCount,
        allowedAcceptedKinds: Array.from(allowedKinds),
        consentDisclosureText: consentText || null,
        expiresAtUtc,
      };

      const res: { link: LinkRow; rawToken: string } = await apiFetch(
        "/v1/workflow/intake-links",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      onCreated({ link: res.link, rawToken: res.rawToken });
    } catch (err) {
      const e = err as { message?: string; code?: string };
      setError(
        e?.code === "FEATURE_DISABLED"
          ? "External intake is not enabled on this deployment."
          : e?.message ?? "Could not create intake link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h2 style={sectionTitleStyle}>New intake link</h2>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}

        {/* Phase IA-self-serve-completion — relabelled "Workflow
            template" to plain-language "Evidence request form". The
            underlying API value is the same template slug; only the
            user-facing label was unexplained jargon for self-serve. */}
        <label style={labelStyle}>Evidence request form</label>
        <select
          style={inputStyle}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        >
          {templates.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.name} ({t.slug})
            </option>
          ))}
        </select>

        <label style={labelStyle}>Intake mode</label>
        <select
          style={inputStyle}
          value={intakeMode}
          onChange={(e) => setIntakeMode(e.target.value)}
        >
          {eligibleModes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label style={labelStyle}>Recipient label (optional)</label>
        <input
          style={inputStyle}
          placeholder="e.g. John Smith — claim 4842"
          value={recipientLabel}
          onChange={(e) => setRecipientLabel(e.target.value.slice(0, 180))}
        />

        <label style={labelStyle}>Recipient email (optional)</label>
        <input
          style={inputStyle}
          type="email"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value.slice(0, 320))}
        />

        <label style={labelStyle}>Recipient phone (optional — required for SMS/WhatsApp)</label>
        <input
          style={{
            ...inputStyle,
            borderColor: phoneError ? "#dc2626" : inputStyle.border as string,
          }}
          type="tel"
          placeholder="+14155550123"
          autoComplete="tel"
          value={recipientPhone}
          onChange={(e) => setRecipientPhone(e.target.value.slice(0, 32))}
          aria-invalid={Boolean(phoneError)}
          data-intake-link-phone
        />
        {phoneError ? (
          <p style={{ ...mutedStyle, color: "#b91c1c", marginTop: -8, marginBottom: 12 }}>
            {phoneError}
          </p>
        ) : (
          <p style={{ ...mutedStyle, marginTop: -8, marginBottom: 12 }}>
            International format with country code (E.164). Used only if you choose to send the link by SMS or WhatsApp.
          </p>
        )}

        <label style={labelStyle}>Expires in (hours)</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          max={24 * 365}
          value={expiresInHours}
          onChange={(e) => setExpiresInHours(Number(e.target.value) || 72)}
        />

        <label style={labelStyle}>Max files per session</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          max={500}
          value={maxFileCount}
          onChange={(e) => {
            const v = e.target.value === "" ? "" : Number(e.target.value);
            setMaxFileCount(typeof v === "number" && Number.isFinite(v) ? v : "");
          }}
        />

        <label style={labelStyle}>Accepted file types</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {ACCEPTED_KIND_OPTIONS.map((k) => (
            <label key={k} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={allowedKinds.has(k)}
                onChange={(e) => {
                  setAllowedKinds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(k);
                    else next.delete(k);
                    return next;
                  });
                }}
              />
              {k}
            </label>
          ))}
        </div>

        <label style={labelStyle}>Consent / disclosure text (optional)</label>
        <textarea
          style={{ ...inputStyle, minHeight: 80 }}
          value={consentText}
          onChange={(e) => setConsentText(e.target.value.slice(0, 4000))}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button type="button" style={secondaryButtonStyle} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" style={primaryButtonStyle} onClick={submit} disabled={busy || !slug}>
            {busy ? "Creating…" : "Create link"}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// One-shot raw token reveal — also the ONLY moment Send-via-SMS/WhatsApp
// is wired, because the rawToken is unrecoverable after this modal closes.
// -----------------------------------------------------------------------------

function RawTokenRevealModal({
  intakeUrl,
  rawToken,
  linkId,
  recipientPhone,
  onClose,
}: {
  intakeUrl: string;
  rawToken: string;
  linkId: string;
  recipientPhone: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sendBusy, setSendBusy] = useState<"SMS" | "WHATSAPP" | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentChannel, setSentChannel] = useState<"SMS" | "WHATSAPP" | null>(null);

  const canSend = Boolean(recipientPhone);

  async function send(channel: "SMS" | "WHATSAPP") {
    setSendError(null);
    setSendBusy(channel);
    try {
      await apiFetch(
        `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, rawToken, intakeUrl }),
        },
      );
      setSentChannel(channel);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      // Translate the backend error codes into user-readable copy.
      const codeMap: Record<string, string> = {
        link_missing_phone:
          "Add a recipient phone number on the link before sending.",
        link_revoked: "This link has been revoked.",
        link_expired: "This link has already expired.",
        provider_unconfigured:
          "Messaging isn't configured for this deployment. Copy the link instead.",
      };
      setSendError(codeMap[e?.code ?? ""] ?? e?.message ?? "Could not send the link.");
    } finally {
      setSendBusy(null);
    }
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle}>
        <h2 style={sectionTitleStyle}>Link created</h2>
        <p style={paragraphStyle}>
          This link will not be shown again. Send or copy it now — once you
          close this dialog, the only way to share it is to create a new
          link.
        </p>
        <input
          style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12 }}
          readOnly
          value={intakeUrl}
          onClick={(e) => (e.target as HTMLInputElement).select()}
          data-intake-link-url
        />

        {sendError ? (
          <div style={errorBoxStyle} data-intake-link-send-error>
            {sendError}
          </div>
        ) : null}
        {sentChannel ? (
          <div
            style={{
              ...infoBoxStyle,
              background: "#dcfce7",
              border: "1px solid #86efac",
              color: "#166534",
            }}
            data-intake-link-send-success
          >
            Queued for {sentChannel === "SMS" ? "SMS" : "WhatsApp"} delivery. Track
            status under <strong>Delivery</strong> on the link card.
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 16,
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              style={canSend ? primaryButtonStyle : disabledButtonStyle}
              onClick={() => send("SMS")}
              disabled={!canSend || sendBusy !== null}
              data-intake-link-send="SMS"
            >
              {sendBusy === "SMS" ? "Sending…" : "Send by SMS"}
            </button>
            <button
              type="button"
              style={canSend ? primaryButtonStyle : disabledButtonStyle}
              onClick={() => send("WHATSAPP")}
              disabled={!canSend || sendBusy !== null}
              data-intake-link-send="WHATSAPP"
            >
              {sendBusy === "WHATSAPP" ? "Sending…" : "Send by WhatsApp"}
            </button>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(intakeUrl);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
              data-intake-link-copy
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
        {!canSend ? (
          <p style={{ ...mutedStyle, marginTop: 12 }}>
            Add a recipient phone number when creating the link to enable
            Send by SMS or WhatsApp.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const paragraphStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: "#334155",
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
};
const cardStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  marginTop: 12,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "10px 20px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
};
const dangerButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontWeight: 500,
  color: "#7f1d1d",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 8,
  cursor: "pointer",
};
const disabledButtonStyle: React.CSSProperties = {
  padding: "10px 20px",
  fontWeight: 600,
  color: "#94a3b8",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  cursor: "not-allowed",
};
const infoBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 14,
  color: "#334155",
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  marginBottom: 12,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  color: "#334155",
};
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};
const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: 24,
  maxWidth: 560,
  width: "100%",
  maxHeight: "90vh",
  overflow: "auto",
  boxShadow: "0 20px 60px rgba(15, 23, 42, 0.25)",
};
