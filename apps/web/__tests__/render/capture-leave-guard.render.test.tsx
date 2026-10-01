import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useCaptureLeaveGuard } from "../../app/(app)/capture/_hooks/useCaptureLeaveGuard";
import { useDirtyWorkLabels } from "../../lib/platform-context/dirtyWorkRegistry";

/**
 * UC-WEB-002 — the capture page must keep its leave-page and workspace-switch
 * guards ON while uploading/finalizing (busy), the only window in which leaving
 * loses in-flight work.
 */
function dispatchBeforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("useCaptureLeaveGuard", () => {
  it("prevents unload while busy (finalize in flight) with staged items", () => {
    renderHook(() => useCaptureLeaveGuard(3, true));
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });

  it("registers dirty work for the workspace switcher while busy", () => {
    const { result } = renderHook(() => {
      useCaptureLeaveGuard(2, true);
      return useDirtyWorkLabels();
    });
    expect(result.current).toContain("Staged evidence in Capture");
  });

  it("prevents unload with staged items when idle", () => {
    renderHook(() => useCaptureLeaveGuard(1, false));
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
  });

  it("does not prompt with nothing staged and nothing in flight", () => {
    const { result } = renderHook(() => {
      useCaptureLeaveGuard(0, false);
      return useDirtyWorkLabels();
    });
    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
    expect(result.current).toEqual([]);
  });

  it("the capture page uses this one guard (no second inline guard)", () => {
    const page = readFileSync(resolve(__dirname, "../../app/(app)/capture/page.tsx"), "utf8");
    expect(page).toMatch(/useCaptureLeaveGuard\(sessionItems\.length, busy\)/);
    expect(page).not.toMatch(/hasStagedMaterials/);
    expect(page).not.toMatch(/useDirtyWork\(/);
    expect(page).not.toMatch(/addEventListener\("beforeunload"/);
  });
});
