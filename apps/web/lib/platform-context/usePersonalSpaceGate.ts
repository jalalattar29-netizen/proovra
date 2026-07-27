"use client";

/**
 * PHASE 10 CLOSURE — FIX 3 (2026-07-23).
 *
 * Client-side driver for `resolvePersonalSpaceGate` (./personalSpaceGate.ts).
 * Mounted once at the App Shell level (AppShellV2) so EVERY (app) route
 * inherits the same protection without each page re-implementing it.
 *
 * Behavior:
 *   - "none"        — render children normally.
 *   - "heal"        — fire a single `switchWorkspace(targetWorkspaceId)`
 *                      attempt (never repeated for the same target — a
 *                      failed switch does not loop) and render the
 *                      canonical unavailable state while it's in flight.
 *                      Once the switch lands, the envelope's active
 *                      context is no longer Personal, the gate re-resolves
 *                      to "none", and children render.
 *   - "unavailable" — render the canonical unavailable state. No heal
 *                      target exists (or the single heal attempt already
 *                      ran) — the client NEVER falls back to Personal
 *                      content and NEVER redirects into another tenant.
 *
 * PHASE 10 CLOSURE FIX 3 — DIRTY-WORK INTEGRATION. A workspace switch is a
 * tenant-boundary change, so the automatic heal obeys the SAME canonical
 * Phase-7 dirty-work registry (dirtyWorkRegistry.ts) the manual switcher
 * (AppAccountToolbar) already consults. While any surface holds unsaved
 * workspace-scoped work (staged capture material, a dirty form, an active
 * upload), the heal is WITHHELD — the client never silently rebinds the
 * context:
 *
 *   - The withhold decision is made from the RENDER-phase dirty snapshot,
 *     not a fresh read in an effect. This is deliberate: showing the panel
 *     unmounts the dirty page, whose `useDirtyWork` cleanup empties the
 *     registry in the SAME commit BEFORE any parent effect runs — a fresh
 *     effect-time read would therefore always see zero and release the
 *     switch (a delayed silent switch). The render snapshot still reflects
 *     the dirty work because it predates that unmount.
 *   - Once withheld we LATCH: subsequent registry emptying (from the
 *     unmount) cannot release the heal. Only an EXPLICIT operator action
 *     does — the panel's "Discard unsaved work and continue" fires
 *     `requestHealRelease()`, which clears the registry and lets the now-
 *     clean heal proceed (behavior A).
 *   - The tenant-keyed draft (tenantStorage.ts) stays under the original
 *     Personal workspace key; contextGeneration is never bumped while
 *     withheld, so no in-flight request can commit into a switched context.
 */

import { useEffect, useRef, useState } from "react";

const EMPTY_LABELS: readonly string[] = Object.freeze([]);

import { usePlatformContext } from "./PlatformContextProvider";
import { resolvePersonalSpaceGate } from "./personalSpaceGate";
import {
  clearAllDirtyWork,
  useDirtyWorkLabels,
} from "./dirtyWorkRegistry";
import {
  clearHealWithheld,
  markHealWithheld,
  subscribeHealRelease,
} from "./personalSpaceHealLatch";

/**
 * The hook's own (simplified) result — "heal" is an internal transient of
 * `resolvePersonalSpaceGate`; from the shell's point of view it collapses
 * into "blocked" (never render Personal content) until the switch lands.
 */
export type PersonalSpaceGateRenderState = "allowed" | "blocked";

export function usePersonalSpaceGate(): PersonalSpaceGateRenderState {
  const { envelope, state, switchWorkspace } = usePlatformContext();

  // PHASE 10 CLOSURE FIX 3 — reactive read of the canonical dirty-work
  // registry. The snapshot is captured DURING render (before the panel-swap
  // unmount can empty it) and drives the withhold decision below.
  const dirtyLabels = useDirtyWorkLabels();

  // Per-target de-dup so a failed switch never loops.
  const [attempted] = useState<Set<string>>(() => new Set());
  // SYNCHRONOUS latch (see below) — a ref so it is set/read within the same
  // render, immune to the setState/deregister race.
  const latchRef = useRef(false);
  const latchedLabelsRef = useRef<readonly string[]>(EMPTY_LABELS);
  // Explicit operator release (panel action) — permits the withheld heal.
  const [released, setReleased] = useState(false);

  const gate = envelope
    ? resolvePersonalSpaceGate({
        activeSpace: envelope.activeSpace ?? null,
        personalSpaceAllowed: envelope.personalSpaceAllowed,
        contextOptions: envelope.contextOptions ?? null,
      })
    : { action: "none" as const };

  const healWarranted = gate.action === "heal";
  const healTargetId = healWarranted ? gate.targetWorkspaceId : null;

  // Render-phase observation: dirty work present at the moment a heal is
  // warranted. Captured here (not in an effect) so the dirty page unmount
  // that the panel triggers cannot erase it first.
  // SYNCHRONOUS latch (ref, set DURING render — never an effect). Once dirty
  // work is observed while a heal is warranted, we latch immediately so the
  // withhold survives the very next render — the one the panel-swap triggers by
  // unmounting the dirty surface (which empties the registry). An effect-based
  // latch loses this race: the deregister re-render can outrun setState and the
  // heal fires before the latch commits. The ref closes that window. It resets
  // only when there is nothing left to heal (fresh/healed context).
  if (!healWarranted) {
    latchRef.current = false;
    latchedLabelsRef.current = EMPTY_LABELS;
  } else if (dirtyLabels.length > 0) {
    latchRef.current = true;
    latchedLabelsRef.current = dirtyLabels;
  }
  const withholding = latchRef.current && !released;

  // Subscribe once to the explicit release bus (panel → gate).
  useEffect(() => {
    return subscribeHealRelease(() => {
      // The operator consciously abandons the staged work; clear it and let
      // the now-clean heal fire on the next effect pass.
      clearAllDirtyWork();
      setReleased(true);
    });
  }, []);

  // Reset the explicit-release flag once there is nothing left to heal (the
  // heal completed or Personal became allowed again) so a future policy flip
  // starts fresh. The LATCH itself resets synchronously in render (above).
  useEffect(() => {
    if (!healWarranted && released) setReleased(false);
  }, [healWarranted, released]);

  // Publish the withhold state (+ the labels captured at latch time) so the
  // panel can show the work and offer the single release action.
  useEffect(() => {
    if (withholding) {
      markHealWithheld(latchedLabelsRef.current);
      // labels come from the latch-time capture — never overwritten with []
      // when the dirty page unmounts.
    } else {
      clearHealWithheld();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withholding]);

  // The heal itself.
  useEffect(() => {
    if (!healTargetId) return;
    // Only heal from a settled READY state — SWITCHING/LOADING already own
    // the network, and a parallel switchWorkspace call would race them.
    if (state.name !== "READY") return;
    // DIRTY-WORK GUARD — withhold while unsaved workspace-scoped work was (or
    // is) present, unless the operator explicitly released it. `withholding`
    // uses the render snapshot + latch, closing the unmount-order race a
    // fresh effect-time read would leave open.
    if (withholding) return;
    if (attempted.has(healTargetId)) return;
    attempted.add(healTargetId);
    void switchWorkspace(healTargetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healTargetId, state.name, withholding]);

  // While a heal is warranted (in flight, withheld, or exhausted) the client
  // must never render Personal content — surface the "blocked" treatment,
  // the same as the true no-alternative case.
  return gate.action === "none" ? "allowed" : "blocked";
}
