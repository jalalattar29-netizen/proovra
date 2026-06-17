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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "../../../lib/api";
import { usePlatformContext } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// OperationalBreadcrumb removed — the breadcrumb row ("Workspace ›
// Intake links") was visual clutter above an already-titled page.
// The H1 + subtitle below frame the page without it.
import { useConfirmAction } from "../../../components/ui/ConfirmActionModal";
import { validateE164 } from "../../../lib/phone/e164";
import { IntakeLinkDeliveryDrawer } from "../../../components/intake-links/IntakeLinkDeliveryDrawer";
import {
  IntakeLinksOperationsConsole,
  type ConsoleItem,
} from "../../../components/intake-links/IntakeLinksOperationsConsole";
// Intake-link enterprise messaging — frontend imports the SAME shared
// renderers + sender-identity resolver the API uses, so the preview
// the operator sees in the modal is bit-for-bit what the recipient
// gets. The placeholder URL keeps the raw token out of the browser
// preview (the real URL is composed on the server at create time).
import {
  renderIntakeEmailMessage,
  renderIntakeSmsMessage,
  renderIntakeWhatsappMessage,
  resolveIntakeSenderDisplay,
  validateCustomSenderDisplayName,
  type IntakeSenderDisplayMode,
  INTAKE_LINK_LOCATION_POLICY_OPTIONS,
  type IntakeLinkLocationPolicy,
} from "@proovra/shared";

type SenderDisplayMode = IntakeSenderDisplayMode;

type SenderTransportChannel = {
  configured: boolean;
  fromName?: string;
  fromAddressPreview?: string;
  fromNumberPreview?: string | null;
  displayName?: string;
};
type SenderTransportInfo = {
  email: SenderTransportChannel;
  sms: SenderTransportChannel;
  whatsapp: SenderTransportChannel;
};

const PLACEHOLDER_INTAKE_URL =
  "https://app.proovra.com/intake/[secure-link]";

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
    archivedAtUtc: string | null;
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
// Short option labels keep the dropdown clean — the long explanation
// lives in INTAKE_MODE_HELPER_TEXT below and renders as helper copy
// under the select based on the current selection. Enum values are
// unchanged so the backend payload is identical to before.
const INTAKE_MODES = [
  { value: "EXTERNAL_ONE_TIME", label: "One-time link" },
  { value: "EXTERNAL_REUSABLE", label: "Reusable link" },
  { value: "EXTERNAL_ANONYMOUS", label: "Anonymous" },
  { value: "EXTERNAL_PSEUDONYMOUS", label: "Display name" },
];

const INTAKE_MODE_HELPER_TEXT: Record<string, string> = {
  EXTERNAL_ONE_TIME: "Best for one recipient and one submission.",
  EXTERNAL_REUSABLE:
    "Use when several people may submit files through the same link.",
  EXTERNAL_ANONYMOUS: "No contributor identity is requested.",
  EXTERNAL_PSEUDONYMOUS:
    "Contributor chooses a name shown with the submission.",
};

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
// P0 audit-fix — delivery method order. Email → SMS → WhatsApp →
// Copy link only. Manual is demoted to last so primary users land
// on a real delivery channel. WhatsApp is annotated with the
// "Requires WhatsApp setup" affordance and gated on the
// sender-identity endpoint's `whatsapp.configured` boolean — when
// false the option is disabled in the selector with a clear reason
// rather than letting the user pick a channel that won't actually
// deliver.
const DELIVERY_METHODS: Array<{
  value: DeliveryMethod;
  label: string;
  description: string;
}> = [
  {
    value: "MANUAL",
    label: "Copy link",
    description: "Create a link and share it yourself.",
  },
  {
    value: "SMS",
    label: "Send by SMS",
    description: "PROOVRA sends the secure upload link by text message.",
  },
  {
    value: "EMAIL",
    label: "Send by email",
    description: "PROOVRA sends a secure request email.",
  },
  {
    value: "WHATSAPP",
    label: "Send by WhatsApp",
    description: "PROOVRA sends the approved WhatsApp request template.",
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

  // Intake-links-e2e redesign — the create-modal state now carries an
  // optional `slug` so the Common Requests tiles can preselect the
  // template before the modal mounts. `null` = closed; an object =
  // open. The wrapper `openCreate(slug?)` is the single entrypoint
  // so every caller (header CTA, empty-state CTA, tiles) clears stale
  // errors / delivery results consistently.
  const [createOpen, setCreateOpen] = useState<{ initialSlug?: string } | null>(
    null,
  );
  const openCreate = (initialSlug?: string) => {
    setError(null);
    setCreateOpen({ initialSlug });
  };
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
  const router = useRouter();
  // Operations Console URL state. The console manages q / tab / channel
  // / lifecycle / delivery / sort / page / pageSize internally; we
  // hand it a writer that pushes the same params back to the address
  // bar via Next's router so reload / share works without losing
  // filter state. Use `replace` (not push) so the back button doesn't
  // step through every keystroke.
  const writeQueryToUrl = useCallback(
    (q: URLSearchParams) => {
      const qs = q.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router],
  );
  const [appliedDeepLink, setAppliedDeepLink] = useState(false);
  useEffect(() => {
    if (appliedDeepLink) return;
    if (searchParams.get("new") === "1") {
      openCreate();
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
          // archiveScope=all so the console's Archived tab actually
          // has rows to filter (the backend default is "active" which
          // hides them). The console tab system then filters
          // client-side: All / Active / Archived / etc. all work
          // off the same loaded array without a per-tab refetch.
          `/v1/workflow/intake-links?teamId=${encodeURIComponent(teamId)}&archiveScope=all`,
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
      {/* Operational header. The H1 + one-line subtitle frame the
          page; the primary CTA sits inline (top-right on desktop,
          stacked on narrow viewports via flexWrap). The breadcrumb
          row above was intentionally removed — it duplicated the H1
          and pushed the page CTA below the fold on smaller screens. */}
      <header style={headerRowStyle}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={titleStyle}>External Intake Links</h1>
          <p style={subtitleStyle}>
            Create secure links so people outside your workspace can
            upload photos, videos, audio, or documents.
          </p>
        </div>
        {currentTeam ? (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => openCreate()}
            disabled={!currentTeam}
            data-intake-links-new-cta="true"
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

      {/* Operations Console — the primary surface when links exist.
          Replaces the legacy stacked-card layout with a searchable +
          filterable + paginated table. KPI strip / status tabs /
          row actions / details drawer all live inside the console
          component. The page passes the rich items array, the
          modal handlers, and the URL search params so reload/share
          round-trips through the address bar. */}
      {currentTeam && items !== null && items.length > 0 ? (
        <section data-intake-links-list-section="true">
          <h2 style={sectionHeaderStyle}>Your intake links</h2>
          <IntakeLinksOperationsConsole
            items={items as ConsoleItem[]}
            onMutated={() => {
              if (currentTeam) void refreshLinks(currentTeam.id);
            }}
            onRevoke={(linkId) => revokeLink(linkId)}
            onOpenDelivery={(linkId) => setDeliveryDrawerLinkId(linkId)}
            onOpenSubmissions={(linkId) => setSubmissionsLinkId(linkId)}
            initialQuery={searchParams ? new URLSearchParams(searchParams.toString()) : undefined}
            writeQuery={writeQueryToUrl}
          />
        </section>
      ) : null}

      {/* Empty state — renders ONLY when the workspace has zero
          links. Two CTAs + three concrete examples so a first-time
          user knows exactly what this page is for. */}
      {currentTeam && items !== null && items.length === 0 ? (
        <EmptyState
          onCreate={() => openCreate()}
          onPickRequestType={(slug) => openCreate(slug)}
        />
      ) : null}

      {/* How it works strip — onboarding only. Hidden entirely
          when links exist so the operator's working surface stays
          uncluttered. */}
      {currentTeam && (items?.length ?? 0) === 0 ? (
        <HowItWorksStrip secondary={false} />
      ) : null}

      {/* Common requests tiles — ONBOARDING only. Hidden entirely
          when ≥1 link exists; templates remain accessible via the
          New intake link modal's request-type catalog. */}
      {currentTeam && (items?.length ?? 0) === 0 ? (
        <CommonRequestsSection
          onPick={(slug) => openCreate(slug)}
          collapsed={false}
        />
      ) : null}

      {/* Intake-links-e2e redesign — safety note. Tells the user
          what does NOT happen (contributors don't get workspace
          access). Compact, not a hero card. */}
      {currentTeam ? (
        <p style={safetyNoteStyle} data-intake-links-safety-note="true">
          Contributors can submit files without accessing your
          workspace. You control delivery, expiration, file types, and
          revocation.
        </p>
      ) : null}

      {createOpen && currentTeam ? (
        <CreateLinkModal
          team={currentTeam}
          templates={eligibleTemplates}
          initialSlug={createOpen.initialSlug}
          onClose={() => setCreateOpen(null)}
          onCreated={(created) => {
            setCreateOpen(null);
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

// IntakeLinkCard and its card-only helpers (LIFECYCLE_LABELS,
// LIFECYCLE_CHIP_STYLES, lifecycleChipBaseStyle, deliveryMethodChipStyle,
// describeDeliverySummary, describeActivitySummary) were removed when
// the stacked-card list was replaced by IntakeLinksOperationsConsole.
// The console owns its own lifecycle chip styling and summary copy;
// `describeRelativeTime` below survives because SubmissionsDrawer
// still uses it.

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
// SenderIdentitySelector — sender identity radio + custom-name input.
// The "via PROOVRA" suffix is appended by the shared resolver, so the
// PROOVRA wordmark is always visible regardless of the choice. The
// operator cannot remove it.
// -----------------------------------------------------------------------------

function SenderIdentitySelector({
  mode,
  name,
  nameError,
  workspaceName,
  onModeChange,
  onNameChange,
}: {
  mode: SenderDisplayMode;
  name: string;
  nameError: string | null;
  workspaceName: string;
  onModeChange: (m: SenderDisplayMode) => void;
  onNameChange: (n: string) => void;
}) {
  // Card-style radio options. Each option is a stacked card with
  // a clean title + muted description — no long explanatory text
  // inside the clickable label, no "for example …" inline. The
  // Custom name text input lives BELOW the cards when CUSTOM is
  // selected so it doesn't fight the radio for visual weight.
  type Option = {
    value: SenderDisplayMode;
    title: string;
    description: string;
  };
  const options: Option[] = [
    {
      value: "PROOVRA",
      title: "PROOVRA",
      description: "Generic sender name. Best for neutral requests.",
    },
    ...(workspaceName
      ? [
          {
            value: "WORKSPACE" as SenderDisplayMode,
            title: "Workspace name",
            description:
              "Uses the current workspace name with PROOVRA.",
          },
        ]
      : []),
    {
      value: "CUSTOM",
      title: "Custom name",
      description: "Show a company, case, or sender name.",
    },
  ];
  return (
    <fieldset
      style={senderFieldsetStyle}
      data-intake-link-sender-selector="true"
    >
      <legend style={labelStyle}>Request appears from</legend>
      <div style={senderCardListStyle}>
        {options.map((opt) => {
          const selected = mode === opt.value;
          return (
            <label
              key={opt.value}
              style={{
                ...senderCardStyle,
                ...(selected ? senderCardSelectedStyle : {}),
              }}
              data-intake-link-sender-card={opt.value}
              data-intake-link-sender-card-selected={
                selected ? "true" : "false"
              }
            >
              <input
                type="radio"
                name="sender-display-mode"
                value={opt.value}
                checked={selected}
                onChange={() => onModeChange(opt.value)}
                data-intake-link-sender-mode-radio={opt.value}
                style={senderCardRadioStyle}
              />
              <span style={senderCardTextStyle}>
                <span style={senderCardTitleStyle}>{opt.title}</span>
                <span style={senderCardDescStyle}>{opt.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      {mode === "CUSTOM" ? (
        <div style={{ marginTop: 12 }}>
          <label style={labelStyle} htmlFor="intake-link-display-name">
            Display name
          </label>
          <input
            id="intake-link-display-name"
            type="text"
            maxLength={80}
            placeholder="Smith & Partners"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            aria-invalid={Boolean(nameError)}
            data-intake-link-sender-custom-name="true"
            style={{
              ...inputStyle,
              borderColor: nameError
                ? "#dc2626"
                : (inputStyle.border as string),
              marginBottom: 4,
            }}
          />
          <p style={{ ...mutedStyle, marginTop: 0 }}>
            This name appears in the request message before &ldquo;via
            PROOVRA&rdquo;.
          </p>
          {nameError ? (
            <p
              style={{
                ...mutedStyle,
                color: "#b91c1c",
                marginTop: 4,
              }}
              data-intake-link-sender-name-error="true"
            >
              {nameError}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

// Operator-facing card-radio for the per-link location-collection
// policy. Mirrors the SenderIdentitySelector card-radio pattern so
// the modal stays visually coherent. The shared
// INTAKE_LINK_LOCATION_POLICY_OPTIONS list is the source of truth
// for label/description copy, so any future tweak to the wording
// happens in @proovra/shared and lights up everywhere at once.
function LocationPolicySelector({
  policy,
  onChange,
}: {
  policy: IntakeLinkLocationPolicy;
  onChange: (p: IntakeLinkLocationPolicy) => void;
}) {
  return (
    <fieldset
      style={senderFieldsetStyle}
      data-intake-link-location-policy-selector="true"
    >
      <legend style={labelStyle}>Location collection</legend>
      <div style={senderCardListStyle}>
        {INTAKE_LINK_LOCATION_POLICY_OPTIONS.map((opt) => {
          const selected = policy === opt.value;
          return (
            <label
              key={opt.value}
              style={{
                ...senderCardStyle,
                ...(selected ? senderCardSelectedStyle : {}),
              }}
              data-intake-link-location-card={opt.value}
              data-intake-link-location-card-selected={
                selected ? "true" : "false"
              }
            >
              <input
                type="radio"
                name="intake-link-location-policy"
                value={opt.value}
                checked={selected}
                onChange={() => onChange(opt.value)}
                data-intake-link-location-radio={opt.value}
                style={senderCardRadioStyle}
              />
              <span style={senderCardTextStyle}>
                <span style={senderCardTitleStyle}>
                  {opt.title}
                  {opt.value === "OPTIONAL" ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#4f46e5",
                        marginLeft: 6,
                        fontWeight: 500,
                      }}
                    >
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span style={senderCardDescStyle}>{opt.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p style={{ ...mutedStyle, marginTop: 8 }}>
        Location is collected by the contributor&apos;s browser only after
        they tap Share. Coordinates are stored on the submitted evidence
        and labelled as &ldquo;Contributor browser location&rdquo;.
      </p>
    </fieldset>
  );
}

// Translates the `validateCustomSenderDisplayName` reason codes into
// plain English shown under the input.
function senderNameReasonCopy(reason: string): string {
  switch (reason) {
    case "empty":
      return "Enter a display name.";
    case "too_long":
      return "Keep the name under 80 characters.";
    case "contains_url":
      return "Display names can't contain URLs.";
    case "contains_email":
      return "Display names can't contain email addresses.";
    case "contains_phone":
      return "Display names can't contain phone numbers.";
    case "contains_control_chars":
      return "Display names can't contain invisible or directional characters.";
    case "impersonation":
      return "Display names can't impersonate courts, police, government, or banks.";
    case "reserved_brand":
      return "PROOVRA is reserved — pick a different name (it's added automatically).";
    default:
      return "That display name isn't allowed.";
  }
}

// -----------------------------------------------------------------------------
// MessagePreviewStudio — shows exactly what the recipient will see.
// Imports the SAME shared renderer the API uses, so the preview is
// bit-for-bit accurate aside from the [secure-link] placeholder.
// -----------------------------------------------------------------------------

function MessagePreviewStudio({
  channel,
  senderMode,
  senderName,
  workspaceName,
  requestTypeSlug,
  recipientLabel,
  expiresInHours,
  senderTransport,
}: {
  channel: "EMAIL" | "SMS" | "WHATSAPP";
  senderMode: SenderDisplayMode;
  senderName: string;
  workspaceName: string;
  requestTypeSlug: string;
  recipientLabel: string;
  expiresInHours: number;
  senderTransport: SenderTransportInfo | null;
}) {
  // Resolve sender display via the SAME shared function. If the
  // current mode is CUSTOM with an invalid name, fall back gracefully
  // so the preview never crashes — the submit gate already prevents
  // the actual send when the name is invalid.
  const senderIdentity = (() => {
    try {
      return resolveIntakeSenderDisplay({
        mode: senderMode,
        workspaceName,
        customName: senderName || "Your business",
      });
    } catch {
      return resolveIntakeSenderDisplay({
        mode: "PROOVRA",
      });
    }
  })();

  const expiresAtUtc = new Date(
    Date.now() + Math.max(1, expiresInHours) * 3600 * 1000,
  ).toISOString();
  const renderInput = {
    senderDisplay: senderIdentity.display,
    requestTypeSlug,
    recipientLabel: recipientLabel || null,
    intakeUrl: PLACEHOLDER_INTAKE_URL,
    expiresAtUtc,
    channel,
    locale: "en" as const,
  };

  let bodyText = "";
  let bodySubject: string | null = null;
  if (channel === "EMAIL") {
    const r = renderIntakeEmailMessage(renderInput);
    bodySubject = r.subject;
    bodyText = r.text;
  } else if (channel === "SMS") {
    bodyText = renderIntakeSmsMessage(renderInput);
  } else {
    // WhatsApp — preview the "plain" body the API ships by default.
    // Rich body is gated behind WHATSAPP_INTAKE_TEMPLATE_MODE on the
    // server; we don't surface that toggle in the modal yet.
    bodyText = renderIntakeWhatsappMessage(renderInput);
  }

  const transport = senderTransport
    ? channel === "EMAIL"
      ? senderTransport.email
      : channel === "SMS"
        ? senderTransport.sms
        : senderTransport.whatsapp
    : null;

  const transportLabel = (() => {
    if (!transport) return "Loading…";
    if (!transport.configured) return "Not configured";
    if (channel === "EMAIL") {
      return `${transport.fromName ?? "PROOVRA"} <${transport.fromAddressPreview ?? "no-reply@proovra.com"}>`;
    }
    if (channel === "SMS") {
      return transport.fromNumberPreview
        ? `PROOVRA via ${transport.fromNumberPreview}`
        : "PROOVRA";
    }
    return transport.fromNumberPreview
      ? `PROOVRA WhatsApp via ${transport.fromNumberPreview}`
      : "PROOVRA WhatsApp";
  })();

  return (
    <section
      style={previewStudioStyle}
      data-intake-link-preview-studio="true"
      data-intake-link-preview-channel={channel}
      aria-label="Message preview"
    >
      <h3 style={previewHeadingStyle}>Message preview</h3>
      <div style={previewMetaRowStyle}>
        <div>
          <div style={previewMetaLabelStyle}>Appears from</div>
          <div
            style={previewMetaValueStyle}
            data-intake-link-preview-sender-display="true"
          >
            {senderIdentity.display}
          </div>
        </div>
        <div>
          <div style={previewMetaLabelStyle}>Sent via</div>
          <div
            style={previewMetaValueStyle}
            data-intake-link-preview-transport="true"
            data-intake-link-preview-transport-configured={
              transport?.configured ? "true" : "false"
            }
          >
            {transportLabel}
          </div>
        </div>
      </div>
      {channel === "EMAIL" && bodySubject ? (
        <div style={previewSubjectStyle}>
          <span style={previewMetaLabelStyle}>Subject</span>
          <div
            style={previewMetaValueStyle}
            data-intake-link-preview-subject="true"
          >
            {bodySubject}
          </div>
        </div>
      ) : null}
      <pre
        style={previewBodyStyle}
        data-intake-link-preview-body="true"
      >
        {bodyText}
      </pre>
      <p style={previewNoteStyle}>
        Preview only. The secure link is generated when you create the
        intake link.
      </p>
    </section>
  );
}

// -----------------------------------------------------------------------------
// HowItWorksStrip — compact 3-card explainer that replaces the old
// oversized guidance card. When `secondary` is true (i.e. the workspace
// already has links) it renders smaller and de-emphasised so it
// doesn't push the operational list down.
// -----------------------------------------------------------------------------

const HOW_IT_WORKS_CARDS: Array<{
  title: string;
  text: string;
  testId: string;
}> = [
  {
    title: "Create",
    text: "Choose a request type, allowed file types, and expiration.",
    testId: "create",
  },
  {
    title: "Share",
    text: "Send by email, SMS, WhatsApp, or copy the secure link manually.",
    testId: "share",
  },
  {
    title: "Track",
    text: "See delivery, openings, submissions, expiration, and revocation.",
    testId: "track",
  },
];

function HowItWorksStrip({ secondary }: { secondary: boolean }) {
  return (
    <section
      style={secondary ? howItWorksStripSecondaryStyle : howItWorksStripStyle}
      data-intake-links-howitworks="true"
      data-intake-links-howitworks-secondary={secondary ? "true" : "false"}
      aria-label="How intake links work"
    >
      <h2 style={secondary ? sectionHeaderSecondaryStyle : sectionHeaderStyle}>
        How it works
      </h2>
      <ol style={howItWorksGridStyle}>
        {HOW_IT_WORKS_CARDS.map((c, i) => (
          <li
            key={c.testId}
            style={
              secondary ? howItWorksCardSecondaryStyle : howItWorksCardStyle
            }
            data-intake-links-howitworks-card={c.testId}
          >
            <div style={howItWorksStepStyle} aria-hidden>
              {i + 1}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={howItWorksTitleStyle}>{c.title}</div>
              <div style={howItWorksTextStyle}>{c.text}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// -----------------------------------------------------------------------------
// CommonRequestsSection — quick-start tiles. Every tile preselects its
// slug in the create modal via the `onPick` callback. No fake actions:
// the catalog mirrors the seed registry so the backend always resolves
// the slug to a real template.
// -----------------------------------------------------------------------------

const COMMON_REQUEST_TILES: Array<{
  slug: string;
  title: string;
  text: string;
}> = [
  {
    slug: "general-evidence-record",
    title: "General evidence request",
    text: "Catch-all for photos, documents, or a quick description.",
  },
  {
    slug: "photos-videos",
    title: "Photos & videos",
    text: "Request visual proof from a client, witness, or field contributor.",
  },
  {
    slug: "documents",
    title: "Documents",
    text: "Ask for PDFs, scans, or clear photos of paperwork.",
  },
  {
    slug: "insurance-claim",
    title: "Insurance claim evidence",
    text: "Damage photos, repair quotes, receipts, and supporting paperwork.",
  },
  {
    slug: "legal-matter",
    title: "Legal document collection",
    text: "Contracts, signed forms, sworn statements, and case documents.",
  },
  {
    slug: "property-damage",
    title: "Property damage",
    text: "Scene overview, close-up damage shots, repair estimates.",
  },
];

function CommonRequestsSection({
  onPick,
  collapsed,
}: {
  onPick: (slug: string) => void;
  collapsed: boolean;
}) {
  // When the workspace has links, the user is here to manage them.
  // Render the section but tighten the layout (denser grid, smaller
  // descriptions) so it doesn't compete with the operational list.
  return (
    <section
      style={collapsed ? commonRequestsSecondaryStyle : commonRequestsStyle}
      data-intake-links-common-requests="true"
      data-intake-links-common-requests-collapsed={collapsed ? "true" : "false"}
      aria-label="Common requests"
    >
      <h2 style={collapsed ? sectionHeaderSecondaryStyle : sectionHeaderStyle}>
        Common requests
      </h2>
      <ul style={tileGridStyle}>
        {COMMON_REQUEST_TILES.map((t) => (
          <li
            key={t.slug}
            style={tileStyle}
            data-intake-links-common-tile={t.slug}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={tileTitleStyle}>{t.title}</div>
              <div style={tileTextStyle}>{t.text}</div>
            </div>
            <button
              type="button"
              style={tileStartButtonStyle}
              onClick={() => onPick(t.slug)}
              data-intake-links-common-tile-start={t.slug}
              aria-label={`Start a new ${t.title} intake link`}
            >
              Start
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// -----------------------------------------------------------------------------
// EmptyState — replaces the previous generic "Create a secure intake
// link…" infoBox. Title + one-line copy + two real actions + three
// concrete examples so a first-time user knows what this page is for.
// -----------------------------------------------------------------------------

const EMPTY_STATE_EXAMPLES = [
  "Ask a client for accident photos",
  "Collect signed documents",
  "Request property damage evidence",
];

function EmptyState({
  onCreate,
  onPickRequestType,
}: {
  onCreate: () => void;
  onPickRequestType: (slug: string) => void;
}) {
  return (
    <section
      style={emptyStateStyle}
      data-intake-links-empty="true"
      aria-label="No intake links yet"
    >
      <h2 style={emptyStateTitleStyle}>No intake links yet</h2>
      <p style={emptyStateBodyStyle}>
        Create your first secure upload link to request evidence from
        someone outside your workspace. Use intake links when you need
        evidence from a client, witness, contractor, or external
        contributor.
      </p>
      <div style={emptyStateActionsStyle}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={onCreate}
          data-intake-links-empty-create="true"
        >
          New intake link
        </button>
        <a
          href="#intake-links-howitworks"
          style={secondaryButtonStyle}
          onClick={(e) => {
            // Smooth scroll to the How-it-works strip; the link
            // remains a real anchor so keyboard users without JS
            // still get the right destination.
            const target = document.querySelector(
              '[data-intake-links-howitworks="true"]',
            );
            if (target) {
              e.preventDefault();
              target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }}
          data-intake-links-empty-learn="true"
        >
          Learn how intake links work
        </a>
      </div>
      <div style={emptyStateExamplesStyle}>
        <div style={emptyStateExamplesLabelStyle}>For example:</div>
        <ul style={emptyStateExamplesListStyle}>
          {EMPTY_STATE_EXAMPLES.map((ex, i) => (
            <li
              key={i}
              style={emptyStateExampleItemStyle}
              data-intake-links-empty-example={i}
            >
              {ex}
            </li>
          ))}
        </ul>
        <p style={emptyStateExamplesHelpStyle}>
          Or pick a quick-start template below.
        </p>
      </div>
      {/* Surface the catalog inline so the user can act without
          scrolling. Calls the same onPickRequestType wiring as the
          standalone CommonRequestsSection. */}
      <ul style={tileGridStyle}>
        {COMMON_REQUEST_TILES.slice(0, 3).map((t) => (
          <li
            key={t.slug}
            style={tileStyle}
            data-intake-links-empty-tile={t.slug}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={tileTitleStyle}>{t.title}</div>
              <div style={tileTextStyle}>{t.text}</div>
            </div>
            <button
              type="button"
              style={tileStartButtonStyle}
              onClick={() => onPickRequestType(t.slug)}
              data-intake-links-empty-tile-start={t.slug}
              aria-label={`Start a new ${t.title} intake link`}
            >
              Start
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
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
  initialSlug,
  onClose,
  onCreated,
}: {
  team: { id: string; name: string };
  templates: WorkflowTemplateRow[];
  /** Common-requests tile preselects a slug; defaults to the first
   *  catalog entry when unset (top-right "New intake link" button). */
  initialSlug?: string;
  onClose: () => void;
  onCreated: (result: CreatedResult) => void;
}) {
  // Intake-links-e2e redesign — resolve the initial slug from the
  // optional `initialSlug` prop (clicked tile) before falling back to
  // the generic catalog entry. Validates the prop against the catalog
  // so a bad value never lands the modal on an unknown template.
  const defaultSlug = (() => {
    if (initialSlug && REQUEST_TYPES.some((r) => r.slug === initialSlug)) {
      return initialSlug;
    }
    return REQUEST_TYPES[0].slug;
  })();
  const defaultKinds = (
    REQUEST_TYPES.find((r) => r.slug === defaultSlug) ?? REQUEST_TYPES[0]
  ).recommendedKinds;
  const [slug, setSlug] = useState<string>(defaultSlug);
  const [intakeMode, setIntakeMode] = useState("EXTERNAL_ONE_TIME");
  // Default delivery method = SMS so the operator opens the modal
  // pointed at a real send channel (the most common case) instead of
  // the manual copy/paste fallback. Config-aware fallback runs in the
  // useEffect below once the sender-identity transport info loads:
  // if SMS isn't configured for this deployment we step down through
  // Email → WhatsApp (only when template-ready) → Manual.
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>("SMS");
  // Track whether the user manually changed the delivery method. If
  // they did, the config-aware fallback below stops overriding their
  // choice — we never want to clobber an explicit operator click.
  const [deliveryMethodTouched, setDeliveryMethodTouched] = useState(false);
  const [recipientLabel, setRecipientLabel] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [maxFileCount, setMaxFileCount] = useState<number | "">(10);
  // Default the accepted-kinds set from the chosen catalog entry's
  // recommendation, then let the user tweak.
  const [allowedKinds, setAllowedKinds] = useState<Set<string>>(
    new Set(defaultKinds),
  );
  const [consentText, setConsentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Intake-link enterprise messaging — sender identity selector
  // state. Defaults to WORKSPACE when the workspace has a name
  // (otherwise PROOVRA), mirroring `defaultIntakeSenderMode` in
  // @proovra/shared. The "via PROOVRA" suffix is always added by the
  // shared renderer; the operator cannot remove it.
  const [senderDisplayMode, setSenderDisplayMode] =
    useState<SenderDisplayMode>(team.name ? "WORKSPACE" : "PROOVRA");
  const [senderDisplayName, setSenderDisplayName] = useState<string>("");
  const [senderNameError, setSenderNameError] = useState<string | null>(null);

  // Intake-link location collection — operator-chosen policy for the
  // contributor page. New links default to OPTIONAL ("ask but don't
  // block"); the backend default for existing rows is NONE so legacy
  // links stay quiet. The shared enum is the source of truth.
  const [locationPolicy, setLocationPolicy] =
    useState<IntakeLinkLocationPolicy>("OPTIONAL");

  // Sender-identity (transport) — populated by the
  // /v1/workflow/intake-links/sender-identity fetch. Used by the
  // preview studio to show "Email goes via PROOVRA <no-reply@…>"
  // etc. without leaking provider secrets.
  const [senderTransport, setSenderTransport] =
    useState<SenderTransportInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch(
      `/v1/workflow/intake-links/sender-identity?teamId=${encodeURIComponent(team.id)}`,
      { method: "GET" },
    )
      .then((res: SenderTransportInfo) => {
        if (!cancelled) setSenderTransport(res);
      })
      .catch(() => {
        if (!cancelled) setSenderTransport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  // Config-aware delivery-method fallback. Default is SMS (set in
  // the useState above) so the modal opens pointed at a real
  // channel. Once the /sender-identity endpoint resolves with the
  // workspace's actual transport configuration, we step the default
  // down through the priority chain if SMS isn't usable:
  //   1. SMS         (default)
  //   2. Email       (when SMS not configured)
  //   3. WhatsApp    (only when configured AND template-ready)
  //   4. Manual      (last resort — no provider available)
  // WhatsApp is intentionally NOT promoted above Email by default
  // because it requires an approved Twilio Content Template; an
  // unconfigured WhatsApp would 503 on send.
  useEffect(() => {
    if (deliveryMethodTouched) return;
    if (!senderTransport) return;
    const smsOk = senderTransport.sms.configured;
    const emailOk = senderTransport.email.configured;
    // WhatsApp readiness pulls the template-configured signal from
    // the sender-identity payload when present; if the API surface
    // doesn't carry it (older deployments) we fall through to
    // `whatsapp.configured` which already gates on the template
    // SID server-side per the strict template fix.
    const waReady = senderTransport.whatsapp.configured;
    const next: DeliveryMethod = smsOk
      ? "SMS"
      : emailOk
        ? "EMAIL"
        : waReady
          ? "WHATSAPP"
          : "MANUAL";
    if (next !== deliveryMethod) setDeliveryMethod(next);
  }, [senderTransport, deliveryMethodTouched, deliveryMethod]);

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

  // Intake-links-e2e mode-compat bugfix — when the operator changes
  // request type, the previously-selected intake mode may no longer be
  // supported by the new template. Auto-correct to the first
  // supported mode so the modal never holds an invalid state, and
  // wipe the create error so a stale message doesn't outlive its
  // cause. The effect re-runs whenever `slug` changes, AND whenever
  // `templates` finishes loading (so the auto-pick still happens
  // even if the user opened the modal before the templates fetch
  // settled).
  useEffect(() => {
    if (!selectedTemplate) return;
    const supported = selectedTemplate.intakeModes;
    if (supported.length === 0) {
      // Template advertises NO intake modes at all. We can't pick
      // one; surface the issue rather than letting the submit fail
      // mid-flight.
      setError(
        "This request type is not configured for external intake. Pick another type.",
      );
      return;
    }
    if (!supported.includes(intakeMode)) {
      // Prefer EXTERNAL_ONE_TIME when available — it's the safest
      // default for SMB / Personal users. Fall back to the first
      // mode the template actually advertises.
      const preferred = supported.includes("EXTERNAL_ONE_TIME")
        ? "EXTERNAL_ONE_TIME"
        : supported[0];
      setIntakeMode(preferred);
    }
    setError(null);
  }, [slug, selectedTemplate, intakeMode]);

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

    // Pre-validate the custom sender name on the client so the user
    // doesn't have to round-trip to the backend for a bad name.
    if (senderDisplayMode === "CUSTOM") {
      const v = validateCustomSenderDisplayName(senderDisplayName);
      if (!v.ok) {
        setSenderNameError(senderNameReasonCopy(v.reason));
        setBusy(false);
        return;
      }
    }
    setSenderNameError(null);

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
        senderDisplayMode,
        senderDisplayName:
          senderDisplayMode === "CUSTOM" ? senderDisplayName.trim() : null,
        locationPolicy,
      };

      const res: CreatedResult = await apiFetch("/v1/workflow/intake-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      onCreated(res);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      setError(friendlyCreateError(e?.code, e?.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={modalBackdropStyle} role="dialog" aria-modal>
      {/* Scoped focus-ring + hover styling for our custom selects.
          CSS-in-JS can't express :focus-visible / :hover, so we inject
          a tiny scoped sheet here. The class is keyed by data-intake-
          link-modal-select on every select inside this modal. */}
      <style>{`
        select[data-intake-link-modal-select]:focus-visible {
          border-color: #4f46e5;
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
        }
        select[data-intake-link-modal-select]:hover:not(:disabled) {
          border-color: #94a3b8;
        }
        select[data-intake-link-modal-select]:disabled {
          background-color: #f3f4f6;
          color: #6b7280;
          cursor: not-allowed;
        }
      `}</style>
      <div style={modalStyle}>
        <h2 style={sectionTitleStyle}>New intake link</h2>
        {error ? <div style={errorBoxStyle}>{error}</div> : null}

        {/* Intake-links-e2e (Phase 1) — built-in catalog primary,
            workspace templates secondary. The picker is plain
            language; the underlying value remains a template slug
            the backend resolves via loadEffectiveWorkflowTemplate. */}
        <label style={labelStyle}>What are you asking for?</label>
        <select
          style={modalSelectStyle}
          value={slug}
          onChange={(e) => {
            const next = e.target.value;
            setSlug(next);
            const match = REQUEST_TYPES.find((r) => r.slug === next);
            if (match) setAllowedKinds(new Set(match.recommendedKinds));
          }}
          data-intake-link-request-type
          data-intake-link-modal-select
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
          style={modalSelectStyle}
          value={intakeMode}
          onChange={(e) => setIntakeMode(e.target.value)}
          data-intake-link-modal-select
        >
          {eligibleModes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {INTAKE_MODE_HELPER_TEXT[intakeMode] ? (
          <p
            style={{ ...mutedStyle, marginTop: -8, marginBottom: 12 }}
            data-intake-link-intake-mode-helper
          >
            {INTAKE_MODE_HELPER_TEXT[intakeMode]}
          </p>
        ) : null}

        {/* Intake-links-e2e (Phase 2) — explicit delivery method
            picker. The conditional recipient field below it changes
            based on this choice; the backend Zod schema enforces the
            same dependency. */}
        <label style={labelStyle}>How should the link be delivered?</label>
        <select
          style={modalSelectStyle}
          value={deliveryMethod}
          data-intake-link-modal-select
          onChange={(e) => {
            const next = e.target.value as DeliveryMethod;
            // Mark touched so the config-aware default useEffect
            // stops overriding the operator's explicit choice.
            setDeliveryMethodTouched(true);
            // P0 audit-fix — if the user somehow picks an unconfigured
            // channel (e.g. via keyboard), force them onto MANUAL so
            // they never end up with a link that "sent" but never
            // arrives. The transport info comes from the same backend
            // /sender-identity endpoint that gates the options below.
            if (next === "WHATSAPP" && senderTransport && !senderTransport.whatsapp.configured) {
              setDeliveryMethod("MANUAL");
              return;
            }
            if (next === "EMAIL" && senderTransport && !senderTransport.email.configured) {
              setDeliveryMethod("MANUAL");
              return;
            }
            if (next === "SMS" && senderTransport && !senderTransport.sms.configured) {
              setDeliveryMethod("MANUAL");
              return;
            }
            setDeliveryMethod(next);
          }}
          data-intake-link-delivery-method
        >
          {DELIVERY_METHODS.map((d) => {
            // Disable the option when the matching provider is not
            // configured. Suffix the label with the reason so the
            // user can see WHY it's greyed out without hunting for
            // a separate explanation.
            const disabled =
              !!senderTransport &&
              ((d.value === "WHATSAPP" && !senderTransport.whatsapp.configured) ||
                (d.value === "EMAIL" && !senderTransport.email.configured) ||
                (d.value === "SMS" && !senderTransport.sms.configured));
            return (
              <option
                key={d.value}
                value={d.value}
                disabled={disabled}
                data-intake-link-delivery-method-option={d.value}
                data-intake-link-delivery-method-disabled={
                  disabled ? "true" : "false"
                }
              >
                {disabled ? `${d.label} — not configured` : d.label}
              </option>
            );
          })}
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

        {/* Intake-link enterprise messaging — sender identity
            selector. "via PROOVRA" is appended automatically by the
            shared resolver; the brand cannot be removed. */}
        <SenderIdentitySelector
          mode={senderDisplayMode}
          name={senderDisplayName}
          nameError={senderNameError}
          workspaceName={team.name}
          onModeChange={(m) => {
            setSenderDisplayMode(m);
            setSenderNameError(null);
          }}
          onNameChange={(n) => {
            setSenderDisplayName(n);
            setSenderNameError(null);
          }}
        />

        <LocationPolicySelector
          policy={locationPolicy}
          onChange={setLocationPolicy}
        />

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

        {/* Intake-link enterprise messaging — Message Preview Studio.
            Hidden for MANUAL (no message is sent). Imports the SAME
            shared renderer the API uses, so the preview equals what
            the recipient will receive. The token is replaced by a
            visible `[secure-link]` placeholder; the real URL is only
            composed on the server at create time. */}
        {deliveryMethod !== "MANUAL" ? (
          <MessagePreviewStudio
            channel={deliveryMethod}
            senderMode={senderDisplayMode}
            senderName={senderDisplayName}
            workspaceName={team.name}
            requestTypeSlug={slug}
            recipientLabel={recipientLabel}
            expiresInHours={expiresInHours}
            senderTransport={senderTransport}
          />
        ) : (
          <div
            style={previewManualNoteStyle}
            data-intake-link-preview-manual="true"
          >
            Manual delivery — no message will be sent. You'll receive
            a one-time link to copy and share however you want.
          </div>
        )}

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
            {/* P0 audit-fix — hide the SMS/WhatsApp send buttons
                when no recipient phone is on the link. Pre-fix we
                rendered them in a disabled state, which looked like
                a bug rather than an intentional gate. Copy link is
                the only action that makes sense in that case. */}
            {canSend ? (
              <>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => send("SMS")}
                  disabled={sendBusy !== null}
                  data-intake-link-send="SMS"
                >
                  {sendBusy === "SMS" ? "Sending…" : "Send by SMS"}
                </button>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => send("WHATSAPP")}
                  disabled={sendBusy !== null}
                  data-intake-link-send="WHATSAPP"
                >
                  {sendBusy === "WHATSAPP" ? "Sending…" : "Send by WhatsApp"}
                </button>
              </>
            ) : null}
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
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Intake-links-e2e mode-compat bugfix — map backend CREATE reason
// codes to plain English so a normal user never sees a raw enum like
// `intake_mode_not_supported_by_template`. Unknown codes fall back to
// the server-provided message; final fallback is a generic "could not
// create" so the modal is never silent.
function friendlyCreateError(
  code: string | undefined,
  message: string | undefined,
): string {
  const map: Record<string, string> = {
    FEATURE_DISABLED:
      "External intake is not enabled on this deployment.",
    intake_mode_not_supported_by_template:
      "This request type does not support the selected intake mode. Please choose another mode.",
    template_not_found:
      "That request type isn't available for this workspace.",
    max_uses_invalid:
      "Pick a usage limit between 1 and 10,000.",
    feature_disabled:
      "External intake is not enabled on this deployment.",
    rate_limited:
      "Too many intake links — wait a minute and try again.",
  };
  if (code && map[code]) return map[code];
  // Backend error envelope sometimes nests reason under `message` — if
  // it's a known reason string, friendly-map that too.
  if (message && map[message]) return map[message];
  return message ?? "Could not create intake link.";
}

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
    whatsapp_template_unconfigured:
      "WhatsApp template not configured — set TWILIO_WHATSAPP_INTAKE_TEMPLATE_SID first",
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
// dangerButtonStyle removed — it was used only by the legacy
// IntakeLinkCard's Revoke button. The Operations Console owns its
// own destructive-action styling now.
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
// modalSelectStyle — used by every <select> inside CreateLinkModal.
// Native browser-default selects looked out of place next to the
// app's text inputs and buttons (different height, different border
// radius, ugly OS-native chevron). This style sheet:
//   • removes the OS-native appearance
//   • paints a custom chevron via background-image SVG
//   • matches the modal's <input> height + radius + border colour
//   • adds a clean keyboard-only focus ring (no blue OS outline)
const SELECT_CHEVRON_SVG =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 20 20'><path fill='%2364748b' d='M5.5 7.5l4.5 5 4.5-5z'/></svg>";
const modalSelectStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  // Right padding doubled to leave room for the chevron art.
  padding: "10px 36px 10px 14px",
  border: "1px solid #d7dee8",
  borderRadius: 10,
  marginBottom: 12,
  fontSize: 14,
  fontWeight: 500,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
  boxSizing: "border-box",
  // Kill OS-native chevron; supply our own.
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  backgroundImage: `url("${SELECT_CHEVRON_SVG}")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 12px center",
  backgroundSize: "12px 12px",
  // Clean keyboard focus ring (Tailwind-style indigo).
  outline: "none",
  cursor: "pointer",
  lineHeight: 1.4,
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
// Intake-links-e2e redesign — operational header row. Flex with
// `flexWrap: "wrap"` so the primary CTA drops below the title on
// narrow viewports instead of overflowing horizontally.
const headerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap",
  marginBottom: 4,
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: "#475569",
  margin: 0,
  maxWidth: 640,
};
const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#0f172a",
  margin: "32px 0 12px",
  letterSpacing: -0.1,
};
const sectionHeaderSecondaryStyle: React.CSSProperties = {
  ...sectionHeaderStyle,
  fontSize: 13,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#64748b",
  margin: "32px 0 10px",
};

// How-it-works strip — 3 compact cards in a grid.
const howItWorksStripStyle: React.CSSProperties = {
  marginTop: 8,
};
const howItWorksStripSecondaryStyle: React.CSSProperties = {
  marginTop: 16,
};
const howItWorksGridStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 12,
};
const howItWorksCardStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "14px 16px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
};
const howItWorksCardSecondaryStyle: React.CSSProperties = {
  ...howItWorksCardStyle,
  padding: "10px 12px",
  background: "#f8fafc",
  boxShadow: "none",
};
const howItWorksStepStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 24,
  height: 24,
  borderRadius: 999,
  background: "#0f172a",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1,
};
const howItWorksTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#0f172a",
  marginBottom: 2,
};
const howItWorksTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: "#475569",
};

// Common requests tiles.
const commonRequestsStyle: React.CSSProperties = {
  marginTop: 8,
};
const commonRequestsSecondaryStyle: React.CSSProperties = {
  marginTop: 16,
};
const tileGridStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 12,
};
const tileStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 16px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
};
const tileTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#0f172a",
  marginBottom: 2,
};
const tileTextStyle: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.4,
  color: "#475569",
};
const tileStartButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
};

// Empty state.
const emptyStateStyle: React.CSSProperties = {
  marginTop: 24,
  padding: "32px 32px 28px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
};
const emptyStateTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "#0f172a",
  margin: "0 0 8px",
};
const emptyStateBodyStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: "#475569",
  margin: "0 0 16px",
  maxWidth: 640,
};
const emptyStateActionsStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginBottom: 24,
};
const emptyStateExamplesStyle: React.CSSProperties = {
  marginBottom: 16,
};
const emptyStateExamplesLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "#64748b",
  marginBottom: 6,
};
const emptyStateExamplesListStyle: React.CSSProperties = {
  listStyle: "disc",
  paddingLeft: 20,
  margin: 0,
};
const emptyStateExampleItemStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: "#334155",
};
const emptyStateExamplesHelpStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
  margin: "12px 0 16px",
};

// Sender identity selector
const senderFieldsetStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "14px 16px 12px",
  margin: "4px 0 16px",
  background: "#fafbfc",
};
// Card-style radio tokens. Each option is a stacked card with a
// 12px radius, subtle border, white background, and a clean
// "selected" state (indigo border + soft shadow). The radio sits
// at the top-left so the title/description text doesn't wrap
// awkwardly beside it.
const senderCardListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  marginTop: 4,
};
const senderCardStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 14px",
  border: "1px solid #d7dee8",
  borderRadius: 12,
  background: "#ffffff",
  cursor: "pointer",
  transition: "border-color 120ms ease, box-shadow 120ms ease",
};
const senderCardSelectedStyle: React.CSSProperties = {
  borderColor: "#4f46e5",
  boxShadow: "0 0 0 2px rgba(99, 102, 241, 0.16)",
};
const senderCardRadioStyle: React.CSSProperties = {
  marginTop: 3,
  flexShrink: 0,
  cursor: "pointer",
};
const senderCardTextStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};
const senderCardTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#0f172a",
  lineHeight: 1.3,
};
const senderCardDescStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
  lineHeight: 1.4,
};

// Message Preview Studio
const previewStudioStyle: React.CSSProperties = {
  marginTop: 16,
  padding: "14px 16px",
  background: "#f8fafc",
  border: "1px solid #cbd5e1",
  borderRadius: 10,
};
const previewHeadingStyle: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  color: "#475569",
};
const previewMetaRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  marginBottom: 10,
};
const previewMetaLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#64748b",
};
const previewMetaValueStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
  wordBreak: "break-word",
};
const previewSubjectStyle: React.CSSProperties = {
  marginBottom: 10,
};
const previewBodyStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: "#0f172a",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "10px 12px",
  margin: 0,
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  maxHeight: 220,
  overflowY: "auto",
};
const previewNoteStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "#64748b",
};
const previewManualNoteStyle: React.CSSProperties = {
  marginTop: 16,
  padding: "10px 14px",
  background: "#f1f5f9",
  border: "1px dashed #cbd5e1",
  borderRadius: 8,
  fontSize: 13,
  color: "#475569",
  lineHeight: 1.5,
};

// Safety note — small, unobtrusive line under the operational
// content. Tells the user what does NOT happen.
const safetyNoteStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: "#64748b",
  margin: "24px 0 0",
  padding: "10px 14px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  lineHeight: 1.5,
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
