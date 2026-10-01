import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * UC-OUT-004 — the evidence-detail report download must map each refusal to
 * its own user-safe sentence and must NOT file a Sentry issue for a bounded,
 * expected refusal (hold / governance / export eligibility / not found).
 */
const apiFetch = vi.fn();
const captureException = vi.fn();
vi.mock("../../lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/sentry", () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import { useEvidenceArtifactActions } from "../../app/(app)/evidence/[id]/_hooks/useEvidenceArtifactActions";

function refusal(statusCode: number, code?: string, message = "raw backend text: prisma P2025"): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

async function download(err: unknown) {
  apiFetch.mockRejectedValueOnce(err);
  const addToast = vi.fn();
  const { result } = renderHook(() =>
    useEvidenceArtifactActions({ evidenceId: "ev-1", addToast, reloadWorkspace: () => {} }),
  );
  await act(async () => {
    await result.current.downloadReport();
  });
  expect(addToast).toHaveBeenCalledTimes(1);
  const [message, tone] = addToast.mock.calls[0] as [string, string];
  return { message, tone };
}

beforeEach(() => {
  apiFetch.mockReset();
  captureException.mockReset();
});

describe("downloadReport refusal feedback", () => {
  it("export-eligibility refusal (hold) → governance sentence, info, no Sentry", async () => {
    const r = await download(refusal(403, "BLOCKED_BY_LEGAL_HOLD"));
    expect(r.message).not.toBe("Failed to download report");
    expect(r.message).toMatch(/blocked/i);
    expect(r.tone).toBe("info");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("access refusal → not-available sentence, no Sentry", async () => {
    const r = await download(refusal(403, "ACCESS_DENIED"));
    expect(r.message).toMatch(/not available to you/i);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("404 → no report generated yet, no Sentry", async () => {
    const r = await download(refusal(404));
    expect(r.message).toMatch(/no report/i);
    expect(r.tone).toBe("info");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("410 report_artifact_missing → file unavailable sentence, no Sentry", async () => {
    const r = await download(refusal(410, "report_artifact_missing"));
    expect(r.message).toMatch(/file is unavailable/i);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("503 governance check → retry shortly, no Sentry", async () => {
    const r = await download(refusal(503, "GOVERNANCE_CHECK_FAILED"));
    expect(r.message).toMatch(/retry/i);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("500 → safe generic copy (never raw text), reported to Sentry", async () => {
    const r = await download(refusal(500, "INTERNAL"));
    expect(r.message).not.toMatch(/prisma|raw backend/i);
    expect(r.tone).toBe("error");
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
