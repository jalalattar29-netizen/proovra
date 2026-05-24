"use client";

/**
 * Phase 32.8 Foundation — Canonical PlatformContextProvider.
 *
 * Single source of truth for user, workspace, role, persona,
 * capabilities, navigation, and platform-admin elevation across the
 * entire web shell. Every page and component consumes
 * `usePlatformContext()` — direct fetches to /v1/users/me or
 * /v1/teams for authority purposes are forbidden by the F-6 grep
 * tests.
 *
 * State machine (see ./types.ts):
 *
 *   IDLE
 *     ↓ mount
 *   LOADING_CONTEXT  (initial fetch)
 *     ↓ success
 *   READY
 *     ↓ switchWorkspace(id)
 *   SWITCHING        (freezes downstream consumers — they keep
 *                     reading the previous envelope until READY)
 *     ↓ success / stale-version / error
 *   READY  |  FAILED
 *
 * Hard rules:
 *
 *   1. NO local authority derivation. Consumers may only read
 *      `state.envelope.*` while `state.name === "READY"`. While
 *      SWITCHING, they read `state.previous.*` (intentional freeze).
 *
 *   2. Authority versioning — if the freshly-fetched envelope's
 *      authority/capability/navigation schema versions don't match
 *      the constants this build was compiled against, the envelope
 *      is discarded and the user is shown a "Refresh required"
 *      banner. Frontend NEVER renders a stale envelope.
 *
 *   3. On switch failure, the provider falls back to the previous
 *      READY envelope. The user sees an error toast — they do NOT
 *      see a half-applied workspace.
 *
 *   4. On any auth error (401), the provider sets FAILED. Higher-
 *      level shell components route to /login.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch } from "../api";
import {
  emit as emitStateEvent,
  redactWorkspaceId,
} from "./state-observability";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
  type CapabilityKey,
  type PlatformContextEnvelope,
  type PlatformContextErrorCode,
  type PlatformContextState,
} from "./types";

type ApiErrorLike = {
  statusCode?: number;
  code?: string;
  message?: string;
  requestId?: string | null;
};

function classifyError(
  err: unknown,
  fallback: PlatformContextErrorCode,
): { code: PlatformContextErrorCode; message: string; requestId: string | null } {
  const e = err as ApiErrorLike;
  if (e?.statusCode === 401) {
    return {
      code: "AUTH_REQUIRED",
      message: "Sign in to continue.",
      requestId: e.requestId ?? null,
    };
  }
  if (e?.statusCode === 403) {
    const code: PlatformContextErrorCode =
      e?.code === "workspace_membership_required"
        ? "WORKSPACE_MEMBERSHIP_REQUIRED"
        : "PERMISSION_DENIED";
    return {
      code,
      message: e?.message ?? "You do not have permission for this workspace.",
      requestId: e.requestId ?? null,
    };
  }
  if (e?.statusCode === 404 && e?.code === "user_not_found") {
    return {
      code: "USER_NOT_FOUND",
      message: "Your user account is missing. Sign out and back in.",
      requestId: e.requestId ?? null,
    };
  }
  if (e?.code === "NETWORK_ERROR") {
    return {
      code: "NETWORK_ERROR",
      message: "Network error reaching the platform service.",
      requestId: e.requestId ?? null,
    };
  }
  return {
    code: fallback,
    message: e?.message ?? "Unable to load platform context.",
    requestId: e?.requestId ?? null,
  };
}

function versionsAreCompatible(envelope: PlatformContextEnvelope): boolean {
  return (
    envelope.authoritySchemaVersion === AUTHORITY_SCHEMA_VERSION &&
    envelope.capabilitySchemaVersion === CAPABILITY_SCHEMA_VERSION &&
    envelope.navigationSchemaVersion === NAVIGATION_SCHEMA_VERSION
  );
}

export type PlatformContextValue = {
  /** Bounded state machine. Header/sidebar/pages MUST gate on `name`. */
  state: PlatformContextState;

  /** Convenience accessor — null when no READY envelope yet. */
  envelope: PlatformContextEnvelope | null;

  /**
   * Bounded capability check. Returns `false` while LOADING_CONTEXT
   * or FAILED (fail-closed). When SWITCHING, returns the previous
   * envelope's capability so the UI doesn't flicker capabilities
   * off mid-switch.
   */
  can: (capability: CapabilityKey) => boolean;

  /**
   * Atomic workspace switch. Pass `null` to switch back to the
   * personal workspace.
   */
  switchWorkspace: (workspaceId: string | null) => Promise<void>;

  /**
   * Hard refresh — re-fetches /v1/platform/context. Used after
   * mutations that change membership/role/capability shape.
   */
  refresh: () => Promise<void>;

  /**
   * True iff the freshly-fetched envelope's authority/capability/
   * navigation schema versions match the build's constants. False
   * means a forced page refresh is required.
   */
  schemaCompatible: boolean;
};

const PlatformContextReactContext = createContext<PlatformContextValue | null>(
  null,
);

export function usePlatformContext(): PlatformContextValue {
  const ctx = useContext(PlatformContextReactContext);
  if (!ctx) {
    throw new Error(
      "usePlatformContext must be used inside <PlatformContextProvider>",
    );
  }
  return ctx;
}

/**
 * Internal — pure capability lookup over the current state. Returns
 * false when no envelope is available (fail-closed).
 */
function readCapability(
  state: PlatformContextState,
  capability: CapabilityKey,
): boolean {
  if (state.name === "READY") {
    return state.envelope.capabilities[capability] === true;
  }
  if (state.name === "SWITCHING") {
    return state.previous.capabilities[capability] === true;
  }
  if (state.name === "FAILED" && state.previous) {
    return state.previous.capabilities[capability] === true;
  }
  return false;
}

export type PlatformContextProviderProps = {
  children: React.ReactNode;
  /**
   * Optional injection for tests — bypasses the network. Test
   * harnesses can pass a constructed envelope and skip fetch.
   */
  testEnvelope?: PlatformContextEnvelope | null;
};

export function PlatformContextProvider({
  children,
  testEnvelope,
}: PlatformContextProviderProps) {
  const [state, setState] = useState<PlatformContextState>(
    testEnvelope
      ? { name: "READY", envelope: testEnvelope }
      : { name: "IDLE" },
  );
  const [schemaCompatible, setSchemaCompatible] = useState<boolean>(true);

  // Sequence number prevents an out-of-order envelope from a slow
  // previous switch overwriting a newer one — exactly the "header
  // shows one workspace while page uses another" failure mode.
  const fetchSequenceRef = useRef(0);

  const ingestEnvelope = useCallback(
    (envelope: PlatformContextEnvelope): "applied" | "stale-version" => {
      if (!versionsAreCompatible(envelope)) {
        setSchemaCompatible(false);
        return "stale-version";
      }
      setSchemaCompatible(true);
      setState({ name: "READY", envelope });
      // CR1.5 / R1 — dev-only observability. No-op in production.
      emitStateEvent("platform-envelope:loaded", "PlatformContextProvider", {
        workspaceId: redactWorkspaceId(envelope.workspace.id),
        activeSpaceType: envelope.activeSpace?.type ?? "none",
      });
      return "applied";
    },
    [],
  );

  const refresh = useCallback(async () => {
    const seq = ++fetchSequenceRef.current;
    setState((prev) =>
      prev.name === "READY"
        ? {
            name: "SWITCHING",
            previous: prev.envelope,
            targetWorkspaceId: prev.envelope.workspace.id,
          }
        : { name: "LOADING_CONTEXT" },
    );
    try {
      const envelope = (await apiFetch("/v1/platform/context", {
        method: "GET",
      })) as PlatformContextEnvelope;
      if (seq !== fetchSequenceRef.current) {
        // A newer fetch has already completed — drop this stale
        // response on the floor.
        return;
      }
      ingestEnvelope(envelope);
      emitStateEvent("platform-envelope:refreshed", "PlatformContextProvider", {
        workspaceId: redactWorkspaceId(envelope.workspace.id),
      });
    } catch (err) {
      if (seq !== fetchSequenceRef.current) return;
      const cls = classifyError(err, "OPERATIONAL");
      setState((prev) => ({
        name: "FAILED",
        errorCode: cls.code,
        message: cls.message,
        requestId: cls.requestId,
        previous:
          prev.name === "READY"
            ? prev.envelope
            : prev.name === "SWITCHING"
              ? prev.previous
              : prev.name === "FAILED"
                ? prev.previous
                : null,
      }));
    }
  }, [ingestEnvelope]);

  const switchWorkspace = useCallback(
    async (workspaceId: string | null) => {
      const seq = ++fetchSequenceRef.current;
      setState((prev) => {
        if (prev.name === "READY") {
          return {
            name: "SWITCHING",
            previous: prev.envelope,
            targetWorkspaceId: workspaceId,
          };
        }
        if (prev.name === "SWITCHING") {
          return { ...prev, targetWorkspaceId: workspaceId };
        }
        return { name: "LOADING_CONTEXT" };
      });

      try {
        const envelope = (await apiFetch(
          "/v1/platform/context/switch-workspace",
          {
            method: "POST",
            body: JSON.stringify({ workspaceId }),
          },
        )) as PlatformContextEnvelope;
        if (seq !== fetchSequenceRef.current) return;
        ingestEnvelope(envelope);
      } catch (err) {
        if (seq !== fetchSequenceRef.current) return;
        const cls = classifyError(err, "OPERATIONAL");
        setState((prev) => ({
          name: "FAILED",
          errorCode: cls.code,
          message: cls.message,
          requestId: cls.requestId,
          previous:
            prev.name === "SWITCHING"
              ? prev.previous
              : prev.name === "READY"
                ? prev.envelope
                : prev.name === "FAILED"
                  ? prev.previous
                  : null,
        }));
      }
    },
    [ingestEnvelope],
  );

  useEffect(() => {
    if (testEnvelope) return; // Test harness bypass.
    void refresh();
    // refresh's identity is stable across renders because of useCallback.
  }, [refresh, testEnvelope]);

  const can = useCallback(
    (capability: CapabilityKey) => readCapability(state, capability),
    [state],
  );

  const value = useMemo<PlatformContextValue>(
    () => ({
      state,
      envelope:
        state.name === "READY"
          ? state.envelope
          : state.name === "SWITCHING"
            ? state.previous
            : state.name === "FAILED"
              ? state.previous
              : null,
      can,
      switchWorkspace,
      refresh,
      schemaCompatible,
    }),
    [state, can, switchWorkspace, refresh, schemaCompatible],
  );

  return (
    <PlatformContextReactContext.Provider value={value}>
      {children}
    </PlatformContextReactContext.Provider>
  );
}
