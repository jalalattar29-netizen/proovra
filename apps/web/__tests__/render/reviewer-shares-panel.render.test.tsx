/**
 * ET-PKG-07 / 2026-10-18 — the owner's controls for SECURE REVIEWER SHARES
 * (pvs_), rendered.
 *
 * The server tests prove what a share can and cannot open. This proves what
 * the OWNER can do about it from the record page, by driving the real panel:
 *
 *   - see the active shares with their profile, and tell expired from revoked;
 *   - create a share — recipient, expiry, use limit, profile — and copy it once;
 *   - grant "Allow original file download" only on a Content preview share,
 *     and confirm identity (step-up) when it is granted;
 *   - creating a share never publishes anything (no confirmation, no
 *     `published` field, no record refresh);
 *   - a share on a withdrawn/suspended page reads as the SERVER says
 *     (usable / inactiveReason PAGE_NOT_AVAILABLE) — never derived here;
 *   - revoke one reviewer's share, and replace (rotate) one;
 *   - see when the legacy record-id link ends, and end it early;
 *   - and never see a stored share's secret.
 */
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

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

/** The step-up flow, reduced to what this panel relies on: a 401
 * STEP_UP_REQUIRED is answered by a challenge, then the action is retried
 * with the proof header. `stepUps` records each challenge. */
let stepUps = 0;
vi.mock("../../components/identity-security/StepUpModal", () => {
  const control = {
    state: { kind: "idle" },
    runStepUpAction: async (fn: (headers?: Record<string, string>) => Promise<unknown>) => {
      try {
        return await fn();
      } catch (err) {
        if ((err as { code?: string }).code !== "STEP_UP_REQUIRED") throw err;
        stepUps += 1;
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

import { ReviewerSharesPanel } from "../../components/evidence-outputs/ReviewerSharesPanel";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const EVIDENCE = "0b6f2f0c-1a52-4f0e-9d0e-3c1b8c1f7a10";
const BASE = `/v1/evidence/${EVIDENCE}/verify-links`;
const TOKEN = "pvs_" + "k".repeat(43);

function link(over: Record<string, unknown> = {}) {
  return {
    id: "link-active",
    purpose: "OWNER_SHARE",
    projection: "STANDARD",
    audience: "Opposing counsel",
    reportVersion: null,
    state: "ACTIVE",
    createdAtUtc: "2026-09-01T10:00:00.000Z",
    createdByUserId: null,
    expiresAtUtc: "2026-10-01T10:00:00.000Z",
    revokedAtUtc: null,
    revokedByUserId: null,
    revocationReason: null,
    rotatedFromId: null,
    maxUses: null,
    useCount: 2,
    lastUsedAtUtc: null,
    usable: true,
    inactiveReason: null,
    allowOriginalDownload: false,
    ...over,
  };
}

function listing(over: Record<string, unknown> = {}) {
  return {
    verificationAccessState: "AVAILABLE",
    shareable: true,
    legacy: null,
    links: [link()],
    ...over,
  };
}

async function mount(onChanged = () => {}) {
  const view = render(
    <ToastProvider>
      <ConfirmActionProvider>
        <ReviewerSharesPanel evidenceId={EVIDENCE} teamId="team-1" onChanged={onChanged} />
      </ConfirmActionProvider>
    </ToastProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector("p.app-field__help")?.textContent).not.toBe("Loading reviewer shares…"),
  );
  return view;
}

async function confirmModal(accept: boolean) {
  const modal = await waitFor(() => {
    const el = document.querySelector("[data-confirm-action-modal]");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  const text = modal.textContent ?? "";
  if (accept) {
    fireEvent.click(modal.querySelector("[data-confirm-action-submit='true']")!);
  } else {
    const cancel = Array.from(modal.querySelectorAll("button")).find((b) => /cancel/i.test(b.textContent ?? ""));
    fireEvent.click(cancel!);
  }
  return text;
}

const posts = () => calls.filter((c) => c.method === "POST");
const bodies = () => posts().map(({ method, path, body }) => ({ method, path, body }));

beforeEach(() => {
  calls = [];
  stepUps = 0;
  routes = { [`GET ${BASE}`]: () => listing() };
});
afterEach(() => cleanup());

describe("Secure reviewer shares — owner controls", () => {
  it("lists the active share with its profile and actions; expired and revoked are told apart, and no secret is rendered", async () => {
    routes[`GET ${BASE}`] = () =>
      listing({
        links: [
          link(),
          link({ id: "link-expired", audience: "Insurer", state: "EXPIRED", expiresAtUtc: "2026-08-01T10:00:00.000Z" }),
          link({ id: "link-revoked", audience: "Court clerk", state: "REVOKED", revokedAtUtc: "2026-09-10T10:00:00.000Z", revocationReason: "OWNER" }),
          link({ id: "link-rotated", audience: "Expert witness", state: "REVOKED", revokedAtUtc: "2026-09-11T10:00:00.000Z", revocationReason: "ROTATED" }),
        ],
      });
    const { container } = await mount();

    const active = container.querySelectorAll("[data-verification-links='active'] [data-verification-link]");
    expect(active.length).toBe(1);
    expect(active[0]!.textContent).toContain("Opposing counsel");
    expect(active[0]!.querySelector("[data-verification-link-profile]")!.textContent).toBe("Content preview");
    expect(active[0]!.querySelector("[data-verification-link-action='revoke']")).not.toBeNull();
    expect(active[0]!.querySelector("[data-verification-link-action='rotate']")).not.toBeNull();

    // Inactive links are behind a toggle that says how many there are.
    expect(container.querySelector("[data-verification-links='inactive']")).toBeNull();
    const toggle = container.querySelector("[data-verification-links-toggle='inactive']")!;
    expect(toggle.textContent).toContain("Show 3 expired or revoked shares");
    fireEvent.click(toggle);

    const state = (id: string) => container.querySelector(`[data-verification-link='${id}']`)!;
    expect(state("link-expired").getAttribute("data-verification-link-state")).toBe("EXPIRED");
    expect(state("link-expired").textContent).toContain("Expired");
    expect(state("link-revoked").getAttribute("data-verification-link-state")).toBe("REVOKED");
    expect(state("link-revoked").textContent).toMatch(/Revoked on /);
    expect(state("link-rotated").textContent).toMatch(/Replaced by a new link on /);
    // A revoked or replaced link offers nothing to do; an EXPIRED owner share
    // offers exactly one thing — an explicit renewal (members audit SEC-08).
    for (const id of ["link-revoked", "link-rotated"]) {
      expect(state(id).querySelector("[data-verification-link-action]")).toBeNull();
    }
    const expiredActions = Array.from(state("link-expired").querySelectorAll("[data-verification-link-action]")).map((b) =>
      b.getAttribute("data-verification-link-action"),
    );
    expect(expiredActions).toEqual(["renew"]);

    // Nothing stored can be shown: no token, and no link built from the record id.
    expect(container.querySelector("[data-verification-link-url]")).toBeNull();
    expect(container.innerHTML).not.toContain("pvs_");
    expect(container.innerHTML).not.toContain(`/verify/${EVIDENCE}`);
  });

  it("creates a share for a named recipient and shows it once, to copy — it never publishes anything", async () => {
    routes[`POST ${BASE}`] = () => ({
      link: link({ id: "link-new", audience: "The insurer" }),
      token: TOKEN,
      verifyPath: `/verify/${TOKEN}`,
    });
    const onChanged = vi.fn();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });
    const { container } = await mount(onChanged);

    // No recipient, no share.
    const submit = container.querySelector("[data-verification-link-action='create']") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(container.querySelector("#verification-link-audience")!, { target: { value: "  The insurer " } });
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Create reviewer share");

    fireEvent.submit(container.querySelector("[data-verification-link-form]")!);
    await waitFor(() => expect(container.querySelector("[data-verification-link-created]")).not.toBeNull());

    // No publish confirmation, no step-up (no download grant), no refresh of
    // the record's page state: a share never publishes.
    expect(document.querySelector("[data-confirm-action-modal]")).toBeNull();
    expect(stepUps).toBe(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(bodies()).toEqual([
      {
        method: "POST",
        path: BASE,
        body: {
          audience: "The insurer",
          // 7 days unless the owner chooses otherwise (members audit SEC-08).
          expiresInDays: 7,
          projection: "STANDARD",
          maxUses: null,
          allowOriginalDownload: false,
        },
      },
    ]);

    const shown = (container.querySelector("[data-verification-link-url]") as HTMLInputElement).value;
    expect(shown).toBe(`${window.location.origin}/verify/${TOKEN}`);
    expect(container.querySelector("[data-verification-link-created]")!.textContent).toContain("It is shown once");

    fireEvent.click(container.querySelector("[data-verification-link-action='copy']")!);
    await waitFor(() => expect(written).toEqual([shown]));

    // Once dismissed it is gone from the page for good.
    const dismiss = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "I have copied it")!;
    fireEvent.click(dismiss);
    expect(container.querySelector("[data-verification-link-created]")).toBeNull();
    expect(container.innerHTML).not.toContain("pvs_");
  });

  it("an invalid use limit blocks creation and says why; a valid one is sent", async () => {
    routes[`POST ${BASE}`] = () => ({ link: link({ id: "n" }), token: TOKEN, verifyPath: `/verify/${TOKEN}` });
    const { container } = await mount();
    fireEvent.change(container.querySelector("#verification-link-audience")!, { target: { value: "Clerk" } });
    const uses = container.querySelector("#verification-link-max-uses")!;
    const submit = container.querySelector("[data-verification-link-action='create']") as HTMLButtonElement;

    fireEvent.change(uses, { target: { value: "0" } });
    expect(submit.disabled).toBe(true);
    expect(container.querySelector(".app-field-error")!.textContent).toContain("whole number of at least 1");

    fireEvent.change(uses, { target: { value: "3" } });
    expect(submit.disabled).toBe(false);
    fireEvent.submit(container.querySelector("[data-verification-link-form]")!);
    await waitFor(() => expect(posts().length).toBe(1));
    expect((posts()[0]!.body as { maxUses: number }).maxUses).toBe(3);
  });

  it("Allow original file download is offered only on a Content preview share, and granting it asks for step-up", async () => {
    routes[`POST ${BASE}`] = (call) => {
      // The server answers 401 STEP_UP_REQUIRED until the proof is attached.
      if (!call.headers["x-step-up-challenge"]) {
        throw Object.assign(new Error("step-up"), { statusCode: 401, code: "STEP_UP_REQUIRED" });
      }
      return {
        link: link({ id: "link-dl", audience: "Expert", allowOriginalDownload: true }),
        token: TOKEN,
        verifyPath: `/verify/${TOKEN}`,
      };
    };
    const { container } = await mount();
    const grant = container.querySelector("[data-verification-link-original-download-toggle]") as HTMLInputElement;
    // Default profile is Content preview: the grant is available, and off.
    expect(grant.disabled).toBe(false);
    expect(grant.checked).toBe(false);
    expect(container.querySelector("label[for='verification-link-original-download']")!.textContent).toBe(
      "Allow original file download",
    );

    fireEvent.change(container.querySelector("#verification-link-audience")!, { target: { value: "Expert" } });
    fireEvent.click(grant);
    expect(grant.checked).toBe(true);
    fireEvent.submit(container.querySelector("[data-verification-link-form]")!);
    await waitFor(() => expect(container.querySelector("[data-verification-link-created]")).not.toBeNull());

    expect(stepUps).toBe(1);
    expect(posts().length).toBe(2);
    expect(posts()[0]!.body).toMatchObject({ projection: "STANDARD", allowOriginalDownload: true });
    expect(posts()[1]!.headers["x-step-up-challenge"]).toBe("challenge-1");
  });

  it("a Verification only share never carries the download grant", async () => {
    routes[`POST ${BASE}`] = () => ({ link: link({ id: "b", projection: "BASIC" }), token: TOKEN, verifyPath: `/verify/${TOKEN}` });
    const { container } = await mount();
    const grant = () => container.querySelector("[data-verification-link-original-download-toggle]") as HTMLInputElement;
    fireEvent.change(container.querySelector("#verification-link-audience")!, { target: { value: "Clerk" } });
    fireEvent.click(grant());
    expect(grant().checked).toBe(true);

    // Switch the profile to Verification only (BASIC): the grant is cleared and disabled.
    fireEvent.click(container.querySelector("#verification-link-projection")!);
    const basic = await waitFor(() => {
      const opt = Array.from(document.querySelectorAll("[role='option']")).find((o) => /Verification only/.test(o.textContent ?? ""));
      expect(opt).toBeTruthy();
      return opt as HTMLElement;
    });
    fireEvent.click(basic);
    await waitFor(() => expect(grant().disabled).toBe(true));
    expect(grant().checked).toBe(false);
    expect(container.textContent).toContain("Available only with the Content preview profile.");

    fireEvent.submit(container.querySelector("[data-verification-link-form]")!);
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.body).toMatchObject({ projection: "BASIC", allowOriginalDownload: false });
    expect(stepUps).toBe(0);
  });

  it("a share with the download grant says so on its row", async () => {
    routes[`GET ${BASE}`] = () => listing({ links: [link({ allowOriginalDownload: true })] });
    const { container } = await mount();
    expect(container.querySelector("[data-verification-link-original-download]")!.textContent).toContain(
      "Original download allowed",
    );
  });

  it("revokes one reviewer's share after a confirmation that names it", async () => {
    routes[`POST ${BASE}/link-active/revoke`] = () => {
      routes[`GET ${BASE}`] = () =>
        listing({ links: [link({ state: "REVOKED", revokedAtUtc: "2026-09-30T10:00:00.000Z", revocationReason: "OWNER" })] });
      return { link: link({ state: "REVOKED" }), changed: true };
    };
    const { container } = await mount();

    fireEvent.click(container.querySelector("[data-verification-link-action='revoke']")!);
    const text = await confirmModal(true);
    expect(text).toContain("Revoke this reviewer share?");
    expect(text).toContain("Opposing counsel");
    expect(text).toContain("Other reviewer shares and the verification page are not affected");

    await waitFor(() => expect(container.textContent).toContain("No active reviewer shares."));
    expect(posts().map((c) => c.path)).toEqual([`${BASE}/link-active/revoke`]);
    expect(container.querySelector("[data-verification-links-toggle='inactive']")!.textContent).toContain("1 expired or revoked share");
  });

  it("declining the revoke confirmation changes nothing", async () => {
    const { container } = await mount();
    fireEvent.click(container.querySelector("[data-verification-link-action='revoke']")!);
    await confirmModal(false);
    await waitFor(() => expect(document.querySelector("[data-confirm-action-modal]")).toBeNull());
    expect(posts()).toEqual([]);
    expect(container.querySelectorAll("[data-verification-links='active'] [data-verification-link]").length).toBe(1);
  });

  it("replaces a share: the old one stops, and the new one is shown once", async () => {
    const NEXT = "pvs_" + "r".repeat(43);
    routes[`POST ${BASE}/link-active/rotate`] = () => ({
      link: link({ id: "link-next", rotatedFromId: "link-active" }),
      token: NEXT,
      verifyPath: `/verify/${NEXT}`,
      replacedLinkId: "link-active",
    });
    const { container } = await mount();

    fireEvent.click(container.querySelector("[data-verification-link-action='rotate']")!);
    const text = await confirmModal(true);
    expect(text).toContain("Replace this reviewer share?");
    expect(text).toContain("stops working immediately");

    await waitFor(() => expect(container.querySelector("[data-verification-link-url]")).not.toBeNull());
    expect((container.querySelector("[data-verification-link-url]") as HTMLInputElement).value).toBe(
      `${window.location.origin}/verify/${NEXT}`,
    );
    expect(posts().map((c) => c.path)).toEqual([`${BASE}/link-active/rotate`]);
  });

  it("renews a share for 30 days, on purpose and after saying so (members audit SEC-08)", async () => {
    routes[`POST ${BASE}/link-active/renew`] = () => ({ link: link({ id: "link-active" }) });
    const { container } = await mount();

    fireEvent.click(container.querySelector("[data-verification-link-action='renew']")!);
    const text = await confirmModal(true);
    expect(text).toContain("Renew this reviewer share for 30 days?");
    expect(text).toContain("recorded in the workspace audit log");
    await waitFor(() => expect(posts().map((c) => c.path)).toEqual([`${BASE}/link-active/renew`]));
    expect(bodies().find((b) => b.path === `${BASE}/link-active/renew`)?.body).toEqual({ days: 30 });
  });

  it("the legacy record-id link states when it ends and can be ended early; an ended one offers nothing", async () => {
    routes[`GET ${BASE}`] = () =>
      listing({ legacy: { active: true, expiresAtUtc: "2027-03-29T10:00:00.000Z", graceDays: 180 } });
    routes[`POST ${BASE}/legacy/revoke`] = () => {
      routes[`GET ${BASE}`] = () =>
        listing({ legacy: { active: false, expiresAtUtc: "2026-09-30T10:00:00.000Z", graceDays: 180 } });
      return { legacy: { active: false, expiresAtUtc: "2026-09-30T10:00:00.000Z", graceDays: 180 }, changed: true };
    };
    const onChanged = vi.fn();
    const { container } = await mount(onChanged);

    const legacy = () => container.querySelector("[data-verification-link='legacy']")!;
    expect(legacy().getAttribute("data-verification-link-state")).toBe("ACTIVE");
    expect(legacy().textContent).toContain("Legacy link (record ID)");
    expect(legacy().textContent).toMatch(/still work until .*2027/);
    expect(legacy().textContent).toContain("It cannot be extended.");

    fireEvent.click(legacy().querySelector("[data-verification-link-action='revoke-legacy']")!);
    const text = await confirmModal(true);
    expect(text).toContain("End the legacy link now?");
    expect(text).toContain("printed in reports");

    await waitFor(() => expect(legacy().getAttribute("data-verification-link-state")).toBe("EXPIRED"));
    expect(legacy().textContent).toContain("Ended");
    expect(legacy().querySelector("[data-verification-link-action]")).toBeNull();
    expect(posts().map((c) => c.path)).toEqual([`${BASE}/legacy/revoke`]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("the workspace's records still reachable by record ID are listed on request, each linking to its own controls", async () => {
    const OTHER = "5b0e7a52-2f8e-4a0c-8b65-0f0d2a1c9e77";
    routes["GET /v1/verify-links/legacy-inventory"] = () => ({
      activeCount: 3,
      earliestExpiryUtc: "2027-01-10T10:00:00.000Z",
      latestExpiryUtc: "2027-03-29T10:00:00.000Z",
      graceDays: 180,
      records: [
        { evidenceId: OTHER, title: "Harbour claim photo", expiresAtUtc: "2027-01-10T10:00:00.000Z" },
        { evidenceId: EVIDENCE, title: null, expiresAtUtc: "2027-03-29T10:00:00.000Z" },
      ],
    });
    const { container } = await mount();
    const toggle = container.querySelector("[data-verification-links-toggle='legacy-inventory']")!;

    // Not read until asked for.
    expect(calls.some((c) => c.path.includes("legacy-inventory"))).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector("[data-verification-legacy-inventory='some']")).not.toBeNull());

    const list = container.querySelector("[data-verification-legacy-inventory='some']")!;
    expect(list.textContent).toContain("3 records can still be opened by record ID");
    expect(list.textContent).toContain("Showing the 2 that end soonest.");
    const first = list.querySelector(`[data-verification-legacy-record='${OTHER}'] a`)!;
    expect(first.textContent).toBe("Harbour claim photo");
    expect(first.getAttribute("href")).toBe(`/evidence/${OTHER}?tab=artifacts#verification-page`);
    expect(list.querySelector(`[data-verification-legacy-record='${EVIDENCE}'] a`)!.textContent).toBe("Untitled record");
    // The list links to controls — it never renders a /verify/<id> link itself.
    expect(list.innerHTML).not.toContain("/verify/");

    fireEvent.click(toggle);
    expect(container.querySelector("[data-verification-legacy-inventory]")).toBeNull();
  });

  it("a workspace with no legacy links says so; a failed read says so", async () => {
    routes["GET /v1/verify-links/legacy-inventory"] = () => ({
      activeCount: 0,
      earliestExpiryUtc: null,
      latestExpiryUtc: null,
      graceDays: 180,
      records: [],
    });
    const { container } = await mount();
    const toggle = container.querySelector("[data-verification-links-toggle='legacy-inventory']")!;
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector("[data-verification-legacy-inventory='none']")).not.toBeNull());
    expect(container.textContent).toContain("No record in this workspace can be opened by its record ID.");

    fireEvent.click(toggle);
    routes["GET /v1/verify-links/legacy-inventory"] = () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    };
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector("[data-verification-legacy-inventory='error']")).not.toBeNull());
  });

  it("a record that cannot be shared yet offers no form and says why", async () => {
    routes[`GET ${BASE}`] = () => listing({ shareable: false, links: [] });
    const { container } = await mount();
    expect(container.querySelector("[data-verification-link-form]")).toBeNull();
    expect(container.querySelector("[data-verification-links-unshareable]")!.textContent).toContain(
      "A reviewer share can be created once the record is finalized, and not while it is in Trash",
    );
  });

  it("a member without the publish permission sees why, and no controls", async () => {
    routes[`GET ${BASE}`] = () => {
      throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    };
    const { container } = await mount();
    expect(container.querySelector("[data-verification-links-forbidden]")!.textContent).toContain("publish permission");
    expect(container.querySelector("[data-verification-link-form]")).toBeNull();
    expect(container.querySelector("[data-verification-link-action]")).toBeNull();
  });

  it("an API that predates share links is 'not available yet' — not an error to retry", async () => {
    routes[`GET ${BASE}`] = () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    };
    const { container } = await mount();
    expect(container.querySelector("[data-verification-links-unavailable]")).not.toBeNull();
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.querySelector("[data-verification-link-form]")).toBeNull();
  });

  it("a failed load says so and retries on request", async () => {
    let fail = true;
    routes[`GET ${BASE}`] = () => {
      if (fail) throw Object.assign(new Error("boom"), { statusCode: 500 });
      return listing();
    };
    const { container } = await mount();
    expect(container.querySelector("[role='alert']")!.textContent).toContain("The reviewer shares could not be loaded.");
    fail = false;
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Try again")!);
    await waitFor(() => expect(container.querySelector("[data-verification-links='active']")).not.toBeNull());
  });
});

describe("Which shares answer — the SERVER's projection, never derived here", () => {
  it("an ACTIVE share the server marks usable reads Active", async () => {
    routes[`GET ${BASE}`] = () => listing({ links: [link({ id: "link-owner" })] });
    const { container } = await mount();
    const row = container.querySelector("[data-verification-link='link-owner']") as HTMLElement;
    expect(row.getAttribute("data-verification-link-usable")).toBe("true");
    expect(row.textContent).toContain("Active");
    expect(container.querySelector("[data-verification-links-state]")!.getAttribute("data-verification-links-state")).toBe(
      "available",
    );
  });

  it("on a withdrawn page an ACTIVE share reads 'Inactive — verification page not available' (PAGE_NOT_AVAILABLE)", async () => {
    routes[`GET ${BASE}`] = () =>
      listing({
        verificationAccessState: "WITHDRAWN",
        links: [link({ id: "link-owner", usable: false, inactiveReason: "PAGE_NOT_AVAILABLE" })],
      });
    const { container } = await mount();
    const row = container.querySelector("[data-verification-link='link-owner']") as HTMLElement;
    expect(row.getAttribute("data-verification-link-usable")).toBe("false");
    expect(row.querySelector("[data-verification-link-inactive]")!.getAttribute("data-verification-link-inactive")).toBe(
      "PAGE_NOT_AVAILABLE",
    );
    expect(row.textContent).toContain("Inactive — verification page not available");
    expect(row.querySelector(".evidence-detail-link-row__main")?.textContent).not.toMatch(/\bActive\b/);
    expect(container.querySelector("[data-verification-links-state]")!.getAttribute("data-verification-links-state")).toBe(
      "page-unavailable",
    );
  });

  it("a REPORT link the server marks usable reads Active whatever the listing's page state says", async () => {
    routes[`GET ${BASE}`] = () =>
      listing({
        verificationAccessState: "SUSPENDED",
        links: [link({ id: "link-report", purpose: "REPORT", reportVersion: 1, audience: null })],
      });
    const { container } = await mount();
    const row = container.querySelector("[data-verification-link='link-report']") as HTMLElement;
    expect(row.getAttribute("data-verification-link-usable")).toBe("true");
    // A printed link carries no reviewer profile badge.
    expect(row.querySelector("[data-verification-link-profile]")).toBeNull();
  });

  it("the panel never says 'published' or offers to publish", async () => {
    const { container } = await mount();
    expect(container.textContent).not.toMatch(/publish/i);
  });
});
