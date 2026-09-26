"use client";

/**
 * SERVICE STATUS INDICATOR — the header's global service status for users
 * who are not operators (Personal, Pro, Team and Enterprise members alike).
 *
 * It says what a user cannot currently DO — "Report and package generation is
 * delayed" — never which subsystem is red. It renders NOTHING while every core
 * capability is healthy, so a normal day carries no status clutter.
 *
 *   ISSUE    a capability is confirmed degraded or unavailable
 *   UNKNOWN  nothing confirmed failed, but status could not be measured —
 *            said here, once, rather than beside every action
 *
 * The one link it may offer is the actor's own health destination
 * (`useHealthDestination`), and only when the actor holds that capability. No
 * operator console, no runbooks.
 *
 * Operators with operational read access get `GlobalRuntimeIndicator` instead,
 * which shows the same service impact plus their incidents and escalations —
 * never both pills.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleHelp } from "lucide-react";
import { summarizeTenantServiceStatus } from "@proovra/shared";

import { formatUserTime } from "../../lib/date";
import { useHealthDestination } from "../../lib/navigation/healthDestination";
import { useServiceStatus } from "../../lib/useServiceStatus";
import { OPS_INK, OPS_SURFACE, OPS_TONES } from "./tokens";

export function ServiceStatusIndicator() {
  const { status, error, settled } = useServiceStatus();
  const healthDestination = useHealthDestination();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing until the first read settles: "pending" is not a status to show.
  if (!settled) return null;
  const summary = summarizeTenantServiceStatus(error ? null : status);
  if (summary.level === "OK") return null;

  const issue = summary.level === "ISSUE";
  const tone = issue ? OPS_TONES.degraded : OPS_TONES.unknown;
  const Icon = issue ? AlertTriangle : CircleHelp;

  return (
    <div
      ref={containerRef}
      className="app-topbar-v2-runtime"
      data-service-status-indicator={summary.level}
      style={{ position: "relative" }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Service status: ${summary.label}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          background: tone.bg,
          border: `1px solid ${tone.border}`,
          color: tone.ink,
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          lineHeight: 1.2,
          maxWidth: 160,
          fontFamily: "inherit",
        }}
      >
        <Icon size={13} strokeWidth={2.2} aria-hidden="true" />
        <span>{summary.label}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Service status"
          data-service-status-dropdown
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 320,
            maxWidth: "calc(100vw - 24px)",
            background: OPS_SURFACE.card,
            border: `1px solid ${OPS_SURFACE.borderStrong}`,
            borderRadius: 10,
            boxShadow: "0 18px 48px rgba(15, 23, 42, 0.18)",
            zIndex: 1000,
            padding: "12px 14px",
            display: "grid",
            gap: 8,
            color: OPS_INK.default,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {summary.notices.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
              {summary.notices.map((n) => (
                <li key={n.capability} data-service-status-capability={n.capability}>
                  {n.message}
                </li>
              ))}
            </ul>
          ) : (
            <span>Service status can&apos;t be confirmed right now. We&apos;ll keep checking.</span>
          )}
          <span style={{ fontSize: 11.5, color: OPS_INK.muted }}>
            {status?.checkedAt ? `Last checked ${formatUserTime(status.checkedAt)}. ` : ""}
            Evidence you have already recorded is not changed by a service issue.
          </span>
          {healthDestination ? (
            <a
              href={healthDestination.href}
              style={{ fontWeight: 700, color: OPS_TONES.warning.link, fontSize: 12.5 }}
            >
              {healthDestination.label}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default ServiceStatusIndicator;
