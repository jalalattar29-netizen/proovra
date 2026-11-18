/**
 * Free-user audit 0ea0 — B7A-F-006, signing-key compromise on the web record.
 *
 * The owner's email links to `/evidence/<id>`. The record shows the SHARED
 * sentences (`describeRecordKeyCompromise`) and, only when the server offers a
 * replacement to this caller, one control that POSTs the existing regenerate
 * route with `intent: "KEY_COMPROMISE_REPLACEMENT"`.
 *
 * Driven through the REAL `apiFetch` over a stubbed `fetch`: the refusals are
 * FLAT `{ code, message }` bodies, so an `instanceof ApiError` branch would be
 * dead here; this exercises the path the browser takes.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRecordKeyCompromise, parseRecordKeyCompromise } from "@proovra/shared";
import { USER_FACING_ERRORS } from "@proovra/shared/user-facing-errors";

import { KeyCompromiseNotice } from "../../components/evidence-outputs/KeyCompromiseNotice";

const EVIDENCE_ID = "8f1e2d3c-4b5a-4968-8776-655443322110";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const available = {
  outputs: { recordSignature: false, packageSeal: true, latestPackageSeal: true, custodyAttestations: false },
  replacement: "AVAILABLE",
  replacesReportVersion: 2,
  callerMayRequest: true,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("B7A-F-006 — key-compromise notice on the evidence record", () => {
  it("(a) AVAILABLE + callerMayRequest: shows the shared copy and POSTs the replacement intent", async () => {
    const fetchMock = stubFetch(202, {
      operation: "KEY_COMPROMISE_REPLACEMENT",
      requestId: "req-1",
      outcome: "ENQUEUED",
      replacesReportVersion: 2,
    });
    const onRequested = vi.fn();
    render(<KeyCompromiseNotice evidenceId={EVIDENCE_ID} keyCompromise={available} onRequested={onRequested} />);

    const d = describeRecordKeyCompromise(parseRecordKeyCompromise(available)!);
    expect(screen.getByRole("heading", { name: d.title })).toBeTruthy();
    expect(screen.getByText(d.message)).toBeTruthy();
    expect(screen.getByText(d.replacementLine)).toBeTruthy();

    const button = screen.getByRole("button", { name: d.actionLabel! });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    // No double submit while the request is in flight.
    fireEvent.click(button);

    await waitFor(() =>
      expect(screen.getByText("Replacement requested. It will appear in this record's versions when it is issued.")).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(new RegExp(`/v1/evidence/${EVIDENCE_ID}/reports/regenerate$`));
    expect((init.method ?? "").toUpperCase()).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ intent: "KEY_COMPROMISE_REPLACEMENT" });
    expect(onRequested).toHaveBeenCalledTimes(1);
  });

  it("(b) a flat 409 NO_TRUSTWORTHY_SIGNER renders the shared copy, not the server text or a generic bucket", async () => {
    stubFetch(409, {
      code: "KEY_COMPROMISE_REPLACEMENT_NO_TRUSTWORTHY_SIGNER",
      message: "SERVER TEXT that must not be shown",
    });
    const onRequested = vi.fn();
    render(<KeyCompromiseNotice evidenceId={EVIDENCE_ID} keyCompromise={available} onRequested={onRequested} />);
    fireEvent.click(screen.getByRole("button", { name: "Request replacement" }));

    const shared = USER_FACING_ERRORS.KEY_COMPROMISE_REPLACEMENT_NO_TRUSTWORTHY_SIGNER;
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(shared.title);
    expect(alert.textContent).toContain(shared.message);
    expect(alert.textContent).not.toContain("SERVER TEXT");
    expect(alert.textContent).not.toContain("Please review your input");
    expect(alert.textContent).not.toContain("We couldn't complete that action");
    expect(screen.queryByText(/Replacement requested/)).toBeNull();
    // The button is usable again after the refusal.
    expect((screen.getByRole("button", { name: "Request replacement" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("(c) RECORD_SIGNATURE_NOT_REPLACEABLE: no control, both not-replaced sentences", () => {
    const raw = {
      outputs: { recordSignature: true, packageSeal: true, latestPackageSeal: true, custodyAttestations: true },
      replacement: "RECORD_SIGNATURE_NOT_REPLACEABLE",
      replacesReportVersion: null,
      callerMayRequest: true,
    };
    const fetchMock = stubFetch(500, {});
    render(<KeyCompromiseNotice evidenceId={EVIDENCE_ID} keyCompromise={raw} onRequested={vi.fn()} />);
    const d = describeRecordKeyCompromise(parseRecordKeyCompromise(raw)!);
    expect(d.notReplaced).toHaveLength(2);
    expect(screen.getByText(d.replacementLine)).toBeTruthy();
    for (const line of d.notReplaced) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(c2) AVAILABLE but the caller may not request it: no control", () => {
    render(
      <KeyCompromiseNotice
        evidenceId={EVIDENCE_ID}
        keyCompromise={{ ...available, callerMayRequest: false }}
        onRequested={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Signed with a withdrawn key" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("(d) null (or an older API that sends nothing) renders nothing", () => {
    const { container, rerender } = render(
      <KeyCompromiseNotice evidenceId={EVIDENCE_ID} keyCompromise={null} onRequested={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
    rerender(<KeyCompromiseNotice evidenceId={EVIDENCE_ID} keyCompromise={undefined} onRequested={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
