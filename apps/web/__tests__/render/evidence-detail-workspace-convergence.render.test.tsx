/**
 * WORKSPACE & CAPABILITY CONVERGENCE GATE — /evidence/[id].
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The Evidence Detail redesign has to be ONE implementation. Every workspace
 * kind — Personal, Small-Business/Organization, Enterprise — must mount the
 * same route file, the same shell, the same tab authority and the same right
 * rail. Capability may decide WHICH MODULES appear and WHICH ACTIONS are
 * offered; it may never decide which design system renders.
 *
 * That property cannot be proven by reading source, because the branches are
 * runtime: the route reads `useEnterpriseSurfaceAccess()` and
 * `usePlanFeatureGate()`, both of which resolve from the server-projected
 * platform-context envelope. So this file drives the REAL page component
 * through six envelopes and asserts the matrix directly.
 *
 * THE SIX CONTEXTS
 *   personal      PERSONAL space, no enterprise flag, no intake entitlement
 *   organization  ORGANIZATION space, small-business plan, no enterprise flag
 *   enterprise    ORGANIZATION space, `flags.isEnterpriseWorkspace === true`
 *   platformAdmin PERSONAL space, `platform.isPlatformAdmin === true`
 *   legacy        an envelope with NO `flags` and NO `planFeatures` keys —
 *                 an older backend, or a degraded projection
 *   missing       no envelope at all (loading / failed projection)
 *
 * FAIL-CLOSED is the point of the last two: an unknown projection must never
 * fall into Enterprise affordances. Enterprise is never inferred from the plan
 * string, the workspace label, the record contents or any incidental field —
 * only from the canonical projection, which is why `legacy` below carries
 * `accountPlan: "ENTERPRISE"` and a workspace literally named "Enterprise
 * Holdings" while still being required to render as a non-enterprise surface.
 */

import React from "react";
import { projectOutputProgress } from "@proovra/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

const EVIDENCE_ID = "ev-convergence-1";

/** Every request the route (and its children) make, in order. */
let requestLog: string[] = [];

/** The tenant service status the fixture answers (default: all healthy). */
let runtimeBody: unknown = { status: "HEALTHY" };
/** Overrides the report's canonical action (the fixture's own is NONE: nothing needed). */
let reportActionOverride: string | null = null;
/** Overrides the separate new-version offer (the fixture's own offers none). */
let newVersionActionOverride: string | null = null;
/** Overrides the report's canonical state (the fixture's own is READY). */
let reportStateOverride: string | null = null;
/** The artifact status as a test edits it: the known blocks, plus any field. */
type StatusDoc = {
  outputs: { report: Record<string, unknown>; verificationPackage: Record<string, unknown>; [k: string]: unknown };
  report: Record<string, unknown>;
  verificationPackage: Record<string, unknown>;
  [k: string]: unknown;
};
/** Rewrites the whole artifact status (review workspace AND /artifacts/status alike). */
let statusPatch: ((status: StatusDoc) => void) | null = null;
/** Runs when the updated report is confirmed (the server's state change). */
let onNewVersionPost: (() => void) | null = null;
/** The id in the route (the record on screen). */
let routeEvidenceId = EVIDENCE_ID;

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    requestLog.push(init?.method === "POST" ? `POST ${path}` : path);
    if (init?.method === "POST" && path.endsWith("/reports/regenerate")) {
      const body = JSON.parse(init.body ?? "{}") as { intent?: string };
      if (body.intent === "NEW_VERSION") onNewVersionPost?.();
      return { outcome: "ENQUEUED", enqueued: true, requestId: "req-attn-1" };
    }
    return respond(path);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/api/intelligence", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchEvidenceIntelligence: async () => ({
    evidenceId: EVIDENCE_ID,
    entities: [],
    extractedText: [],
    similarities: [],
  }),
  // B6-F-47 — the page reads through the typed reader now.
  readEvidenceIntelligence: async () => ({
    kind: "ok",
    data: { entities: [], extractedTexts: [], similarities: [], disclaimer: "" },
  }),
}));

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: routeEvidenceId }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/evidence/${EVIDENCE_ID}`,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { PlatformContextProvider } from "../../lib/platform-context";
import { resetServiceStatusForTests } from "../../lib/useServiceStatus";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import EvidenceDetailPage from "../../app/(app)/evidence/[id]/page";
import { respondEvidenceDetail } from "./_fixtures/evidence-detail-fixture";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function respond(path: string): unknown {
  return respondEvidenceDetail(path, {
    evidenceId: EVIDENCE_ID,
    runtimeBody,
    patchWorkspace: (raw) => {
      const w = raw as { artifactStatus: { outputs: { report: { action: string } } } };
      if (reportActionOverride) w.artifactStatus.outputs.report.action = reportActionOverride;
      if (newVersionActionOverride) {
        (w.artifactStatus.outputs as unknown as { newVersion: { action: string; reason: string | null } }).newVersion = {
          ...(w.artifactStatus.outputs as unknown as { newVersion: object }).newVersion,
          action: newVersionActionOverride,
          reason: null,
        } as { action: string; reason: string | null };
      }
      if (reportStateOverride) {
        (w.artifactStatus.outputs.report as unknown as { state: string }).state = reportStateOverride;
      }
      statusPatch?.(w.artifactStatus as unknown as StatusDoc);
    },
    patchStatus: (status) => statusPatch?.(status as unknown as StatusDoc),
  });
}

type ContextKey =
  | "personal"
  | "organization"
  | "enterprise"
  | "platformAdmin"
  | "team"
  | "legacy"
  | "missing";

/**
 * Envelope builder. `flags` and `planFeatures` are the ONLY levers; the plan
 * string and workspace name are deliberately misleading in the `legacy` case.
 */
function makeEnvelope(key: ContextKey): unknown {
  const base = {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { EVIDENCE_VIEW: true },
    diagnostics: { requestId: `test-${key}` },
  };
  const space = (type: "PERSONAL" | "ORGANIZATION", id: string, displayName: string) => ({
    workspace: { id, name: displayName, status: "active", scope: type },
    activeSpace: { type, id, displayName, roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: id, kind: type, organizationId: null, displayName },
    },
  });

  switch (key) {
    case "personal":
      return {
        ...base,
        ...space("PERSONAL", "ws-personal", "Personal Space"),
        account: { accountPlan: "FREE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: false },
      };
    case "organization":
      return {
        ...base,
        ...space("ORGANIZATION", "ws-smb", "Northgate Claims"),
        account: { accountPlan: "BUSINESS", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: true },
      };
    case "enterprise":
      return {
        ...base,
        ...space("ORGANIZATION", "ws-ent", "Meridian Legal"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: true },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: true, reviewerOperationsIncluded: true },
      };
    case "team":
      // F-02. TEAM is NOT an enterprise workspace and DOES include reviewer
      // operations (plan-catalog.ts:462) - the case the page used to get
      // wrong, and the one no fixture here covered.
      return {
        ...base,
        ...space("ORGANIZATION", "ws-team", "Harbour Investigations"),
        account: { accountPlan: "TEAM", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: false },
        planFeatures: { intakeIncluded: true, reviewerOperationsIncluded: true },
      };
    case "platformAdmin":
      return {
        ...base,
        ...space("PERSONAL", "ws-admin", "Personal Space"),
        account: { accountPlan: "FREE", accountStatus: "active" },
        flags: { isEnterpriseWorkspace: false },
        platform: { isPlatformAdmin: true },
        planFeatures: {},
      };
    case "legacy":
      // No `flags`, no `platform`, no `planFeatures` — and every incidental
      // field screaming "enterprise". The gate must ignore all of it.
      return {
        ...base,
        ...space("ORGANIZATION", "ws-legacy", "Enterprise Holdings"),
        account: { accountPlan: "ENTERPRISE", accountStatus: "active" },
      };
    case "missing":
      return null;
  }
}

function renderContext(key: ContextKey) {
  const envelope = makeEnvelope(key);
  return render(
    <PlatformContextProvider testEnvelope={envelope as never}>
      <ToastProvider>
        <ConfirmActionProvider>
          <EvidenceDetailPage />
        </ConfirmActionProvider>
      </ToastProvider>
    </PlatformContextProvider>,
  );
}

/** Renders and waits for the route's own load to settle. */
async function mountLoaded(key: ContextKey) {
  const utils = renderContext(key);
  await waitFor(() => {
    expect(document.querySelector(".evidence-detail-hero")).not.toBeNull();
  });
  // Flush the follow-up effects (intelligence, workflow events) so the DOM the
  // matrix inspects is the settled one, not the first paint.
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

/*
 * The reviewer-ops axis is the ENTITLEMENT, not the workspace tier.
 *
 * These were named ENTERPRISE / NON_ENTERPRISE, which is what the page gated
 * on and is not what the server enforces: reviewer operations are included for
 * TEAM and above (PlanCapabilities.reviewerOperationsIncluded) and
 * reviewer-workspace.routes.ts:430 checks that field. `team` therefore belongs
 * with `enterprise`, and `organization` - whose plan does not include them -
 * belongs with `personal`.
 */
const REVIEWER_OPS_CONTEXTS: ContextKey[] = ["enterprise", "platformAdmin", "team"];
const NO_REVIEWER_OPS_CONTEXTS: ContextKey[] = ["personal", "organization", "legacy"];
const ENTERPRISE_CONTEXTS: ContextKey[] = ["enterprise", "platformAdmin"];
const NON_ENTERPRISE_CONTEXTS: ContextKey[] = ["personal", "organization", "legacy", "team"];
const LOADED_CONTEXTS: ContextKey[] = [...NON_ENTERPRISE_CONTEXTS, ...ENTERPRISE_CONTEXTS];

beforeEach(() => {
  requestLog = [];
  runtimeBody = { status: "HEALTHY" };
  reportActionOverride = null;
  newVersionActionOverride = null;
  reportStateOverride = null;
  statusPatch = null;
  onNewVersionPost = null;
  routeEvidenceId = EVIDENCE_ID;
  resetServiceStatusForTests();
});

// ---------------------------------------------------------------------------
// 1. ONE implementation — the shell is byte-identical in structure
// ---------------------------------------------------------------------------

describe("convergence — one shell for every workspace kind", () => {
  it.each(LOADED_CONTEXTS)("%s mounts the same shell anatomy", async (key) => {
    await mountLoaded(key);
    expect(document.querySelectorAll(".evidence-detail-hero")).toHaveLength(1);
    expect(document.querySelectorAll(".evidence-detail-layout")).toHaveLength(1);
    expect(document.querySelectorAll(".evidence-detail-main")).toHaveLength(1);
    // Exactly ONE tab authority, and it is the canonical `.app-tabs`.
    const tablists = document.querySelectorAll("nav[role='tablist']");
    expect(tablists).toHaveLength(1);
    expect(tablists[0]?.className).toContain("app-tabs");
    expect(tablists[0]?.className).toContain("evidence-detail-tabs");
  });

  it.each(LOADED_CONTEXTS)("%s mounts exactly one shared rail with the four canonical sections", async (key) => {
    await mountLoaded(key);
    const rails = document.querySelectorAll("[data-evidence-sidebar='status-and-next-action']");
    expect(rails).toHaveLength(1);
    const sections = [...rails[0]!.querySelectorAll("[data-evidence-side]")].map((el) =>
      el.getAttribute("data-evidence-side"),
    );
    expect(sections).toEqual([
      "risk-signals",
      "operational-summary",
      "attributes",
      "public-verification-shortcut",
    ]);
    const headings = [...rails[0]!.querySelectorAll(".evidence-detail-rail-heading")].map(
      (el) => el.textContent,
    );
    expect(headings).toEqual([
      "Risk Signals",
      "Review Workflow",
      "Attributes",
      "Verification page",
    ]);
  });

  it.each(LOADED_CONTEXTS)("%s renders the same tab set from the same record projection", async (key) => {
    await mountLoaded(key);
    const tabs = [...document.querySelectorAll("[role='tab']")].map((el) => el.textContent?.trim());
    // The record fixture is identical in every context, so the tab set must be
    // too. Discussion is gated by the RECORD's capability snapshot, never by
    // workspace kind.
    expect(tabs).toEqual([
      "Overview",
      "Integrity",
      "Custody",
      "Review",
      "Artifacts",
      "Discussion",
      "Technical Appendix",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Capability drives MODULES — not the design system
// ---------------------------------------------------------------------------

describe("convergence — capability controls modules only", () => {
  async function openReviewTab(key: ContextKey) {
    await mountLoaded(key);
    const reviewTab = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    await act(async () => {
      reviewTab.click();
    });
  }

  it.each(REVIEWER_OPS_CONTEXTS)("%s reaches the reviewer-ops panels", async (key) => {
    await openReviewTab(key);
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).not.toBeNull();
  });

  it.each(NO_REVIEWER_OPS_CONTEXTS)("%s does not reach the reviewer-ops panels", async (key) => {
    await openReviewTab(key);
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
  });

  it.each(LOADED_CONTEXTS)("%s offers the shared, non-gated review action", async (key) => {
    await openReviewTab(key);
    // Attach-to-case is capability-INVARIANT: every workspace kind gets it,
    // which is what makes the reviewer-ops difference above a module gate
    // rather than a whole-tab gate.
    expect(document.querySelector("[data-evidence-action='attach-to-case']")).not.toBeNull();
  });

  it("reviewer-ops panels use the SAME primitives as the ungated surface", async () => {
    await openReviewTab("enterprise");
    const panels = document.querySelector("[data-evidence-review-enterprise-panels]")!;
    // The note panels load, and show their controls, when opened, and only for
    // a caller the API says may write (the fixture answers canWrite: true).
    for (const details of [...panels.querySelectorAll("details")]) {
      await act(async () => {
        details.open = true;
        fireEvent(details, new Event("toggle"));
      });
    }
    await waitFor(() => expect(panels.querySelectorAll("button").length).toBeGreaterThan(0));
    // Every button inside the capability-gated region must be a canonical
    // action primitive. A legacy `Button` renders `.btn`/`.button` classes.
    const buttons = [...panels.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.className).toMatch(
        /app-(primary|secondary|ghost)-action|app-listbox__trigger|evidence-detail-/,
      );
    }
    // And no native select survives inside the gated region.
    expect(panels.querySelector("select")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. FAIL CLOSED — unknown / legacy / missing projection
// ---------------------------------------------------------------------------

describe("convergence — unknown capability data fails closed", () => {
  it("a legacy envelope with no flags renders as NON-enterprise despite an ENTERPRISE plan string", async () => {
    await mountLoaded("legacy");
    const reviewTab = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    await act(async () => {
      reviewTab.click();
    });
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
    // The misleading fields really are present in the envelope under test.
    const env = makeEnvelope("legacy") as { account: { accountPlan: string }; workspace: { name: string } };
    expect(env.account.accountPlan).toBe("ENTERPRISE");
    expect(env.workspace.name).toBe("Enterprise Holdings");
  });

  it("a missing envelope renders no enterprise affordance and does not throw", async () => {
    expect(() => renderContext("missing")).not.toThrow();
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
  });

  it("a missing envelope issues no evidence request at all", async () => {
    renderContext("missing");
    await act(async () => {
      await Promise.resolve();
    });
    // Nothing tenant-scoped may be fetched before the projection resolves.
    expect(requestLog.filter((p) => p.includes(EVIDENCE_ID))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. No legacy design system in ANY branch
// ---------------------------------------------------------------------------

describe("convergence — no legacy design system in any capability branch", () => {
  it.each(LOADED_CONTEXTS)("%s renders no legacy primitive and no inline colour", async (key) => {
    await mountLoaded(key);
    const root = document.body;
    // Legacy barrel primitives.
    expect(root.querySelector(".btn, .button, .card, .badge, .modal")).toBeNull();
    // Native selects were replaced by AppListbox everywhere on this route.
    expect(root.querySelector("select")).toBeNull();
    // No element may carry a hard-coded colour in a style attribute; the
    // redesign moved every colour into tokens.
    const styled = [...root.querySelectorAll("[style]")].map((el) => el.getAttribute("style") ?? "");
    for (const s of styled) {
      expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Tenant isolation across a context change
// ---------------------------------------------------------------------------

describe("convergence — no cross-context leakage", () => {
  it("switching context re-requests the record and never reuses the prior envelope's gate", async () => {
    const first = await mountLoaded("enterprise");
    const reviewTab = () =>
      [...document.querySelectorAll("[role='tab']")].find(
        (el) => el.textContent?.trim() === "Review",
      ) as HTMLButtonElement;
    await act(async () => {
      reviewTab().click();
    });
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).not.toBeNull();
    first.unmount();

    requestLog = [];
    await mountLoaded("personal");
    await act(async () => {
      reviewTab().click();
    });
    expect(document.querySelector("[data-evidence-review-enterprise-panels]")).toBeNull();
    // The second mount fetched for itself rather than rendering the first
    // mount's data.
    expect(requestLog.some((p) => p.includes(`/v1/evidence/${EVIDENCE_ID}/review-workspace`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Every tab mounts in every context
// ---------------------------------------------------------------------------

describe("convergence — every tab mounts under every capability projection", () => {
  const TABS = [
    "Overview",
    "Integrity",
    "Custody",
    "Review",
    "Artifacts",
    "Discussion",
    "Technical Appendix",
  ];

  it.each(LOADED_CONTEXTS)("%s renders all seven tab panels without error", async (key) => {
    await mountLoaded(key);
    for (const label of TABS) {
      const tab = [...document.querySelectorAll("[role='tab']")].find(
        (el) => el.textContent?.trim() === label,
      ) as HTMLButtonElement;
      expect(tab, `${key}: tab ${label}`).toBeDefined();
      await act(async () => {
        tab.click();
      });
      // The panel the tab controls must exist and be non-empty. An exception
      // inside a capability-gated child would have surfaced here.
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel, `${key}: panel for ${label}`).not.toBeNull();
      expect(panel!.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      // The rail is mounted once regardless of which tab is active.
      expect(
        document.querySelectorAll("[data-evidence-sidebar='status-and-next-action']"),
      ).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The gate authority itself
// ---------------------------------------------------------------------------

describe("convergence — the route reads only the canonical projection", () => {
  it("never derives enterprise from the plan string", async () => {
    // `organization` carries BUSINESS + isEnterpriseWorkspace:false, `legacy`
    // carries ENTERPRISE + no flag. Both must render identically w.r.t. the
    // gated region, which is only possible if the plan string is unread.
    for (const key of ["organization", "legacy"] as ContextKey[]) {
      const utils = await mountLoaded(key);
      const tab = [...document.querySelectorAll("[role='tab']")].find(
        (el) => el.textContent?.trim() === "Review",
      ) as HTMLButtonElement;
      await act(async () => {
        tab.click();
      });
      expect(
        document.querySelector("[data-evidence-review-enterprise-panels]"),
        `${key} must not reach reviewer ops`,
      ).toBeNull();
      utils.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Service status — the record is not a platform status surface
// ---------------------------------------------------------------------------

describe("service status — Evidence never renders the platform diagnostic panel", () => {
  const caps = (over: Record<string, string> = {}) => ({
    uploads: "HEALTHY",
    artifactGeneration: "HEALTHY",
    downloads: "HEALTHY",
    search: "HEALTHY",
    reviewAutomation: "HEALTHY",
    ...over,
  });
  const VARIANTS: Record<string, unknown> = {
    healthy: { status: "HEALTHY", capabilities: caps(), checkedAt: "2026-09-26T00:00:00Z" },
    "generation degraded": { status: "DEGRADED", capabilities: caps({ artifactGeneration: "DEGRADED" }) },
    "downloads unavailable": { status: "DEGRADED", capabilities: caps({ downloads: "UNAVAILABLE" }) },
    "search degraded only": { status: "DEGRADED", capabilities: caps({ search: "DEGRADED" }) },
    unknown: { status: "UNAVAILABLE", capabilities: caps({ artifactGeneration: "UNKNOWN" }) },
    "legacy server DEGRADED": { status: "DEGRADED" },
    "status read fails": new Error("network"),
  };
  const PANEL = /degraded mode|partial or stale|subsystem\(s\)|Failing subsystems/i;

  async function openArtifacts() {
    const tab = [...document.querySelectorAll("[role='tab']")].find(
      (el) => el.textContent?.trim() === "Artifacts",
    ) as HTMLButtonElement;
    await act(async () => {
      tab.click();
    });
    // Let the shared status store settle (first read is scheduled on idle).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
  }

  it.each(Object.keys(VARIANTS))(
    "%s: no platform panel, no empty subsystem list, no admin link — on the record or its Artifacts",
    async (name) => {
      runtimeBody = VARIANTS[name];
      await mountLoaded("personal");
      await openArtifacts();
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(PANEL);
      expect(document.querySelector("[data-empty-state-code='runtime_degraded']")).toBeNull();
      const adminLinks = [...document.querySelectorAll("a")]
        .map((a) => a.getAttribute("href") ?? "")
        .filter((h) => h.startsWith("/admin"));
      expect(adminLinks).toEqual([]);
      // A search-only or unmeasured status says nothing on the record at all.
      if (name === "search degraded only" || name === "unknown" || name === "status read fails" || name === "healthy") {
        expect(document.querySelector("[data-service-notice]")).toBeNull();
      }
    },
    15_000,
  );

  it("a generation incident is said beside Create new version, without calling the evidence stale — and the report download stays enabled", async () => {
    newVersionActionOverride = "CREATE_NEW_VERSION";
    runtimeBody = VARIANTS["generation degraded"];
    await mountLoaded("personal");
    await openArtifacts();
    const notice = document.querySelector("[data-service-notice='artifactGeneration']");
    expect(notice?.textContent).toMatch(/generation is delayed/);
    expect(notice?.textContent).not.toMatch(/stale|corrupt|incomplete|partial/i);
    // Beside the control it affects.
    expect(notice?.closest("[data-evidence-section='reports-ready-actions']")).not.toBeNull();
    const report = document.querySelector(
      "[data-evidence-artifact-download='report']",
    ) as HTMLButtonElement | null;
    expect(report).not.toBeNull();
    expect(report!.disabled).toBe(false);
    expect(document.querySelector("[data-service-notice='downloads']")).toBeNull();
  }, 15_000);

  it("a record's own generation failure stays visible beside a service notice — neither hides the other", async () => {
    reportStateOverride = "RETRYABLE_FAILURE";
    reportActionOverride = "RETRY";
    runtimeBody = VARIANTS["generation degraded"];
    await mountLoaded("personal");
    await openArtifacts();
    const failure = document.querySelector("[data-evidence-section='reports-retryable-failure']");
    expect(failure?.textContent).toMatch(/Report generation failed/);
    // The platform notice is beside the Retry control, inside the record's
    // own failure panel — it does not replace or explain away the failure.
    expect(failure?.querySelector("[data-service-notice='artifactGeneration']")).not.toBeNull();
    expect(document.querySelector("[data-evidence-generate-verb='RETRY']")).not.toBeNull();
  }, 15_000);

  it("healthy status: the record's own failure is still shown, with no service notice", async () => {
    reportStateOverride = "RETRYABLE_FAILURE";
    reportActionOverride = "RETRY";
    await mountLoaded("personal");
    await openArtifacts();
    expect(document.querySelector("[data-evidence-section='reports-retryable-failure']")).not.toBeNull();
    expect(document.querySelector("[data-service-notice]")).toBeNull();
  }, 15_000);

  it("a downloads incident is said at the downloads, not over the record", async () => {
    runtimeBody = VARIANTS["downloads unavailable"];
    await mountLoaded("personal");
    await openArtifacts();
    const notice = document.querySelector("[data-service-notice='downloads']");
    expect(notice?.textContent).toMatch(/Downloads are temporarily unavailable/);
    expect(document.querySelector(".evidence-detail-hero [data-service-notice]")).toBeNull();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Evidence output attention — ONE value across Overview, the tab, the banner
// and Artifacts (2026-10-06)
// ---------------------------------------------------------------------------

describe("evidence output attention — one canonical value across the page", () => {
  const OFFER = {
    revision: "ofr1.test.sig",
    createdAtUtc: "2026-10-06T10:00:00Z",
    expiresAtUtc: "2099-01-01T00:00:00Z",
    operation: "NEW_VERSION",
    targetVersion: 3,
    reasonRequired: true,
    creditEffect: { kind: "NONE" },
    storageEffect: { estimatedBytes: "1000", fitsStorage: true, storageBytesUsed: null, storageBytesLimit: null },
  };
  const TRUST = {
    tsa: { status: "STAMPED", validated: true, validatedAtUtc: "2026-10-06T10:00:00Z", failureCode: null, genTimeUtc: null },
    ots: { state: "ANCHORED", anchoredAtUtc: "2026-10-06T10:05:00Z" },
  };
  const pairOf = (v: number, withPackage = true) => ({
    reportVersion: v,
    generatedAtUtc: "2026-07-04T05:23:22Z",
    sizeBytes: "1000",
    sha256: "c".repeat(64),
    immutableRecorded: true,
    issueKind: v > 1 ? "UPDATED" : null,
    issueReason: null,
    latest: true,
    digestMismatch: false,
    package: withPackage
      ? {
          version: v,
          generatedAtUtc: "2026-07-04T05:23:22Z",
          sizeBytes: "2000",
          sha256: "d".repeat(64),
          embeddedReportSha256: "c".repeat(64),
          sealed: true,
          immutableRecorded: true,
          pairing: "REPORT_VERSION",
        }
      : null,
  });
  const fresh = (newer: boolean) => ({
    reportVersion: 2,
    reportGeneratedAtUtc: "2026-07-04T05:23:22Z",
    hasNewerFacts: newer,
    changes: newer
      ? [
          { code: "TSA_VALIDATED_AFTER_REPORT", atUtc: "2026-10-06T10:00:00Z" },
          { code: "OTS_ANCHORED_AFTER_REPORT", atUtc: "2026-10-06T10:05:00Z" },
        ]
      : [],
  });
  const activeReq = (state: string, progressStage: string | null) => ({
    requestId: "req-attn-1",
    intent: "NEW_VERSION",
    artifactType: "REPORT",
    state,
    stage: null,
    progressStage,
    targetVersion: 3,
    terminalReasonCode: null,
    attemptCount: 1,
    createdAtUtc: "2026-10-06T10:10:00Z",
    updatedAtUtc: "2026-10-06T10:10:05Z",
    completedAtUtc: state === "SUCCEEDED" ? "2026-10-06T10:11:00Z" : null,
    recent: true,
    progress: projectOutputProgress({ state, stage: null, progressStage, artifactType: "REPORT" }),
  });

  const UPDATE_AVAILABLE = (st: StatusDoc) => {
    st.outputs.trust = TRUST;
    st.outputs.freshness = fresh(true);
    st.outputs.offer = OFFER;
    st.outputs.newVersion = { action: "CREATE_NEW_VERSION", reason: null, currentVersion: 2, nextVersion: 3, estimate: null };
    st.outputs.activeRequest = null;
    st.versions = { versions: [pairOf(2)], unpairedPackages: [] };
  };
  const IN_PROGRESS = (st: StatusDoc) => {
    UPDATE_AVAILABLE(st);
    st.outputs.offer = null;
    st.outputs.newVersion = { action: "NONE", reason: "IN_PROGRESS", currentVersion: 2, nextVersion: 3, estimate: null };
    st.outputs.activeRequest = activeReq("PROCESSING", "RENDERING_REPORT");
    st.outputs.pollIntervalMs = 40;
  };
  const CURRENT_V3 = (st: StatusDoc) => {
    st.outputs.trust = TRUST;
    st.outputs.freshness = { ...fresh(false), reportVersion: 3 };
    st.outputs.offer = null;
    st.outputs.newVersion = { action: "NONE", reason: "NOT_REQUIRED", currentVersion: 3, nextVersion: 4, estimate: null };
    st.outputs.report.version = 3;
    st.outputs.report.latestAvailableVersion = 3;
    st.outputs.verificationPackage.version = 3;
    st.outputs.verificationPackage.latestAvailableVersion = 3;
    st.outputs.activeRequest = activeReq("SUCCEEDED", "VERIFYING_PACKAGE");
    st.outputs.pollIntervalMs = null;
    st.report.version = 3;
    st.verificationPackage.version = 3;
    st.versions = { versions: [{ ...pairOf(2), latest: false }, pairOf(3)], unpairedPackages: [] };
  };
  const PACKAGE_MISSING = (st: StatusDoc) => {
    st.outputs.trust = TRUST;
    st.outputs.freshness = fresh(false);
    st.outputs.verificationPackage = {
      ...st.outputs.verificationPackage,
      state: "ELIGIBLE_NOT_GENERATED",
      action: "RECOVER",
      actionUnavailableReason: null,
      operation: "PACKAGE_RECOVERY",
      availability: "NO_ARTIFACT",
      version: null,
      latestAvailableVersion: 1,
    };
    st.verificationPackage = { ...st.verificationPackage, available: false, version: null, generatedAtUtc: null };
    st.versions = { versions: [pairOf(2, false)], unpairedPackages: [] };
  };

  const card = () => document.querySelector("[data-testid='evidence-outputs-card']") as HTMLElement | null;
  const artifactsTab = () => document.querySelector("[data-evidence-tab='artifacts']") as HTMLButtonElement;
  const indicator = () => document.querySelector("[data-testid='artifacts-tab-indicator']");
  const banner = () => document.querySelector("[data-testid='output-attention-banner']");

  /** Overview card, tab name, tab indicator and banner — read from ONE render. */
  function surfaces() {
    return {
      card: card()?.getAttribute("data-output-attention") ?? null,
      tabName: artifactsTab().getAttribute("aria-label"),
      indicator: indicator()?.getAttribute("data-output-attention") ?? null,
      banner: banner()?.getAttribute("data-output-attention") ?? null,
    };
  }

  it("CURRENT: a calm card, no tab indicator, no banner", async () => {
    statusPatch = (st) => {
      st.outputs.trust = TRUST;
      st.outputs.freshness = fresh(false);
      st.versions = { versions: [pairOf(2)], unpairedPackages: [] };
    };
    await mountLoaded("personal");
    expect(surfaces()).toEqual({ card: "CURRENT", tabName: null, indicator: null, banner: null });
    expect(card()!.textContent).toMatch(/All generated outputs reflect the latest verified facts./);
    expect(artifactsTab().textContent?.trim()).toBe("Artifacts");
  }, 15_000);

  it("UPDATE_AVAILABLE: card + tab agree, no banner, and the Artifacts primary action is the same decision", async () => {
    statusPatch = UPDATE_AVAILABLE;
    await mountLoaded("personal");
    expect(surfaces()).toEqual({
      card: "UPDATE_AVAILABLE",
      tabName: "Artifacts — update available",
      indicator: "UPDATE_AVAILABLE",
      banner: null,
    });
    await act(async () => {
      artifactsTab().click();
    });
    const generate = document.querySelector("[data-testid='evidence-new-version']") as HTMLButtonElement;
    expect(generate.getAttribute("data-output-attention")).toBe("UPDATE_AVAILABLE");
    expect(generate.className).toContain("app-primary-action");
    expect(document.querySelector("[data-testid='truth-freshness']")).not.toBeNull();
    // Still the same answer on the tab while Artifacts is open.
    expect(artifactsTab().getAttribute("aria-label")).toBe("Artifacts — update available");
  }, 15_000);

  it("Generate updated report on Overview opens THE dialog; closing returns focus to the card button", async () => {
    statusPatch = UPDATE_AVAILABLE;
    await mountLoaded("personal");
    const trigger = document.querySelector("[data-testid='evidence-outputs-generate']") as HTMLButtonElement;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const dialog = await waitFor(() => {
      const d = document.querySelector("[data-testid='updated-report-dialog']");
      expect(d).not.toBeNull();
      return d as HTMLElement;
    });
    expect(dialog.textContent).toMatch(/Generate report v3/);
    // Only one dialog exists on the page.
    expect(document.querySelectorAll("[data-testid='updated-report-dialog']")).toHaveLength(1);
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    await waitFor(() => expect(document.querySelector("[data-testid='updated-report-dialog']")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }, 15_000);

  it("UPDATE_AVAILABLE → IN_PROGRESS → CURRENT, every surface following the durable state", async () => {
    statusPatch = UPDATE_AVAILABLE;
    // The server's state change on Confirm: the durable request now exists.
    onNewVersionPost = () => {
      statusPatch = IN_PROGRESS;
    };
    await mountLoaded("personal");
    await act(async () => {
      (document.querySelector("[data-testid='evidence-outputs-generate']") as HTMLButtonElement).click();
    });
    const reason = await waitFor(() => {
      const r = document.querySelector("[data-testid='updated-report-reason']") as HTMLTextAreaElement | null;
      expect(r).not.toBeNull();
      return r!;
    });
    await act(async () => {
      fireEvent.change(reason, { target: { value: "TSA validated and OTS anchored after v2" } });
    });
    const confirm = document.querySelector("[data-testid='updated-report-confirm']") as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    await act(async () => {
      confirm.click();
    });
    // The signed revision travelled with the confirmation.
    await waitFor(() => expect(requestLog).toContain(`POST /v1/evidence/${EVIDENCE_ID}/reports/regenerate`));
    await waitFor(() => expect(surfaces().card).toBe("IN_PROGRESS"));
    expect(surfaces()).toEqual({
      card: "IN_PROGRESS",
      tabName: "Artifacts — generation in progress",
      indicator: "IN_PROGRESS",
      banner: null,
    });
    expect(card()!.textContent).toMatch(/Generating report v3/);
    // The worker finishes: the page's own poll carries every surface to CURRENT.
    statusPatch = CURRENT_V3;
    await waitFor(() => expect(surfaces().card).toBe("CURRENT"), { timeout: 5000 });
    expect(surfaces()).toEqual({ card: "CURRENT", tabName: null, indicator: null, banner: null });
    expect(document.querySelector("[data-testid='evidence-outputs-report']")?.textContent).toBe("v3");
  }, 20_000);

  it("View progress opens Artifacts and focuses the durable progress card", async () => {
    statusPatch = IN_PROGRESS;
    await mountLoaded("personal");
    await act(async () => {
      (document.querySelector("[data-testid='evidence-outputs-view-progress']") as HTMLButtonElement).click();
    });
    expect(artifactsTab().getAttribute("aria-selected")).toBe("true");
    const progress = document.querySelector("[data-testid='output-progress']");
    expect(progress).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(progress));
    // The Overview did not render a second progress implementation.
    expect(document.querySelectorAll("[data-testid='output-progress']")).toHaveLength(1);
  }, 15_000);

  it("RECOVERY: card, tab, banner and the Artifacts panel all name the same package recovery; Review lands on it", async () => {
    statusPatch = PACKAGE_MISSING;
    await mountLoaded("personal");
    expect(surfaces()).toEqual({
      card: "RECOVERY_AVAILABLE",
      tabName: "Artifacts — action required",
      indicator: "RECOVERY_AVAILABLE",
      banner: "RECOVERY_AVAILABLE",
    });
    expect(banner()!.textContent).toMatch(/Verification package v2 could not be completed./);
    expect(document.querySelector("[data-testid='evidence-outputs-recover']")?.textContent).toBe("Retry verification package");
    await act(async () => {
      (document.querySelector("[data-testid='output-attention-banner-review']") as HTMLButtonElement).click();
    });
    expect(artifactsTab().getAttribute("aria-selected")).toBe("true");
    const panel = document.querySelector("[data-evidence-section='package-recovery']");
    expect(panel).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(panel));
    // The Artifacts panel offers the very verb the card offered.
    expect(panel!.querySelector("[data-evidence-generate-verb='RECOVER']")?.textContent).toBe("Retry verification package");
    // The banner stays across tabs while the state holds.
    expect(banner()).not.toBeNull();
  }, 15_000);

  it("Recover on the card posts the server's verb through the existing recovery path", async () => {
    statusPatch = PACKAGE_MISSING;
    await mountLoaded("personal");
    await act(async () => {
      (document.querySelector("[data-testid='evidence-outputs-recover']") as HTMLButtonElement).click();
    });
    await waitFor(() => expect(requestLog).toContain(`POST /v1/evidence/${EVIDENCE_ID}/reports/regenerate`));
  }, 15_000);

  it("a status for another record is never painted on this one", async () => {
    // The route shows a different record than the one the responses describe
    // (a late answer for the previous evidence).
    routeEvidenceId = "ev-convergence-OTHER";
    statusPatch = PACKAGE_MISSING;
    await mountLoaded("personal");
    expect(surfaces()).toEqual({ card: null, tabName: null, indicator: null, banner: null });
  }, 15_000);
});

/*
 * AUD-25 (2026-10-20) — capturedAtUtc is when PROOVRA RECEIVED the bytes. The
 * Overview labelled it "Captured", a claim about the capture PROOVRA never saw.
 */
describe("Overview record summary — server receipt is not capture (AUD-25)", () => {
  it("labels the server receipt time 'Received by PROOVRA', never 'Captured'", async () => {
    await mountLoaded(LOADED_CONTEXTS[0]!);
    const labels = [...document.querySelectorAll("[data-evidence-record-grid] .evidence-detail-record-card__label")].map((el) => el.textContent?.trim());
    expect(labels.length).toBeGreaterThan(3);
    expect(labels).toContain("Received by PROOVRA");
    expect(labels).not.toContain("Captured");
  });
});
