/**
 * Phase 4A Final Closure — In-platform bridge page that surfaces the
 * Trust Center / Methodology / AI Disclosure / Security article
 * references + active subprocessors for the active workspace.
 *
 * The public /verify/[token] surface is unauthenticated and cannot
 * call /v1/trust/verify-references (workspace-anchored, requireAuth).
 * This in-platform bridge gives operators a workspace-anchored view
 * of the same references that get embedded into reports and the
 * verification package.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import VerifyTrustReferences from "../_verify-trust-references";

export default function VerifyTrustReferencesPage() {
  return (
    <PageRouteGate routeId="workspace.trust">
      <div
        style={{
          padding: 20,
          maxWidth: 1080,
          margin: "0 auto",
          display: "grid",
          gap: 16,
        }}
      >
        <header style={{ display: "grid", gap: 6 }}>
          <h1
            style={{
              margin: 0,
              fontSize: "clamp(1.5rem, 2vw, 2rem)",
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: "#10201d",
            }}
          >
            Verify-page trust references
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              lineHeight: 1.6,
              color: "rgba(16,32,29,0.72)",
            }}
          >
            The published Trust Center, Methodology, AI Disclosure, Security
            articles, and active subprocessor registry that back this
            workspace&apos;s verify views. Click any row to open the full
            content in the in-platform Trust Center.
          </p>
        </header>

        <VerifyTrustReferences />
      </div>
    </PageRouteGate>
  );
}
