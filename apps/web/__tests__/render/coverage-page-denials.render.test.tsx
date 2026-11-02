/**
 * The denial states of the pages the audit could not open: the team invitation
 * accept page, an access review campaign and a redaction project. Real `apiFetch`
 * over a stubbed network, with the bodies the API sends
 * (cov-page-apis.integration.test.ts proves those bodies against real rows).
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({
  params: { token: "", campaignId: "" } as Record<string, string>,
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => nav.params,
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The render harness runs React 18, which has no `use`; the page only reads an
// already-resolved params promise.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, use: (p: { value: unknown }) => p.value };
});
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/ui")>()),
  useToast: () => ({ addToast: () => {} }),
}));
vi.mock("../../lib/platform-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform-context")>()),
  useTeamId: () => "11111111-1111-4111-8111-111111111111",
  useTenantGuard: () => ({ stamp: () => 0, isStale: () => false, generation: 0 }),
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => true }) }));
vi.mock("../../components/identity-security/StepUpModal", () => ({
  useStepUpAction: () => ({ runStepUpAction: async (fn: (h?: Record<string, string>) => Promise<unknown>) => fn() }),
  StepUpModal: () => null,
}));
vi.mock("../../components/redaction/ImageRedactionViewer", () => ({ ImageRedactionViewer: () => null }));
vi.mock("../../components/redaction/PdfRedactionViewer", () => ({ PdfRedactionViewer: () => null }));
vi.mock("../../components/redaction/VideoRedactionViewer", () => ({ VideoRedactionViewer: () => null }));
vi.mock("../../components/redaction/VideoReviewWorkspace", () => ({ VideoReviewWorkspace: () => null }));
vi.mock("../../components/redaction/DetectionReviewPanel", () => ({ DetectionReviewPanel: () => null }));
vi.mock("../../components/redaction/DetectionManifestPanel", () => ({ DetectionManifestPanel: () => null }));
vi.mock("../../components/redaction/RegionListPanel", () => ({ RegionListPanel: () => null }));
vi.mock("../../components/redaction/RedactionActivityPanel", () => ({ RedactionActivityPanel: () => null }));

import AcceptTeamInvitePage from "../../app/(app)/collaboration-teams/invites/[token]/accept/page";
import AccessReviewCampaignDetailPage from "../../app/(app)/governance-platform/access-reviews/[campaignId]/page";
import RedactionProjectPage from "../../app/(app)/redaction/[projectId]/page";

const TOKEN = `ctit_v1_${"A".repeat(52)}`;
const campaignId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";

type Reply = { status: number; body: unknown };
let replies: Array<[RegExp, string, Reply]>;
const fetchMock = vi.fn();

function answer(url: string, method: string): Response {
  const hit = replies.find(([re, m]) => re.test(url) && m === method);
  const reply = hit?.[2] ?? { status: 200, body: {} };
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  replies = [];
  nav.params = { token: encodeURIComponent(TOKEN), campaignId };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) =>
    answer(String(url), init?.method ?? "GET"),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("team invitation accept: each refusal is its own state", () => {
  const refused = (status: number, code: string, message: string): Reply => ({
    status,
    body: { error: { code, message, requestId: "req-1" } },
  });
  const accepting = (reply: Reply) => {
    replies = [[/\/v1\/collaboration-team-invites\/accept$/, "POST", reply]];
    render(<AcceptTeamInvitePage />);
  };
  const state = async (status: string) =>
    waitFor(() => expect(screen.getByTestId("accept-invite-page").getAttribute("data-status")).toBe(status));

  it.each([
    ["expired", refused(410, "INVITE_EXPIRED", "This invite has expired."), "team-invite-expired"],
    ["revoked", refused(410, "INVITE_REVOKED", "This invite has been revoked."), "team-invite-revoked"],
    ["invalid", refused(404, "INVITE_NOT_FOUND", "This invite does not exist."), "team-invite-invalid"],
  ])("%s shows its own notice", async (status, reply, testId) => {
    accepting(reply);
    await state(status);
    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("the wrong person is told to use the invited address, with no team detail", async () => {
    accepting(refused(403, "INVITE_EMAIL_MISMATCH", "Sign in with the address this invitation was sent to."));
    await state("error");
    expect(screen.getByTestId("accept-invite-body").textContent).toContain("the address this invitation was sent to");
  });

  it("a person outside the workspace is sent to join it first", async () => {
    accepting(refused(403, "WORKSPACE_MEMBERSHIP_REQUIRED", "Join the workspace first."));
    await state("workspace_required");
  });

  it("no session asks for sign-in and keeps the invitation in the return path", async () => {
    accepting(refused(401, "auth_required", "Sign in to accept this invitation."));
    await state("auth_required");
    fireEvent.click(screen.getByTestId("accept-invite-signin"));
    expect(nav.push.mock.calls.at(-1)?.[0]).toContain(encodeURIComponent(`/collaboration-teams/invites/`));
  });
});

describe("access review campaign: a refusal never reads as an empty campaign or a dead button", () => {
  const items: Reply = {
    status: 200,
    body: {
      items: [
        {
          id: itemId,
          campaignId,
          subjectUserId: "55555555-5555-4555-8555-555555555555",
          grantRef: "delegated_scope:x",
          decision: "PENDING",
          reviewerUserId: null,
          reviewedAtUtc: null,
          notes: null,
        },
      ],
    },
  };
  const itemsUrl = new RegExp(`/campaigns/${campaignId}/items$`);
  const denialOf = () => document.querySelector("[data-access-review-items-denial]");

  it("a campaign of another workspace says so, and shows no empty table", async () => {
    replies = [[itemsUrl, "GET", { status: 404, body: { denial: "CAMPAIGN_NOT_FOUND" } }]];
    render(<AccessReviewCampaignDetailPage />);
    await waitFor(() => expect(denialOf()?.getAttribute("data-access-review-items-denial")).toBe("CAMPAIGN_NOT_FOUND"));
    expect(denialOf()?.textContent).toContain("does not exist in the current workspace");
    expect(document.querySelector("[data-access-review-items-table]")?.hasAttribute("hidden")).toBe(true);
  });

  it("deciding one's own item is refused out loud, and the row stays", async () => {
    replies = [
      [itemsUrl, "GET", items],
      [/\/items\/[^/]+\/decision$/, "POST", { status: 409, body: { denial: "SELF_REVIEW_REFUSED" } }],
    ];
    render(<AccessReviewCampaignDetailPage />);
    const button = await waitFor(() => {
      const b = document.querySelector('[data-access-review-item-decision-button="APPROVED"]');
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(denialOf()?.getAttribute("data-access-review-items-denial")).toBe("SELF_REVIEW_REFUSED"));
    expect(denialOf()?.textContent).toContain("cannot decide your own access");
    expect(document.querySelector("[data-access-review-items-table]")?.hasAttribute("hidden")).toBe(false);
  });

  it("a missing permission names it and who can grant it", async () => {
    replies = [
      [itemsUrl, "GET", items],
      [
        /\/items\/[^/]+\/decision$/,
        "POST",
        { status: 403, body: { denial: "PERMISSION_REQUIRED", permission: "governance.access_review.decide" } },
      ],
    ];
    render(<AccessReviewCampaignDetailPage />);
    const button = await waitFor(() => {
      const b = document.querySelector('[data-access-review-item-decision-button="REVOKED"]');
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(denialOf()?.getAttribute("data-access-review-items-denial")).toBe("PERMISSION_REQUIRED"));
    expect(denialOf()?.textContent).toContain("Permission required");
  });

  it("the Enterprise gate's refusal is shown in product language", async () => {
    replies = [
      [itemsUrl, "GET", items],
      [
        /\/items\/[^/]+\/decision$/,
        "POST",
        { status: 402, body: { error: { code: "ENTERPRISE_FEATURE_REQUIRED", message: "x", upgradeCta: "/contact-sales" } } },
      ],
    ];
    render(<AccessReviewCampaignDetailPage />);
    const button = await waitFor(() => {
      const b = document.querySelector('[data-access-review-item-decision-button="APPROVED"]');
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(denialOf()).not.toBeNull());
    expect(denialOf()?.textContent).not.toContain("ENTERPRISE_FEATURE_REQUIRED");
    expect(denialOf()?.textContent?.length).toBeGreaterThan(10);
  });
});

describe("redaction project: the API's denial reaches the banner", () => {
  const settled = (value: unknown) => {
    const p = Promise.resolve(value) as Promise<unknown> & { status?: string; value?: unknown };
    p.status = "fulfilled";
    p.value = value;
    return p;
  };
  const params = () => settled({ projectId }) as Promise<{ projectId: string }>;
  const project = {
    id: projectId,
    evidenceId: "66666666-6666-4666-8666-666666666666",
    artifactKind: "IMAGE",
    state: "OPEN",
    title: "Sample",
    publishedVersion: null,
    versions: [],
    limitations: [],
  };
  const projectUrl = new RegExp(`/v1/redaction/projects/${projectId}$`);

  it("a project that answers as missing, which a closed record does, is a clear failure, not a spinner", async () => {
    replies = [[projectUrl, "GET", { status: 404, body: { denial: "PROJECT_NOT_FOUND" } }]];
    render(<RedactionProjectPage params={params()} />);
    await waitFor(() => expect(document.body.textContent).toContain("could not be loaded"));
  });

  it("a refused new version names the refusal it was given, not a fixed one", async () => {
    replies = [
      [projectUrl, "GET", { status: 200, body: { project } }],
      [/\/versions$/, "POST", { status: 403, body: { denial: "NOT_PERMITTED" } }],
    ];
    render(<RedactionProjectPage params={params()} />);
    const button = await waitFor(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /new version/i.test(x.textContent ?? ""));
      expect(b).toBeTruthy();
      return b as HTMLButtonElement;
    });
    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector("[data-redaction-banner]")).not.toBeNull());
    const banner = document.querySelector("[data-redaction-banner]")!.textContent!;
    expect(banner).toContain("Not permitted");
    expect(banner).not.toContain("POLICY_REJECTED");
  });
});
