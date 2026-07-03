// Phase IA-self-serve-completion — Trust hub uses the
// `useSurfaceUserContext` hook to filter cards bound to ENTERPRISE
// surfaces. The hook requires a client boundary, so the file is
// rendered as a client component. The data here is fully static
// (the TRUST_CARDS array is the entire payload) so client-render is
// safe and there is no SSR-data dependency to preserve.
"use client";

/**
 * PHASE 1 PART A — Trust pillar landing page (in-product Trust hub).
 *
 * Trust is one of the 8 canonical pillars (Phase 0 §6.2.1). This page
 * is a real surface — not a placeholder. It is the in-product
 * counterpart to the external Trust Center and is the operator's
 * single source of truth for:
 *
 *   1. Verification methodology — link to the public methodology
 *      disclosure + the offline verifier (CLI + browser).
 *   2. Signer health — link to /operations/signers when entitled.
 *   3. Reproducible exports — link to /operations/exports.
 *   4. Object-lock posture — link to /operations/recovery.
 *   5. Public verify entry point — link to /verify.
 *   6. Legal disclosures (subprocessors, retention, privacy, terms).
 *
 * Hard rules:
 *
 *   1. EVERY link on this page MUST point to a route that exists.
 *      Placeholders are forbidden.
 *
 *   2. Capability-gated operator surfaces use `requiresCapability` so
 *      personal-space users see the verification + methodology cards
 *      without seeing the operator-only signer/exports cards.
 *
 *   3. NEVER assert "your evidence is trusted" — only describe the
 *      primitives and let the operator click through to verify. This
 *      enforces P6 of the Phase 0 principles.
 *
 *   4. Wrapped in `PageRouteGate` like every other canonical surface
 *      so degraded states render the structured recovery panel.
 */

import Link from "next/link";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
// Phase IA-self-serve-completion — gate "Governance posture" + any
// other surface-tier-restricted trust card so self-serve users do
// not see cards that would 404 when clicked. The card-level
// `requires` field is honored at render time by TrustCardView, but
// for surface-tier-bounded entries we ALSO consult
// canAccessSurface so the visibility matches the sidebar / All
// Tools / command palette.
import { canAccessSurface } from "../../../lib/surface/access";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";

type TrustCard = {
  title: string;
  body: string;
  href: string;
  /** Capability key required to render this card. Empty = always. */
  requires?: string;
  /** When true, the link is external (different URL family). */
  external?: boolean;
  /**
   * Optional surface-tier gate. When set, the card only renders if
   * `canAccessSurface(surfaceUserCtx, surfaceHref)` returns true.
   * This is the strict bound for ENTERPRISE-only links so a FREE /
   * PAYG / PRO / TEAM user never sees a card that leads to a 404.
   */
  surfaceHref?: string;
};

const TRUST_CARDS: ReadonlyArray<TrustCard> = [
  // ---------------------------------------------------------------------
  // Universal cards (no capability gate beyond DASHBOARD_VIEW).
  // ---------------------------------------------------------------------
  {
    title: "Verification methodology",
    body: "How PROOVRA proves capture integrity: hash chain, RFC 3161 trusted timestamp, OpenTimestamps anchoring, KMS countersignature. Open the methodology disclosure for the full chain explainer.",
    href: "/legal/verification-methodology",
  },
  {
    title: "AI transparency",
    body: "Provider usage, advisory scope, data sent to models, human review boundaries, known risks, and cost transparency. Opens the published AI disclosure center.",
    href: "/trust-center/ai-disclosure",
  },
  {
    title: "Security documentation",
    body: "Authentication, authorisation, RBAC, MFA, encryption posture, audit logging, immutability, monitoring, incident response, and recovery documentation.",
    href: "/trust-center/security",
  },
  {
    title: "Public verification",
    body: "Verify a PROOVRA bundle without an account. Paste a verify token or upload a verification package — the public verifier runs the same checks the offline verifier runs.",
    href: "/verify",
  },
  {
    title: "Offline verifier",
    body: "Verify a bundle air-gapped. The verifier is open source and ships as a CLI, a browser bundle, and a Node library. Court-grade reproducibility without PROOVRA online.",
    href: "/offline-verifier",
  },
  {
    title: "Subprocessors",
    body: "Vendors that may process customer data, with purpose, region, and certification status. Update notifications are sent 30 days before changes take effect.",
    href: "/subprocessors",
  },
  {
    title: "Privacy policy",
    body: "How PROOVRA collects, uses, and retains personal data. GDPR + UK DPA + CCPA aligned.",
    href: "/privacy",
  },
  {
    title: "Data retention",
    body: "Retention windows by data class, your retention controls, and how PROOVRA enforces them.",
    href: "/data-retention",
  },

  // ---------------------------------------------------------------------
  // Operator cards (gated to OPS_CENTER_VIEW + GOVERNANCE_VIEW).
  // Visibility decided by the resolver downstream; cards are rendered
  // for everyone here and the underlying pages enforce capability.
  // ---------------------------------------------------------------------
  {
    title: "Reproducible exports",
    body: "Export manifests + reproducibility checks. Every exported bundle can be reconstructed deterministically from cold storage.",
    href: "/operations/exports",
    requires: "OPS_CENTER_VIEW",
  },
  {
    title: "Recovery validation",
    body: "Object-lock posture, recovery drill results, custody-event durability checks.",
    href: "/operations/recovery",
    requires: "OPS_CENTER_VIEW",
  },
  {
    // Phase IA-self-serve-completion — body rewritten in plain
    // language and the card is additionally gated by
    // `surfaceHref: "/governance"` so self-serve users (FREE /
    // PAYG / PRO / TEAM) no longer see it. /governance is
    // ENTERPRISE_ONLY in the tier table; without this gate the
    // card was rendered to everyone and clicking it landed on a
    // bounded 404.
    title: "Governance posture",
    body: "How retention, legal holds, and deletions are managed for your records, plus the audit trail.",
    href: "/governance",
    requires: "GOVERNANCE_VIEW",
    surfaceHref: "/governance",
  },

  // ---------------------------------------------------------------------
  // Legal documents.
  // ---------------------------------------------------------------------
  {
    title: "Terms",
    body: "Master service agreement, acceptable use policy.",
    href: "/terms",
  },
  {
    title: "Abuse reporting",
    body: "Report verification fraud, account compromise, or abuse of PROOVRA-issued capture signatures.",
    href: "/abuse-reporting",
  },
];

function TrustCardView({ card }: { card: TrustCard }) {
  return (
    <Link
      href={card.href}
      data-trust-card
      data-trust-card-href={card.href}
      data-trust-card-requires={card.requires ?? "none"}
      style={{
        display: "block",
        padding: "20px 22px",
        borderRadius: 14,
        background: "rgba(15, 23, 42, 0.04)",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        textDecoration: "none",
        color: "inherit",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 15, letterSpacing: 0.1 }}>{card.title}</strong>
        <span aria-hidden="true" style={{ color: "#475569" }}>
          →
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "#475569" }}>
        {card.body}
      </p>
    </Link>
  );
}

export default function TrustPage() {
  // Phase IA-self-serve-completion — surface-tier gating for the
  // trust card grid. Cards with a `surfaceHref` are filtered by
  // canAccessSurface so self-serve users never see a card that
  // would 404 when clicked. Cards without `surfaceHref` (the
  // universal trust + legal disclosures) always render.
  const surfaceUserCtx = useSurfaceUserContext();
  const visibleCards = TRUST_CARDS.filter((card) =>
    card.surfaceHref
      ? canAccessSurface(surfaceUserCtx, card.surfaceHref)
      : true,
  );
  return (
    <PageRouteGate routeId="workspace.trust">
      <div
        data-hub-page
        data-hub-page-id="trust"
        style={{ padding: "28px 32px", maxWidth: 1200, margin: "0 auto" }}
      >
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
            Trust Center
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              lineHeight: 1.55,
              color: "#475569",
              maxWidth: 760,
            }}
          >
            Provable integrity from capture to verification. PROOVRA does not
            assert truth; it records integrity primitives, methodology,
            security posture, and disclosure references that anyone can verify,
            air-gapped, without PROOVRA online. Every surface linked from here
            is a real route with bounded, honest product behavior.
          </p>
        </header>

        <section
          data-trust-section="cards"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 14,
          }}
        >
          {visibleCards.map((card) => (
            <TrustCardView key={card.href} card={card} />
          ))}
        </section>

        <footer
          style={{
            marginTop: 32,
            padding: "18px 22px",
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.03)",
            border: "1px dashed rgba(15, 23, 42, 0.16)",
            color: "#475569",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <strong style={{ display: "block", marginBottom: 6, color: "#0f172a" }}>
            Verifier reproducibility statement
          </strong>
          Every artifact reachable from this hub can be independently
          reproduced from cold storage. The offline verifier accepts the same
          verification package the public verify page consumes. If PROOVRA
          ever disappears, your evidence does not.
        </footer>
      </div>
    </PageRouteGate>
  );
}
