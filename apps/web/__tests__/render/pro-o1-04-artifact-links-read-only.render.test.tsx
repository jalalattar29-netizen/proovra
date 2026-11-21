// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * PRO-O1-04 — a verification link printed in an issued report or package is
 * read-only in the reviewer-share panel: it belongs to the artifact, and taking
 * verification down is Withdraw, not a reviewer-share revoke/rotate.
 *
 * The real panel and the real `apiFetch` over a stubbed network.
 *   - allowed: an ACTIVE owner share offers Renew, Replace share and Revoke;
 *   - refused: an ACTIVE REPORT link and an ACTIVE PACKAGE link offer no
 *     action at all (no revoke, no rotate, no renew).
 */

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { ReviewerSharesPanel } from "../../components/evidence-outputs/ReviewerSharesPanel";
import { ToastProvider } from "../../components/ui";
import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";

const EVIDENCE = "0b6f2f0c-1a52-4f0e-9d0e-3c1b8c1f7a10";

function link(over: Record<string, unknown>) {
  return {
    id: "link",
    purpose: "OWNER_SHARE",
    projection: "STANDARD",
    audience: "Opposing counsel",
    reportVersion: null,
    state: "ACTIVE",
    createdAtUtc: "2026-09-01T10:00:00.000Z",
    createdByUserId: null,
    expiresAtUtc: "2099-10-01T10:00:00.000Z",
    revokedAtUtc: null,
    revokedByUserId: null,
    revocationReason: null,
    rotatedFromId: null,
    maxUses: null,
    useCount: 0,
    lastUsedAtUtc: null,
    usable: true,
    inactiveReason: null,
    allowOriginalDownload: false,
    ...over,
  };
}

const LISTING = {
  verificationAccessState: "AVAILABLE",
  shareable: true,
  legacy: null,
  links: [
    link({ id: "link-owner" }),
    link({ id: "link-report", purpose: "REPORT", reportVersion: 1, audience: null, expiresAtUtc: null }),
    link({ id: "link-package", purpose: "PACKAGE", audience: null, expiresAtUtc: null }),
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes(`/v1/evidence/${EVIDENCE}/verify-links`)) {
        return new Response(JSON.stringify(LISTING), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  const view = render(
    <ToastProvider>
      <ConfirmActionProvider>
        <ReviewerSharesPanel evidenceId={EVIDENCE} teamId="team-1" onChanged={() => {}} />
      </ConfirmActionProvider>
    </ToastProvider>,
  );
  await waitFor(() => expect(view.container.querySelector("[data-verification-link='link-package']")).not.toBeNull());
  return view;
}

const actionsOf = (container: HTMLElement, id: string) =>
  Array.from(container.querySelectorAll(`[data-verification-link='${id}'] [data-verification-link-action]`)).map((b) =>
    b.getAttribute("data-verification-link-action"),
  );

describe("PRO-O1-04 — artifact verification links are read-only in the reviewer-share panel", () => {
  it("allowed: an active owner share keeps Renew, Replace share and Revoke", async () => {
    const { container } = await mount();
    expect(actionsOf(container, "link-owner").sort()).toEqual(["renew", "revoke", "rotate"]);
  });

  it("refused: an active REPORT link offers no revoke, rotate or renew", async () => {
    const { container } = await mount();
    expect(actionsOf(container, "link-report")).toEqual([]);
  });

  it("refused: an active PACKAGE link offers no revoke, rotate or renew", async () => {
    const { container } = await mount();
    expect(actionsOf(container, "link-package")).toEqual([]);
  });
});
