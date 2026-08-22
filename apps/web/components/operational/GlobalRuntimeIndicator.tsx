"use client";

/**
 * Phase 28-J — Global runtime indicator (topbar pill + dropdown).
 *
 * Compact severity pill that lives in the topbar between the language
 * switcher and the user menu. Renders the most-severe runtime state
 * across:
 *   - readiness subsystems
 *   - open operational incidents
 *   - open reviewer escalations
 *
 * Click opens a dropdown panel that shows the operator a complete
 * operational snapshot:
 *   - degraded subsystems with reason codes
 *   - active incidents (severity + title + runbook deep-link)
 *   - escalation count
 *   - last readiness refresh + per-source error flags
 *   - quick links: Operations Center, Observability, Escalations, Runbooks
 *
 * Hard rules:
 *   - Pill stays compact at all times — never widens past ~140px.
 *   - HEALTHY pill is intentionally muted (subtle green dot, no shouting).
 *   - DEGRADED / INCIDENT_ACTIVE pill carries amber.
 *   - CRITICAL pill is red AND animates a faint pulse so it cannot be
 *     missed on glance.
 *   - All data comes from `useGlobalRuntimeState` — fail-closed: any
 *     fetch error rolls up to UNKNOWN.
 *   - Keyboard accessible: pill is `<button>`, dropdown closes on Esc /
 *     outside click, dropdown items are real anchors.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  CircleHelp,
  Radio,
  RefreshCw,
} from "lucide-react";

import {
  useGlobalRuntimeState,
  type GlobalRuntimeSeverity,
} from "../../lib/useGlobalRuntimeState";
import { useCan } from "../../lib/platform-context";
import { formatUserTime } from "../../lib/date";
import { OPS_INK, OPS_SURFACE, OPS_TONES } from "./tokens";

export type GlobalRuntimeIndicatorProps = {
  teamId: string | null;
  /** Optional poll override — used by tests. */
  pollMs?: number;
};

type Palette = {
  bg: string;
  border: string;
  ink: string;
  dot: string;
  pulse: boolean;
};

const SEVERITY_PALETTE: Record<GlobalRuntimeSeverity, Palette> = {
  HEALTHY: {
    bg: OPS_SURFACE.cardMuted,
    border: OPS_SURFACE.border,
    ink: OPS_TONES.healthy.inkMuted,
    dot: "#10b981", // emerald-500
    pulse: false,
  },
  DEGRADED: {
    bg: OPS_TONES.degraded.bg,
    border: OPS_TONES.degraded.border,
    ink: OPS_TONES.degraded.ink,
    dot: "#f59e0b", // amber-500
    pulse: false,
  },
  INCIDENT_ACTIVE: {
    bg: OPS_TONES.high.bg,
    border: OPS_TONES.high.border,
    ink: OPS_TONES.high.ink,
    dot: "#ef4444", // red-500
    pulse: false,
  },
  CRITICAL: {
    bg: OPS_TONES.critical.bg,
    border: OPS_TONES.critical.border,
    ink: OPS_TONES.critical.ink,
    dot: "#b91c1c", // red-700
    pulse: true,
  },
  UNKNOWN: {
    bg: OPS_TONES.unknown.bg,
    border: OPS_TONES.unknown.border,
    ink: OPS_TONES.unknown.inkMuted,
    dot: "#dc2626",
    pulse: false,
  },
};

// R1 Part 3 — neutral, non-alarming label for the UNKNOWN runtime
// severity. "Unknown" reads as a red error in a primary-shell
// indicator; the actual semantics are "no recent telemetry," which
// is operational status not user-actionable failure.
const SEVERITY_LABEL: Record<GlobalRuntimeSeverity, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  INCIDENT_ACTIVE: "Incident",
  CRITICAL: "CRITICAL",
  UNKNOWN: "Status pending",
};

export function GlobalRuntimeIndicator({
  teamId,
  pollMs,
}: GlobalRuntimeIndicatorProps) {
  // STAGE 2 — The global runtime indicator is an operator-facing surface
  // (readiness subsystems, incidents, escalations, runbooks). Personal
  // workspaces (workspace.scope !== "TEAM") pass teamId === null from
  // AppAccountToolbar; for those users there is no team-scoped runtime to
  // report against, so the pill perpetually renders as UNKNOWN with the
  // "Status pending" label. That looks like a broken/alarming status
  // chip in the primary shell for users who should never have seen the
  // operator indicator in the first place. Bail out before subscribing
  // to runtime state so personal users get a clean topbar and the hook
  // does no needless polling. Team/org/admin users (teamId is a real
  // workspace id) keep the indicator and all its existing behavior via
  // the inner component below.
  if (teamId === null) {
    return null;
  }
  return <TeamScopedRuntimeIndicator teamId={teamId} pollMs={pollMs} />;
}

function TeamScopedRuntimeIndicator({
  teamId,
  pollMs,
}: GlobalRuntimeIndicatorProps & { teamId: string }) {
  const state = useGlobalRuntimeState(teamId, pollMs);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const palette = SEVERITY_PALETTE[state.severity];
  const label = SEVERITY_LABEL[state.severity];

  // Compute the secondary count for the pill body (operator's quick scan
  // signal). Priority: criticals > highs > escalations > degraded subs.
  const pillCount =
    state.counts.incidentsCritical > 0
      ? state.counts.incidentsCritical
      : state.counts.incidentsHigh > 0
        ? state.counts.incidentsHigh
        : state.counts.escalations > 0
          ? state.counts.escalations
          : state.counts.degradedSubsystems;

  return (
    <div
      ref={containerRef}
      data-global-runtime-indicator
      data-severity={state.severity}
      style={{ position: "relative" }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Runtime status: ${label}. ${
          pillCount > 0 ? `${pillCount} active signal(s).` : "No active signals."
        }`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          background: palette.bg,
          border: `1px solid ${palette.border}`,
          color: palette.ink,
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.3,
          cursor: "pointer",
          lineHeight: 1.2,
          maxWidth: 160,
          fontFamily: "inherit",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 8,
            background: palette.dot,
            boxShadow: palette.pulse
              ? `0 0 0 0 ${palette.dot}`
              : `0 0 0 1px ${OPS_SURFACE.cardMuted}`,
            animation: palette.pulse
              ? "global-runtime-pulse 1.4s infinite"
              : undefined,
          }}
        />
        <span>{label}</span>
        {pillCount > 0 ? (
          <span
            data-pill-count
            style={{
              padding: "0 6px",
              background: "rgba(0,0,0,0.06)",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              minWidth: 18,
              textAlign: "center",
            }}
          >
            {pillCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Operational runtime summary"
          data-global-runtime-dropdown
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 360,
            maxWidth: "calc(100vw - 24px)",
            background: OPS_SURFACE.card,
            border: `1px solid ${OPS_SURFACE.borderStrong}`,
            borderRadius: 10,
            boxShadow: "0 18px 48px rgba(15, 23, 42, 0.18)",
            zIndex: 1000,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            color: OPS_INK.default,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          }}
        >
          <DropdownHeader state={state} palette={palette} label={label} />
          <DropdownBody state={state} />
          <DropdownFooter onClose={() => setOpen(false)} />
        </div>
      ) : null}

      {/* Keyframes for the CRITICAL pulse. Scoped via a unique selector. */}
      <style>{`
        @keyframes global-runtime-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(185,28,28,0.55); }
          70%  { box-shadow: 0 0 0 8px rgba(185,28,28,0); }
          100% { box-shadow: 0 0 0 0 rgba(185,28,28,0); }
        }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Internal subcomponents
// -----------------------------------------------------------------------------

function DropdownHeader({
  state,
  palette,
  label,
}: {
  state: ReturnType<typeof useGlobalRuntimeState>;
  palette: Palette;
  label: string;
}) {
  const IconForSeverity =
    state.severity === "CRITICAL"
      ? AlertOctagon
      : state.severity === "INCIDENT_ACTIVE"
        ? AlertTriangle
        : state.severity === "DEGRADED"
          ? AlertTriangle
          : state.severity === "UNKNOWN"
            ? CircleHelp
            : CheckCircle2;
  return (
    <div
      style={{
        padding: "12px 14px",
        borderBottom: `1px solid ${OPS_SURFACE.border}`,
        background: palette.bg,
        color: palette.ink,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <IconForSeverity size={18} strokeWidth={2.2} aria-hidden="true" />
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <strong style={{ fontSize: 13, letterSpacing: 0.3 }}>
          Runtime · {label}
        </strong>
        <span style={{ fontSize: 11, color: OPS_INK.muted }}>
          {state.refreshedAtUtc
            ? `Last refresh: ${formatUserTime(state.refreshedAtUtc)}`
            : "Loading runtime state…"}
        </span>
      </div>
      <button
        type="button"
        aria-label="Refresh runtime status"
        onClick={(e) => {
          e.preventDefault();
          state.refresh();
        }}
        style={{
          background: "transparent",
          border: `1px solid ${OPS_SURFACE.border}`,
          borderRadius: 6,
          padding: "4px 6px",
          cursor: "pointer",
          color: OPS_INK.muted,
        }}
      >
        <RefreshCw size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

function DropdownBody({
  state,
}: {
  state: ReturnType<typeof useGlobalRuntimeState>;
}) {
  const degraded = state.readiness?.subsystems.filter(
    (s) => s.status !== "HEALTHY",
  ) ?? [];

  return (
    <div
      style={{
        padding: "10px 14px 4px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxHeight: "min(60vh, 480px)",
        overflowY: "auto",
      }}
    >
      <RowGroup
        title="Degraded subsystems"
        count={state.counts.degradedSubsystems}
        empty={
          state.errors.readiness
            ? "Readiness unavailable — treat as unknown."
            : "All subsystems healthy."
        }
        errored={state.errors.readiness}
      >
        {degraded.map((s) => (
          <li
            key={s.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              padding: "4px 0",
              fontSize: 12,
              color: OPS_INK.default,
            }}
          >
            <span style={{ fontWeight: 600 }}>{s.id}</span>
            <span
              data-subsystem-status={s.status}
              style={{
                fontSize: 10,
                letterSpacing: 0.4,
                fontWeight: 700,
                color:
                  s.status === "CRITICAL"
                    ? OPS_TONES.critical.inkMuted
                    : s.status === "DEGRADED"
                      ? OPS_TONES.degraded.kicker
                      : OPS_INK.subtle,
              }}
            >
              {s.status}
            </span>
          </li>
        ))}
      </RowGroup>

      <RowGroup
        title="Active incidents"
        count={state.counts.incidents}
        empty={
          state.errors.incidents
            ? "Incident endpoint unavailable — treat as unknown."
            : "No open incidents."
        }
        errored={state.errors.incidents}
      >
        {state.incidents.slice(0, 6).map((i) => (
          <li
            key={i.id}
            style={{
              padding: "4px 0",
              fontSize: 12,
              color: OPS_INK.default,
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 600 }}>{i.title}</span>
            <span
              data-incident-severity={i.severity}
              style={{
                fontSize: 10,
                letterSpacing: 0.4,
                fontWeight: 700,
                color:
                  i.severity === "CRITICAL"
                    ? OPS_TONES.critical.inkMuted
                    : i.severity === "HIGH"
                      ? OPS_TONES.high.inkMuted
                      : i.severity === "WARNING"
                        ? OPS_TONES.warning.inkMuted
                        : OPS_INK.subtle,
              }}
            >
              {i.severity}
            </span>
          </li>
        ))}
      </RowGroup>

      <RowGroup
        title="Reviewer escalations"
        count={state.counts.escalations}
        empty={
          state.errors.escalations
            ? "Escalation endpoint unavailable — treat as unknown."
            : "No open escalations."
        }
        errored={state.errors.escalations}
      >
        {state.escalations.slice(0, 5).map((e) => (
          <li
            key={e.id}
            style={{
              padding: "4px 0",
              fontSize: 12,
              color: OPS_INK.default,
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 600 }}>{e.reason}</span>
            <span
              data-escalation-severity={e.severity}
              style={{
                fontSize: 10,
                letterSpacing: 0.4,
                fontWeight: 700,
                color:
                  e.severity === "CRITICAL"
                    ? OPS_TONES.critical.inkMuted
                    : e.severity === "HIGH"
                      ? OPS_TONES.high.inkMuted
                      : OPS_TONES.warning.inkMuted,
              }}
            >
              {e.severity}
            </span>
          </li>
        ))}
      </RowGroup>
    </div>
  );
}

function DropdownFooter({ onClose }: { onClose: () => void }) {
  // STAGE 2 — Each footer link is gated by the capability that the
  // canonical route registry requires for the destination route. Users
  // without ANY of the four capabilities see no footer at all — the
  // dropdown is still useful (severity + subsystems + incidents) but
  // the deep-links into operator surfaces stay hidden for users who
  // could not USE them anyway.
  const canOpsCenter = useCan("OPS_CENTER_VIEW");
  const canObservability = useCan("OBSERVABILITY_VIEW");
  const canEscalations = useCan("ESCALATIONS_VIEW");
  const canRunbooks = useCan("RUNBOOKS_VIEW");
  if (!canOpsCenter && !canObservability && !canEscalations && !canRunbooks) {
    return null;
  }
  return (
    <div
      style={{
        borderTop: `1px solid ${OPS_SURFACE.border}`,
        background: OPS_SURFACE.cardMuted,
        padding: "10px 14px",
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 6,
      }}
    >
      {canOpsCenter ? (
        <FooterLink
          href="/operations"
          icon={<Radio size={13} strokeWidth={2} />}
          label="Operations Center"
          onClose={onClose}
        />
      ) : null}
      {canObservability ? (
        <FooterLink
          href="/admin/platform/observability"
          icon={<Activity size={13} strokeWidth={2} />}
          label="Observability"
          onClose={onClose}
        />
      ) : null}
      {canEscalations ? (
        <FooterLink
          href="/reviewer-ops/escalations"
          icon={<AlertTriangle size={13} strokeWidth={2} />}
          label="Escalations"
          onClose={onClose}
        />
      ) : null}
      {canRunbooks ? (
        <FooterLink
          href="/admin/platform/runbooks"
          icon={<BookOpen size={13} strokeWidth={2} />}
          label="Runbooks"
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}

function FooterLink({
  href,
  icon,
  label,
  onClose,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  onClose: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClose}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        fontSize: 12,
        fontWeight: 600,
        color: OPS_INK.default,
        background: OPS_SURFACE.card,
        border: `1px solid ${OPS_SURFACE.border}`,
        borderRadius: 6,
        textDecoration: "none",
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function RowGroup({
  title,
  count,
  empty,
  errored,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  errored: boolean;
  children: React.ReactNode;
}) {
  return (
    <section data-runtime-row-group={title.toLowerCase().replace(/\s+/g, "_")}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
        }}
      >
        <strong
          style={{
            fontSize: 11,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            color: OPS_INK.subtle,
            fontWeight: 700,
          }}
        >
          {title}
        </strong>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: errored
              ? OPS_TONES.unknown.inkMuted
              : count > 0
                ? OPS_TONES.high.inkMuted
                : OPS_INK.muted,
          }}
        >
          {errored ? "—" : count}
        </span>
      </div>
      {count === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: errored ? OPS_TONES.unknown.inkMuted : OPS_INK.muted,
            fontStyle: errored ? "italic" : "normal",
          }}
        >
          {empty}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {children}
        </ul>
      )}
    </section>
  );
}
