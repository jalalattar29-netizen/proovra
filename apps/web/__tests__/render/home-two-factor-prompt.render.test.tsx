/**
 * Stage B — T-034: a Team workspace's Home prompts the person to enrol a second
 * factor before any review needs one (e4e908e88: nothing prompted; the first
 * encounter was a refusal mid-verdict). The real dashboard, the real prompt and
 * the real apiFetch; only the Home data hook is replaced with a normalized
 * view-model.
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let plan: string = "TEAM";
const reviewQueuesIncluded = () => ["TEAM", "ENTERPRISE"].includes(plan);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/home",
}));
vi.mock("../../components/home-experience/useHomeData", async () => {
  const vmMod = await import("../../components/home-experience/home-view-model");
  return {
    HOME_PARTIAL_LOAD_MESSAGE: "",
    HOME_FOCUS_REFRESH_MIN_INTERVAL_MS: 30_000,
    useHomeData: () => {
      // The prompt follows the server-projected reviewer-operations
      // capability (Team and above), not the plan name.
      const vm = vmMod.normalizeHomeViewModel({
        plan,
        planFeatures: { reviewQueuesIncluded: reviewQueuesIncluded() },
      } as never);
      return { status: "ready", viewModel: { ...vm, plan }, reload: () => {} };
    },
  };
});

import { SelfServeHomeDashboard } from "../../components/home-experience/SelfServeHomeDashboard";
import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";

const WS = "88888888-8888-4888-8888-888888888888";
function envelope() {
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { EVIDENCE_VIEW: true },
    diagnostics: { requestId: "stage-b-home" },
    user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: null, displayName: null, firstName: null, lastName: null, avatarUrl: null, locale: null, timezone: null },
    workspace: { id: WS, name: "Personal Space", status: "active", scope: "PERSONAL", membership: { role: "OWNER" } },
    activeSpace: { type: "PERSONAL", id: WS, displayName: "Personal Space", roleLabel: "Owner" },
    personalSpace: { id: WS, status: "active" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: WS, kind: "PERSONAL", organizationId: null, displayName: "Personal Space" },
    },
    account: { accountPlan: plan, accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: { reviewQueuesIncluded: reviewQueuesIncluded() },
  };
}
const mount = () =>
  render(
    <PlatformContextProvider testEnvelope={envelope() as never}>
      <SelfServeHomeDashboard />
    </PlatformContextProvider>,
  );

let hasMfa = false;
beforeEach(() => {
  hasMfa = false;
  plan = "TEAM";
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = path === "/v1/identity/mfa/factors" ? { hasMfa } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("T-034 Team Home prompts two-factor enrolment", () => {
  it("a Team workspace without a second factor shows 'Enrol two-factor authentication' with a link that returns to Home", async () => {
    mount();
    await settle();
    const prompt = document.querySelector("[data-two-factor-prompt]");
    expect(prompt).not.toBeNull();
    expect(prompt!.textContent).toMatch(/Enrol two-factor authentication/);
    expect(document.querySelector("[data-two-factor-prompt-link]")!.getAttribute("href")).toBe(
      "/settings?returnTo=%2Fhome#security",
    );
  });

  it("no prompt once a factor exists, and none outside Team", async () => {
    hasMfa = true;
    mount();
    await settle();
    expect(document.querySelector("[data-two-factor-prompt]")).toBeNull();
    cleanup();
    hasMfa = false;
    plan = "PRO";
    mount();
    await settle();
    expect(document.querySelector("[data-two-factor-prompt]")).toBeNull();
  });
});
