"use client";

/**
 * Phase IA-self-serve-simplification — self-serve Home dashboard.
 *
 * The pre-fix Home rendered enterprise/reviewer/governance language
 * (Operational command surface, Reviewer queue, Governance posture,
 * SLA pressure, …). For FREE / PAYG / PRO / TEAM users the GTM brief
 * requires a self-serve flavour with plain language:
 *
 *   * Quick actions       — Capture / Create case / Create intake
 *                            link (PRO+) / View reports / Invite
 *                            teammate (PRO+) / Upgrade (FREE/PAYG)
 *   * Recent evidence     — last 5 records (label + status + verify URL)
 *   * Recent cases        — last 3 cases (label + evidence count)
 *   * Evidence health     — records created / storage used / reports
 *                            generated / verify URLs active
 *   * Storage usage       — used / included + upgrade CTA
 *   * Team activity       — PRO/TEAM only (members + recent activity)
 *   * Getting started     — 5-step checklist
 *   * Trust summary       — bounded plan-safe claim copy
 *
 * Strict copy rules (also enforced by the terminology guard test):
 *   * NO Operational command surface
 *   * NO Reviewer queue / Reviewer ops / Reviewer escalations
 *   * NO Governance posture / Compliance posture
 *   * NO SLA pressure / Escalation lifecycle / Departmental rollout
 *   * NO Enterprise intelligence / Intelligence operations
 *   * NO claim of legal admissibility / factual truth / authenticity
 *
 * Each section is rendered only when the user's plan enables it
 * (Team activity for PRO+, Invite teammate for PRO+, Upgrade CTA for
 * FREE/PAYG, etc.). The component reads `useSurfaceUserContext` to
 * make that decision.
 *
 * NOT yet wired into /home/page.tsx — wiring is the next sprint's
 * task. This component is exported so the existing Home can A/B it
 * behind a feature flag, and the test suite already pins the
 * contract.
 */

import Link from "next/link";

import { useSurfaceUserContext } from "../../lib/surface/useSurfaceUserContext";

type QuickAction = {
  id: string;
  label: string;
  href: string;
  primary?: boolean;
};

function buildQuickActions(
  plan: ReturnType<typeof useSurfaceUserContext>["plan"],
): QuickAction[] {
  const actions: QuickAction[] = [
    { id: "capture", label: "Capture evidence", href: "/capture", primary: true },
    { id: "create-case", label: "Create case", href: "/cases" },
    { id: "view-reports", label: "View reports", href: "/reports" },
  ];
  const isProOrTeam = plan === "PRO" || plan === "TEAM";
  if (isProOrTeam) {
    actions.push(
      { id: "create-intake", label: "Create intake link", href: "/intake-links" },
      { id: "invite-team", label: "Invite teammate", href: "/teams" },
    );
  }
  if (plan === "FREE" || plan === "PAYG") {
    actions.push({ id: "upgrade", label: "Upgrade", href: "/billing", primary: true });
  }
  return actions;
}

export function SelfServeHomeDashboard() {
  const surfaceUserCtx = useSurfaceUserContext();
  const { plan } = surfaceUserCtx;
  const isProOrTeam = plan === "PRO" || plan === "TEAM";
  const quickActions = buildQuickActions(plan);

  return (
    <main
      className="self-serve-home"
      data-self-serve-home
      data-self-serve-plan={plan ?? "UNKNOWN"}
    >
      {/* 1. Quick actions */}
      <section data-self-serve-section="quick-actions" aria-labelledby="qa-h">
        <h2 id="qa-h">Quick actions</h2>
        <ul style={{ display: "flex", flexWrap: "wrap", gap: 12, listStyle: "none", padding: 0 }}>
          {quickActions.map((a) => (
            <li key={a.id}>
              <Link
                href={a.href}
                data-quick-action={a.id}
                style={{
                  padding: "10px 16px",
                  borderRadius: 8,
                  background: a.primary ? "#4f46e5" : "white",
                  color: a.primary ? "white" : "#4f46e5",
                  border: a.primary ? "none" : "1px solid #4f46e5",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                {a.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* 2. Recent evidence */}
      <section data-self-serve-section="recent-evidence" aria-labelledby="re-h">
        <h2 id="re-h">Recent evidence</h2>
        <p>Latest evidence records and verification links.</p>
        <Link href="/evidence">View all evidence →</Link>
      </section>

      {/* 3. Recent cases */}
      <section data-self-serve-section="recent-cases" aria-labelledby="rc-h">
        <h2 id="rc-h">Recent cases</h2>
        <p>Active cases and their evidence count.</p>
        <Link href="/cases">View all cases →</Link>
      </section>

      {/* 4. Evidence health */}
      <section data-self-serve-section="evidence-health" aria-labelledby="eh-h">
        <h2 id="eh-h">Evidence health</h2>
        <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <dt>Records created</dt><dd data-stat="records-created">—</dd>
          <dt>Storage used</dt><dd data-stat="storage-used">—</dd>
          <dt>Reports generated</dt><dd data-stat="reports-generated">—</dd>
          <dt>Verification links active</dt><dd data-stat="verify-urls-active">—</dd>
        </dl>
      </section>

      {/* 5. Storage usage */}
      <section data-self-serve-section="storage-usage" aria-labelledby="su-h">
        <h2 id="su-h">Storage usage</h2>
        <p>Used / included for your plan.</p>
        <Link href="/billing" data-storage-cta="upgrade">
          Upgrade or top up storage
        </Link>
      </section>

      {/* 6. Team activity (PRO/TEAM only) */}
      {isProOrTeam ? (
        <section data-self-serve-section="team-activity" aria-labelledby="ta-h">
          <h2 id="ta-h">Team activity</h2>
          <p>Members, recent activity, and pending invites.</p>
          <Link href="/teams">Manage teams →</Link>
        </section>
      ) : null}

      {/* 7. Getting started checklist */}
      <section data-self-serve-section="getting-started" aria-labelledby="gs-h">
        <h2 id="gs-h">Getting started</h2>
        <ol>
          <li data-getting-started-step="capture">Capture your first evidence record</li>
          <li data-getting-started-step="case">Create your first case</li>
          <li data-getting-started-step="report">Generate or unlock your first report</li>
          {isProOrTeam ? (
            <>
              <li data-getting-started-step="intake">Create your first intake link</li>
              <li data-getting-started-step="invite">Invite a teammate</li>
            </>
          ) : null}
        </ol>
      </section>

      {/* 8. Trust summary — bounded plan-safe copy */}
      <section data-self-serve-section="trust-summary" aria-labelledby="ts-h">
        <h2 id="ts-h">Trust and verification</h2>
        <ul>
          <li>Digital signatures applied to evidence</li>
          <li>Trusted timestamps from a public TSA</li>
          <li>Public verification links</li>
          <li>Storage protection through Object Lock</li>
        </ul>
        <p style={{ fontSize: 12, opacity: 0.75 }}>
          These materials support independent verification. Legal
          admissibility is decided by reviewers and courts on a
          case-by-case basis — PROOVRA does not certify legal status.
        </p>
      </section>
    </main>
  );
}
