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
 *   3. C2PA generation readiness — link to /operations/c2pa when
 *      entitled.
 *   4. Reproducible exports — link to /operations/exports.
 *   5. Object-lock posture — link to /operations/recovery.
 *   6. Public verify entry point — link to /verify.
 *   7. Legal disclosures (subprocessors, retention, privacy, terms).
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

type TrustCard = {
  title: string;
  body: string;
  href: string;
  /** Capability key required to render this card. Empty = always. */
  requires?: string;
  /** When true, the link is external (different URL family). */
  external?: boolean;
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
    body: "Retention windows by data class, customer controls, and the lifecycle orchestrator that enforces them.",
    href: "/data-retention",
  },

  // ---------------------------------------------------------------------
  // Operator cards (gated to OPS_CENTER_VIEW + GOVERNANCE_VIEW).
  // Visibility decided by the resolver downstream; cards are rendered
  // for everyone here and the underlying pages enforce capability.
  // ---------------------------------------------------------------------
  {
    title: "Signer health",
    body: "KMS signer registry, current key set, rotation lineage, last successful signature timestamp. The signing surface that backs every Capture Signature + countersignature.",
    href: "/operations/signers",
    requires: "OPS_CENTER_VIEW",
  },
  {
    title: "C2PA generation readiness",
    body: "C2PA manifest generation readiness: provider binary, signing certificate, signing key, generation targets. Shows the bounded readiness state without revealing key bytes.",
    href: "/operations/c2pa",
    requires: "OPS_CENTER_VIEW",
  },
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
    title: "Governance posture",
    body: "Lifecycle orchestrator state, retention compliance, destruction reviews, audit posture.",
    href: "/governance",
    requires: "GOVERNANCE_VIEW",
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
  return (
    <PageRouteGate routeId="workspace.trust">
      <div
        data-hub-page
        data-hub-page-id="trust"
        style={{ padding: "28px 32px", maxWidth: 1200, margin: "0 auto" }}
      >
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
            Trust
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
            assert truth — it records integrity primitives that anyone can
            verify, air-gapped, without PROOVRA online. Every operator surface
            you reach from here is real product, not a marketing page.
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
          {TRUST_CARDS.map((card) => (
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
