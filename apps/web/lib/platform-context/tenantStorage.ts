"use client";

/**
 * PHASE 7 §10.2/§10.3 (2026-07-22) — tenant-scoped storage + in-flight
 * isolation, built on the canonical tenant generation exposed by
 * PlatformContextProvider.
 *
 * §10.2 — drafts and cached state must be keyed by the active workspace
 * so that switching tenants NEVER surfaces the previous tenant's data.
 * `tenantStorageKey` namespaces every key; `useTenantDraft` reads/writes
 * localStorage under the tenant-scoped key, so a workspace switch changes
 * the key and the old tenant's value is structurally invisible (and can
 * be actively purged).
 *
 * §10.3 — `useTenantGuard` returns a stamp of the current generation and
 * an `isStale(stamp)` predicate; async callers capture the stamp before
 * awaiting and drop the result if the tenant changed underneath them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePlatformContext } from "./PlatformContextProvider";
import { useDirtyWork as useDirtyWorkModule } from "./dirtyWorkRegistry";

const NS = "proovra:tenant";

/**
 * Namespaced storage key for a workspace-scoped value. `null`
 * workspace id (no READY envelope yet) yields a `:none:` namespace so a
 * pre-context write never collides with a real tenant.
 */
export function tenantStorageKey(
  workspaceId: string | null,
  baseKey: string,
): string {
  return `${NS}:${workspaceId ?? "none"}:${baseKey}`;
}

function readRaw(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Quota/security errors are non-fatal for draft persistence.
  }
}

/**
 * Tenant-scoped draft persisted to localStorage. The value is bound to
 * the ACTIVE workspace: when the tenant changes, the hook re-reads under
 * the new tenant's key (yielding that tenant's own draft or the default)
 * and never leaks the prior tenant's draft. Optionally purges the prior
 * tenant's entry on switch.
 */
export function useTenantDraft<T>(
  baseKey: string,
  defaultValue: T,
  options: { purgePriorTenantOnSwitch?: boolean } = {},
): {
  value: T;
  setValue: (next: T) => void;
  clear: () => void;
  activeWorkspaceId: string | null;
} {
  const { activeWorkspaceId } = usePlatformContext();
  const storageKey = tenantStorageKey(activeWorkspaceId, baseKey);
  const priorKeyRef = useRef<string | null>(null);

  const load = useCallback((): T => {
    const raw = readRaw(storageKey);
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
    // defaultValue intentionally not a dep — it is the initial fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const [value, setValueState] = useState<T>(load);

  // Re-load whenever the tenant-scoped key changes (workspace switch).
  // §10.2 — old tenant data disappears immediately; optionally purge it.
  useEffect(() => {
    if (
      options.purgePriorTenantOnSwitch &&
      priorKeyRef.current &&
      priorKeyRef.current !== storageKey
    ) {
      writeRaw(priorKeyRef.current, null);
    }
    priorKeyRef.current = storageKey;
    setValueState(load());
  }, [storageKey, load, options.purgePriorTenantOnSwitch]);

  const setValue = useCallback(
    (next: T) => {
      setValueState(next);
      writeRaw(storageKey, JSON.stringify(next));
    },
    [storageKey],
  );

  const clear = useCallback(() => {
    setValueState(defaultValue);
    writeRaw(storageKey, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  return { value, setValue, clear, activeWorkspaceId };
}

/**
 * In-flight tenant guard (§10.3). Capture `stamp()` before an async
 * operation and check `isStale(stamp)` after awaiting — a tenant switch
 * between capture and resolution makes the result stale, so the caller
 * drops it rather than applying another tenant's data into this one.
 */
export function useTenantGuard(): {
  stamp: () => number;
  isStale: (captured: number) => boolean;
  generation: number;
} {
  const { contextGeneration } = usePlatformContext();
  const genRef = useRef(contextGeneration);
  genRef.current = contextGeneration;

  const stamp = useCallback(() => genRef.current, []);
  const isStale = useCallback((captured: number) => captured !== genRef.current, []);

  return useMemo(
    () => ({ stamp, isStale, generation: contextGeneration }),
    [stamp, isStale, contextGeneration],
  );
}

/**
 * PHASE 7 §10 — one composed hook a workspace-scoped mutation surface
 * adopts to get the full context-safety bundle: registers dirty work
 * (§10.1) while `isDirty`, exposes the tenant stale-guard (§10.3), and
 * surfaces `activeWorkspaceId` for draft keying (§10.2). Pairs with
 * <WorkspaceContextBanner> for §10.5. Composes the existing primitives —
 * never a competing mechanism.
 *
 * Usage:
 *   const { runGuarded } = useWorkspaceContextSafety({ isDirty, dirtyLabel });
 *   await runGuarded(() => apiFetch(...), (result) => applyToState(result));
 * `runGuarded` drops the result if the tenant changed mid-flight.
 */
export function useWorkspaceContextSafety(opts: {
  isDirty: boolean;
  dirtyLabel: string;
}): {
  activeWorkspaceId: string | null;
  isStale: (captured: number) => boolean;
  stamp: () => number;
  runGuarded: <T>(
    op: () => Promise<T>,
    apply: (result: T) => void,
  ) => Promise<void>;
} {
  // Register dirty work while the surface holds unsaved workspace state.
  useDirtyWorkModule(opts.isDirty, opts.dirtyLabel);
  const { activeWorkspaceId } = usePlatformContext();
  const { stamp, isStale } = useTenantGuard();

  const runGuarded = useCallback(
    async <T>(op: () => Promise<T>, apply: (result: T) => void) => {
      const captured = stamp();
      const result = await op();
      // §10.3 — the tenant changed under us; drop the stale result rather
      // than applying another tenant's data into the current context.
      if (isStale(captured)) return;
      apply(result);
    },
    [stamp, isStale],
  );

  return { activeWorkspaceId, isStale, stamp, runGuarded };
}
