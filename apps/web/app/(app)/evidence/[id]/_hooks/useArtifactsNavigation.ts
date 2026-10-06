"use client";

/**
 * THE ONE WAY TO SEND SOMEONE TO ARTIFACTS — open the tab, then move focus to
 * the section the summary was about (truth header, progress card, recovery
 * state or version history).
 *
 * It drives the page's existing tab state; it adds no route and no history
 * entry, so Back/Forward behave exactly as they do for a tab click and a copied
 * Evidence URL stays valid. `?tab=artifacts&focus=progress` deep-links the same
 * landing (the page already reads `?tab=`).
 *
 * Focus is moved after the tab has rendered (an effect runs after commit), and
 * only once the record is loaded. The first matching selector wins, so a
 * section an older API does not render falls back to the next truthful one.
 */

import { useCallback, useEffect, useState } from "react";

import type { ArtifactsFocusTarget } from "../../../../../components/evidence-outputs/output-attention";

const TRUTH = '[data-testid="artifact-truth-header"]';
const HISTORY = '[data-testid="matched-version-history"], .evidence-detail-artifacts';
const PROGRESS =
  '[data-testid="output-progress"], [data-evidence-section="reports-queued"], [data-evidence-section="reports-generating"], [data-evidence-section="reports-new-version-in-flight"], [data-evidence-section="package-recovery-in-flight"]';
const RECOVERY =
  '[data-evidence-section="package-recovery"], [data-evidence-section="reports-retryable-failure"], [data-evidence-section="reports-terminal-failure"], [data-evidence-section="reports-blocked"], [data-evidence-section="reports-integrity-failed"], [data-evidence-section="reports-eligible-not-generated"], [data-evidence-section="reports-ready-actions"]';

export const ARTIFACTS_FOCUS_ORDER: Record<ArtifactsFocusTarget, string[]> = {
  status: [TRUTH, RECOVERY, PROGRESS, HISTORY],
  progress: [PROGRESS, TRUTH, RECOVERY, HISTORY],
  recovery: [RECOVERY, PROGRESS, TRUTH, HISTORY],
  history: [HISTORY, TRUTH],
};

const TARGETS = new Set<string>(Object.keys(ARTIFACTS_FOCUS_ORDER));

export function findArtifactsFocusTarget(root: ParentNode, focus: ArtifactsFocusTarget): HTMLElement | null {
  for (const selector of ARTIFACTS_FOCUS_ORDER[focus]) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

export function useArtifactsNavigation<Tab extends string>({
  activeTab,
  setActiveTab,
  ready,
  initialFocus,
}: {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  /** The record (and so the Artifacts tab body) has loaded. */
  ready: boolean;
  /** `?focus=` from the URL, honoured when the page opened on Artifacts. */
  initialFocus?: string | null;
}): (focus?: ArtifactsFocusTarget) => void {
  // Only a page that OPENED on Artifacts honours `?focus=`; a later manual
  // tab click must not jump somewhere the person did not ask for.
  const [pending, setPending] = useState<ArtifactsFocusTarget | null>(() =>
    activeTab === "artifacts" && initialFocus && TARGETS.has(initialFocus)
      ? (initialFocus as ArtifactsFocusTarget)
      : null,
  );

  const openArtifacts = useCallback(
    (focus: ArtifactsFocusTarget = "status") => {
      setActiveTab("artifacts" as Tab);
      setPending(focus);
    },
    [setActiveTab],
  );

  useEffect(() => {
    if (!pending || !ready || activeTab !== "artifacts") return;
    setPending(null);
    const el = findArtifactsFocusTarget(document, pending);
    if (!el) return;
    // A section is not a control: focusable programmatically, not in tab order.
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "start" });
  }, [pending, ready, activeTab]);

  return openArtifacts;
}
