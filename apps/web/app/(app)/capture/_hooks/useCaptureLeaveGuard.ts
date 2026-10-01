"use client";

import { useEffect } from "react";
import { useDirtyWork } from "../../../../lib/platform-context/dirtyWorkRegistry";

/**
 * Capture — the ONE leave-page / workspace-switch guard (UC-WEB-002).
 *
 * Work is at risk when material is staged OR when a finalize/upload is in
 * flight. The previous inline condition was `items > 0 && !busy`, which
 * switched both guards OFF for the whole finalize — exactly the window in
 * which leaving the page (or switching workspace) loses in-flight bytes and
 * can orphan a reserved record. The success path clears the staged items
 * before it navigates, so guarding while busy never produces a false prompt.
 */
export function captureWorkAtRisk(stagedItemCount: number, busy: boolean): boolean {
  return stagedItemCount > 0 || busy;
}

export const CAPTURE_DIRTY_WORK_LABEL = "Staged evidence in Capture";

export function useCaptureLeaveGuard(stagedItemCount: number, busy: boolean): void {
  const atRisk = captureWorkAtRisk(stagedItemCount, busy);

  useEffect(() => {
    if (!atRisk) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [atRisk]);

  // `beforeunload` only fires on real browser navigation; an in-app
  // WORKSPACE SWITCH is an envelope swap that never triggers it. Register in
  // the dirty-work registry so the context switcher demands confirmation
  // before staged or in-flight evidence could finalize into another tenant.
  useDirtyWork(atRisk, CAPTURE_DIRTY_WORK_LABEL);
}
