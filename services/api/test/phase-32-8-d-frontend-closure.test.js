/**
 * Phase 32.8D-frontend-closure — RETIRED (canonical replacement: Phase C1).
 *
 * The original 32.8D-closure file asserted internals of the legacy
 * `components/cases-experience/CaseWorkspace.tsx` — the classic
 * scroll-spy / section-anchor / direct-unlink workspace flow that
 * Phase G4.2 retired. Phase C1.1 deleted the file outright when the
 * canonical `MatterWorkspace.tsx` (a tabbed workspace with a
 * fundamentally different internal structure) took over `/cases/[id]`.
 *
 * Every positive shape-assertion in this file referenced patterns
 * that exist only on the deleted CaseWorkspace component:
 *   * SECTION_*  jump-nav anchors + IntersectionObserver scroll spy
 *   * data-matter-section-*  data attributes on the 11-section view
 *   * openUnlinkEvidenceConfirm / removeEvidenceLink wiring on
 *     Evidence Board rows
 *   * env-driven viewer.canChangeStatus / canAssign reads
 *
 * The canonical contract — that the `/cases/[id]` surface mounts the
 * `MatterWorkspace` component (rather than CaseWorkspace), that the
 * tabbed view declares the canonical tabs, and that the workspace
 * never surfaces signed URLs or makes legal-admissibility claims —
 * is asserted by `phase-c1-matter-workspace.test.ts` and
 * `phase-32-8-d-frontend-matter-workspace.test.ts` (the canonical
 * Matter Workspace contract files).
 *
 * The replacement assertion below records the canonical state so the
 * file's continued presence in the test tree is honest about scope:
 * it now exists only to declare "the legacy CaseWorkspace is gone and
 * its successor is asserted elsewhere".
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
describe("Phase 32.8D-frontend-closure — RETIRED (canonical replacement: Phase C1)", () => {
    it("the legacy CaseWorkspace.tsx is deleted and the canonical MatterWorkspace.tsx exists", () => {
        // Phase C1.1 retired the legacy classic workspace. Its successor
        // — the canonical tabbed `MatterWorkspace` — lives at the path
        // below and is covered by `phase-c1-matter-workspace.test.ts`.
        const legacy = fileURLToPath(new URL("../../../apps/web/components/cases-experience/CaseWorkspace.tsx", import.meta.url));
        const canonical = fileURLToPath(new URL("../../../apps/web/components/cases-experience/MatterWorkspace.tsx", import.meta.url));
        expect(existsSync(legacy)).toBe(false);
        expect(existsSync(canonical)).toBe(true);
    });
});
