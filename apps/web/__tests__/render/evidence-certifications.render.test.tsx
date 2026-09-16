import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiFetch: mocks.fetch }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: mocks.confirm }) }));
vi.mock("../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection", () => ({ EvidenceProvenanceChainSection: () => null }));
vi.mock("../../components/capture-location/CaptureLocationMapPanel", () => ({ default: () => null }));

import { EvidenceIntegrityTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab";

const evidenceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const listPath = `/v1/evidence/${evidenceId}/certifications`;
const STATEMENT = "Stored declaration statement text.";

type Cert = Record<string, unknown> & { declarationType: string; status: string; version: number };
let server: { items: Cert[]; failList: unknown; failRereadAfterWrite: boolean; wrote: boolean; applyWrites: boolean };

function cert(over: Partial<Cert> = {}): Cert {
  return {
    id: "c-" + Math.random().toString(16).slice(2), evidenceId, declarationType: "CUSTODIAN", status: "REQUESTED", version: 1,
    requestedByUserId: "u1", requestedAtUtc: "2026-09-01T00:00:00.000Z", attestedByUserId: null, attestedAtUtc: null,
    attestorName: null, attestorTitle: null, attestorEmail: null, attestorOrganization: null,
    statementMarkdown: null, statementSnapshot: null, signatureText: null, certificationHash: null,
    revokedAtUtc: null, revokedByUserId: null, revokeReason: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
  };
}

async function route(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (method === "POST") {
    server.wrote = true;
    if (!server.applyWrites) return { certification: server.items[0] };
    const type = body.declarationType;
    const latest = server.items.filter((c) => c.declarationType === type).sort((a, b) => b.version - a.version)[0];
    if (path.endsWith("/request")) server.items = [...server.items, cert({ declarationType: type, version: latest ? latest.version + 1 : 1 })];
    if (path.endsWith("/attest")) Object.assign(latest!, { status: "ATTESTED", attestedAtUtc: "2026-09-02T00:00:00.000Z", attestorName: body.attestorName, attestorTitle: body.attestorTitle, certificationHash: "hash-after-sign" });
    if (path.endsWith("/revoke")) Object.assign(latest!, { status: "REVOKED", revokedAtUtc: "2026-09-03T00:00:00.000Z", revokeReason: body.reason });
    return { certification: latest };
  }
  if (path === listPath) {
    if (server.failList) throw server.failList;
    if (server.wrote && server.failRereadAfterWrite) throw { statusCode: 503 };
    return { evidenceId, certifications: server.items.map((c) => ({ ...c })) };
  }
  throw new Error("unexpected " + method + " " + path);
}

beforeEach(() => {
  server = { items: [], failList: null, failRereadAfterWrite: false, wrote: false, applyWrites: true };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(route);
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});

const artifactStatus = {
  report: { available: false, pending: false, pdfSignature: null },
  verificationPackage: { available: false, pending: false, blocked: false, manifestSignature: null },
  outputs: { report: { state: "NOT_REQUESTED" }, verificationPackage: { state: "NOT_REQUESTED" } },
};
function ctx(): never {
  return {
    evidenceId,
    otsStatusPresentation: null,
    showManualLatestStatusCheck: false,
    loadWorkspace: () => {},
    workspaceCaps: { verificationPackageIncluded: false },
    preservation: {
      verificationStatus: "MATERIALS_AVAILABLE", verificationStatusLabel: "Materials available",
      sha256Recorded: true, fingerprintHashRecorded: false, fingerprintCanonicalHashMatches: null,
      signature: { recorded: false, valid: false }, tsa: { timestampAvailable: false, status: null },
      ots: { effectiveStatus: null, lastUpdatedAtUtc: null }, storage: null,
      report: { available: false, version: null }, verificationPackage: { available: false, version: null },
      custodyChain: { valid: true, mode: "full", reason: null },
    },
    workspace: {
      sourceContext: {
        sourceType: null, captureMethod: null, capturedAtUtc: null, uploadedAtUtc: null, deviceTimeIso: null,
        locationIncluded: false, clientSignalsSummary: { screenshotLikeStatus: "NOT_COLLECTED", folderPathStatus: "NOT_COLLECTED" },
        limitations: ["Boundary text."],
      },
      sourceCaptureLocation: null,
      artifactStatus,
      evidence: {},
      snapshot: { reportGeneratedAtUtc: null, verificationPackageGeneratedAtUtc: null, currentStatus: "READY", fixedArtifactNote: "Note." },
      artifactVersions: { trustDecisionConsistency: null },
    },
  } as never;
}

function mount() {
  return render(<EvidenceIntegrityTab ctx={ctx()} />);
}
const panel = () => document.querySelector("[data-evidence-certifications]") as HTMLElement;
const writes = (suffix: string) => mocks.fetch.mock.calls.filter(([p, init]) => init?.method === "POST" && String(p).endsWith(suffix));

async function chooseType(label: string) {
  const trigger = await waitFor(() => {
    const el = panel().querySelector("[role='combobox']") as HTMLButtonElement;
    expect(el.disabled).toBe(false);
    return el;
  });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(label) }));
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("evidence certifications on the Integrity tab", () => {
  it("the Integrity tab lists declarations and states the empty case truthfully", async () => {
    mount();
    await screen.findByText("No declaration is attached to this record.");
    expect(mocks.fetch).toHaveBeenCalledWith(listPath);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requests a declaration after confirmation and announces it only after the reread", async () => {
    mount();
    await screen.findByText("No declaration is attached to this record.");
    const request = screen.getByRole("button", { name: "Request declaration" });
    expect(request.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(request.getAttribute("aria-describedby")!)?.textContent).toBe("Choose the declaration type to request.");
    await chooseType("Qualified-person certification");
    fireEvent.click(request);
    await screen.findByText("Qualified-person certification requested. The saved declarations were reloaded.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Request a qualified-person certification?" }));
    const calls = mocks.fetch.mock.calls;
    const write = calls.findIndex(([, init]) => init?.method === "POST");
    expect(calls[write][0]).toBe(`${listPath}/request`);
    expect(JSON.parse(calls[write][1].body)).toEqual({ declarationType: "QUALIFIED_PERSON" });
    expect(calls.slice(write + 1).some(([p]) => p === listPath)).toBe(true);
    expect(panel().querySelector("[data-evidence-certification='QUALIFIED_PERSON']")?.textContent).toMatch(/Requested — awaiting signature/);
  });

  it("cancelling the request confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    mount();
    await screen.findByText("No declaration is attached to this record.");
    await chooseType("Custodian declaration");
    fireEvent.click(screen.getByRole("button", { name: "Request declaration" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Request declaration" }).hasAttribute("disabled")).toBe(false));
    expect(writes("/request")).toHaveLength(0);
  });

  it("explains why no further request is possible when both types are open", async () => {
    server.items = [cert(), cert({ declarationType: "QUALIFIED_PERSON", status: "ATTESTED", attestedAtUtc: "2026-09-02T00:00:00.000Z" })];
    mount();
    await waitFor(() => expect(panel().querySelectorAll("[data-evidence-certification]")).toHaveLength(2));
    const request = screen.getByRole("button", { name: "Request declaration" });
    expect(document.getElementById(request.getAttribute("aria-describedby")!)?.textContent).toMatch(/Both declaration types already have an open request or a signature/);
  });

  it("refuses to sign a request that carries no stored statement, and says why", async () => {
    server.items = [cert()];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sign declaration" }));
    expect(document.querySelector("[data-certification-statement-missing]")).toBeTruthy();
    const submit = screen.getAllByRole("button", { name: "Sign declaration" }).at(-1)!;
    expect(submit.getAttribute("type")).toBe("submit");
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(submit.getAttribute("aria-describedby")!)?.textContent).toBe(
      "No declaration statement is recorded for this request, so it cannot be signed here.",
    );
    expect(writes("/attest")).toHaveLength(0);
  });

  it("signs the stored statement with the full payload after explicit confirmation", async () => {
    server.items = [cert({ statementMarkdown: STATEMENT })];
    mount();
    const toggle = await screen.findByRole("button", { name: "Sign declaration" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-certification-statement]")?.textContent).toBe(STATEMENT);
    expect(document.activeElement).toBe(screen.getByLabelText("Signer full name"));
    const submit = () => screen.getAllByRole("button", { name: "Sign declaration" }).at(-1)!;
    fill("Signer full name", "Dana Reyes");
    fill("Signer title or role", "Records Custodian");
    fill("Signer email", "not-an-email");
    expect(document.getElementById(submit().getAttribute("aria-describedby")!)?.textContent).toBe("Enter a valid email address for the signer.");
    fill("Signer email", "dana@example.test");
    expect(document.getElementById(submit().getAttribute("aria-describedby")!)?.textContent).toBe("Type the signature to sign the statement.");
    fill("Typed signature", "Dana Reyes");
    fireEvent.click(submit());
    await screen.findByText("Custodian declaration signed. The saved declarations were reloaded.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Sign this declaration?" }));
    const write = writes("/attest")[0]!;
    expect(JSON.parse(String(write[1].body))).toEqual({
      declarationType: "CUSTODIAN",
      attestorName: "Dana Reyes",
      attestorTitle: "Records Custodian",
      attestorEmail: "dana@example.test",
      attestorOrganization: null,
      statementMarkdown: STATEMENT,
      signatureText: "Dana Reyes",
    });
    expect(await screen.findByText("hash-after-sign")).toBeTruthy();
    expect(screen.getByText("hash-after-sign").hasAttribute("data-identifier")).toBe(true);
  });

  it("cancelling the signing form makes no write and restores focus", async () => {
    server.items = [cert({ statementMarkdown: STATEMENT })];
    mount();
    const toggle = await screen.findByRole("button", { name: "Sign declaration" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(toggle);
    expect(writes("/attest")).toHaveLength(0);
  });

  it("revokes a signed declaration with a required reason after a danger confirmation", async () => {
    server.items = [cert({ status: "ATTESTED", attestedAtUtc: "2026-09-02T00:00:00.000Z", attestorName: "Dana Reyes", certificationHash: "h1" })];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke declaration" }));
    const submit = screen.getAllByRole("button", { name: "Revoke declaration" }).at(-1)!;
    expect(document.getElementById(submit.getAttribute("aria-describedby")!)?.textContent).toBe("Enter the reason for revoking.");
    fill("Reason (required, recorded in custody history)", "Signed in error.");
    fireEvent.click(submit);
    await screen.findByText("Custodian declaration revoked. The saved declarations were reloaded.");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Revoke this signed declaration?", tone: "danger" }));
    expect(JSON.parse(String(writes("/revoke")[0]![1].body))).toEqual({ declarationType: "CUSTODIAN", reason: "Signed in error." });
    expect(document.querySelector("[data-certification-revoke-reason]")?.textContent).toBe("Signed in error.");
  });

  it("cancelling the revoke confirmation makes no write", async () => {
    mocks.confirm.mockResolvedValue(false);
    server.items = [cert({ status: "ATTESTED" })];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke declaration" }));
    fill("Reason (required, recorded in custody history)", "x");
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke declaration" }).at(-1)!);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(writes("/revoke")).toHaveLength(0);
  });

  it.each([
    ["refused", { statusCode: 403, code: "FORBIDDEN" }],
    ["missing", { statusCode: 404, code: "NOT_FOUND" }],
    ["failed", { statusCode: 500 }],
  ])("a %s list read is an error, never an empty list, and blocks requests", async (_label, error) => {
    server.failList = error;
    mount();
    await waitFor(() => expect(document.querySelector("[data-evidence-certifications-error]")).toBeTruthy());
    expect(screen.queryByText("No declaration is attached to this record.")).toBeNull();
    const request = screen.getByRole("button", { name: "Request declaration" });
    expect(request.hasAttribute("disabled")).toBe(true);
    expect(document.getElementById(request.getAttribute("aria-describedby")!)?.textContent).toMatch(/must load/);
  });

  it("reports a refused write without claiming success", async () => {
    mocks.fetch.mockImplementation(async (p: string, init?: RequestInit) => {
      if (init?.method === "POST") throw { statusCode: 409 };
      return route(p, init);
    });
    mount();
    await screen.findByText("No declaration is attached to this record.");
    await chooseType("Custodian declaration");
    fireEvent.click(screen.getByRole("button", { name: "Request declaration" }));
    await waitFor(() => expect(document.querySelector("[data-evidence-certifications-mutation-error]")).toBeTruthy());
    expect(document.querySelector("[data-evidence-certifications-notice]")).toBeNull();
  });

  it("does not claim success when the confirming reread fails", async () => {
    server.failRereadAfterWrite = true;
    mount();
    await screen.findByText("No declaration is attached to this record.");
    await chooseType("Custodian declaration");
    fireEvent.click(screen.getByRole("button", { name: "Request declaration" }));
    await screen.findByText(/could not be reloaded to confirm it/);
    expect(document.querySelector("[data-evidence-certifications-notice]")).toBeNull();
  });

  it("does not claim success when the reread does not show the change", async () => {
    server.applyWrites = false;
    mount();
    await screen.findByText("No declaration is attached to this record.");
    await chooseType("Custodian declaration");
    fireEvent.click(screen.getByRole("button", { name: "Request declaration" }));
    await screen.findByText(/reloaded declarations do not show the change/);
    expect(document.querySelector("[data-evidence-certifications-notice]")).toBeNull();
  });
});
