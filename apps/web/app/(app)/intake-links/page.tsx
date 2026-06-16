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

// Intake-links-e2e Phase 1 — the rich list-item shape returned by
// GET /v1/workflow/intake-links. Matches projectIntakeLinkList on the
// backend. Includes computed lifecycle, latest delivery, and session
// activity aggregates so the list renders without a per-link follow-up.
type LinkListItem = {
  link: {
    id: string;
    teamId: string;
    workflowTemplateSlug: string;
    workflowTemplateVersion: number;
    workflowTemplateName: string;
    intakeMode: string;
    caseId: string | null;
    recipientLabel: string | null;
    recipientEmailPreview: string | null;
    recipientPhonePreview: string | null;
    maxUses: number;
    usedCount: number;
    status: string;
    expiresAtUtc: string;
    revokedAtUtc: string | null;
    revokedReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  delivery: {
    latestStatus: string | null;
    latestChannel: string | null;
    latestAtUtc: string | null;
    latestSentAtUtc: string | null;
    latestDeliveredAtUtc: string | null;
    latestFailedAtUtc: string | null;
    latestErrorCode: string | null;
    attemptCount: number;
    channelsAttempted: string[];
    latestProviderMessageId: string | null;
  };
  activity: {
    firstOpenedAtUtc: string | null;
    lastOpenedAtUtc: string | null;
    firstStartedAtUtc: string | null;
    lastStartedAtUtc: string | null;
    firstSubmittedAtUtc: string | null;
    lastSubmittedAtUtc: string | null;
    sessionsCreated: number;
    sessionsOpened: number;
    sessionsStarted: number;
    sessionsSubmitted: number;
    sessionsExpired: number;
    sessionsRevoked: number;
    evidenceCount: number;
  };
  computedLifecycle:
    | "CREATED"
    | "SENT"
    | "DELIVERY_FAILED"
    | "OPENED"
    | "STARTED"
    | "SUBMITTED"
    | "EXPIRED"
    | "REVOKED";
};

// Intake-links-e2e Phase 3 — submissions drawer payload.
type SubmissionSession = {
  id: string;
  status: string;
  submitterDisplayName: string | null;
  submitterEmailPreview: string | null;
  submitterPhonePreview: string | null;
  pseudonym: string | null;
  openedAtUtc: string | null;
  uploadStartedAtUtc: string | null;
  uploadCompletedAtUtc: string | null;
  submittedAtUtc: string | null;
  abandonedAtUtc: string | null;
  revokedAtUtc: string | null;
  expiresAtUtc: string;
  consentAcceptedAtUtc: string | null;
  evidenceId: string | null;
};

type SubmissionsPayload = {
  link: {
    id: string;
    teamId: string;
    intakeMode: string;
    recipientLabel: string | null;
    workflowTemplateSlug: string;
    workflowTemplateName: string;
  };
  sessions: SubmissionSession[];
  totals: {
    sessions: number;
    submitted: number;
    inProgress: number;
    evidenceProduced: number;
  };
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

// Intake-links-e2e (Phase 1) — built-in request types catalog.
//
// The backend create endpoint resolves `workflowTemplateSlug` via
// `loadEffectiveWorkflowTemplate`, which falls back to the seeded
// IntakeTemplate registry when no workspace override exists. These six
// slugs are the canonical seed IDs (see
// services/api/src/services/capture-intake-templates.ts), so every
// workspace can use them without needing to create a template first.
//
// Why a hardcoded catalog and not just the fetched templates list?
//   - SMB users don't think in "workflow templates" — they think in
//     "what am I asking the other side to send me". Plain-language
//     labels beat slug-only dropdowns.
//   - The pre-existing dropdown silently rendered empty if the
//     /v1/workflow/templates fetch failed, leaving the user staring
//     at a useless modal with no way to recover.
//   - Workspace-specific templates (enterprise admin custom flows)
//     are still surfaced as an "Other" group below the catalog when
//     the fetch succeeds and returns rows the catalog doesn't cover.
const REQUEST_TYPES: Array<{
  slug: string;
  label: string;
  description: string;
  recommendedKinds: Array<"PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT">;
}> = [
  {
    slug: "general-evidence-record",
    label: "General evidence request",
    description:
      "Catch-all for anything — photos, documents, or a quick description.",
    recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  },
  {
    slug: "photos-videos",
    label: "Photos & videos",
    description:
      "Ask for photos and short videos only — no documents required.",
    recommendedKinds: ["PHOTO", "VIDEO"],
  },
  {
    slug: "documents",
    label: "Documents",
    description:
      "Ask the contributor for documents (PDFs, scans, or clear photos of paperwork).",
    recommendedKinds: ["DOCUMENT", "PHOTO"],
  },
  {
    slug: "insurance-claim",
    label: "Insurance claim evidence",
    description:
      "Damage photos, repair quotes, receipts, and supporting paperwork.",
    recommendedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
  },
  {
    slug: "legal-matter",
    label: "Legal document collection",
    description:
      "Contracts, signed forms, sworn statements, and other case documents.",
    recommendedKinds: ["DOCUMENT", "PHOTO"],
  },
  {
    slug: "property-damage",
    label: "Property damage",
    description:
      "Scene overview, close-up damage shots, and any repair estimates or receipts.",
    recommendedKinds: ["PHOTO", "VIDEO", "DOCUMENT"],
  },
  {
    slug: "incident-investigation",
    label: "Incident investigation",
    description:
      "Photos of the scene, witness statements, and supporting context.",
    recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  },
  {
    slug: "compliance-audit",
    label: "Compliance / audit submission",
    description:
      "Policies, procedures, training records, and audit trail documents.",
    recommendedKinds: ["DOCUMENT"],
  },
  {
    slug: "journalism-field-capture",
    label: "Source / witness submission",
    description:
      "Anonymous or pseudonymous submissions from sources or witnesses.",
    recommendedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"],
  },
];

// Intake-links-e2e (Phase 2) — delivery method catalog. Mirrors the
// backend DELIVERY_METHODS enum exactly.
type DeliveryMethod = "MANUAL" | "EMAIL" | "SMS" | "WHATSAPP";
const DELIVERY_METHODS: Array<{
  value: DeliveryMethod;
  label: string;
  description: string;
}> = [
  {
    value: "MANUAL",
    label: "Copy link manually",
    description:
      "You'll get a one-time link to copy and share however you want.",
  },
  {
    value: "EMAIL",
    label: "Send by email",
    description: "PROOVRA sends the link to the recipient email below.",
  },
  {
    value: "SMS",
    label: "Send by SMS",
    description: "PROOVRA sends an SMS to the recipient phone number below.",
  },
  {
    value: "WHATSAPP",
    label: "Send by WhatsApp",
    description:
      "PROOVRA sends a WhatsApp message to the recipient phone number below.",
  },
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
  // Intake-links-e2e Phase 2 — the list endpoint now returns rich
  // items with lifecycle + delivery + activity envelopes. The legacy
  // `links` array is preserved as a fallback for the create flow which
  // needs the bare LinkRow shape on response (rawToken reveal).
  const [items, setItems] = useState<LinkListItem[] | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [rawTokenReveal, setRawTokenReveal] = useState<{
    rawToken: string;
    intakeUrl: string;
    linkId: string;
    recipientPhone: string | null;
    delivery: CreatedResult["delivery"];
  } | null>(null);
  const [deliveryDrawerLinkId, setDeliveryDrawerLinkId] = useState<string | null>(
    null,
  );
  // Intake-links-e2e Phase 3 — view submissions drawer state.
  const [submissionsLinkId, setSubmissionsLinkId] = useState<string | null>(
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

  // Load links once we know the workspace. Reads the rich `items`
  // envelope (lifecycle + delivery + activity); falls back to the
  // legacy `links` array if the backend hasn't rolled out yet.
  const refreshLinks = useMemo(
    () => async (teamId: string): Promise<void> => {
      try {
        const res = (await apiFetch(
          `/v1/workflow/intake-links?teamId=${encodeURIComponent(teamId)}`,
          { method: "GET" },
        )) as { items?: LinkListItem[]; links?: LinkRow[] };
        setItems(res.items ?? []);
        setFeatureDisabled(false);
      } catch (err) {
        const e = err as {
          code?: string;
          statusCode?: number;
          message?: string;
        };
        if (e?.statusCode === 503 || e?.code === "FEATURE_DISABLED") {
          setFeatureDisabled(true);
          setItems([]);
          return;
        }
        setError(e?.message ?? "Unable to load intake links.");
      }
    },
    [],
  );
  useEffect(() => {
    if (!currentTeam) return;
    void refreshLinks(currentTeam.id);
  }, [currentTeam?.id, refreshLinks]);

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
      await apiFetch(`/v1/workflow/intake-links/${linkId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: null }),
      });
      // Always refetch the whole list — the revoke changes the
      // lifecycle chip, so a local patch of just the bare LinkRow
      // would leave the list-item envelope stale.
      if (currentTeam) await refreshLinks(currentTeam.id);
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

      {/* Intake-links-e2e Phase 8 — compact 3-step guidance card.
          Frames the page for SMB users who land here cold.  */}
      <section style={guidanceCardStyle} data-intake-links-guidance="true">
        <h2 style={{ ...sectionTitleStyle, marginBottom: 6 }}>
          Request evidence with a secure upload link
        </h2>
        <p style={{ ...paragraphStyle, marginTop: 0, marginBottom: 12 }}>
          Send a link by email, SMS, WhatsApp, or copy it manually.
          Contributors upload files without joining your workspace.
        </p>
        <ol style={guidanceListStyle}>
          <li>
            <strong>Choose the request type.</strong>
          </li>
          <li>
            <strong>Share the secure link.</strong>
          </li>
          <li>
            <strong>Track delivery and submissions.</strong>
          </li>
        </ol>
      </section>

      {!currentTeam ? (
        <div style={infoBoxStyle} data-intake-links-loading>
          Loading workspace…
        </div>
      ) : null}

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {currentTeam && items !== null ? (
        items.length === 0 ? (
          <div style={infoBoxStyle} data-intake-links-empty>
            Create a secure intake link to request evidence from a
            client, source, witness, or contributor.
          </div>
        ) : (
          <ul
            style={{ listStyle: "none", padding: 0, marginTop: 24 }}
            data-intake-links-list="true"
          >
            {items.map((it) => (
              <IntakeLinkCard
                key={it.link.id}
                item={it}
                onRevoke={() => revokeLink(it.link.id)}
                onDelivery={() => setDeliveryDrawerLinkId(it.link.id)}
                onViewSubmissions={() => setSubmissionsLinkId(it.link.id)}
              />
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
              delivery: created.delivery,
            });
            // Refetch the list so the new link shows up with its
            // freshly-computed lifecycle envelope (the create response
            // doesn't have the rich shape).
            if (currentTeam) void refreshLinks(currentTeam.id);
          }}
        />
      ) : null}

      {rawTokenReveal ? (
        <RawTokenRevealModal
          intakeUrl={rawTokenReveal.intakeUrl}
          rawToken={rawTokenReveal.rawToken}
          linkId={rawTokenReveal.linkId}
          recipientPhone={rawTokenReveal.recipientPhone}
          delivery={rawTokenReveal.delivery}
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

      {submissionsLinkId ? (
        <SubmissionsDrawer
          linkId={submissionsLinkId}
          onClose={() => setSubmissionsLinkId(null)}
        />
      ) : null}
    </main>
  );
}

// -----------------------------------------------------------------------------
// IntakeLinkCard — Phase 2 row renderer for the new envelope.
// -----------------------------------------------------------------------------

function IntakeLinkCard({
  item,
  onRevoke,
  onDelivery,
  onViewSubmissions,
}: {
  item: LinkListItem;
  onRevoke: () => void;
  onDelivery: () => void;
  onViewSubmissions: () => void;
}) {
  const { link, delivery, activity, computedLifecycle } = item;
  const lifecycleStyle = LIFECYCLE_CHIP_STYLES[computedLifecycle];
  const deliverySummary = describeDeliverySummary(delivery);
  const activitySummary = describeActivitySummary(activity);
  return (
    <li
      style={cardStyle}
      data-intake-link-row={link.id}
      data-intake-link-lifecycle={computedLifecycle}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 6,
          }}
        >
          <span
            style={{ ...lifecycleChipBaseStyle, ...lifecycleStyle }}
            data-intake-link-lifecycle-chip="true"
          >
            {LIFECYCLE_LABELS[computedLifecycle]}
          </span>
          <span
            style={deliveryMethodChipStyle}
            data-intake-link-delivery-method-chip={
              delivery.latestChannel ?? "MANUAL"
            }
          >
            {delivery.latestChannel ?? "Manual"}
          </span>
        </div>
        <div style={{ fontWeight: 600 }}>
          {link.recipientLabel ?? link.workflowTemplateName}
        </div>
        <div style={mutedStyle}>
          {link.workflowTemplateName} ·{" "}
          {link.recipientEmailPreview
            ? `to ${link.recipientEmailPreview}`
            : link.recipientPhonePreview
              ? `to ${link.recipientPhonePreview}`
              : "no recipient set"}
        </div>
        <div
          style={{ ...mutedStyle, marginTop: 4 }}
          data-intake-link-delivery-summary="true"
        >
          {deliverySummary}
        </div>
        <div
          style={{ ...mutedStyle, marginTop: 4 }}
          data-intake-link-activity-summary="true"
        >
          {activitySummary}
        </div>
        <div style={{ ...mutedStyle, marginTop: 4 }}>
          Used {link.usedCount} / {link.maxUses} · Created{" "}
          {new Date(link.createdAt).toLocaleString()} · Expires{" "}
          {new Date(link.expiresAtUtc).toLocaleString()}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        {activity.sessionsCreated > 0 ? (
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={onViewSubmissions}
            data-intake-link-view-submissions={link.id}
          >
            View submissions ({activity.sessionsCreated})
          </button>
        ) : null}
        <button
          type="button"
          style={secondaryButtonStyle}
          onClick={onDelivery}
          data-intake-link-delivery={link.id}
        >
          Delivery
        </button>
        {link.status === "ACTIVE" ? (
          <button
            type="button"
            style={dangerButtonStyle}
            onClick={onRevoke}
            data-intake-link-revoke-btn={link.id}
          >
            Revoke
          </button>
        ) : null}
      </div>
    </li>
  );
}

// Intake-links-e2e Phase 2 — lifecycle chip styling. Colours are
// chosen so SUBMITTED reads "done" (green), DELIVERY_FAILED reads
// "needs your attention" (red), and EXPIRED/REVOKED read "closed"
// (grey/red). No emoji — accessibility + i18n.
const LIFECYCLE_LABELS: Record<LinkListItem["computedLifecycle"], string> = {
  CREATED: "Created",
  SENT: "Sent",
  DELIVERY_FAILED: "Delivery failed",
  OPENED: "Opened",
  STARTED: "Started",
  SUBMITTED: "Submitted",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};
const LIFECYCLE_CHIP_STYLES: Record<
  LinkListItem["computedLifecycle"],
  React.CSSProperties
> = {
  CREATED: { background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1" },
  SENT: { background: "#dbeafe", color: "#1e40af", border: "1px solid #93c5fd" },
  DELIVERY_FAILED: {
    background: "#fee2e2",
    color: "#991b1b",
    border: "1px solid #fca5a5",
  },
  OPENED: {
    background: "#fef9c3",
    color: "#854d0e",
    border: "1px solid #fde047",
  },
  STARTED: {
    background: "#fde68a",
    color: "#854d0e",
    border: "1px solid #facc15",
  },
  SUBMITTED: {
    background: "#dcfce7",
    color: "#166534",
    border: "1px solid #86efac",
  },
  EXPIRED: { background: "#f1f5f9", color: "#475569", border: "1px solid #94a3b8" },
  REVOKED: { background: "#fee2e2", color: "#7f1d1d", border: "1px solid #fca5a5" },
};

const lifecycleChipBaseStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: 999,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const deliveryMethodChipStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#475569",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  padding: "2px 8px",
  borderRadius: 999,
};

function describeDeliverySummary(delivery: LinkListItem["delivery"]): string {
  if (delivery.attemptCount === 0) return "Delivery: not sent yet (manual link).";
  const ts = delivery.latestAtUtc
    ? ` (${describeRelativeTime(delivery.latestAtUtc)})`
    : "";
  const channel = delivery.latestChannel ?? "channel";
  switch (delivery.latestStatus) {
    case "SENT":
    case "DELIVERED":
      return `Delivery: ${channel.toLowerCase()} sent${ts}.`;
    case "FAILED":
    case "UNDELIVERED":
      return `Delivery: ${channel.toLowerCase()} failed${ts}. Use Resend.`;
    case "QUEUED":
    case "RETRY_SCHEDULED":
      return `Delivery: ${channel.toLowerCase()} queued${ts}.`;
    case "CANCELLED":
      return `Delivery: ${channel.toLowerCase()} cancelled${ts}.`;
    default:
      return `Delivery: ${delivery.attemptCount} attempt(s).`;
  }
}

function describeActivitySummary(activity: LinkListItem["activity"]): string {
  if (activity.sessionsSubmitted > 0) {
    const when = activity.lastSubmittedAtUtc
      ? ` (last ${describeRelativeTime(activity.lastSubmittedAtUtc)})`
      : "";
    return `Submitted ${activity.sessionsSubmitted} time(s)${when} · ${activity.evidenceCount} evidence record(s).`;
  }
  if (activity.sessionsStarted > 0) {
    const when = activity.lastStartedAtUtc
      ? ` (last ${describeRelativeTime(activity.lastStartedAtUtc)})`
      : "";
    return `Upload in progress${when}.`;
  }
  if (activity.sessionsOpened > 0) {
    const when = activity.lastOpenedAtUtc
      ? ` ${describeRelativeTime(activity.lastOpenedAtUtc)}`
      : "";
    return `Opened${when}, no upload yet.`;
  }
  return "Not opened yet.";
}

function describeRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const ms = Math.max(0, now - then);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// -----------------------------------------------------------------------------
// SubmissionsDrawer — Phase 3 view.
// -----------------------------------------------------------------------------

function SubmissionsDrawer({
  linkId,
  onClose,
}: {
  linkId: string;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<SubmissionsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/workflow/intake-links/${encodeURIComponent(linkId)}/submissions`, {
      method: "GET",
    })
      .then((res: SubmissionsPayload) => {
        if (!cancelled) setPayload(res);
      })
      .catch((err: { message?: string }) => {
        if (!cancelled) {
          setError(err?.message ?? "Unable to load submissions.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      <div style={modalStyle} data-intake-link-submissions-drawer="true">
        <h2 style={sectionTitleStyle}>Submissions</h2>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}
        {!payload && !error ? (
          <div style={infoBoxStyle}>Loading submissions…</div>
        ) : null}
        {payload ? (
          <>
            <p style={mutedStyle}>
              <strong>{payload.link.workflowTemplateName}</strong> ·{" "}
              {payload.link.recipientLabel ?? "no recipient label"}
            </p>
            <p style={mutedStyle}>
              {payload.totals.sessions} total ·{" "}
              {payload.totals.submitted} submitted ·{" "}
              {payload.totals.inProgress} in progress ·{" "}
              {payload.totals.evidenceProduced} evidence record(s)
            </p>
            {payload.sessions.length === 0 ? (
              <div style={infoBoxStyle} data-intake-link-submissions-empty="true">
                No submissions yet. The link is ready; nobody has uploaded
                anything yet.
              </div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0 }}>
                {payload.sessions.map((s) => (
                  <li
                    key={s.id}
                    style={cardStyle}
                    data-intake-link-submission-row={s.id}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {s.pseudonym
                          ? `Alias: ${s.pseudonym}`
                          : s.submitterDisplayName ?? "Anonymous contributor"}
                      </div>
                      <div style={mutedStyle}>
                        Status: <strong>{s.status}</strong>{" "}
                        {s.submitterEmailPreview
                          ? `· ${s.submitterEmailPreview}`
                          : ""}
                      </div>
                      <div style={mutedStyle}>
                        {s.openedAtUtc
                          ? `Opened ${describeRelativeTime(s.openedAtUtc)}`
                          : "Not opened"}
                        {s.submittedAtUtc
                          ? ` · Submitted ${describeRelativeTime(s.submittedAtUtc)}`
                          : ""}
                      </div>
                    </div>
                    {s.evidenceId ? (
                      <a
                        href={`/evidence/${encodeURIComponent(s.evidenceId)}`}
                        style={{
                          ...secondaryButtonStyle,
                          textDecoration: "none",
                        }}
                        data-intake-link-submission-open-evidence={s.evidenceId}
                      >
                        Open evidence
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={secondaryButtonStyle} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Create modal
// -----------------------------------------------------------------------------

type CreatedResult = {
  link: LinkRow;
  rawToken: string;
  // Intake-links-e2e (Phase 4) — delivery envelope from the backend.
  // Always present so the reveal modal can show Sent / Failed / Manual
  // status immediately after create.
  delivery: {
    method: DeliveryMethod;
    status: "sent" | "failed" | "skipped";
    communicationMessageId?: string | null;
    reason?: string | null;
  };
};

function CreateLinkModal({
  team,
  templates,
  onClose,
  onCreated,
}: {
  team: { id: string; name: string };
  templates: WorkflowTemplateRow[];
  onClose: () => void;
  onCreated: (result: CreatedResult) => void;
}) {
  // Intake-links-e2e (Phase 1) — default to the most generic catalog
  // entry rather than the first fetched workspace template. Falls
  // through to a workspace template only when the user explicitly
  // picks one from the "Other workflow" group.
  const [slug, setSlug] = useState<string>(REQUEST_TYPES[0].slug);
  const [intakeMode, setIntakeMode] = useState("EXTERNAL_ONE_TIME");
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>(
    "MANUAL",
  );
  const [recipientLabel, setRecipientLabel] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [maxFileCount, setMaxFileCount] = useState<number | "">(10);
  // Default the accepted-kinds set from the chosen catalog entry's
  // recommendation, then let the user tweak.
  const [allowedKinds, setAllowedKinds] = useState<Set<string>>(
    new Set(REQUEST_TYPES[0].recommendedKinds),
  );
  const [consentText, setConsentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Intake-links-e2e Phase 5 — a per-modal-lifetime nonce. Mounting
  // the modal generates a fresh value; double-clicking the submit
  // button re-sends the SAME value so the backend dispatcher dedupes
  // the delivery. Opening the modal a second time (after a successful
  // create or an explicit Cancel) gets a fresh nonce automatically.
  // Synthesised from crypto.randomUUID when available, otherwise from
  // a short Math.random fallback (idempotency keys don't need to be
  // unguessable — they just need to be stable within the modal).
  const submitNonce = useMemo(() => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `create:${crypto.randomUUID()}`;
    }
    return `create:${Math.random().toString(36).slice(2)}${Date.now()}`;
  }, []);

  // Other (custom) workspace templates — surface only those that aren't
  // already covered by the built-in catalog so the dropdown stays
  // signal-dense.
  const catalogSlugs = new Set(REQUEST_TYPES.map((r) => r.slug));
  const otherTemplates = templates.filter((t) => !catalogSlugs.has(t.slug));
  const builtIn = REQUEST_TYPES.find((r) => r.slug === slug) ?? null;

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

  // Intake-links-e2e (Phase 2) — conditional validation. EMAIL requires
  // an email; SMS/WHATSAPP requires a valid E.164 phone. Block submit
  // up-front rather than surfacing the backend 400.
  const emailRequiredAndMissing =
    deliveryMethod === "EMAIL" && !recipientEmail.trim();
  const phoneRequiredAndMissing =
    (deliveryMethod === "SMS" || deliveryMethod === "WHATSAPP") &&
    !phoneCanonical;
  const submitDisabled =
    busy ||
    !slug ||
    emailRequiredAndMissing ||
    phoneRequiredAndMissing ||
    Boolean(phoneError);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const expiresAtUtc = new Date(
        Date.now() + expiresInHours * 3600 * 1000,
      ).toISOString();

      // Intake-links-e2e — when the operator picks a non-manual
      // delivery method we ALSO need to pass the public origin to the
      // backend so it can compose the contributor URL. The backend
      // appends `/intake/<token>` itself.
      const intakeUrlBase =
        typeof window !== "undefined" && window.location
          ? `${window.location.protocol}//${window.location.host}`
          : undefined;

      // Intake-links-e2e Phase 5 — per-form-submit idempotency
      // nonce. Generated when the modal mounts (see useMemo below);
      // a double-click ships the SAME nonce so the backend
      // dispatcher dedupes the delivery to a single provider call.
      const body = {
        teamId: team.id,
        workflowTemplateSlug: slug,
        intakeMode,
        deliveryMethod,
        intakeUrlBase: deliveryMethod === "MANUAL" ? undefined : intakeUrlBase,
        recipientLabel: recipientLabel || null,
        recipientEmail: recipientEmail || null,
        recipientPhone: phoneCanonical,
        maxUses: intakeMode === "EXTERNAL_REUSABLE" ? 1000 : 1,
        maxFileCountPerSession: maxFileCount === "" ? null : maxFileCount,
        allowedAcceptedKinds: Array.from(allowedKinds),
        consentDisclosureText: consentText || null,
        expiresAtUtc,
        idempotencyKey: submitNonce,
      };

      const res: CreatedResult = await apiFetch("/v1/workflow/intake-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      onCreated(res);
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

        {/* Intake-links-e2e (Phase 1) — built-in catalog primary,
            workspace templates secondary. The picker is plain
            language; the underlying value remains a template slug
            the backend resolves via loadEffectiveWorkflowTemplate. */}
        <label style={labelStyle}>What are you asking for?</label>
        <select
          style={inputStyle}
          value={slug}
          onChange={(e) => {
            const next = e.target.value;
            setSlug(next);
            const match = REQUEST_TYPES.find((r) => r.slug === next);
            if (match) setAllowedKinds(new Set(match.recommendedKinds));
          }}
          data-intake-link-request-type
        >
          <optgroup label="Common requests">
            {REQUEST_TYPES.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.label}
              </option>
            ))}
          </optgroup>
          {otherTemplates.length > 0 ? (
            <optgroup label="Other workflow templates for this workspace">
              {otherTemplates.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {builtIn ? (
          <p style={{ ...mutedStyle, marginTop: -8, marginBottom: 12 }}>
            {builtIn.description}
          </p>
        ) : null}

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

        {/* Intake-links-e2e (Phase 2) — explicit delivery method
            picker. The conditional recipient field below it changes
            based on this choice; the backend Zod schema enforces the
            same dependency. */}
        <label style={labelStyle}>How should the link be delivered?</label>
        <select
          style={inputStyle}
          value={deliveryMethod}
          onChange={(e) =>
            setDeliveryMethod(e.target.value as DeliveryMethod)
          }
          data-intake-link-delivery-method
        >
          {DELIVERY_METHODS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        <p style={{ ...mutedStyle, marginTop: -8, marginBottom: 4 }}>
          {DELIVERY_METHODS.find((d) => d.value === deliveryMethod)
            ?.description}
        </p>
        {/* Intake-links-e2e Phase 8 — multi-channel disclosure. The
            backend only sends through the single selected channel;
            this line removes the "did it also email them?" doubt
            without forcing the user to dig into the docs. */}
        <p
          style={{ ...mutedStyle, marginTop: 0, marginBottom: 12 }}
          data-intake-link-single-channel-note="true"
        >
          Only the selected channel will be used. PROOVRA won't send
          email and SMS together unless you choose a multi-channel
          workflow.
        </p>

        <label style={labelStyle}>Recipient label (optional)</label>
        <input
          style={inputStyle}
          placeholder="e.g. John Smith — claim 4842"
          value={recipientLabel}
          onChange={(e) => setRecipientLabel(e.target.value.slice(0, 180))}
        />

        {/* Intake-links-e2e (Phase 2) — conditionally render the
            email field only when EMAIL is selected. Hidden fields
            avoid asking for data we don't need and visually steer
            the user toward the delivery choice they made. */}
        {deliveryMethod === "EMAIL" ? (
          <>
            <label style={labelStyle}>
              Recipient email{" "}
              <span style={{ color: "#b91c1c" }}>(required)</span>
            </label>
            <input
              style={{
                ...inputStyle,
                borderColor: emailRequiredAndMissing
                  ? "#dc2626"
                  : (inputStyle.border as string),
              }}
              type="email"
              value={recipientEmail}
              onChange={(e) =>
                setRecipientEmail(e.target.value.slice(0, 320))
              }
              data-intake-link-email
              aria-invalid={emailRequiredAndMissing}
            />
          </>
        ) : (
          <>
            <label style={labelStyle}>Recipient email (optional)</label>
            <input
              style={inputStyle}
              type="email"
              value={recipientEmail}
              onChange={(e) =>
                setRecipientEmail(e.target.value.slice(0, 320))
              }
            />
          </>
        )}

        {deliveryMethod === "SMS" || deliveryMethod === "WHATSAPP" ? (
          <>
            <label style={labelStyle}>
              Recipient phone{" "}
              <span style={{ color: "#b91c1c" }}>(required)</span>
            </label>
            <input
              style={{
                ...inputStyle,
                borderColor: phoneError
                  ? "#dc2626"
                  : (inputStyle.border as string),
              }}
              type="tel"
              placeholder="+14155550123"
              autoComplete="tel"
              value={recipientPhone}
              onChange={(e) =>
                setRecipientPhone(e.target.value.slice(0, 32))
              }
              aria-invalid={Boolean(phoneError) || phoneRequiredAndMissing}
              data-intake-link-phone
            />
            {phoneError ? (
              <p
                style={{
                  ...mutedStyle,
                  color: "#b91c1c",
                  marginTop: -8,
                  marginBottom: 12,
                }}
              >
                {phoneError}
              </p>
            ) : (
              <p
                style={{
                  ...mutedStyle,
                  marginTop: -8,
                  marginBottom: 12,
                }}
              >
                International format with country code, e.g. +14155550123.
              </p>
            )}
          </>
        ) : (
          <>
            <label style={labelStyle}>Recipient phone (optional)</label>
            <input
              style={{
                ...inputStyle,
                borderColor: phoneError
                  ? "#dc2626"
                  : (inputStyle.border as string),
              }}
              type="tel"
              placeholder="+14155550123"
              autoComplete="tel"
              value={recipientPhone}
              onChange={(e) =>
                setRecipientPhone(e.target.value.slice(0, 32))
              }
              aria-invalid={Boolean(phoneError)}
              data-intake-link-phone
            />
            {phoneError ? (
              <p
                style={{
                  ...mutedStyle,
                  color: "#b91c1c",
                  marginTop: -8,
                  marginBottom: 12,
                }}
              >
                {phoneError}
              </p>
            ) : null}
          </>
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
          <button
            type="button"
            style={
              submitDisabled ? disabledButtonStyle : primaryButtonStyle
            }
            onClick={submit}
            disabled={submitDisabled}
            data-intake-link-submit
          >
            {busy
              ? "Creating…"
              : deliveryMethod === "MANUAL"
                ? "Create link"
                : "Create & send"}
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
  delivery,
  onClose,
}: {
  intakeUrl: string;
  rawToken: string;
  linkId: string;
  recipientPhone: string | null;
  delivery: CreatedResult["delivery"];
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

        {/* Intake-links-e2e (Phase 4) — surface the on-create delivery
            outcome immediately. The user is reading this modal because
            they just clicked Create; they need to know whether the
            email/SMS actually went out. */}
        {delivery.status === "sent" ? (
          <div
            style={{
              ...infoBoxStyle,
              background: "#dcfce7",
              border: "1px solid #86efac",
              color: "#166534",
            }}
            data-intake-link-delivery-result="sent"
          >
            <strong>Sent</strong> — link delivered via {delivery.method}.
            Track status under <strong>Delivery</strong> on the link card.
          </div>
        ) : null}
        {delivery.status === "failed" ? (
          <div
            style={errorBoxStyle}
            data-intake-link-delivery-result="failed"
          >
            <strong>Delivery failed</strong> ({delivery.method}
            {delivery.reason ? `: ${friendlyDeliveryReason(delivery.reason)}` : ""}).
            The link itself is created — copy and share it manually, or
            retry from the Delivery panel.
          </div>
        ) : null}
        {delivery.status === "skipped" ? (
          <div
            style={{ ...infoBoxStyle, marginTop: 12 }}
            data-intake-link-delivery-result="skipped"
          >
            Manual delivery — copy the link below and share it however
            you want. This link is shown <strong>once</strong>.
          </div>
        ) : null}

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
// Helpers
// -----------------------------------------------------------------------------

// Intake-links-e2e (Phase 4) — map backend delivery-failure reason
// codes to plain-language copy. Unknown codes pass through verbatim
// so we never silently swallow a new reason the backend adds.
function friendlyDeliveryReason(reason: string): string {
  const map: Record<string, string> = {
    link_missing_email:
      "no recipient email on the link",
    link_missing_phone:
      "no recipient phone on the link",
    link_revoked: "this link has been revoked",
    link_expired: "this link has already expired",
    provider_unconfigured:
      "messaging isn't configured on this deployment",
    delivery_failed: "the message provider rejected the send",
    delivery_failed_or_skipped:
      "the message provider rejected or skipped the send",
  };
  return map[reason] ?? reason;
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
const guidanceCardStyle: React.CSSProperties = {
  marginTop: 16,
  padding: "20px 24px",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 12,
};
const guidanceListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 14,
  lineHeight: 1.6,
  color: "#1e3a8a",
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
