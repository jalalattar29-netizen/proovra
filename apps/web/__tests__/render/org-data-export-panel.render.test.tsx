/**
 * PRO-CENZ-01 / GOV-015 — the organization owner's offboarding export
 * (EP-0842 request, EP-0843 manifest, EP-0844 links).
 *
 * The real panel over the REAL apiFetch and a stubbed network: history,
 * request with the step-up proof in the body, the manifest saved as the
 * server's bytes, paged sealed-version links, and every refusal in words. The
 * mount rule (owner of a customer organization only) is tested on the
 * organization page itself.
 */
import React from "react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: async () => false }) }));
vi.mock("../../lib/platform-context", async (orig) => ({
  ...((await orig()) as object),
  usePlatformContext: () => ({ refresh: async () => {}, envelope: { user: { id: "owner-1" } } }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  useSearchParams: () => new URLSearchParams(),
}));

import { OrgDataExportPanel } from "../../app/(app)/organizations/[id]/_components/OrgDataExportPanel";
import OrganizationPage from "../../app/(app)/organizations/[id]/page";

const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE = `/v1/orgs/${ORG}/data-export`;
const REQ = "11111111-1111-4111-8111-111111111111";
// Deliberately formatted so a parse + re-stringify would NOT reproduce it.
const MANIFEST_BYTES = '{"schema":"PROOVRA_ORG_DATA_EXPORT_V1",  "manifest":{"recordCount":2}}';
const MANIFEST_SHA = createHash("sha256").update(MANIFEST_BYTES, "utf8").digest("hex");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const row = (status: string, extra: Record<string, unknown> = {}) => ({
  id: REQ,
  status,
  requestedAtUtc: "2026-11-20T09:00:00.000Z",
  completedAtUtc: status === "READY" ? "2026-11-20T09:05:00.000Z" : null,
  expiresAtUtc: status === "READY" ? "2026-11-27T09:05:00.000Z" : null,
  failureCode: null,
  manifestSha256: status === "READY" ? MANIFEST_SHA : null,
  recordCount: status === "READY" ? 2 : null,
  objectCount: status === "READY" ? 3 : null,
  heldRecordCount: status === "READY" ? 1 : null,
  missingObjectCount: status === "READY" ? 0 : null,
  downloadCount: 0,
  ...extra,
});

const link = (n: number) => ({
  evidenceId: `e${n}eeeeee-eeee-4eee-8eee-eeeeeeeeeeee`,
  kind: "original",
  key: `org/${n}.jpg`,
  versionId: `v-${n}`,
  sha256: "a".repeat(64),
  sizeBytes: "10",
  url: `https://storage.example.test/org/${n}.jpg?versionId=v-${n}`,
});

type Call = { path: string; method: string; body: Record<string, unknown> | null };
let calls: Call[];
let routes: Record<string, (call: Call) => Response | Promise<Response>>;

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] as string;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const call = { path, method, body };
      calls.push(call);
      const handler = routes[`${method} ${path}`];
      return handler ? handler(call) : json(200, {});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const stepUpRequired = () =>
  json(401, { error: { code: "STEP_UP_REQUIRED", message: "Verify it's you.", methods: ["password"] } });

describe("EP-0842 — request the organization export", () => {
  it("loading, then empty; the request asks for the step-up, carries the proof in the body, and the history shows it", async () => {
    let rows: unknown[] = [];
    routes[`GET ${BASE}`] = () => json(200, { requests: rows });
    routes[`POST ${BASE}`] = (c) => {
      if (!c.body?.stepUp) return stepUpRequired();
      rows = [row("REQUESTED")];
      return json(201, { request: { id: REQ, status: "REQUESTED", requestedAtUtc: "2026-11-20T09:00:00.000Z" } });
    };
    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
    await settle();
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();

    fireEvent.click(container.querySelector('[data-action="org-data-export-request"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector("[data-cc-step-up-verify]")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "owner-pass" } });
    fireEvent.submit(container.querySelector("[data-cc-step-up-verify] form") as HTMLFormElement);
    await settle();

    const posts = calls.filter((c) => c.method === "POST" && c.path === BASE);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual({});
    expect(posts[1]!.body).toEqual({ stepUp: { method: "password", currentPassword: "owner-pass" } });
    expect(container.querySelector("[data-cc-step-up-verify]")).toBeNull();
    expect(screen.getByText(/Export requested/)).toBeTruthy();
    expect(container.querySelector('[data-org-export-row="REQUESTED"]')).not.toBeNull();
    // One active request per organization: no second request is offered.
    expect(container.querySelector('[data-action="org-data-export-request"]')).toBeNull();
  });

  it("an export already active is said and the history re-read", async () => {
    routes[`GET ${BASE}`] = () => json(200, { requests: [] });
    routes[`POST ${BASE}`] = () =>
      json(409, { error: { code: "export_request_active", message: "An export is already requested or ready." } });
    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    await settle();
    fireEvent.click(container.querySelector('[data-action="org-data-export-request"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector("[data-org-export-error]")?.textContent).toContain("An export is already requested or ready");
    expect(calls.filter((c) => c.method === "GET" && c.path === BASE)).toHaveLength(2);
  });

  it("a refused history read (not the owner) says why and offers no request", async () => {
    routes[`GET ${BASE}`] = () => json(403, { error: { code: "forbidden" } });
    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    await settle();
    expect(container.querySelector('[data-state="error"]')?.textContent).toContain(
      "Only the organization owner can export the organization's data.",
    );
    expect(container.querySelector('[data-action="org-data-export-request"]')).toBeNull();
  });

  it("a lost answer is not 'no exports': it says so, offers Try again, and no request", async () => {
    let up = false;
    routes[`GET ${BASE}`] = () => (up ? json(200, { requests: [row("READY")] }) : Promise.reject(new TypeError("Failed to fetch")));
    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    await settle();
    expect(container.querySelector('[data-state="error"]')).not.toBeNull();
    expect(container.querySelector('[data-state="empty"]')).toBeNull();
    expect(container.querySelector('[data-action="org-data-export-request"]')).toBeNull();
    up = true;
    fireEvent.click(container.querySelector('[data-action="org-data-export-retry"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector('[data-org-export-row="READY"]')).not.toBeNull();
  });
});

describe("EP-0843 / EP-0844 — download a READY export", () => {
  it("the manifest file is the server's bytes, so its SHA-256 is the one shown", async () => {
    routes[`GET ${BASE}`] = () => json(200, { requests: [row("READY")] });
    routes[`POST ${BASE}/${REQ}/manifest`] = (c) =>
      c.body?.stepUp
        ? new Response(MANIFEST_BYTES, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } })
        : stepUpRequired();
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        blobs.push(b);
        return "blob:manifest";
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    await settle();
    expect(container.querySelector("[data-org-export-checksum]")?.textContent).toContain(MANIFEST_SHA);
    expect(container.textContent).toContain("2 records · 3 stored files · 1 under legal hold");

    fireEvent.click(container.querySelector('[data-action="org-data-export-manifest"]') as HTMLButtonElement);
    await settle();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "owner-pass" } });
    fireEvent.submit(container.querySelector("[data-cc-step-up-verify] form") as HTMLFormElement);
    await settle();

    expect(blobs).toHaveLength(1);
    const saved = await blobs[0]!.text();
    expect(saved).toBe(MANIFEST_BYTES);
    expect(createHash("sha256").update(saved, "utf8").digest("hex")).toBe(MANIFEST_SHA);
  });

  it("links come a page at a time with the next offset, and withheld records are counted", async () => {
    routes[`GET ${BASE}`] = () => json(200, { requests: [row("READY")] });
    routes[`POST ${BASE}/${REQ}/links`] = (c) =>
      c.body?.offset === 100
        ? json(200, { links: [link(101)], nextOffset: null, total: 101, withheldByLegalHold: [] })
        : json(200, {
            links: [link(1), link(2)],
            nextOffset: 100,
            total: 101,
            withheldByLegalHold: [{ evidenceId: "held", workspaceId: "w", reason: "WITHHELD_BY_LEGAL_HOLD" }],
          });
    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    await settle();
    fireEvent.click(container.querySelector('[data-action="org-data-export-links"]') as HTMLButtonElement);
    await settle();
    expect(calls.find((c) => c.path === `${BASE}/${REQ}/links`)?.body).toEqual({ offset: 0 });
    const anchors = Array.from(container.querySelectorAll("[data-org-export-links] a")) as HTMLAnchorElement[];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([link(1).url, link(2).url]);
    expect(anchors[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    const text = container.querySelector("[data-org-export-links]")?.textContent ?? "";
    expect(text).toContain("of 101");
    expect(text).toContain("1 record is withheld under legal hold");

    fireEvent.click(container.querySelector('[data-action="org-data-export-links-next"]') as HTMLButtonElement);
    await settle();
    const linkCalls = calls.filter((c) => c.path === `${BASE}/${REQ}/links`);
    expect(linkCalls[1]!.body).toEqual({ offset: 100 });
    expect(container.querySelector("[data-org-export-links]")?.textContent).toContain("Files 101–101 of 101");
    expect(container.querySelector('[data-action="org-data-export-links-next"]')).toBeNull();
  });

  it("an export that expired between reads is said, not retried", async () => {
    routes[`GET ${BASE}`] = () => json(200, { requests: [row("READY")] });
    routes[`POST ${BASE}/${REQ}/links`] = () =>
      json(409, { error: { code: "export_not_ready", message: "This export is not available for download." } });
    const { container } = render(<OrgDataExportPanel orgId={ORG} />);
    await settle();
    fireEvent.click(container.querySelector('[data-action="org-data-export-links"]') as HTMLButtonElement);
    await settle();
    expect(container.querySelector("[data-org-export-error]")?.textContent).toBe(
      "This export is not available for download any more.",
    );
    expect(calls.filter((c) => c.path === `${BASE}/${REQ}/links`)).toHaveLength(1);
  });
});

describe("the organization page mounts the export for the owner of a customer organization only", () => {
  function servePage(callerRole: string, organizationKind: "CUSTOMER" | "SYSTEM") {
    routes[`GET /v1/orgs/${ORG}`] = () =>
      json(200, {
        organizationId: ORG,
        name: "Acme Legal",
        status: "ACTIVE",
        callerRole,
        adminSurfaces: ["overview"],
        organizationKind,
        summary: { memberCount: 2, workspaceCount: 1, pendingInviteCount: 0 },
      });
    routes[`GET /v1/orgs/${ORG}/members`] = () =>
      json(200, { organizationId: ORG, summary: { totalMembers: 1 }, members: [] });
    routes[`GET /v1/orgs/${ORG}/workspaces`] = () =>
      json(200, { organizationId: ORG, summary: { totalWorkspaces: 0 }, callerCanSeeBilling: false, workspaces: [] });
    routes[`GET /v1/orgs/${ORG}/audit-events`] = () => json(200, { organizationId: ORG, summary: { totalEvents: 0 }, events: [] });
    routes[`GET /v1/orgs/${ORG}/invites`] = () => json(200, { organizationId: ORG, summary: { totalPending: 0 }, invites: [] });
    routes[`GET /v1/orgs/${ORG}/closure`] = () =>
      json(200, { request: null, blockers: [], confirmationPhrase: "close this organization", coolingOffDays: 7 });
    routes[`GET /v1/orgs/${ORG}/ownership-offer`] = () => json(200, { offer: null });
    routes[`GET ${BASE}`] = () => json(200, { requests: [] });
  }

  it("the owner of a customer organization gets the export", async () => {
    servePage("ORG_OWNER", "CUSTOMER");
    const { container } = render(<OrganizationPage />);
    await settle();
    expect(container.querySelector('[data-control="org-data-export"]')).not.toBeNull();
    expect(calls.some((c) => c.path === BASE)).toBe(true);
  });

  it("an organization admin gets none, and is told the export is the owner's", async () => {
    servePage("ORG_ADMIN", "CUSTOMER");
    const { container } = render(<OrganizationPage />);
    await settle();
    expect(container.querySelector('[data-control="org-data-export"]')).toBeNull();
    expect(calls.some((c) => c.path === BASE)).toBe(false);
    expect(container.querySelector('[data-control="lifecycle-owner-only-note"]')?.textContent).toContain(
      "the organization data export",
    );
  });

  it("the owner of a SYSTEM organization (a personal workspace's container) gets none", async () => {
    servePage("ORG_OWNER", "SYSTEM");
    const { container } = render(<OrganizationPage />);
    await settle();
    expect(container.querySelector('[data-control="org-data-export"]')).toBeNull();
    expect(calls.some((c) => c.path === BASE)).toBe(false);
  });
});
