/**
 * PHASE 7 §10.2/§10.3 (2026-07-22) — tenant isolation primitives.
 *
 * Behavioral: tenantStorageKey namespaces every draft/cache key by the
 * active workspace so switching tenants cannot surface the prior
 * tenant's data. Source-contract: the provider bumps `contextGeneration`
 * ONLY on an actual workspace-id change, and exposes activeWorkspaceId +
 * contextGeneration; the tenant helpers are barrel-exported.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tenantStorageKey } from "../lib/platform-context/tenantStorage";
import {
  registerDirtyWork,
  getDirtyWorkLabels,
} from "../lib/platform-context/dirtyWorkRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

test("tenantStorageKey namespaces by workspace; different tenants never collide", () => {
  const a = tenantStorageKey("ws-A", "capture-draft");
  const b = tenantStorageKey("ws-B", "capture-draft");
  assert.notEqual(a, b);
  assert.match(a, /^proovra:tenant:ws-A:capture-draft$/);
  // Pre-context writes land under a reserved namespace, never a real one.
  assert.equal(tenantStorageKey(null, "k"), "proovra:tenant:none:k");
});

test("provider bumps contextGeneration ONLY on workspace-id change", () => {
  const src = read("lib/platform-context/PlatformContextProvider.tsx");
  assert.match(src, /lastAppliedWorkspaceIdRef\.current !== envelope\.workspace\.id/);
  assert.match(src, /setContextGeneration\(\(g\) => g \+ 1\)/);
  // Both new fields are exposed on the context value.
  assert.match(src, /activeWorkspaceId:\s*activeEnvelope\?\.workspace\.id \?\? null/);
  assert.match(src, /contextGeneration,/);
});

test("tenant helpers + context-safety primitives are barrel-exported", () => {
  const barrel = read("lib/platform-context/index.ts");
  assert.match(barrel, /tenantStorageKey/);
  assert.match(barrel, /useTenantDraft/);
  assert.match(barrel, /useTenantGuard/);
  assert.match(barrel, /useWorkspaceContextSafety/);
  assert.match(barrel, /WorkspaceContextBanner/);
});

test("composed safety hook registers dirty work + guards on the tenant generation", () => {
  const src = read("lib/platform-context/tenantStorage.ts");
  // Composes the EXISTING dirty registry (not a competing mechanism).
  assert.match(src, /useDirtyWorkModule\(opts\.isDirty, opts\.dirtyLabel\)/);
  // runGuarded drops the result when the tenant changed mid-flight.
  assert.match(src, /if \(isStale\(captured\)\) return;/);
});

test("context banner reads the canonical envelope (no per-page tenant copy)", () => {
  const src = read("lib/platform-context/WorkspaceContextBanner.tsx");
  assert.match(src, /usePlatformContext\(\)/);
  assert.match(src, /contextOptions\?\.activeContext/);
  assert.match(src, /data-workspace-context-banner/);
});

test("dirty-work registry: registered labels gate the switch; cleanup clears them", () => {
  // Behavioral: a surface registers unsaved work → the switcher (which
  // reads getDirtyWorkLabels) sees it and must confirm before switching.
  const before = getDirtyWorkLabels().length;
  const releaseA = registerDirtyWork("Unsaved case");
  const releaseB = registerDirtyWork("Unsaved legal hold");
  const labels = getDirtyWorkLabels();
  assert.ok(labels.includes("Unsaved case"));
  assert.ok(labels.includes("Unsaved legal hold"));
  assert.equal(getDirtyWorkLabels().length, before + 2);
  // Unmount/clean the first surface — its label disappears, the other stays.
  releaseA();
  assert.ok(!getDirtyWorkLabels().includes("Unsaved case"));
  assert.ok(getDirtyWorkLabels().includes("Unsaved legal hold"));
  releaseB();
  assert.equal(getDirtyWorkLabels().length, before);
});

test("all 15 required Phase 7 surfaces compose the render-proven primitives", () => {
  // The shared primitives themselves have REAL render-level behavioral
  // coverage (__tests__/render/context-safety*.render.test.tsx: stale-
  // response, tenant-storage collision, banner identity, dirty-switch,
  // polling disposal, upload binding, capability gating, route healing).
  // Per the mandate, source-contract composition proof is valid ONCE the
  // primitive is render-verified — that is the case here.
  const surfaces: Array<[string, RegExp[]]> = [
    // [file, required markers]
    ["components/cases-experience/matter-modals/CreateCaseModal.tsx", [/useWorkspaceContextSafety\(/, /WorkspaceContextBanner/, /runGuarded\(/]],
    // CAPTURE proves tenant isolation by BLOCKING the boundary crossing, not
    // by narrating it.
    //
    // The banner rendered "Captured evidence will be stored in Personal Space
    // · Personal Space" above the page title — the workspace named twice, in
    // weaker type, under an app header that already names it. It was removed
    // as redundant copy (a7ec4b57); the shared component is untouched and
    // still wired on the eight surfaces that need it.
    //
    // The Phase 7 guarantee is unaffected, and what replaces the marker is
    // strictly stronger than the banner was. A banner is a sentence: it can
    // render the correct workspace name over material that is about to
    // finalize into a different one. What Capture actually holds is the
    // registration that makes that impossible — staged evidence is declared
    // to the dirty-work registry, so the context switcher demands explicit
    // confirmation before the tenant boundary is crossed at all. An in-app
    // workspace switch is an envelope swap that never fires `beforeunload`,
    // so this registration is the only thing standing between staged evidence
    // and a silent finalize into the wrong workspace.
    [
      "app/(app)/capture/page.tsx",
      [/useDirtyWork\(/, /sessionItems\.length > 0 && !busy/, /"Staged evidence in Capture"/],
    ],
    ["app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts", [/useTenantGuard/, /ctxIsStale\(captured\)/]],
    ["app/(app)/evidence-lifecycle/legal-holds/page.tsx", [/useWorkspaceContextSafety\(/, /WorkspaceContextBanner/, /runGuarded\(/, /teamId\]/]],
    ["app/(app)/evidence-lifecycle/retention/page.tsx", [/useWorkspaceContextSafety\(/, /WorkspaceContextBanner/, /runGuarded\(/]],
    ["app/(app)/evidence-lifecycle/_shared.tsx", [/prevWorkspaceRef/, /activeWorkspaceId\]/]],
    ["app/(app)/redaction/page.tsx", [/useWorkspaceContextSafety\(/, /WorkspaceContextBanner/, /runGuarded\(/, /activeWorkspaceId\]/]],
    ["app/(app)/review/page.tsx", [/WorkspaceContextBanner/]],
    // REPORTS proves tenant isolation by its LOAD, not by a banner.
    //
    // The banner rendered "Reports & artifacts for Personal Space · Personal
    // Space" — the workspace named twice, under a global header that already
    // named it. It was removed as redundant copy, and the Phase 7 guarantee it
    // stood for is unaffected: what tenant isolation requires of a read-only
    // list is that it RE-QUERIES when the workspace changes. That is asserted
    // directly here, which is a stronger marker than the banner ever was — a
    // banner can render the right name over a stale list.
    [
      "components/reports-experience/ReportsIndex.tsx",
      [/useWorkspaceId\(\)/, /if \(!workspaceId\) return;/, /reload, workspaceId\]/],
    ],
    // Intake links names its owning workspace from the SAME canonical resolver
    // the shared banner uses (`useOwningContextLabel`), rendered inline in the
    // page header instead of as a separate strip — the shared banner printed
    // "Personal Space · Personal Space" here, saying the same thing twice. The
    // probe attribute the banner emits (`data-context-workspace`) is preserved,
    // and `__tests__/render/intake-links-management.render.test.tsx` proves the
    // rendered surface names the workspace exactly once.
    [
      "app/(app)/intake-links/page.tsx",
      [/useOwningContextLabel/, /data-context-workspace/],
    ],
    ["app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx", [/useWorkspaceContextSafety\(/, /WorkspaceContextBanner/, /runGuarded\(/]],
    ["app/(app)/settings/_sections/BillingSection.tsx", [/WorkspaceContextBanner/, /activeWorkspaceId\]/]],
    ["app/(app)/settings/_sections/AiSection.tsx", [/useWorkspaceContextSafety\(/, /WorkspaceContextBanner/, /runGuarded\(/]],
    // Org settings — proven complete via the org-name header + orgId re-scope.
    ["app/(app)/organizations/[id]/admin/layout.tsx", [/state\.data\.name/, /\[orgId\]/]],
    // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — Checkout moved, and the
    // tenant-isolation property got STRONGER rather than merely relocating.
    //
    // `CheckoutPanel` let the user pick a target workspace INSIDE checkout and
    // proved isolation by naming the selection ("Checkout will apply to
    // workspace: X"). Picking the subject inside the purchase is how someone
    // buys the wrong workspace a plan.
    //
    // The drawer has no target picker at all: the page has already selected a
    // BILLING ACCOUNT, that account is what is being bought for, and the
    // drawer states which account it applies to. The server re-authorizes
    // BILLING_MANAGE on that exact subject.
    //
    // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the workspace-id
    // derivation went with the subject that needed it, and the isolation
    // property got stronger again. A checkout does not derive a workspace, it
    // does not carry one, and the server refuses a body that names one: there
    // is one payer, and it is the person. What is asserted here is therefore
    // the ABSENCE — the drawer must not reintroduce a workspace target — plus
    // the statement of subject that was always the point.
    [
      "app/(app)/billing/_sections/CheckoutDrawer.tsx",
      // The SENTENCE changed with the redesign — the plan drawer now says
      // "Pick the plan for <account>" — but the PROPERTY was always the
      // point: the drawer names the account it applies to, so a customer
      // with two billing accounts can never be looking at the wrong one. It
      // is asserted as the interpolation rather than as the wording.
      [/projection\.account\.displayName/],
    ],
  ];
  // Share — N/A as a distinct authenticated form: sharing in this product
  // is (a) Evidence Request (wired above), (b) external-review portal
  // grants (server-side resource-scoped, Phase 5 §8.5), and (c) public
  // verification token routes (deliberately separate). There is no
  // standalone workspace-scoped "share" mutation page to wire.
  for (const [file, markers] of surfaces) {
    const src = read(file);
    for (const m of markers) {
      assert.match(src, m, `${file} missing ${m}`);
    }
  }
});

test("Phase 7 wired reference surfaces adopt the primitives (not superficially)", () => {
  const caseModal = read(
    "components/cases-experience/matter-modals/CreateCaseModal.tsx",
  );
  assert.match(caseModal, /useWorkspaceContextSafety\(/);
  assert.match(caseModal, /WorkspaceContextBanner/);
  assert.match(caseModal, /runGuarded\(/); // guarded submit
  // Capture's adoption is the dirty-work gate plus the tenant guard in its
  // orchestration hook — see the surface table above for why the banner is
  // not the marker here. Both halves are asserted, because either one alone
  // is superficial: the gate stops the switch, the guard stops a response
  // that crossed anyway from being applied.
  const capture = read("app/(app)/capture/page.tsx");
  assert.match(capture, /useDirtyWork\(/);
  assert.match(capture, /"Staged evidence in Capture"/);
  const captureSession = read(
    "app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
  );
  assert.match(captureSession, /useTenantGuard\(\)/);
  assert.match(captureSession, /ctxIsStale\(captured\)/);
});
