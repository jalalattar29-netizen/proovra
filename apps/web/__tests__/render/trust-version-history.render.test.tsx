import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch, ApiError: class ApiError extends Error {} }));
vi.mock("../../components/navigation/PageRouteGate", () => ({ PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/trust-center/security", useRouter: () => ({ push: () => {}, replace: () => {} }) }));

import { TrustCenterSectionList } from "../../app/(app)/trust-center/_section-list";
import SubprocessorsPage from "../../app/(app)/trust-center/subprocessors/page";

const ARTICLE = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";
const article = { id: ARTICLE, kind: "SECURITY", section: "encryption", slug: "encryption", title: "Encryption", summary: "Current summary", body: "Current body", state: "PUBLISHED", version: 2, driftState: null, implementationReferences: [] };
const articleVersions = [
  { id: "v1", articleId: ARTICLE, version: 1, title: "Encryption", summary: "First summary", body: "Original body text", state: "SUPERSEDED", authoredByUserId: "u", createdAtUtc: "2026-01-01T00:00:00.000Z", publishedAtUtc: null },
  { id: "v2", articleId: ARTICLE, version: 2, title: "Encryption", summary: "Current summary", body: "Current body", state: "PUBLISHED", authoredByUserId: "u", createdAtUtc: "2026-02-01T00:00:00.000Z", publishedAtUtc: "2026-02-02T00:00:00.000Z" },
];
const sub = { id: SUB, slug: "object-storage", name: "Object storage", vendor: "ExampleCloud", purpose: "Stores files", region: "EU", dataCategories: ["EVIDENCE_CONTENT"], state: "ACTIVE", effectiveAtUtc: "2026-01-01T00:00:00.000Z", documentationUrl: null, contractRef: null, version: 2, changeHistorySummary: "" };
const subVersions = [
  { id: "s1", subprocessorId: SUB, version: 1, changeSummary: "Initial registration", snapshot: { state: "PROPOSED", region: "US", dataCategories: ["ACCOUNT_METADATA"], effectiveAtUtc: "2026-01-01T00:00:00.000Z" }, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "s2", subprocessorId: SUB, version: 2, changeSummary: "Moved storage to the EU", snapshot: { state: "ACTIVE", region: "EU", dataCategories: ["EVIDENCE_CONTENT"], effectiveAtUtc: "2026-03-01T00:00:00.000Z" }, createdAt: "2026-03-01T00:00:00.000Z" },
];

function reply(path: string): unknown {
  if (path.startsWith("/v1/trust/articles?")) return { articles: [article] };
  if (path === `/v1/trust/articles/${ARTICLE}/versions`) return { versions: articleVersions };
  if (path === "/v1/trust/subprocessors") return { subprocessors: [sub] };
  if (path === `/v1/trust/subprocessors/${SUB}/versions`) return { versions: subVersions };
  return {};
}
const versionReads = (fragment: string) => mocks.fetch.mock.calls.filter(([p]) => String(p).includes(fragment));
const mutations = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string) => reply(path));
});
afterEach(cleanup);

function renderArticles() {
  return render(<TrustCenterSectionList kind="SECURITY" title="Security" description="d" anchor="security" />);
}

describe("trust article version history", () => {
  it("loads only when opened and lists versions newest first, read-only", async () => {
    renderArticles();
    const toggle = await screen.findByRole("button", { name: "Version history for Encryption" });
    expect(versionReads("/versions")).toHaveLength(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = await screen.findByRole("list", { name: "Versions of Encryption" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0].getAttribute("data-trust-article-version-row")).toBe("2");
    expect(items[1].getAttribute("data-trust-article-version-row")).toBe("1");
    expect(within(items[1]).getByText(/Superseded/)).toBeTruthy();
    fireEvent.click(within(items[1]).getByRole("button", { name: "Read version 1" }));
    expect(await screen.findByText("Original body text")).toBeTruthy();
    expect(mutations()).toHaveLength(0);
  });

  it("labels the current state instead of printing the stored value", async () => {
    renderArticles();
    await screen.findByRole("button", { name: "Version history for Encryption" });
    expect(screen.getByText(/Version 2 · Published/)).toBeTruthy();
    expect(screen.queryByText(/PUBLISHED/)).toBeNull();
  });

  it("reports a failed history read with a retry, never as empty", async () => {
    let fail = true;
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/versions") && fail) throw { statusCode: 500 };
      return reply(path);
    });
    renderArticles();
    fireEvent.click(await screen.findByRole("button", { name: "Version history for Encryption" }));
    const retry = await screen.findByRole("button", { name: "Retry version history" });
    expect(screen.queryByText("No earlier versions are recorded for this section.")).toBeNull();
    fail = false;
    fireEvent.click(retry);
    await screen.findByRole("list", { name: "Versions of Encryption" });
  });

  it("reports a refused history read as refused", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/versions")) throw { statusCode: 403 };
      return reply(path);
    });
    renderArticles();
    fireEvent.click(await screen.findByRole("button", { name: "Version history for Encryption" }));
    await screen.findByText(/do not have access to this record's version history/);
  });

  it("says so when only one version exists", async () => {
    mocks.fetch.mockImplementation(async (path: string) => (path.endsWith("/versions") ? { versions: [articleVersions[0]] } : reply(path)));
    renderArticles();
    fireEvent.click(await screen.findByRole("button", { name: "Version history for Encryption" }));
    await screen.findByText("Only one version is recorded — this is the original text.");
  });
});

describe("subprocessor change history", () => {
  it("opens a read-only change history newest first with labelled values", async () => {
    render(<SubprocessorsPage />);
    const toggle = await screen.findByRole("button", { name: "Change history for Object storage" });
    expect(versionReads("/versions")).toHaveLength(0);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = await screen.findByRole("list", { name: "Change history for Object storage" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0].textContent).toContain("Moved storage to the EU");
    expect(items[1].textContent).toContain("Initial registration");
    expect(items[1].textContent).toContain("Proposed");
    expect(items[1].textContent).toContain("Region: US");
    expect(items[1].textContent).toContain("Account metadata");
    expect(items[1].textContent).not.toContain("ACCOUNT_METADATA");
    expect(versionReads(`/v1/trust/subprocessors/${SUB}/versions`)).toHaveLength(1);
    expect(mutations()).toHaveLength(0);
  });

  it("reports a failed change-history read, never as empty", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/versions")) throw { statusCode: 503 };
      return reply(path);
    });
    render(<SubprocessorsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change history for Object storage" }));
    await screen.findByRole("button", { name: "Retry change history" });
    expect(screen.queryByText(/No change history is recorded/)).toBeNull();
  });

  it("shows an empty history truthfully", async () => {
    mocks.fetch.mockImplementation(async (path: string) => (path.endsWith("/versions") ? { versions: [] } : reply(path)));
    render(<SubprocessorsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change history for Object storage" }));
    await screen.findByText("No change history is recorded for Object storage.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not call the registry empty before the first read settles", async () => {
    let release!: (v: unknown) => void;
    mocks.fetch.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(<SubprocessorsPage />);
    expect(screen.queryByText("No subprocessors registered.")).toBeNull();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release({ subprocessors: [] });
    await screen.findByText("No subprocessors registered.");
  });
});
