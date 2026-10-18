/**
 * MANAGE VERIFICATION PAGE (2026-10-18) — the one owner control for the
 * record's permanent verification page, rendered.
 *
 * The server decides what anonymous visitors see; this proves the OWNER's
 * control prints that and changes the policy correctly:
 *
 *   - the permanent pvr_ reference with Copy and Open, and the access state
 *     as icon + text;
 *   - disclosure as a keyboard-operable radiogroup (Verification only /
 *     Content preview);
 *   - "Show recorded location" is disabled (with the reason) under
 *     Verification only and is cleared when the owner narrows back to it;
 *   - "What anonymous visitors see" is the server's visitorPreview, verbatim —
 *     never computed from the choice;
 *   - saving sends {mode, showRecordedLocation, expectedVersion};
 *   - widening answers 401 STEP_UP_REQUIRED and is retried with the proof;
 *   - 409 DISCLOSURE_VERSION_CONFLICT re-reads and shows the current setting,
 *     and the owner can retry against the new version;
 *   - without canChangeDisclosure the control is disabled and says why;
 *   - withdraw / reinstate keep working beside it.
 */
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];
let routes: Record<string, (call: Call) => unknown> = {};

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const call: Call = {
      method: (init.method ?? "GET").toUpperCase(),
      path,
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers ?? {},
    };
    calls.push(call);
    const handler = routes[`${call.method} ${path}`];
    if (!handler) throw Object.assign(new Error("not stubbed"), { statusCode: 500 });
    return handler(call);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

/** The step-up flow reduced to its contract: a 401 STEP_UP_REQUIRED is
 * answered by a challenge (or cancelled), then the action is retried with
 * the proof header. */
let stepUps = 0;
let cancelStepUp = false;
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => {
      try {
        return await fn();
      } catch (err) {
        if ((err as { code?: string }).code !== "STEP_UP_REQUIRED") throw err;
        stepUps += 1;
        if (cancelStepUp) throw Object.assign(new Error("cancel"), { code: "STEP_UP_CANCEL" });
        return fn({ "x-step-up-challenge": "challenge-1" });
      }
    },
    cancel: () => {},
    closeIdle: () => {},
    startChallenge: async () => {},
    verifyAndRetry: async () => {},
  };
  return { useStepUpAction: () => control, StepUpModal: () => null };
});

import { ManageVerificationPagePanel } from "../../components/evidence-outputs/ManageVerificationPagePanel";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const EVIDENCE = "0b6f2f0c-1a52-4f0e-9d0e-3c1b8c1f7a10";
const ACCESS = `/v1/evidence/${EVIDENCE}/verification-access`;
const DISCLOSURE = `/v1/evidence/${EVIDENCE}/verification-disclosure`;
const REF = "pvr_AbCdEfGhIjKlMnOpQrStUvWxYz0";

// Deliberately NOT the shared describer's wording: the panel must print what
// the server sent, not what it could compute.
const VO_PREVIEW = {
  shown: ["SERVER-SHOWN: the verification result"],
  withheld: ["SERVER-WITHHELD: title", "SERVER-WITHHELD: previews"],
  never: ["SERVER-NEVER: original files"],
};
const CP_PREVIEW = {
  shown: ["SERVER-SHOWN: the verification result", "SERVER-SHOWN: title and previews"],
  withheld: ["SERVER-WITHHELD: recorded location"],
  never: ["SERVER-NEVER: original files"],
};

function access(over: Record<string, unknown> = {}, disclosure: Record<string, unknown> = {}) {
  return {
    status: "AVAILABLE",
    reference: REF,
    verifyPath: `/verify/${REF}`,
    issuedAtUtc: "2026-10-01T10:00:00.000Z",
    withdrawal: null,
    canWithdraw: true,
    disclosure: {
      mode: "VERIFICATION_ONLY",
      showRecordedLocation: false,
      version: 3,
      changedAtUtc: null,
      visitorPreview: VO_PREVIEW,
      ...disclosure,
    },
    canChangeDisclosure: true,
    ...over,
  };
}

async function mount(onChanged = () => {}) {
  const view = render(
    <ToastProvider>
      <ConfirmActionProvider>
        <ManageVerificationPagePanel evidenceId={EVIDENCE} teamId="team-1" onChanged={onChanged} />
      </ConfirmActionProvider>
    </ToastProvider>,
  );
  await waitFor(() => expect(view.container.querySelector("[data-verification-access-status]")).not.toBeNull());
  return view;
}

const q = <T extends Element = HTMLElement>(c: Element, sel: string) => c.querySelector(sel) as T;
const radio = (c: Element, mode: string) => q<HTMLButtonElement>(c, `[data-verification-disclosure-mode='${mode}']`);
const locationToggle = (c: Element) => q<HTMLInputElement>(c, "[data-verification-disclosure-location]");
const save = (c: Element) => q<HTMLButtonElement>(c, "[data-verification-disclosure-action='save']");
const puts = () => calls.filter((c) => c.method === "PUT");

beforeEach(() => {
  calls = [];
  stepUps = 0;
  cancelStepUp = false;
  routes = { [`GET ${ACCESS}`]: () => access() };
});
afterEach(() => cleanup());

describe("Manage verification page — reference, access and disclosure", () => {
  it("shows the permanent reference with Copy and Open, the access state as icon + text, and the visitor warning", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });
    const { container } = await mount();
    expect(container.querySelector("h2")!.textContent).toBe("Manage verification page");
    expect(q(container, "[data-verification-access-reference]").textContent).toBe(REF);
    const open = q<HTMLAnchorElement>(container, "[data-verification-access-action='open']");
    expect(open.getAttribute("href")).toBe(`${window.location.origin}/verify/${REF}`);
    expect(open.getAttribute("rel")).toContain("noopener");
    fireEvent.click(q(container, "[data-verification-access-action='copy-link']"));
    await waitFor(() => expect(written).toEqual([`${window.location.origin}/verify/${REF}`]));

    const badge = q(container, "[data-verification-access-badge]");
    expect(badge.textContent).toBe("Available");
    expect(badge.querySelector("svg")).not.toBeNull();

    expect(q(container, "[data-verification-disclosure-warning]").textContent).toMatch(
      /Anyone holding the permanent verification reference .* can view the information this page discloses\./,
    );
    // Nothing on this control publishes anything.
    expect(container.textContent).not.toMatch(/\bpublish/i);
  });

  it("renders the two modes as an accessible radiogroup, keyboard operable", async () => {
    const { container } = await mount();
    const group = q(container, "[role='radiogroup']");
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("What the page discloses");
    const vo = radio(container, "VERIFICATION_ONLY");
    const cp = radio(container, "CONTENT_PREVIEW");
    expect(vo.getAttribute("role")).toBe("radio");
    expect(vo.getAttribute("aria-checked")).toBe("true");
    expect(cp.getAttribute("aria-checked")).toBe("false");
    // Roving tab stop: only the checked option is in the tab order.
    expect(vo.tabIndex).toBe(0);
    expect(cp.tabIndex).toBe(-1);
    expect(vo.textContent).toContain("Verification only");
    expect(cp.textContent).toContain("Content preview");

    fireEvent.keyDown(vo, { key: "ArrowRight" });
    expect(cp.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(cp);
    fireEvent.keyDown(cp, { key: "ArrowLeft" });
    expect(vo.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(vo, { key: "End" });
    expect(cp.getAttribute("aria-checked")).toBe("true");
  });

  it("'Show recorded location' is disabled with its reason under Verification only, and cleared when narrowing back", async () => {
    const { container } = await mount();
    const label = container.querySelector(`label[for='${locationToggle(container).id}']`)!;
    expect(label.textContent).toBe("Show recorded location");
    expect(locationToggle(container).getAttribute("role")).toBe("switch");
    expect(locationToggle(container).disabled).toBe(true);
    const help = document.getElementById(locationToggle(container).getAttribute("aria-describedby")!)!;
    expect(help.textContent).toContain("Available only with Content preview");

    fireEvent.click(radio(container, "CONTENT_PREVIEW"));
    expect(locationToggle(container).disabled).toBe(false);
    fireEvent.click(locationToggle(container));
    expect(locationToggle(container).checked).toBe(true);

    fireEvent.click(radio(container, "VERIFICATION_ONLY"));
    expect(locationToggle(container).disabled).toBe(true);
    expect(locationToggle(container).checked).toBe(false);
    // Back to the saved setting: nothing to save.
    expect(save(container).disabled).toBe(true);
  });

  it("prints the server's visitorPreview verbatim — the owner's unsaved choice never rewrites it", async () => {
    const { container } = await mount();
    const preview = q(container, "[data-verification-visitor-preview]");
    expect(preview.textContent).toContain("What anonymous visitors see");
    const items = (kind: string) =>
      Array.from(preview.querySelectorAll(`[data-verification-visitor-preview-group='${kind}'] li`)).map((li) => li.textContent);
    expect(items("shown")).toEqual(VO_PREVIEW.shown);
    expect(items("withheld")).toEqual(VO_PREVIEW.withheld);
    expect(items("never")).toEqual(VO_PREVIEW.never);

    fireEvent.click(radio(container, "CONTENT_PREVIEW"));
    expect(items("shown")).toEqual(VO_PREVIEW.shown);
    expect(q(container, "[data-verification-visitor-preview-basis]").textContent).toContain(
      "This describes the saved setting (Verification only). Save to apply your change.",
    );
  });

  it("widening is saved with expectedVersion after a step-up, and the new server preview replaces the old", async () => {
    routes[`PUT ${DISCLOSURE}`] = (call) => {
      if (!call.headers["x-step-up-challenge"]) {
        throw Object.assign(new Error("step-up"), { statusCode: 401, code: "STEP_UP_REQUIRED" });
      }
      return {
        changed: true,
        disclosure: { mode: "CONTENT_PREVIEW", showRecordedLocation: true, version: 4, visitorPreview: CP_PREVIEW },
      };
    };
    const onChanged = vi.fn();
    const { container } = await mount(onChanged);

    fireEvent.click(radio(container, "CONTENT_PREVIEW"));
    fireEvent.click(locationToggle(container));
    expect(q(container, "[data-verification-disclosure-step-up-hint]").textContent).toContain("confirm your identity");
    expect(save(container).disabled).toBe(false);
    fireEvent.click(save(container));

    await waitFor(() => expect(q(container, "[data-verification-disclosure-notice]").textContent).toContain("Saved."));
    expect(stepUps).toBe(1);
    expect(puts().map((c) => c.body)).toEqual([
      { mode: "CONTENT_PREVIEW", showRecordedLocation: true, expectedVersion: 3 },
      { mode: "CONTENT_PREVIEW", showRecordedLocation: true, expectedVersion: 3 },
    ]);
    expect(puts()[1]!.headers["x-step-up-challenge"]).toBe("challenge-1");
    expect(q(container, "[data-verification-disclosure-notice]").getAttribute("aria-live")).toBe("polite");
    expect(q(container, "[data-verification-disclosure-notice]").textContent).toContain(
      "Content preview, with the recorded location",
    );
    const shown = Array.from(
      container.querySelectorAll("[data-verification-visitor-preview-group='shown'] li"),
    ).map((li) => li.textContent);
    expect(shown).toEqual(CP_PREVIEW.shown);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(save(container).disabled).toBe(true);
  });

  it("a cancelled step-up saves nothing and says why", async () => {
    cancelStepUp = true;
    routes[`PUT ${DISCLOSURE}`] = () => {
      throw Object.assign(new Error("step-up"), { statusCode: 401, code: "STEP_UP_REQUIRED" });
    };
    const onChanged = vi.fn();
    const { container } = await mount(onChanged);
    fireEvent.click(radio(container, "CONTENT_PREVIEW"));
    fireEvent.click(save(container));
    await waitFor(() => expect(container.querySelector("[data-verification-disclosure-problem]")).not.toBeNull());
    expect(q(container, "[data-verification-disclosure-problem]").textContent).toContain("Not saved");
    expect(onChanged).not.toHaveBeenCalled();
    // The saved preview is unchanged.
    expect(q(container, "[data-verification-disclosure]").getAttribute("data-verification-disclosure")).toBe("VERIFICATION_ONLY");
  });

  it("409 DISCLOSURE_VERSION_CONFLICT re-reads, shows the current setting, and the retry uses the new version", async () => {
    let attempt = 0;
    routes[`PUT ${DISCLOSURE}`] = () => {
      attempt += 1;
      if (attempt === 1) {
        // Someone else switched the page to Content preview (version 5).
        routes[`GET ${ACCESS}`] = () =>
          access({}, { mode: "CONTENT_PREVIEW", showRecordedLocation: false, version: 5, visitorPreview: CP_PREVIEW });
        throw Object.assign(new Error("conflict"), { statusCode: 409, code: "DISCLOSURE_VERSION_CONFLICT" });
      }
      return {
        changed: true,
        disclosure: { mode: "CONTENT_PREVIEW", showRecordedLocation: true, version: 6, visitorPreview: CP_PREVIEW },
      };
    };
    const { container } = await mount();
    fireEvent.click(radio(container, "CONTENT_PREVIEW"));
    fireEvent.click(locationToggle(container));
    fireEvent.click(save(container));

    await waitFor(() => expect(container.querySelector("[data-verification-disclosure-conflict]")).not.toBeNull());
    const conflict = q(container, "[data-verification-disclosure-conflict]");
    expect(conflict.getAttribute("role")).toBe("alert");
    expect(conflict.textContent).toContain("changed elsewhere");
    expect(conflict.textContent).toContain("It now shows: Content preview, without the recorded location.");
    // The current server preview is printed; the owner's choice is kept.
    expect(
      Array.from(container.querySelectorAll("[data-verification-visitor-preview-group='shown'] li")).map((li) => li.textContent),
    ).toEqual(CP_PREVIEW.shown);
    expect(locationToggle(container).checked).toBe(true);

    fireEvent.click(save(container));
    await waitFor(() => expect(q(container, "[data-verification-disclosure-notice]").textContent).toContain("Saved."));
    expect(puts().map((c) => (c.body as { expectedVersion: number }).expectedVersion)).toEqual([3, 5]);
    expect(container.querySelector("[data-verification-disclosure-conflict]")).toBeNull();
  });

  it("without canChangeDisclosure the control is disabled and says why — the server preview still prints", async () => {
    routes[`GET ${ACCESS}`] = () => access({ canChangeDisclosure: false, canWithdraw: false });
    const { container } = await mount();
    expect(radio(container, "VERIFICATION_ONLY").disabled).toBe(true);
    expect(radio(container, "CONTENT_PREVIEW").disabled).toBe(true);
    expect(locationToggle(container).disabled).toBe(true);
    expect(container.querySelector("[data-verification-disclosure-action='save']")).toBeNull();
    const why = q(container, "[data-verification-disclosure-forbidden]");
    expect(why.textContent).toContain("publish permission");
    expect(q(container, "[role='radiogroup']").getAttribute("aria-describedby")).toBe(why.id);
    expect(container.querySelectorAll("[data-verification-visitor-preview-group] li").length).toBe(4);
    expect(container.querySelector("[data-verification-access-withdrawal]")).toBeNull();
  });

  it("a 403 DISCLOSURE_CHANGE_NOT_PERMITTED on save says why and re-reads the permission", async () => {
    routes[`PUT ${DISCLOSURE}`] = () => {
      routes[`GET ${ACCESS}`] = () => access({ canChangeDisclosure: false });
      throw Object.assign(new Error("forbidden"), { statusCode: 403, code: "DISCLOSURE_CHANGE_NOT_PERMITTED" });
    };
    const { container } = await mount();
    fireEvent.click(radio(container, "CONTENT_PREVIEW"));
    fireEvent.click(save(container));
    await waitFor(() => expect(container.querySelector("[data-verification-disclosure-forbidden]")).not.toBeNull());
    expect(q(container, "[data-verification-disclosure-problem]").textContent).toContain("publish permission");
  });

  it("narrowing back to Verification only needs no step-up", async () => {
    routes[`GET ${ACCESS}`] = () =>
      access({}, { mode: "CONTENT_PREVIEW", showRecordedLocation: true, version: 7, visitorPreview: CP_PREVIEW });
    routes[`PUT ${DISCLOSURE}`] = () => ({
      changed: true,
      disclosure: { mode: "VERIFICATION_ONLY", showRecordedLocation: false, version: 8, visitorPreview: VO_PREVIEW },
    });
    const { container } = await mount();
    expect(locationToggle(container).checked).toBe(true);
    fireEvent.click(radio(container, "VERIFICATION_ONLY"));
    expect(container.querySelector("[data-verification-disclosure-step-up-hint]")).toBeNull();
    fireEvent.click(save(container));
    await waitFor(() => expect(q(container, "[data-verification-disclosure-notice]").textContent).toContain("Saved."));
    expect(stepUps).toBe(0);
    expect(puts().map((c) => c.body)).toEqual([{ mode: "VERIFICATION_ONLY", showRecordedLocation: false, expectedVersion: 7 }]);
  });

  it("a withdrawn page states it with icon + text and can be reinstated", async () => {
    routes[`GET ${ACCESS}`] = () =>
      access({
        status: "WITHDRAWN",
        withdrawal: { state: "WITHDRAWN", reason: "LEGAL_REQUEST", changedAtUtc: "2026-10-10T10:00:00.000Z" },
      });
    routes[`POST ${ACCESS}/reinstate`] = () => {
      routes[`GET ${ACCESS}`] = () => access();
      return { state: "AVAILABLE", changed: true };
    };
    const onChanged = vi.fn();
    const { container } = await mount(onChanged);
    const badge = q(container, "[data-verification-access-badge]");
    expect(badge.textContent).toBe("Withdrawn");
    expect(badge.querySelector("svg")).not.toBeNull();
    fireEvent.click(q(container, "[data-verification-access-action='reinstate']"));
    await waitFor(() => expect(q(container, "[data-verification-access-badge]").textContent).toBe("Available"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("a suspended page reads 'Suspended'", async () => {
    routes[`GET ${ACCESS}`] = () => access({ status: "TEMPORARILY_UNAVAILABLE" });
    const { container } = await mount();
    expect(q(container, "[data-verification-access-badge]").textContent).toBe("Suspended");
  });

  it("a record whose page is not issued yet has no disclosure control and says when it can be chosen", async () => {
    routes[`GET ${ACCESS}`] = () =>
      access({ status: "NOT_ISSUED", reference: null, verifyPath: null, disclosure: null, canWithdraw: false });
    const { container } = await mount();
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
    expect(q(container, "[data-verification-disclosure-unavailable]").textContent).toContain(
      "once its verification page is issued",
    );
  });

  it("a failed load says so and retries on request", async () => {
    let fail = true;
    routes[`GET ${ACCESS}`] = () => {
      if (fail) throw Object.assign(new Error("boom"), { statusCode: 500 });
      return access();
    };
    const view = render(
      <ToastProvider>
        <ConfirmActionProvider>
          <ManageVerificationPagePanel evidenceId={EVIDENCE} teamId="team-1" />
        </ConfirmActionProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(view.container.querySelector("[data-verification-page-unavailable]")).not.toBeNull());
    fail = false;
    fireEvent.click(Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent === "Try again")!);
    await waitFor(() => expect(view.container.querySelector("[role='radiogroup']")).not.toBeNull());
  });
});
