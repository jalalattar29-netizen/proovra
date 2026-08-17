"use client";

/**
 * PHASE 13 §UI — Automation rule enable / disable.
 *
 * Closes two registered-but-unreachable routes:
 *
 *   POST /v1/automation/rules/:id/enable   — services/api/src/routes/automation.routes.ts:412
 *   POST /v1/automation/rules/:id/disable  — services/api/src/routes/automation.routes.ts:418
 *
 * ONE control, not two. The leg is derived from the rule's CURRENT state, so
 * the product can never offer "Enable" on an already-enabled rule (which the
 * server would happily accept as a no-op write, bumping `version` and
 * clearing `disabledAt` for no reason).
 *
 * Both legs share `transitionEnabled` server-side and return the updated rule
 * projection (200). Failure modes handled: 400 (bad id), 401, 403 (missing
 * AUTOMATION_MANAGE), 404 (rule gone / not a member — anti-enumeration),
 * >=500 and network.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import type { AutomationRule } from "./types";

type ToggleStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export type AutomationRuleToggleProps = {
  rule: AutomationRule;
  canManage: boolean;
  onChanged: () => void | Promise<void>;
};

export function AutomationRuleToggle({
  rule,
  canManage,
  onChanged,
}: AutomationRuleToggleProps): JSX.Element {
  const [status, setStatus] = useState<ToggleStatus>({ kind: "idle" });

  // Stale-response protection — a second click (or an unmount while the
  // request is in flight) must not let an older response write state.
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = status.kind === "working";
  const disabled = !canManage || busy;

  const onClick = useCallback(async () => {
    if (disabled) return;
    // The leg is the INVERSE of the rule's current state — one control.
    const leg = rule.enabled ? "disable" : "enable";
    const mine = ++seq.current;
    setStatus({ kind: "working" });
    try {
      await apiFetch(
        `/v1/automation/rules/${encodeURIComponent(rule.id)}/${leg}`,
        { method: "POST" },
      );
      if (!mounted.current || mine !== seq.current) return;
      setStatus({
        kind: "done",
        message: leg === "enable" ? "Rule enabled." : "Rule disabled.",
      });
      await onChanged();
    } catch (err) {
      if (!mounted.current || mine !== seq.current) return;
      const e = err as { statusCode?: number };
      const code = typeof e.statusCode === "number" ? e.statusCode : 0;
      if (code === 403) {
        setStatus({
          kind: "denied",
          message:
            "You don't have permission to enable or disable automation rules here.",
        });
        return;
      }
      if (code === 404) {
        setStatus({
          kind: "error",
          message:
            "That rule is no longer available in this workspace. Refresh the list.",
        });
        return;
      }
      // 400 / 401 / >=500 / network / unexpected 4xx — bounded copy only.
      setStatus({
        kind: "error",
        message: toSafeUserError(err, {
          message: `We couldn't ${leg} this rule. Please try again.`,
        }).message,
      });
    }
  }, [disabled, rule.enabled, rule.id, onChanged]);

  const label = rule.enabled ? "Disable" : "Enable";

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <button
        type="button"
        data-automation-rule-toggle={rule.enabled ? "disable" : "enable"}
        data-automation-rule-toggle-for={rule.id}
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy}
        aria-label={`${label} automation rule ${rule.name}`}
        title={
          canManage
            ? undefined
            : "Requires the AUTOMATION_MANAGE capability (workspace owner or admin) on this platform-admin console."
        }
        style={{
          padding: "4px 10px",
          border: "1px solid #cbd5e1",
          background: rule.enabled ? "#fff" : "#0f172a",
          color: rule.enabled ? "#0f172a" : "#fafafa",
          fontWeight: 600,
          fontSize: 12,
          borderRadius: 6,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {busy ? "Working…" : label}
      </button>
      <span
        role="status"
        aria-live="polite"
        data-automation-toggle-status={status.kind}
        style={{
          fontSize: 11,
          color: status.kind === "done" ? "#166534" : "#b91c1c",
          minHeight: 12,
        }}
      >
        {status.kind === "idle" || status.kind === "working"
          ? ""
          : status.message}
      </span>
    </span>
  );
}
