import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { clearAllDirtyWork } from "../../lib/platform-context/dirtyWorkRegistry";
import { clearHealWithheld } from "../../lib/platform-context/personalSpaceHealLatch";

// PHASE 7 render harness — unmount + clear jsdom storage between tests so
// tenant-keyed drafts and the module-level dirty registry never leak.
afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* jsdom storage may be absent in a degraded env */
  }
  // PHASE 10 FIX 3 — reset the module-level singletons (dirty-work registry +
  // heal-withhold latch) so one test's withheld state never bleeds into the
  // next test's panel/gate.
  clearAllDirtyWork();
  clearHealWithheld();
});
