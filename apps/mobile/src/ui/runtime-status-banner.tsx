/**
 * RUNTIME STATUS BANNER (T-15) — the native port of
 * `apps/web/components/operational/RuntimeStatusBanner.tsx`, mounted where the
 * web mounts it (evidence detail).
 *
 * GET /v1/runtime/status answers ONLY { status: HEALTHY | DEGRADED | UNAVAILABLE }
 * — tenant-safe, no subsystem ids. HEALTHY renders nothing; a failed read is
 * FAIL-CLOSED (an UNKNOWN banner), because rendering nothing would look
 * identical to healthy. Polls every 60s while mounted.
 *
 * Deliberate differences from the web, both web defects recorded in the
 * ledger: the web's degraded notice prints "0 subsystem(s) reported…" and an
 * empty "Failing subsystems: ." line (the tenant projection carries no list),
 * and links tenants to the admin-only /admin/platform/runbooks. Native keeps
 * the sentences that are true for a tenant and drops those three.
 *
 * THE HEALTH DESTINATION (healthDestination.ts resolveHealthDestination): a
 * holder of WORKSPACE_HEALTH_VIEW is offered "View workspace health"
 * (/operations/health) on the DEGRADED notice and after the UNKNOWN sentence
 * ("… for detail."). The PLATFORM_TELEMETRY_VIEW branch points at
 * /admin/platform/observability, a platform-staff console native does not
 * have, so it is not offered. The capability is read only while a banner is
 * actually showing, so a healthy page makes no extra request.
 */
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { apiFetch } from "../api";
import { canViewWorkspaceHealth } from "../product/ops-console";
import { usePlatformContext } from "../product/platform-context";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";

export const WORKSPACE_HEALTH_DESTINATION = { href: "/operations/health", label: "View workspace health" } as const;

/** The health link, or nothing when this actor may not open workspace health. */
function HealthLink({ suffix }: { suffix?: string }) {
  const router = useRouter();
  const { envelope } = usePlatformContext();
  if (!canViewWorkspaceHealth(envelope)) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.space.s2 }}>
      <ProovraButton
        label={WORKSPACE_HEALTH_DESTINATION.label}
        variant="ghost"
        fullWidth={false}
        onPress={() => router.push(WORKSPACE_HEALTH_DESTINATION.href)}
        testID="runtime-status-health-link"
      />
      {suffix ? (
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          {suffix}
        </ProovraText>
      ) : null}
    </View>
  );
}

export const RUNTIME_STATUS_PATH = "/v1/runtime/status";
type RuntimeStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

export function parseRuntimeStatus(payload: unknown): RuntimeStatus {
  const d = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const st = d["status"];
  return st === "HEALTHY" || st === "DEGRADED" || st === "UNAVAILABLE" ? st : "UNAVAILABLE";
}

export function RuntimeStatusBanner({ pollMs = 60_000 }: { pollMs?: number }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = parseRuntimeStatus(await apiFetch(RUNTIME_STATUS_PATH));
        if (!cancelled) {
          setStatus(next);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
          setFailed(true);
        }
      }
    };
    void load();
    if (pollMs <= 0) return () => void (cancelled = true);
    const t = setInterval(() => void load(), pollMs);
    // A poll must never keep a JS runtime alive on its own (Node test runs);
    // React Native timers have no unref, so this is a no-op in the app.
    (t as unknown as { unref?: () => void }).unref?.();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pollMs]);

  const box = (tone: "warn" | "unknown", title: string, body?: string, link?: React.ReactNode) => (
    <View
      testID={`runtime-status-${tone}`}
      accessibilityRole="summary"
      style={{
        borderWidth: 1,
        borderColor: tone === "warn" ? theme.color.status.pending.fg : theme.color.border.strong,
        borderRadius: theme.radius.md,
        padding: theme.space.s3,
        marginBottom: theme.space.s3,
        gap: 2,
      }}
    >
      <ProovraText variant="bodySm" weight="semibold">{title}</ProovraText>
      {body ? <ProovraText variant="label" color={theme.color.ink.secondary}>{body}</ProovraText> : null}
      {link ?? null}
    </View>
  );

  if (failed) return box("unknown", "Runtime readiness could not be loaded — treat dashboard as unknown state.", "UNKNOWN");
  if (!status || status === "HEALTHY") return null;
  if (status === "DEGRADED") {
    return box(
      "warn",
      "Runtime is in degraded mode.",
      "The data on this page may be partial or stale. The platform continues to operate but operator attention is recommended.",
      <HealthLink />,
    );
  }
  return box("unknown", "Runtime status is currently unknown.", undefined, <HealthLink suffix="for detail." />);
}
