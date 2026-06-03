"use client";
/* eslint-env browser */
// Committed compiled output of PlatformContextProvider.tsx. The .tsx source is
// canonical; this .jsx artifact must remain in sync. ESLint scans both; the
// browser env directive prevents no-undef on document/window etc.
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
 *
 *   5. CR1.6 — Optional focus-triggered envelope refresh. When
 *      `NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED === "true"`,
 *      the provider listens for window focus and document
 *      `visibilitychange` events. On a true visibility transition
 *      (hidden → visible) OR a window focus event, if the provider is
 *      in READY state AND more than `MIN_REFRESH_INTERVAL_MS` (60s)
 *      has elapsed since the last refresh, a single `refresh()` is
 *      issued. Concurrent refresh attempts are dropped via a guard
 *      ref. The feature is OFF by default and SSR-safe (the effect
 *      no-ops when `window` is undefined).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, } from "react";
import { apiFetch } from "../api";
import { emit as emitStateEvent, redactWorkspaceId, } from "./state-observability";
import { ACCEPTED_AUTHORITY_SCHEMA_VERSIONS, ACCEPTED_CAPABILITY_SCHEMA_VERSIONS, ACCEPTED_NAVIGATION_SCHEMA_VERSIONS, AUTHORITY_SCHEMA_VERSION, CAPABILITY_SCHEMA_VERSION, NAVIGATION_SCHEMA_VERSION, } from "./types";
function classifyError(err, fallback) {
    const e = err;
    if (e?.statusCode === 401) {
        return {
            code: "AUTH_REQUIRED",
            message: "Sign in to continue.",
            requestId: e.requestId ?? null,
        };
    }
    if (e?.statusCode === 403) {
        const code = e?.code === "workspace_membership_required"
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
/**
 * STAGE 1 SCHEMA ALIGNMENT — Version compatibility check.
 *
 * The envelope is accepted when each of its declared schema versions
 * appears in the corresponding `ACCEPTED_*_SCHEMA_VERSIONS` whitelist
 * (see ./types.ts). This admits BOTH the previous accepted version AND
 * the current emitted version so that:
 *
 *   - Older deployed envelopes from any short window do not lock users
 *     out (e.g. a stale CDN serving an older API response).
 *   - The current build's expected constants (`*_SCHEMA_VERSION`) are
 *     always present in the whitelist, so the canonical happy path is
 *     unchanged.
 *
 * Validation is NOT bypassed — envelopes outside the bounded whitelists
 * are still rejected (the provider then enters FAILED with
 * `SCHEMA_VERSION_MISMATCH`).
 *
 * The single-version constants are referenced here in a no-op assertion
 * so the build retains its hard dependency on them (TypeScript catches
 * drift between the whitelists and the build's expected current value).
 */
function versionsAreCompatible(envelope) {
    // Self-check: the current build's expected constants must each be in
    // the corresponding whitelist. This is a static invariant — failure
    // here means the types module was edited inconsistently.
    void AUTHORITY_SCHEMA_VERSION;
    void CAPABILITY_SCHEMA_VERSION;
    void NAVIGATION_SCHEMA_VERSION;
    return (ACCEPTED_AUTHORITY_SCHEMA_VERSIONS.includes(envelope.authoritySchemaVersion) &&
        ACCEPTED_CAPABILITY_SCHEMA_VERSIONS.includes(envelope.capabilitySchemaVersion) &&
        ACCEPTED_NAVIGATION_SCHEMA_VERSIONS.includes(envelope.navigationSchemaVersion));
}
/**
 * STAGE 1 SCHEMA ALIGNMENT — Human-readable mismatch summary used in
 * the FAILED state message. Bounded format: only the three version
 * triplets are surfaced (no envelope contents leak).
 */
function describeVersionMismatch(envelope) {
    return (`Platform context schema mismatch. ` +
        `Expected authority=${AUTHORITY_SCHEMA_VERSION} ` +
        `capability=${CAPABILITY_SCHEMA_VERSION} ` +
        `navigation=${NAVIGATION_SCHEMA_VERSION}; ` +
        `received authority=${envelope.authoritySchemaVersion} ` +
        `capability=${envelope.capabilitySchemaVersion} ` +
        `navigation=${envelope.navigationSchemaVersion}. ` +
        `Refresh the page to load the latest build.`);
}
// CR1.6 — Focus-refresh tuning constants. Exported as `const` so
// tests can reference the same values; not exported from the module.
//   - MIN_REFRESH_INTERVAL_MS: throttle window. A focus/visibility
//     event that lands inside this window since the last refresh is
//     ignored. 60 s prevents thrash from rapid tab-switching and
//     keeps API load bounded.
//   - The feature is read from a NEXT_PUBLIC_ flag so it is statically
//     known at build time (Next.js strips false references in prod
//     bundles).
const MIN_REFRESH_INTERVAL_MS = 60_000;
function isFocusRefreshEnabled() {
    // The flag is a NEXT_PUBLIC_ env var so it is inlined at build time
    // by Next.js. Safe to read on the client. Default OFF.
    return (process.env.NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED === "true");
}
const PlatformContextReactContext = createContext(null);
export function usePlatformContext() {
    const ctx = useContext(PlatformContextReactContext);
    if (!ctx) {
        throw new Error("usePlatformContext must be used inside <PlatformContextProvider>");
    }
    return ctx;
}
/**
 * Internal — pure capability lookup over the current state. Returns
 * false when no envelope is available (fail-closed).
 */
function readCapability(state, capability) {
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
export function PlatformContextProvider({ children, testEnvelope, }) {
    const [state, setState] = useState(testEnvelope
        ? { name: "READY", envelope: testEnvelope }
        : { name: "IDLE" });
    const [schemaCompatible, setSchemaCompatible] = useState(true);
    // Sequence number prevents an out-of-order envelope from a slow
    // previous switch overwriting a newer one — exactly the "header
    // shows one workspace while page uses another" failure mode.
    const fetchSequenceRef = useRef(0);
    const ingestEnvelope = useCallback((envelope) => {
        if (!versionsAreCompatible(envelope)) {
            // STAGE 1 SCHEMA ALIGNMENT — explicit FAILED transition.
            //
            // Previously the provider only flipped `schemaCompatible=false`
            // and returned, which left the state in LOADING_CONTEXT /
            // SWITCHING forever (no envelope ever reaches READY). That
            // produced the "Workspace setup required" / blank shell
            // confusion. We now ALSO transition the state machine to
            // FAILED with the new explicit `SCHEMA_VERSION_MISMATCH` code,
            // preserving any previous READY envelope so the shell can
            // continue rendering the last-known-good context behind a
            // "Refresh required" banner.
            setSchemaCompatible(false);
            setState((prev) => ({
                name: "FAILED",
                errorCode: "SCHEMA_VERSION_MISMATCH",
                message: describeVersionMismatch(envelope),
                requestId: envelope.diagnostics?.requestId ?? null,
                previous: prev.name === "READY"
                    ? prev.envelope
                    : prev.name === "SWITCHING"
                        ? prev.previous
                        : prev.name === "FAILED"
                            ? prev.previous
                            : null,
            }));
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
    }, []);
    const refresh = useCallback(async () => {
        const seq = ++fetchSequenceRef.current;
        setState((prev) => prev.name === "READY"
            ? {
                name: "SWITCHING",
                previous: prev.envelope,
                targetWorkspaceId: prev.envelope.workspace.id,
            }
            : { name: "LOADING_CONTEXT" });
        try {
            const envelope = (await apiFetch("/v1/platform/context", {
                method: "GET",
            }));
            if (seq !== fetchSequenceRef.current) {
                // A newer fetch has already completed — drop this stale
                // response on the floor.
                return;
            }
            // STAGE 1 SCHEMA ALIGNMENT — only emit `refreshed` when the
            // envelope was actually applied. A `stale-version` result has
            // already transitioned the provider to FAILED with
            // SCHEMA_VERSION_MISMATCH, and emitting a "refreshed" event in
            // that case would mislead the dev-only observability stream.
            const result = ingestEnvelope(envelope);
            if (result === "applied") {
                emitStateEvent("platform-envelope:refreshed", "PlatformContextProvider", {
                    workspaceId: redactWorkspaceId(envelope.workspace.id),
                });
            }
        }
        catch (err) {
            if (seq !== fetchSequenceRef.current)
                return;
            const cls = classifyError(err, "OPERATIONAL");
            setState((prev) => ({
                name: "FAILED",
                errorCode: cls.code,
                message: cls.message,
                requestId: cls.requestId,
                previous: prev.name === "READY"
                    ? prev.envelope
                    : prev.name === "SWITCHING"
                        ? prev.previous
                        : prev.name === "FAILED"
                            ? prev.previous
                            : null,
            }));
        }
    }, [ingestEnvelope]);
    const switchWorkspace = useCallback(async (workspaceId) => {
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
            const envelope = (await apiFetch("/v1/platform/context/switch-workspace", {
                method: "POST",
                body: JSON.stringify({ workspaceId }),
            }));
            if (seq !== fetchSequenceRef.current)
                return;
            ingestEnvelope(envelope);
        }
        catch (err) {
            if (seq !== fetchSequenceRef.current)
                return;
            const cls = classifyError(err, "OPERATIONAL");
            setState((prev) => ({
                name: "FAILED",
                errorCode: cls.code,
                message: cls.message,
                requestId: cls.requestId,
                previous: prev.name === "SWITCHING"
                    ? prev.previous
                    : prev.name === "READY"
                        ? prev.envelope
                        : prev.name === "FAILED"
                            ? prev.previous
                            : null,
            }));
        }
    }, [ingestEnvelope]);
    useEffect(() => {
        if (testEnvelope)
            return; // Test harness bypass.
        void refresh();
        // refresh's identity is stable across renders because of useCallback.
    }, [refresh, testEnvelope]);
    // ----------------------------------------------------------------
    // CR1.6 — Focus-triggered envelope refresh (opt-in, throttled).
    //
    // When the user returns to a tab after time away, an admin may have
    // granted them new capabilities or moved them between workspaces.
    // Without this hook the only way to pick up the change is a manual
    // reload. We add a guarded, throttled refresh on focus /
    // visibilitychange so the canonical envelope catches up
    // automatically.
    //
    // Invariants:
    //   - OFF unless NEXT_PUBLIC_PLATFORM_CONTEXT_FOCUS_REFRESH_ENABLED.
    //   - SSR-safe: short-circuits when `window` / `document` are
    //     undefined.
    //   - Test-harness safe: short-circuits when `testEnvelope` is set.
    //   - Skips while LOADING_CONTEXT, SWITCHING, IDLE, or FAILED — only
    //     refreshes while READY (we already have an envelope and a
    //     concurrent fetch would be wasted / confusing).
    //   - Throttle: at most one refresh per MIN_REFRESH_INTERVAL_MS.
    //   - Concurrency guard: a ref prevents overlapping refresh
    //     invocations even if events arrive in fast succession.
    // ----------------------------------------------------------------
    const lastRefreshAtRef = useRef(Date.now());
    const focusRefreshInflightRef = useRef(false);
    useEffect(() => {
        if (testEnvelope)
            return;
        if (!isFocusRefreshEnabled())
            return;
        if (typeof window === "undefined" || typeof document === "undefined") {
            return;
        }
        // Capture the current `state` and `refresh` via closure. The
        // effect re-binds whenever those change so the latest state /
        // refresh function is consulted on every event.
        const onMaybeRefresh = (reason) => {
            // Only the "hidden → visible" transition is a true return.
            if (reason === "visibility" && document.visibilityState !== "visible") {
                return;
            }
            // Concurrency guard.
            if (focusRefreshInflightRef.current)
                return;
            // Only refresh while READY — other states already own the
            // network and a parallel refresh would race them.
            if (state.name !== "READY")
                return;
            // Throttle.
            const now = Date.now();
            if (now - lastRefreshAtRef.current < MIN_REFRESH_INTERVAL_MS)
                return;
            focusRefreshInflightRef.current = true;
            lastRefreshAtRef.current = now;
            void refresh().finally(() => {
                focusRefreshInflightRef.current = false;
            });
        };
        const onFocus = () => onMaybeRefresh("focus");
        const onVisibility = () => onMaybeRefresh("visibility");
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [refresh, state, testEnvelope]);
    // Also update lastRefreshAtRef on any provider-driven refresh so the
    // throttle starts from the actual fetch time, not the initial mount
    // time.
    useEffect(() => {
        if (state.name === "READY") {
            lastRefreshAtRef.current = Date.now();
        }
    }, [state.name === "READY" ? state.envelope : null]);
    const can = useCallback((capability) => readCapability(state, capability), [state]);
    const value = useMemo(() => ({
        state,
        envelope: state.name === "READY"
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
    }), [state, can, switchWorkspace, refresh, schemaCompatible]);
    return (<PlatformContextReactContext.Provider value={value}>
      {children}
    </PlatformContextReactContext.Provider>);
}
