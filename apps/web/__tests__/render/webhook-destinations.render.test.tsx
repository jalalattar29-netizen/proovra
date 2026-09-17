/**
 * BATCH J — Automation webhook destinations.
 *
 *   GET   /v1/automation/webhooks?teamId=
 *   POST  /v1/automation/webhooks
 *   PATCH /v1/automation/webhooks/:id
 *   POST  /v1/automation/webhooks/:id/enable
 *   POST  /v1/automation/webhooks/:id/disable
 *   POST  /v1/automation/webhooks/:id/rotate-secret
 *
 * components/automation/AutomationWebhookDestinationsPanel.tsx (mounted by
 * app/(app)/operations/automation/page.tsx) and the rule form's destination
 * picker. Every mutation is announced only after the list reread shows it; a
 * signing secret is shown once with a copy control.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));

vi.mock("../../lib/api", () => ({
  apiFetch: mocks.fetch,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../components/ui/ConfirmActionModal", () => ({
  useConfirmAction: () => ({ confirm: mocks.confirm }),
}));

import { AutomationWebhookDestinationsPanel } from "../../components/automation/AutomationWebhookDestinationsPanel";
import { AutomationRuleForm } from "../../components/automation/AutomationRuleForm";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-01T10:00:00.000Z";
const LIST = `/v1/automation/webhooks?teamId=${TEAM}`;

type Row = Record<string, unknown>;
function dest(over: Row = {}): Row {
  return {
    id: ID, teamId: TEAM, name: "Receiver", url: "https://receiver.example/hook", urlOrigin: "https://receiver.example",
    secretFingerprint: "fp-old", enabled: false, createdAt: ISO, updatedAt: ISO, disabledAt: ISO,
    lastSuccessAt: null, lastFailureAt: ISO, failureCount: 5, ...over,
  };
}
function failure(statusCode: number, code?: string, extra: Row = {}): Error {
  return Object.assign(new Error("request failed"), { statusCode, code, ...extra });
}

let rows: Row[];
function defaultReply(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? "GET";
  if (method === "GET" && path === LIST) return { destinations: rows, limits: { maxDestinationsPerTeam: 10 } };
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (method === "POST" && path === "/v1/automation/webhooks") {
    const created = dest({ id: NEW, name: body.name, url: body.url, urlOrigin: "https://new.example", secretFingerprint: "fp-new-dest" });
    rows = [...rows, created];
    return { ...created, revealedSecret: "whsec_created_once" };
  }
  const match = path.match(/^\/v1\/automation\/webhooks\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const [, id, leg] = match;
    const i = rows.findIndex((r) => r.id === id);
    if (method === "PATCH") rows[i] = { ...rows[i], ...body };
    if (leg === "enable") rows[i] = { ...rows[i], enabled: true, disabledAt: null };
    if (leg === "disable") rows[i] = { ...rows[i], enabled: false, disabledAt: ISO };
    if (leg === "rotate-secret") {
      rows[i] = { ...rows[i], secretFingerprint: "fp-rotated" };
      return { ...rows[i], revealedSecret: "whsec_rotated_once" };
    }
    return rows[i];
  }
  throw new Error("unexpected " + method + " " + path);
}

beforeEach(() => {
  rows = [dest()];
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => defaultReply(path, init));
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

const writes = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
function mount(canManage = true, onChange?: (list: unknown) => void) {
  return render(<AutomationWebhookDestinationsPanel teamId={TEAM} canManage={canManage} onDestinationsChange={onChange} />);
}
function reasonOf(button: HTMLElement) {
  return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent;
}
function readsAfter(index: number) {
  return mocks.fetch.mock.calls.slice(index + 1).filter(([p, init]) => p === LIST && (init?.method ?? "GET") === "GET").length;
}
function lastWriteIndex() {
  const calls = mocks.fetch.mock.calls;
  for (let i = calls.length - 1; i >= 0; i -= 1) if (calls[i][1]?.method && calls[i][1].method !== "GET") return i;
  return -1;
}

describe("automation webhook destinations", () => {
  it("lists destinations with host, state, failures and last outcomes", async () => {
    const onChange = vi.fn();
    mount(true, onChange);
    const item = (await screen.findByText("Receiver")).closest("li") as HTMLElement;
    expect(within(item).getByText("https://receiver.example")).toBeTruthy();
    expect(within(item).getByText("Disabled")).toBeTruthy();
    expect(within(item).getByText("5")).toBeTruthy();
    expect(within(item).getByText("Never")).toBeTruthy();
    expect(within(item).getByText(ID).hasAttribute("data-identifier")).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: ID })]);
  });

  it("creates with the real payload, shows the secret once, and announces after the reread", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    mount();
    const add = await screen.findByRole("button", { name: "Add destination" });
    fireEvent.click(add);
    expect(add.getAttribute("aria-expanded")).toBe("true");
    const form = screen.getByRole("form", { name: "Add a webhook destination" });
    expect(document.activeElement).toBe(within(form).getByLabelText("Name"));
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "New receiver" } });
    fireEvent.change(within(form).getByLabelText("Destination URL"), { target: { value: "https://new.example/in" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add destination" }));
    await screen.findByText(/"New receiver" was added and confirmed from the saved record/);
    const post = writes()[0];
    expect(post[0]).toBe("/v1/automation/webhooks");
    expect(JSON.parse(post[1].body)).toEqual({ teamId: TEAM, name: "New receiver", url: "https://new.example/in" });
    expect(readsAfter(lastWriteIndex())).toBeGreaterThanOrEqual(1);
    const secret = screen.getByRole("region", { name: /Signing secret for/ });
    expect(within(secret).getByText("whsec_created_once")).toBeTruthy();
    expect(within(secret).getByText(/You will not see this secret again/)).toBeTruthy();
    fireEvent.click(within(secret).getByRole("button", { name: "Copy secret" }));
    await within(secret).findByText("Copied to the clipboard.");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("whsec_created_once");
    fireEvent.click(within(secret).getByRole("button", { name: /I have stored it/ }));
    expect(screen.queryByText("whsec_created_once")).toBeNull();
  });

  it("shows a server URL rejection beside the URL field", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(400, "url_rejected", { body: { error: { code: "url_rejected", reason: "localhost" } } });
      return defaultReply(path, init);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add destination" }));
    const form = screen.getByRole("form", { name: "Add a webhook destination" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Local" } });
    fireEvent.change(within(form).getByLabelText("Destination URL"), { target: { value: "https://localhost/in" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add destination" }));
    const error = await within(form).findByText(/This URL was rejected: it points at this machine/);
    expect(within(form).getByLabelText("Destination URL").getAttribute("aria-describedby")).toBe(error.id);
    expect(screen.queryByText(/was added/)).toBeNull();
  });

  it("cancelling the create form makes no write and returns focus to Add", async () => {
    mount();
    const add = await screen.findByRole("button", { name: "Add destination" });
    fireEvent.click(add);
    fireEvent.click(within(screen.getByRole("form", { name: "Add a webhook destination" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Add a webhook destination" })).toBeNull();
    expect(document.activeElement).toBe(add);
    expect(writes()).toHaveLength(0);
  });

  it("explains disabled controls for a view-only operator and an invalid form", async () => {
    mount(false);
    const add = await screen.findByRole("button", { name: "Add destination" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(reasonOf(add)).toBe("Only a workspace owner or admin can change webhook destinations.");
    const enable = screen.getByRole("button", { name: "Enable destination Receiver" });
    expect(reasonOf(enable)).toBe("Only a workspace owner or admin can change webhook destinations.");
    cleanup();
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "Add destination" }));
    const submit = within(screen.getByRole("form", { name: "Add a webhook destination" })).getByRole("button", { name: "Add destination" });
    expect(reasonOf(submit)).toBe("Enter a name of 1 to 120 characters.");
  });

  it("enables after confirmation and announces after the reread", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Enable destination Receiver" }));
    await screen.findByText(/"Receiver" is enabled and confirmed from the saved record/);
    expect(mocks.confirm.mock.calls[0][0].description).toMatch(/from now on/);
    expect(writes()[0][0]).toBe(`/v1/automation/webhooks/${ID}/enable`);
    expect(readsAfter(lastWriteIndex())).toBeGreaterThanOrEqual(1);
    await screen.findByRole("button", { name: "Disable destination Receiver" });
  });

  it("disables behind a danger confirmation naming the effect on rules; cancel writes nothing", async () => {
    rows = [dest({ enabled: true, disabledAt: null })];
    mocks.confirm.mockResolvedValueOnce(false);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Disable destination Receiver" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0][0]).toMatchObject({ tone: "danger", title: 'Disable "Receiver"?' });
    expect(mocks.confirm.mock.calls[0][0].description).toMatch(/webhook deliveries will fail/);
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Disable destination Receiver" }));
    await screen.findByText(/"Receiver" is disabled and confirmed/);
    expect(writes()[0][0]).toBe(`/v1/automation/webhooks/${ID}/disable`);
  });

  it("rotates the secret, shows the new one once, and confirms the new fingerprint from the reread", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate signing secret of Receiver" }));
    await screen.findByText(/signing secret of "Receiver" was rotated and confirmed/);
    expect(mocks.confirm.mock.calls[0][0]).toMatchObject({ tone: "danger" });
    expect(mocks.confirm.mock.calls[0][0].description).toMatch(/stops working immediately/);
    expect(writes()[0][0]).toBe(`/v1/automation/webhooks/${ID}/rotate-secret`);
    const secret = screen.getByRole("region", { name: /New signing secret for/ });
    expect(within(secret).getByText("whsec_rotated_once")).toBeTruthy();
    expect(screen.getByText("fp-rotated")).toBeTruthy();
  });

  it("edits only the changed field and confirms before changing the address", async () => {
    mount();
    const edit = await screen.findByRole("button", { name: "Edit destination Receiver" });
    fireEvent.click(edit);
    const form = screen.getByRole("form", { name: 'Edit "Receiver"' });
    const submit = within(form).getByRole("button", { name: "Save changes" });
    expect(reasonOf(submit)).toBe("Change the name or the address to save.");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(submit);
    await screen.findByText(/"Renamed" was saved and confirmed/);
    expect(mocks.confirm).not.toHaveBeenCalled();
    const patch = writes()[0];
    expect(patch[0]).toBe(`/v1/automation/webhooks/${ID}`);
    expect(patch[1].method).toBe("PATCH");
    expect(JSON.parse(patch[1].body)).toEqual({ name: "Renamed" });

    fireEvent.click(screen.getByRole("button", { name: "Edit destination Renamed" }));
    const second = screen.getByRole("form", { name: 'Edit "Renamed"' });
    fireEvent.change(within(second).getByLabelText("Destination URL"), { target: { value: "https://other.example/in" } });
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(within(second).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1);
  });

  it.each([403, 500])("a %s list read is not rendered as an empty list", async (status) => {
    const onChange = vi.fn();
    mocks.fetch.mockRejectedValue(failure(status));
    mount(true, onChange);
    await waitFor(() => expect(document.querySelector("[data-automation-destinations-unreadable]")?.textContent).toMatch(/not an empty list/));
    expect(screen.queryByText("No webhook destinations registered yet.")).toBeNull();
    expect(reasonOf(screen.getByRole("button", { name: "Add destination" }))).toBe("Load the destination list first.");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("a loaded empty list says so", async () => {
    rows = [];
    mount();
    await screen.findByText("No webhook destinations registered yet.");
  });

  it.each([
    ["enable", 404, "This destination no longer exists in this workspace. Refresh the list."],
    ["enable", 403, "Only a workspace owner or admin can change webhook destinations."],
  ])("a refused %s (%s) is reported without claiming success", async (_leg, status, message) => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw failure(status);
      return defaultReply(path, init);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Enable destination Receiver" }));
    await screen.findByText(message);
    expect(screen.queryByText(/confirmed from the saved record/)).toBeNull();
  });

  it("does not claim success when the reread does not show the change", async () => {
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return dest({ enabled: true });
      return defaultReply(path, init);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Enable destination Receiver" }));
    await screen.findByText(/reloaded destination does not show it/);
    expect(screen.queryByText(/is enabled and confirmed/)).toBeNull();
  });

  it("keeps a rotated secret visible even when the reread fails", async () => {
    let rotated = false;
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (rotated && path === LIST) throw failure(503);
      if (String(path).endsWith("/rotate-secret")) rotated = true;
      return defaultReply(path, init);
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate signing secret of Receiver" }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(screen.getByText("whsec_rotated_once")).toBeTruthy();
    expect(screen.queryByText(/was rotated and confirmed/)).toBeNull();
  });
});

describe("rule form destination picker", () => {
  const baseProps = {
    mode: "create" as const,
    teamId: TEAM,
    triggerTypes: ["EVIDENCE_CREATED"],
    actionTypes: ["WEBHOOK_DELIVERY_INTERNAL_ONLY"],
    canManage: true,
    onSaved: () => {},
    onCancel: () => {},
  };

  it("offers the registered destinations by name instead of a raw id", () => {
    render(<AutomationRuleForm {...baseProps} destinationOptions={[{ id: ID, label: "Receiver (https://receiver.example)" }]} />);
    const field = screen.getByLabelText("Webhook destination") as HTMLSelectElement;
    expect(field.tagName).toBe("SELECT");
    expect(within(field).getByRole("option", { name: "Receiver (https://receiver.example)" })).toBeTruthy();
    fireEvent.change(field, { target: { value: ID } });
    expect(field.value).toBe(ID);
  });

  it("says why the id must be typed when the destination list is unreadable", () => {
    render(<AutomationRuleForm {...baseProps} destinationOptions={null} />);
    expect(screen.getByLabelText("Webhook destination").tagName).toBe("INPUT");
    expect(screen.getByText(/destination list could not be loaded/)).toBeTruthy();
  });

  it("tells the operator to register a destination first when there are none", () => {
    render(<AutomationRuleForm {...baseProps} destinationOptions={[]} />);
    expect(screen.getByRole("option", { name: "No destinations registered" })).toBeTruthy();
    expect(screen.getByText("Register a destination under Webhook destinations first.")).toBeTruthy();
  });
});

describe("automation page wiring", () => {
  it("mounts the destinations section on the automation page and feeds the rule form picker", async () => {
    vi.resetModules();
    vi.doMock("../../lib/platform-context", () => {
      const ctx = { can: () => true };
      return { usePlatformContext: () => ctx, useActiveSpaceId: () => TEAM };
    });
    vi.doMock("../../components/navigation/PageRouteGate", () => ({
      PageRouteGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    }));
    mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/v1/automation/rules?")) {
        return { rules: [], allowlist: { triggerTypes: ["EVIDENCE_CREATED"], actionTypes: ["WEBHOOK_DELIVERY_INTERNAL_ONLY"] } };
      }
      if (path.startsWith("/v1/automation/runs?")) return { runs: [], total: 0, limit: 50 };
      return defaultReply(path, init);
    });
    const { default: AutomationPage } = await import("../../app/(app)/operations/automation/page");
    render(<AutomationPage />);
    const section = await screen.findByRole("region", { name: "Webhook destinations" });
    await within(section).findByText("Receiver");
    fireEvent.click(screen.getByRole("button", { name: "Create the first rule" }));
    const picker = (await screen.findByLabelText("Webhook destination")) as HTMLSelectElement;
    expect(picker.tagName).toBe("SELECT");
    expect(within(picker).getByRole("option", { name: "Receiver (https://receiver.example) — disabled" })).toBeTruthy();
  });
});
