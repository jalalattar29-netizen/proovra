/**
 * SERVICE STATUS (native) — the counterpart of the web's
 * `components/operational/RuntimeStatusBanner.tsx` (contextual notice) and
 * `ServiceStatusIndicator.tsx` (header), reading GET /v1/runtime/status through
 * the SAME shared interpreter (`@proovra/shared` tenant-service-status), so one
 * response cannot mean two things on two clients.
 *
 * WHAT THIS REPLACES. A full-width "Runtime is in degraded mode" panel at the
 * top of Evidence detail, driven by a platform readiness rollup and telling the
 * reader "the data on this page may be partial or stale". A platform
 * diagnostic is not a statement about the record in front of the user.
 *
 *   RuntimeStatusBanner({ requires })  — one line beside an action, only when a
 *     capability it depends on is CONFIRMED degraded or unavailable.
 *   ServiceStatusIndicator             — the header chip; nothing while every
 *     core capability is healthy; "Service issue" / "Status unavailable"
 *     otherwise, with the actor's workspace-health link only when they hold
 *     WORKSPACE_HEALTH_VIEW. Never an operator console, never runbooks.
 *
 * One poll (60s) serves every mounted consumer; it stops when none remain.
 */
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  contextualServiceNotices,
  summarizeTenantServiceStatus,
  type TenantServiceCapability,
  type TenantServiceStatus,
} from "@proovra/shared";

import { apiFetch } from "../api";
import { canViewWorkspaceHealth } from "../product/ops-console";
import { RUNTIME_STATUS_PATH, parseServiceStatus } from "../product/service-status";
import { usePlatformContext } from "../product/platform-context";
import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";

export const WORKSPACE_HEALTH_DESTINATION = { href: "/operations/health", label: "View workspace health" } as const;
export { RUNTIME_STATUS_PATH };
export const SERVICE_STATUS_POLL_MS = 60_000;

/* ------------------------------------------------------------------ store */

type Snapshot = { status: TenantServiceStatus | null; error: boolean; settled: boolean };
const INITIAL: Snapshot = { status: null, error: false, settled: false };
let snapshot: Snapshot = INITIAL;
const listeners = new Set<() => void>();
let consumers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function emit(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export async function refreshServiceStatus(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const status = parseServiceStatus(await apiFetch(RUNTIME_STATUS_PATH));
    emit({ status, error: false, settled: true });
  } catch {
    emit({ status: null, error: true, settled: true });
  } finally {
    inFlight = false;
  }
}

export function useServiceStatus(): Snapshot {
  useEffect(() => {
    consumers += 1;
    if (!timer) {
      void refreshServiceStatus();
      timer = setInterval(() => void refreshServiceStatus(), SERVICE_STATUS_POLL_MS);
      // A poll must never keep a JS runtime alive on its own (Node test runs);
      // React Native timers have no unref, so this is a no-op in the app.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    return () => {
      consumers -= 1;
      if (consumers <= 0 && timer) {
        consumers = 0;
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => snapshot,
    () => INITIAL,
  );
}

/** Tests only. */
export function resetServiceStatusForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  consumers = 0;
  inFlight = false;
  snapshot = INITIAL;
}

/* ------------------------------------------------------- contextual notice */

export function RuntimeStatusBanner({ requires }: { requires: ReadonlyArray<TenantServiceCapability> }) {
  const { status } = useServiceStatus();
  const notices = contextualServiceNotices(status, requires);
  if (notices.length === 0) return null;
  const unavailable = notices.some((n) => n.status === "UNAVAILABLE");
  return (
    <View
      testID={`service-notice-${notices.map((n) => n.capability).join("-")}`}
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={{
        borderWidth: 1,
        borderColor: unavailable ? theme.color.status.risk.fg : theme.color.status.pending.fg,
        borderRadius: theme.radius.md,
        paddingVertical: 6,
        paddingHorizontal: 10,
        gap: 2,
      }}
    >
      {notices.map((n) => (
        <ProovraText key={n.capability} variant="label" color={theme.color.ink.secondary}>
          {n.message}
        </ProovraText>
      ))}
    </View>
  );
}

/* -------------------------------------------------------- header indicator */

export function ServiceStatusIndicator() {
  const router = useRouter();
  const { envelope } = usePlatformContext();
  const { status, error, settled } = useServiceStatus();
  const [open, setOpen] = useState(false);
  if (!settled) return null;
  const summary = summarizeTenantServiceStatus(error ? null : status);
  if (summary.level === "OK") return null;
  const issue = summary.level === "ISSUE";
  return (
    <View testID={`service-status-${summary.level.toLowerCase()}`}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`Service status: ${summary.label}`}
        accessibilityState={{ expanded: open }}
        testID="header-service-status"
        style={{
          borderWidth: 1,
          borderColor: issue ? theme.color.status.pending.fg : theme.color.border.strong,
          borderRadius: 999,
          paddingHorizontal: 10,
          minHeight: 32,
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.color.ink.secondary }} numberOfLines={1}>
          {summary.label}
        </Text>
      </Pressable>
      {open ? (
        <View testID="service-status-details" style={{ gap: 4, paddingTop: 6, maxWidth: 280 }}>
          {summary.notices.length > 0 ? (
            summary.notices.map((n) => (
              <ProovraText key={n.capability} variant="label" color={theme.color.ink.secondary}>
                {n.message}
              </ProovraText>
            ))
          ) : (
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              Service status can't be confirmed right now. We'll keep checking.
            </ProovraText>
          )}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Evidence you have already recorded is not changed by a service issue.
          </ProovraText>
          {canViewWorkspaceHealth(envelope) ? (
            <ProovraButton
              label={WORKSPACE_HEALTH_DESTINATION.label}
              variant="ghost"
              fullWidth={false}
              onPress={() => router.push(WORKSPACE_HEALTH_DESTINATION.href)}
              testID="runtime-status-health-link"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
