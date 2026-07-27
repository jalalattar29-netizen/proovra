"use client";

/**
 * P3 DOMAIN REMEDIATION (2026-07-21) — dirty-work registry for
 * tenant-boundary transitions.
 *
 * Switching workspace is a TENANT change: unsaved workspace-scoped work
 * (staged capture material, a half-written case, an in-progress report)
 * must never silently carry across the boundary. Surfaces that hold such
 * state register here; the switcher consults the registry BEFORE calling
 * the switch mutation and requires an explicit confirmation naming the
 * work that would be left behind.
 *
 * Module-level singleton (not React context) so the App Shell toolbar and
 * deeply-nested pages share it without provider plumbing; entries are
 * removed on unmount via the hook's cleanup.
 */

import { useEffect, useSyncExternalStore } from "react";

const entries = new Map<string, string>();
let nextId = 0;

// PHASE 10 CLOSURE FIX 3 (2026-07-23) — reactive subscription layer over the
// canonical registry. The manual switcher (AppAccountToolbar) reads the
// registry synchronously inside a click handler and never needed
// reactivity. The AUTOMATIC no-Personal heal (usePersonalSpaceGate) runs in
// an effect, so it must (a) refuse to switch while dirty work exists and
// (b) re-evaluate when that work is explicitly resolved. This adds a
// listener set + a stable snapshot so an effect can subscribe — WITHOUT
// forking a second registry. `getDirtyWorkLabels()` (the existing
// synchronous getter) still returns the live truth for the switcher.
const listeners = new Set<() => void>();
let snapshot: readonly string[] = [];

function emitChange(): void {
  // Recompute a fresh immutable snapshot so subscribers see a NEW reference
  // only when the set actually changed (useSyncExternalStore identity).
  snapshot = Object.freeze(Array.from(entries.values()));
  for (const listener of listeners) listener();
}

export function registerDirtyWork(label: string): () => void {
  const id = `dirty-${++nextId}`;
  entries.set(id, label);
  emitChange();
  return () => {
    if (entries.delete(id)) emitChange();
  };
}

/** Labels of all currently-dirty surfaces (empty = safe to switch). */
export function getDirtyWorkLabels(): string[] {
  return Array.from(entries.values());
}

/**
 * PHASE 10 CLOSURE FIX 3 — force-clear every registered entry. Used ONLY by
 * the no-Personal gate's EXPLICIT "discard unsaved work and continue"
 * resolution (the operator has consciously chosen to abandon the staged
 * work). The tenant-keyed drafts in localStorage are unaffected and remain
 * keyed to their original workspace. Not for casual use — normal cleanup
 * happens per-surface via the hook's unmount path.
 */
export function clearAllDirtyWork(): void {
  if (entries.size === 0) return;
  entries.clear();
  emitChange();
}

/**
 * Subscribe to registry changes. Returns an unsubscribe fn. Used by
 * `useDirtyWorkLabels` (below) and any effect that must react to unsaved
 * workspace-scoped work appearing/clearing.
 */
export function subscribeDirtyWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly string[] {
  return snapshot;
}

/**
 * Reactive read of the current dirty-work labels. Re-renders the caller
 * whenever a surface registers or clears dirty work. SSR-safe (the server
 * snapshot is the same stable empty array).
 */
export function useDirtyWorkLabels(): readonly string[] {
  return useSyncExternalStore(subscribeDirtyWork, getSnapshot, getSnapshot);
}

/**
 * Declarative hook — register while `isDirty` is true. The label should
 * name the work in operator terms (e.g. "Staged evidence in Capture").
 */
export function useDirtyWork(isDirty: boolean, label: string): void {
  useEffect(() => {
    if (!isDirty) return undefined;
    return registerDirtyWork(label);
  }, [isDirty, label]);
}
