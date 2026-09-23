import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), state: { archived: false, bound: null as string | null } }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../lib/platform-context", () => ({ useActiveSpaceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../components/navigation/PageRouteGate", () => ({
  PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import CodingSchemasPage from "../../app/(app)/review/schemas/page";
import { CodingSchemaBindingPanel } from "../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel";

const teamId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const schemaId = "11111111-1111-4111-8111-111111111111";
const otherId = "11111111-1111-4111-8111-111111111112";
const workflowId = "22222222-2222-4222-8222-222222222222";
const listUrl = `/v1/coding/schemas?teamId=${teamId}`;
const archiveUrl = `/v1/coding/schemas/${schemaId}/archive?teamId=${teamId}`;
const codingUrl = `/v1/reviewer/work/${workflowId}/coding?teamId=${teamId}`;
const publishedUrl = `/v1/coding/schemas?teamId=${teamId}&status=PUBLISHED`;
const bindUrl = `/v1/reviewer/work/${workflowId}/bind-schema?teamId=${teamId}`;
const ARCHIVED = 'Schema "Privilege review" archived. The saved list shows it as archived.';
const BOUND = 'Coding schema set to "Privilege review". Reviewers now see its coding fields.';

function schema(status: string) {
  return { id: schemaId, slug: "privilege_review", label: "Privilege review", category: "PRIVILEGE", version: 1, status, description: null, fields: [] };
}
const labels: Record<string, string> = { [schemaId]: "Privilege review", [otherId]: "Relevance" };
function workspace(capabilities: string[]) {
  return { workspace: { capabilities } };
}
let capabilities: string[] = ["review.schema.author", "review.assign"];

function writes(url: string) {
  return mocks.fetch.mock.calls.filter(([path, init]) => path === url && init?.method === "POST");
}

beforeEach(() => {
  capabilities = ["review.schema.author", "review.assign"];
  mocks.state.archived = false;
  mocks.state.bound = null;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
    if (path === archiveUrl && init?.method === "POST") { mocks.state.archived = true; return { ok: true }; }
    if (path === listUrl) return { schemas: [schema(mocks.state.archived ? "ARCHIVED" : "PUBLISHED")] };
    if (path === publishedUrl) return { schemas: [{ id: schemaId, label: "Privilege review", version: 1 }, { id: otherId, label: "Relevance", version: 2 }] };
    if (path === bindUrl && init?.method === "POST") { mocks.state.bound = JSON.parse(String(init.body)).schemaId; return { ok: true }; }
    if (path === codingUrl) {
      const id = mocks.state.bound;
      return { values: [], coverage: { totalRequired: 0, fulfilled: 0, unfulfilledFieldIds: [] }, schemaBinding: id ? { id, label: labels[id], version: 1, status: "PUBLISHED" } : null };
    }
    return {};
  });
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

async function archiveButton() {
  const button = await screen.findByRole("button", { name: "Archive Privilege review" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
}

describe("coding schema archive", () => {
  it("confirms, archives, rereads the list and only then announces success", async () => {
    render(<CodingSchemasPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText(ARCHIVED);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive the schema "Privilege review"?', tone: "danger" }));
    expect(writes(archiveUrl)).toHaveLength(1);
    const calls = mocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(calls.lastIndexOf(listUrl)).toBeGreaterThan(calls.indexOf(archiveUrl));
    const row = screen.getByRole("button", { name: "Archive Privilege review" });
    expect(row.hasAttribute("disabled")).toBe(true);
    expect(row.getAttribute("data-disabled-reason")).toBe("This schema is already archived.");
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.queryByText("PUBLISHED")).toBeNull();
  });

  it("cancellation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<CodingSchemasPage />);
    fireEvent.click(await archiveButton());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive Privilege review" }).hasAttribute("disabled")).toBe(false));
    expect(writes(archiveUrl)).toHaveLength(0);
  });

  it("explains why a non-author cannot archive", async () => {
    capabilities = ["review.code"];
    render(<CodingSchemasPage />);
    const button = await screen.findByRole("button", { name: "Archive Privilege review" });
    await waitFor(() => expect(button.getAttribute("data-disabled-reason")).toBe("Only schema authors in this workspace can archive a schema."));
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("renders a refused archive without claiming success", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
      if (path === archiveUrl) throw { statusCode: 403, code: "NOT_PERMITTED" };
      return { schemas: [schema("PUBLISHED")] };
    });
    render(<CodingSchemasPage />);
    fireEvent.click(await archiveButton());
    await screen.findByText("Only schema authors in this workspace can archive a schema.", { selector: "[role=alert]" });
    expect(screen.queryByText(ARCHIVED)).toBeNull();
  });

  it("never renders a failed or refused list as empty", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
      throw { statusCode: 403 };
    });
    render(<CodingSchemasPage />);
    await screen.findByText("You do not have access to coding schemas in this workspace.");
    expect(screen.queryByText("No coding schemas are available in this workspace yet.")).toBeNull();
  });
});

describe("coding schema binding on a review", () => {
  async function openBinding() {
    render(<CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />);
    await screen.findByText("No coding schema is bound, so reviewers see no coding fields for this review.");
    const toggle = screen.getByRole("button", { name: "Choose coding schema" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    const select = await screen.findByLabelText("Published schema");
    await waitFor(() => expect(document.activeElement).toBe(select));
    return { toggle, select };
  }

  it("binds the chosen published schema and announces only after the reread shows it", async () => {
    const { select } = await openBinding();
    const submit = screen.getByRole("button", { name: "Bind schema" });
    expect(submit.getAttribute("data-disabled-reason")).toBe("Choose a published schema.");
    fireEvent.change(select, { target: { value: schemaId } });
    fireEvent.click(submit);
    await screen.findByText(BOUND);
    expect(writes(bindUrl)).toHaveLength(1);
    expect(JSON.parse(writes(bindUrl)[0][1].body)).toEqual({ schemaId });
    const calls = mocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(calls.lastIndexOf(codingUrl)).toBeGreaterThan(calls.indexOf(bindUrl));
    expect(screen.getByText("Privilege review (version 1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change coding schema" })).toBeTruthy();
  });

  it("cancelling the confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    const { select } = await openBinding();
    fireEvent.change(select, { target: { value: schemaId } });
    fireEvent.click(screen.getByRole("button", { name: "Bind schema" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(writes(bindUrl)).toHaveLength(0);
    expect(screen.queryByText(BOUND)).toBeNull();
  });

  it("cancelling the form restores focus to its toggle", async () => {
    const { toggle } = await openBinding();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(toggle);
    expect(screen.queryByLabelText("Published schema")).toBeNull();
  });

  it("warns before replacing an existing binding", async () => {
    mocks.state.bound = otherId;
    render(<CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />);
    const toggle = await screen.findByRole("button", { name: "Change coding schema" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    const select = await screen.findByLabelText("Published schema");
    fireEvent.change(select, { target: { value: otherId } });
    expect(screen.getByRole("button", { name: "Bind schema" }).getAttribute("data-disabled-reason")).toBe("This review already uses that schema.");
    fireEvent.change(select, { target: { value: schemaId } });
    fireEvent.click(screen.getByRole("button", { name: "Bind schema" }));
    await screen.findByText(BOUND);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Change this review's coding schema?", tone: "warning" }));
  });

  it.each([
    ["SCHEMA_NOT_FOUND", 409, "That schema is no longer published in this workspace. Choose another."],
    ["WORKFLOW_NOT_FOUND", 409, "This review no longer exists in this workspace."],
    ["NOT_PERMITTED", 403, "Only reviewers who can assign reviews can change the coding schema."],
  ])("maps %s to operator language", async (code, statusCode, text) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === bindUrl && init?.method === "POST") throw { statusCode, code };
      if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
      if (path === publishedUrl) return { schemas: [{ id: schemaId, label: "Privilege review", version: 1 }] };
      return { values: [], coverage: {}, schemaBinding: null };
    });
    const { select } = await openBinding();
    fireEvent.change(select, { target: { value: schemaId } });
    fireEvent.click(screen.getByRole("button", { name: "Bind schema" }));
    expect((await screen.findByText(text)).getAttribute("role")).toBe("alert");
    expect(screen.queryByText(BOUND)).toBeNull();
  });

  it("does not announce success when the reread does not show the new schema", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
      if (path === publishedUrl) return { schemas: [{ id: schemaId, label: "Privilege review", version: 1 }] };
      return { values: [], coverage: {}, schemaBinding: null };
    });
    const { select } = await openBinding();
    fireEvent.change(select, { target: { value: schemaId } });
    fireEvent.click(screen.getByRole("button", { name: "Bind schema" }));
    await screen.findByText(/does not show it yet/);
    expect(screen.queryByText(BOUND)).toBeNull();
  });

  it("explains why a reviewer without assign rights cannot bind", async () => {
    capabilities = ["review.code"];
    render(<CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />);
    const toggle = await screen.findByRole("button", { name: "Choose coding schema" });
    await waitFor(() => expect(toggle.getAttribute("data-disabled-reason")).toBe("Only reviewers who can assign reviews can change the coding schema."));
  });

  it("never renders a refused or failed binding read as unbound", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
      throw { statusCode: 403 };
    });
    render(<CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />);
    await screen.findByText(/coding schema is not available to you/);
    expect(screen.queryByText(/No coding schema is bound/)).toBeNull();
  });

  it("states an empty published list with a way forward", async () => {
    mocks.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/v1/reviewer/workspace")) return workspace(capabilities);
      if (path === publishedUrl) return { schemas: [] };
      return { values: [], coverage: {}, schemaBinding: null };
    });
    render(<CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />);
    const toggle = await screen.findByRole("button", { name: "Choose coding schema" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    const empty = await screen.findByText(/No schema is published in this workspace yet/);
    expect(within(empty).getByRole("link", { name: "Coding schemas" }).getAttribute("href")).toBe("/review/schemas");
  });

  it("the review page mounts the binding panel", () => {
    const src = readFileSync(join(__dirname, "../../app/(app)/reviewer-ops/[reviewId]/page.tsx"), "utf8");
    expect(src).toMatch(/<CodingSchemaBindingPanel teamId=\{teamId\} workflowId=\{workflowId\} \/>/);
  });
});
