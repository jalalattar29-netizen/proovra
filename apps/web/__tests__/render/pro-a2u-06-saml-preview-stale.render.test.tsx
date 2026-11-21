/**
 * PRO-A2U-06 (closure) — the SAML attribute-mapping page never shows (or lets
 * Save acknowledge) a preview computed for a mapping that is no longer the one
 * on screen. The real page, the real apiFetch over a stubbed network whose
 * preview answers are released by the test:
 *   - refused: a preview requested BEFORE an edit resolves after it -> ignored,
 *     Save stays unavailable ("Preview required before save");
 *   - refused: two previews, the older resolves last -> the newer one stands;
 *   - allowed: a preview for the mapping on screen is shown and enables Save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/security-center/sso/mapping",
  useParams: () => ({}),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../../lib/platform-context", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, useTeamId: () => "team-1" };
});

import { ToastProvider } from "../../components/ui";
import SamlMappingPage from "../../app/(app)/security-center/sso/mapping/page";

type Deferred = { resolve: (body: unknown) => void; body: Record<string, unknown> };
let previews: Deferred[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SCHEMA = {
  version: 1,
  notes: [],
  fields: [
    { key: "email", label: "Email attribute", description: "d", kind: "string", required: true, suggestions: [], privilegeAffecting: false },
    { key: "name", label: "Display name attribute", description: "d", kind: "string", required: false, suggestions: [], privilegeAffecting: false },
  ],
};
const CURRENT = {
  connectionId: "conn-1",
  teamId: "team-1",
  provider: "GENERIC_SAML",
  status: "ACTIVE",
  scimManaged: false,
  mapping: { email: "mail", name: "displayName", externalId: null, groupClaim: null, defaultRole: "MEMBER", groupRoleMap: [] },
  jitDefaultRole: null,
};
const previewFor = (name: string) => ({
  preview: {
    privilegeAffecting: false,
    changes: [{ field: "name", before: "displayName", after: name }],
    warnings: [],
    sampleResolution: null,
  },
});

beforeEach(() => {
  previews = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (path.startsWith("/v1/saml/mapping/schema")) return json({ schema: SCHEMA });
      if (path.startsWith("/v1/admin/identity/providers")) return json({ providers: [{ id: "conn-1", provider: "GENERIC_SAML" }] });
      if (path.startsWith("/v1/saml/mapping/current")) return json({ current: CURRENT });
      if (path.startsWith("/v1/saml/mapping/preview")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Promise<Response>((resolve) => previews.push({ body, resolve: (b) => resolve(json(b)) }));
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  render(
    <ToastProvider>
      <SamlMappingPage />
    </ToastProvider>,
  );
  await screen.findByLabelText("Display name attribute");
}
const nameInput = () => screen.getByLabelText("Display name attribute") as HTMLInputElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function clickPreview() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Preview changes|Previewing/ }));
  });
}
async function edit(value: string) {
  await act(async () => {
    fireEvent.change(nameInput(), { target: { value } });
  });
}

describe("PRO-A2U-06 — a stale SAML preview never lands", () => {
  it("refused: a preview requested before an edit, answered after it, is ignored and Save stays unavailable", async () => {
    await mount();
    await edit("cn");
    await clickPreview();
    expect(previews).toHaveLength(1);
    await edit("givenName"); // the mapping on screen changes while the preview is in flight
    await act(async () => previews[0]!.resolve(previewFor("cn")));
    await flush();
    expect(screen.queryByText("Preview ready")).toBeNull();
    expect(screen.getByText("Preview required before save")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Preview" })).toBeNull();
  });

  it("refused: of two previews, the older answer resolving last does not replace the newer one", async () => {
    await mount();
    await edit("cn");
    await clickPreview();
    await edit("givenName");
    await clickPreview();
    expect(previews).toHaveLength(2);
    expect((previews[1]!.body.mapping as { name: string }).name).toBe("givenName");
    await act(async () => previews[1]!.resolve(previewFor("givenName")));
    await flush();
    await act(async () => previews[0]!.resolve(previewFor("cn")));
    await flush();
    expect(screen.getByText("Preview ready")).toBeTruthy();
    expect(screen.getAllByText("givenName").length).toBeGreaterThan(0);
    expect(screen.queryByText("cn")).toBeNull();
  });

  it("allowed: a preview of the mapping on screen is shown and enables Save", async () => {
    await mount();
    await edit("cn");
    await clickPreview();
    await act(async () => previews[0]!.resolve(previewFor("cn")));
    await flush();
    expect(screen.getByText("Preview ready")).toBeTruthy();
    const save = screen.getByRole("button", { name: /Save mapping/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });
});
