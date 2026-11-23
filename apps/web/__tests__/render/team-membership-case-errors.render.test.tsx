/**
 * TEAM-SPEC §3 "Team membership surfaces" — case detail maps 401 / 403 / 404
 * to three different next steps, over the real apiFetch (stubbed transport).
 * 404 stays deliberately neutral (absent OR not on the access list).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const caseId = "c1000000-0000-4000-8000-000000000001";

vi.mock("../../lib/platform-context", async (orig) => ({
  ...(await orig<typeof import("../../lib/platform-context")>()),
  usePlatformContext: () => ({ envelope: null }),
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  StepUpModal: () => null,
  useStepUpAction: () => ({ runStepUpAction: async (fn: () => Promise<unknown>) => fn() }),
}));
vi.mock("../../components/presence/PresenceIndicator", () => ({ PresenceIndicator: () => null }));
vi.mock("../../components/collaboration/TeamResponsibilityPanel", () => ({ TeamResponsibilityPanel: () => null }));
vi.mock("../../components/hidden-feature-panels/HiddenFeaturePanels", () => ({ CaseRiskPanel: () => null }));
vi.mock("../../components/governance/GovernanceSummary", () => ({ GovernanceSummary: () => null }));
vi.mock("../../components/ai-copilot/CaseCopilotPanel", () => ({ CaseCopilotPanel: () => null }));
vi.mock("../../components/external-review/ExternalReviewSubjectPanel", () => ({ ExternalReviewSubjectPanel: () => null }));
vi.mock("../../app/(app)/cases/components/SiuPanel", () => ({ SiuPanel: () => null }));
vi.mock("../../app/(app)/cases/components/SiuWorklistPanel", () => ({ SiuWorklistPanel: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => `/cases/${caseId}`,
  useParams: () => ({ id: caseId }),
}));

import { SimpleCaseDetail } from "../../components/cases-experience/simple-case-detail/SimpleCaseDetail";
import { ToastProvider } from "../../components/ui";

let status = 404;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: status === 403 ? "FORBIDDEN" : "NOT_FOUND" } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <ToastProvider>
      <SimpleCaseDetail caseId={caseId} onOpenEvidence={() => {}} />
    </ToastProvider>,
  );
}

describe("case detail — 401 / 403 / 404 each say what to do next", () => {
  it("401 asks the person to sign in again, returning to this case", async () => {
    status = 401;
    mount();
    expect(await screen.findByText("Your session has ended.")).toBeTruthy();
    const link = document.querySelector("[data-simple-case-detail-reauth]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(`/cases/${caseId}`)}`);
  });

  it("403 says the role can't open the case", async () => {
    status = 403;
    mount();
    expect(await screen.findByText("Your role can't open this case.")).toBeTruthy();
    expect(document.querySelector("[data-simple-case-detail-forbidden]")).toBeTruthy();
  });

  it("404 stays neutral: not found, or not on the access list — ask the case owner", async () => {
    status = 404;
    mount();
    expect(await screen.findByText("Case not found, or you aren't on its access list")).toBeTruthy();
    expect(screen.getByText(/ask the case owner to add you/)).toBeTruthy();
  });
});
