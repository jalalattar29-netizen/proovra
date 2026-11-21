/**
 * PRO-CENZ-01 / EP-0806 — the organization retention template is published
 * from the organization's Retention tab.
 *
 * POST /v1/orgs/:id/policies/retention had no caller, and the tab told admins
 * to "publish a template from Evidence Lifecycle → Retention", which writes a
 * workspace policy only. The real page over the REAL apiFetch and a stubbed
 * network: the form is offered only when the read says viewer.canPublish (the
 * POST's own gate), sends the route's bounded body, and says a refusal.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/admin/retention",
  useSearchParams: () => new URLSearchParams(),
}));

import OrganizationAdminRetentionPage from "../../app/(app)/organizations/[id]/admin/retention/page";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATH = `/v1/orgs/${ORG}/policies/retention`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function read(value: Record<string, unknown> | null, canPublish: boolean | undefined) {
  return {
    organizationId: ORG,
    key: "retention.default",
    value,
    updatedAt: value ? "2026-11-20T10:00:00.000Z" : null,
    lastUpdatedByUserId: null,
    inheritance: { workspaceCount: 2, sample: [] },
    workspacePolicies: { activePolicyCount: 0, workspacesWithPolicyCount: 0 },
    ...(canPublish === undefined ? {} : { viewer: { canPublish } }),
  };
}

type Call = { path: string; method: string; body: unknown };
let calls: Call[];
let getAnswer: () => Response | Promise<Response>;
let postAnswer: (body: unknown) => Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, method, body });
      if (path === PATH && method === "GET") return getAnswer();
      if (path === PATH && method === "POST") return postAnswer(body);
      return json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const daysInput = () => screen.getByLabelText("Keep evidence for (days)") as HTMLInputElement;
const publishButton = () => screen.getByRole("button", { name: /Publish (template|changes)/ }) as HTMLButtonElement;

describe("EP-0806 — publish the organization retention template", () => {
  it("shows the loading state, then offers the form to an owner or admin and publishes the bounded body", async () => {
    let stored: Record<string, unknown> | null = null;
    getAnswer = () => json(200, read(stored, true));
    postAnswer = (body) => {
      stored = body as Record<string, unknown>;
      return json(200, { organizationId: ORG, key: "retention.default", value: body, updatedAt: "2026-11-21T00:00:00.000Z" });
    };
    const { container } = render(<OrganizationAdminRetentionPage />);
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
    await settle();

    // The copy no longer sends the admin to the workspace page to publish.
    const empty = screen.getByTestId("retention-not-configured").textContent ?? "";
    expect(empty).toContain("Publish one below");
    expect(empty).not.toContain("Evidence Lifecycle");
    expect(screen.getByTestId("retention-publish-form")).toBeTruthy();

    fireEvent.change(daysInput(), { target: { value: "2555" } });
    fireEvent.click(screen.getByLabelText(/Make it a floor/));
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "  Seven-year default  " } });
    fireEvent.click(publishButton());
    await settle();

    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(PATH);
    expect(post?.body).toEqual({ retentionDays: 2555, immutable: true, description: "Seven-year default" });
    expect(screen.getByText(/Template published\. Workspaces without a retention policy/)).toBeTruthy();
    // The card re-read the template and shows it as published.
    expect(calls.filter((c) => c.method === "GET" && c.path === PATH)).toHaveLength(2);
    expect(container.querySelector('[data-state="configured"]')).not.toBeNull();
    expect(screen.getByTestId("retention-template-json").textContent).toContain("2555");
  });

  it("indefinite retention is sent as null, and a published template prefills the form", async () => {
    getAnswer = () => json(200, read({ retentionDays: 365, immutable: false, description: "One year" }, true));
    postAnswer = (body) => json(200, { organizationId: ORG, key: "retention.default", value: body, updatedAt: "2026-11-21T00:00:00.000Z" });
    render(<OrganizationAdminRetentionPage />);
    await settle();
    expect(daysInput().value).toBe("365");
    expect((screen.getByLabelText("Description (optional)") as HTMLTextAreaElement).value).toBe("One year");

    fireEvent.click(screen.getByLabelText(/Indefinitely/));
    expect(daysInput().disabled).toBe(true);
    fireEvent.click(publishButton());
    await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ retentionDays: null, immutable: false, description: "One year" });
  });

  it("an out-of-range period is not sent", async () => {
    getAnswer = () => json(200, read(null, true));
    postAnswer = () => json(500, {});
    render(<OrganizationAdminRetentionPage />);
    await settle();
    fireEvent.change(daysInput(), { target: { value: "99999" } });
    expect(publishButton().disabled).toBe(true);
    expect(screen.getByText(/whole number of days from 0 to 18250/)).toBeTruthy();
    fireEvent.change(daysInput(), { target: { value: "" } });
    expect(publishButton().disabled).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a role without the publish gate (auditor, security admin) reads the template and is offered no form", async () => {
    getAnswer = () => json(200, read(null, false));
    postAnswer = () => json(500, {});
    render(<OrganizationAdminRetentionPage />);
    await settle();
    expect(screen.queryByTestId("retention-publish-form")).toBeNull();
    expect(screen.getByTestId("retention-publish-not-offered").textContent).toContain("Only an organization owner or admin");
    expect(screen.getByTestId("retention-not-configured").textContent).toContain("An organization owner or admin can publish");
  });

  it("an older API that projects no viewer offers no form (fail closed)", async () => {
    getAnswer = () => json(200, read(null, undefined));
    postAnswer = () => json(500, {});
    render(<OrganizationAdminRetentionPage />);
    await settle();
    expect(screen.queryByTestId("retention-publish-form")).toBeNull();
  });

  it("a refused publish is said, and the form stays", async () => {
    getAnswer = () => json(200, read(null, true));
    postAnswer = () => json(403, { error: { code: "forbidden" } });
    render(<OrganizationAdminRetentionPage />);
    await settle();
    fireEvent.change(daysInput(), { target: { value: "30" } });
    fireEvent.click(publishButton());
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Only an organization owner or admin can publish the retention template.");
    expect(screen.getByTestId("retention-publish-form")).toBeTruthy();
    expect(screen.queryByText(/Template published/)).toBeNull();
  });

  it("a quarantined session and a lost organization get their own sentences", async () => {
    getAnswer = () => json(200, read(null, true));
    postAnswer = () => json(403, { error: { code: "session_quarantined", message: "This session is quarantined; privileged actions blocked." } });
    render(<OrganizationAdminRetentionPage />);
    await settle();
    fireEvent.change(daysInput(), { target: { value: "30" } });
    fireEvent.click(publishButton());
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("restricted after a security check");

    postAnswer = () => json(404, { error: { code: "not_found" } });
    fireEvent.click(publishButton());
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("This organization is not available to you any more.");
  });

  it("a refused read is said (403) and offers no form", async () => {
    getAnswer = () => json(403, { error: { code: "forbidden" } });
    postAnswer = () => json(500, {});
    const { container } = render(<OrganizationAdminRetentionPage />);
    await settle();
    expect(container.querySelector('[data-state="error"]')?.textContent).toContain("You don't have access to org-level retention configuration.");
    expect(screen.queryByTestId("retention-publish-form")).toBeNull();
  });
});
