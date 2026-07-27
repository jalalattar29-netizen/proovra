"use client";

/**
 * PHASE 10 CLOSURE FIX 3 (2026-07-23) — heal-withhold latch (coordination
 * glue between usePersonalSpaceGate and PersonalSpaceUnavailablePanel).
 *
 * This is NOT a second dirty-work registry and it never re-derives policy.
 * It records a single fact the GATE decides — "the automatic no-Personal
 * heal is currently WITHHELD because unsaved workspace-scoped work (per the
 * canonical dirtyWorkRegistry) was present the moment the heal became
 * warranted" — plus the operator-facing labels of that work, so the PANEL
 * can show them and offer the ONE explicit release action.
 *
 * Why a module singleton (same shape as dirtyWorkRegistry): the gate lives
 * in AppShellV2 while the panel is a sibling it renders; they share this
 * latch without provider plumbing. The latch must survive the dirty surface
 * unmounting (the panel replaces the page content, so the capture/form's own
 * `useDirtyWork` cleanup fires and empties the registry). Without the latch,
 * that unmount would silently release the switch — exactly the bypass this
 * fix closes.
 */

import { useSyncExternalStore } from "react";

export type HealWithheldState = {
  withheld: boolean;
  labels: readonly string[];
};

const EMPTY: HealWithheldState = Object.freeze({ withheld: false, labels: Object.freeze([]) });

let state: HealWithheldState = EMPTY;
const stateListeners = new Set<() => void>();
const releaseListeners = new Set<() => void>();

function emitState(): void {
  for (const listener of stateListeners) listener();
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Gate → latch: the heal is withheld pending explicit resolution. */
export function markHealWithheld(labels: readonly string[]): void {
  if (state.withheld && sameLabels(state.labels, labels)) return;
  state = Object.freeze({ withheld: true, labels: Object.freeze([...labels]) });
  emitState();
}

/** Gate → latch: the heal is no longer withheld (clean, or released, or done). */
export function clearHealWithheld(): void {
  if (!state.withheld) return;
  state = EMPTY;
  emitState();
}

export function getHealWithheldState(): HealWithheldState {
  return state;
}

export function subscribeHealWithheld(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Reactive read for the panel. */
export function useHealWithheld(): HealWithheldState {
  return useSyncExternalStore(
    subscribeHealWithheld,
    getHealWithheldState,
    getHealWithheldState,
  );
}

/**
 * Panel → gate: the operator explicitly chose to discard the unsaved
 * workspace-scoped work and continue. The gate's subscription clears the
 * dirty registry and lets the (now clean) heal proceed.
 */
export function requestHealRelease(): void {
  for (const listener of releaseListeners) listener();
}

export function subscribeHealRelease(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}
