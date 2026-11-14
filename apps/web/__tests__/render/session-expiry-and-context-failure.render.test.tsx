/**
 * F-18 — an expired session, an unavailable context and a genuine refusal are
 * three different things on screen.
 *
 * Mounted with the REAL PlatformContextProvider, PageRouteGate,
 * SignedOutAppGate and apiFetch over a stubbed fetch, so every response is
 * classified the way production classifies it:
 *
 *   - network failure on the first context load → "couldn't load your
 *     workspace" with Try again (not "Requires permission"); Try again loads
 *   - 403 on the context → the genuine refusal panel, no retry offer
 *   - a session that ends mid-page (a page request answers 401 UNAUTHORIZED,
 *     the context confirms 401) → the page stays mounted with its typed draft
 *     under a "Your session has ended" notice whose sign-in links carry a safe
 *     return path; "continue here" after signing in elsewhere clears it
 *   - a 401 the server attaches a decision to (STEP_UP_REQUIRED) is not a
 *     session end, and a 401 the context does NOT confirm changes nothing
 *   - one confirmation per burst: no request loop
 */
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { apiFetch } from "../../lib/api";
import { PlatformContextProvider } from "../../lib/platform-context";
import {
  AUTHORITY_SCHEMA_VERSION,
  CAPABILITY_SCHEMA_VERSION,
  NAVIGATION_SCHEMA_VERSION,
} from "../../lib/platform-context/types";
import { PageRouteGate } from "../../components/navigation/PageRouteGate";
import { SignedOutAppGate } from "../../components/navigation/SignedOutAppState";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function envelope(): unknown {
  const id = "44444444-4444-4444-8444-444444444444";
  return {
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    navigationSchemaVersion: NAVIGATION_SCHEMA_VERSION,
    capabilities: { ACCOUNT_SETTINGS_VIEW: true },
    diagnostics: { requestId: "f18" },
    workspace: { id, name: "Personal", status: "active", scope: "PERSONAL" },
    activeSpace: { type: "PERSONAL", id, displayName: "Personal", roleLabel: "Owner" },
    contextOptions: {
      personalSpace: null,
      ownedWorkspaces: [],
      organizations: [],
      activeContext: { workspaceId: id, kind: "PERSONAL", organizationId: null, displayName: "Personal" },
    },
    account: { accountPlan: "FREE", accountStatus: "active" },
    flags: { isEnterpriseWorkspace: false },
    platform: { isPlatformAdmin: false },
    planFeatures: {},
  };
}

type Answer = (url: string) => Response | Promise<Response>;
let answer: Answer;
const calls: string[] = [];

function stub() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push(path);
      return answer(path);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A page with a draft and a button that calls an API route. */
function DraftPage({ route }: { route: string }) {
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState("");
  return (
    <div data-testid="page">
      <label>
        Draft
        <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button
        type="button"
        onClick={() =>
          void apiFetch(route, { method: "GET" }).then(
            () => setResult("ok"),
            (e: { code?: string }) => setResult(`failed:${e.code ?? ""}`),
          )
        }
      >
        Save
      </button>
      <span data-testid="result">{result}</span>
    </div>
  );
}

function mount(route = "/v1/things") {
  return render(
    <PlatformContextProvider>
      <SignedOutAppGate active={false} pathname="/settings">
        <PageRouteGate routeId="account.settings">
          <DraftPage route={route} />
        </PageRouteGate>
      </SignedOutAppGate>
    </PlatformContextProvider>,
  );
}

describe("F-18 — unavailable context is not a refusal", () => {
  it("a network failure on the first load offers Try again, and Try again loads the page", async () => {
    let up = false;
    answer = (p) => {
      if (p === "/v1/platform/context") {
        if (!up) throw new TypeError("Failed to fetch");
        return json(200, envelope());
      }
      return json(200, {});
    };
    stub();
    mount();
    await settle();
    expect(screen.queryByTestId("page")).toBeNull();
    const gate = document.querySelector('[data-page-route-gate-route-id="account.settings"]');
    expect(gate?.getAttribute("data-page-route-gate-state")).toBe("CONTEXT_UNAVAILABLE");
    expect(screen.getByRole("heading", { name: "We couldn’t load your workspace" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Requires permission|Permission required|Workspace setup required/);
    // Exactly one load attempt: nothing retries on its own.
    expect(calls.filter((c) => c === "/v1/platform/context")).toHaveLength(1);

    up = true;
    fireEvent.click(screen.getByTestId("page-route-gate-retry"));
    await settle();
    expect(screen.getByTestId("page")).toBeTruthy();
  });

  it("a 403 on the context is a genuine refusal: the denial panel, no retry offer", async () => {
    answer = (p) =>
      p === "/v1/platform/context"
        ? json(403, { error: { code: "permission_denied", message: "Not allowed" } })
        : json(200, {});
    stub();
    mount();
    await settle();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(screen.queryByTestId("page-route-gate-retry")).toBeNull();
    const gate = document.querySelector('[data-page-route-gate-route-id="account.settings"]');
    expect(gate?.getAttribute("data-page-route-gate-state")).not.toBe("CONTEXT_UNAVAILABLE");
    expect(gate?.getAttribute("data-page-route-gate-state")).not.toBe("AUTH_REQUIRED");
  });
});

describe("F-18 — a session that ends while the page is open", () => {
  it("keeps the page and its draft under a sign-in notice; continue-here clears it once signed in again", async () => {
    window.history.replaceState(null, "", "/settings?tab=privacy");
    let sessionAlive = true;
    answer = (p) => {
      if (p === "/v1/platform/context") {
        return sessionAlive
          ? json(200, envelope())
          : json(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      }
      if (p === "/v1/things") {
        return sessionAlive ? json(200, {}) : json(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
      }
      return json(200, {});
    };
    stub();
    mount();
    await settle();
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "half-written note" } });

    sessionAlive = false;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();

    // The page threw its own error as before…
    expect(screen.getByTestId("result").textContent).toBe("failed:UNAUTHORIZED");
    // …and the shell now says what happened, without unmounting the page.
    expect(screen.getByRole("alertdialog", { name: "Your session has ended" })).toBeTruthy();
    expect(screen.getByTestId("page")).toBeTruthy();
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("half-written note");
    const back = encodeURIComponent("/settings?tab=privacy");
    expect(screen.getByTestId("session-ended-sign-in").getAttribute("href")).toBe(`/login?next=${back}`);
    // One confirmation of the session, no loop.
    const contextCalls = calls.filter((c) => c === "/v1/platform/context").length;
    expect(contextCalls).toBe(2);
    await settle();
    expect(calls.filter((c) => c === "/v1/platform/context").length).toBe(contextCalls);

    // Signed in again in another tab, then "continue here".
    sessionAlive = true;
    fireEvent.click(screen.getByTestId("session-ended-continue"));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("half-written note");
  });

  it("a 401 that names a decision (step-up) is not a session end", async () => {
    answer = (p) =>
      p === "/v1/platform/context"
        ? json(200, envelope())
        : json(401, { error: { code: "STEP_UP_REQUIRED", message: "Confirm it is you", methods: ["reauth"] } });
    stub();
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(screen.getByTestId("result").textContent).toBe("failed:STEP_UP_REQUIRED");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.filter((c) => c === "/v1/platform/context")).toHaveLength(1);
  });

  it("a stray 401 the context does not confirm changes nothing", async () => {
    answer = (p) =>
      p === "/v1/platform/context"
        ? json(200, envelope())
        : json(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    stub();
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(screen.getByTestId("result").textContent).toBe("failed:UNAUTHORIZED");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("page")).toBeTruthy();
  });
});
