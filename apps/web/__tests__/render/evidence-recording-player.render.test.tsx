/**
 * 2026-10-29 — the recording player for a segmented screen recording.
 *
 *   * PENDING / PROCESSING say "Preparing combined video" and poll;
 *   * COMPLETED plays the DERIVED combined video on the presigned playback URL,
 *     labels it DERIVED, marks every gap ("No recording: 3.0 s") on the
 *     timeline and in a list that seeks past it, says PARTIAL when segments
 *     are missing, and offers "Download combined recording (derived)" +
 *     "Original technical files";
 *   * FAILED / UNSUPPORTED say "Combined video unavailable — original segments
 *     remain available" and still offer the originals;
 *   * a person the byte-release gate refuses gets no video and no download;
 *   * NOT_STARTED offers Prepare (when allowed) and POSTs it.
 *
 * Drives the REAL component against a mocked transport.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let responders: Record<string, (body: unknown) => unknown> = {};

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? "GET", body });
    const key = Object.keys(responders)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.includes(k));
    if (!key) return {};
    return responders[key]!(body);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

import { RecordingPlayer } from "../../components/evidence-recording";

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const BASE = `/v1/evidence/${EVIDENCE_ID}/combined-recording`;

function status(state: string, over: Record<string, unknown> = {}) {
  return {
    evidenceId: EVIDENCE_ID,
    applicable: state !== "NOT_APPLICABLE",
    state,
    segmentCount: 3,
    run: null,
    combined: null,
    release: { allowed: true },
    ...over,
  };
}

const COMBINED = {
  assetId: "33333333-3333-4333-8333-333333333333",
  generation: 1,
  artifactClass: "DERIVED",
  derivedSha256: "a".repeat(64),
  sizeBytes: 1234,
  widthPx: 360,
  heightPx: 640,
  filename: "11111111-DERIVED-combined-recording-v1.mp4",
  mode: "REMUX",
  completeness: "PARTIAL",
  durationMs: 9000,
  gaps: [
    { atMs: 4000, durationMs: 3000, cause: "TIMELINE_GAP", missingSequences: [], limitations: ["BROADCAST_PAUSED"] },
    { atMs: null, durationMs: null, cause: "TAIL_MISSING", missingSequences: [3], limitations: [] },
  ],
  limitations: ["BROADCAST_PAUSED"],
  sources: [],
  statement: "DERIVED review copy.",
};

beforeEach(() => {
  calls = [];
  responders = {};
});

describe("RecordingPlayer", () => {
  it("PENDING says 'Preparing combined video' and offers no video", async () => {
    responders[BASE] = () => status("PENDING");
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} onShowOriginalFiles={() => undefined} />);
    expect(await screen.findByText("Preparing combined video")).toBeTruthy();
    expect(screen.queryByTestId("recording-video")).toBeNull();
    expect(screen.getByText("Original technical files")).toBeTruthy();
    expect(calls.some((c) => c.path.includes("/playback"))).toBe(false);
  });

  it("COMPLETED plays the DERIVED video, marks the gaps and offers the downloads", async () => {
    responders[BASE] = () => status("COMPLETED", { combined: COMBINED });
    responders[`${BASE}/playback`] = () => ({ url: "https://s3.test.invalid/combined.mp4?sig", filename: COMBINED.filename, expiresInSeconds: 300 });
    const onOriginals = vi.fn();
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} onShowOriginalFiles={onOriginals} />);
    const video = (await screen.findByTestId("recording-video")) as HTMLVideoElement;
    await waitFor(() => expect(video.getAttribute("src")).toBe("https://s3.test.invalid/combined.mp4?sig"));
    expect(screen.getByTestId("derived-badge").textContent).toMatch(/DERIVED/);
    // The gap is drawn on the timeline at 4.0 s of 9.0 s and listed.
    const marker = screen.getByTestId("gap-timeline").firstElementChild as HTMLElement;
    expect(marker.style.left).toBe(`${(100 * 4000) / 9000}%`);
    expect(marker.getAttribute("title")).toBe("No recording: 3.0 s");
    const jump = screen.getByText("0:04 — No recording: 3.0 s");
    fireEvent.click(jump);
    expect(video.currentTime).toBe(7);
    expect(screen.getByText(/After the end — No recording: end of session missing/)).toBeTruthy();
    expect(screen.getByTestId("recording-partial").textContent).toMatch(/missing/);
    fireEvent.click(screen.getByText("Original technical files"));
    expect(onOriginals).toHaveBeenCalled();

    responders[`${BASE}/download`] = () => ({ url: "https://s3.test.invalid/combined.mp4?dl", filename: COMBINED.filename, expiresInSeconds: 300 });
    const clicked: Array<{ href: string; download: string }> = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    fireEvent.click(screen.getByText("Download combined recording (derived)"));
    await waitFor(() => expect(clicked).toEqual([{ href: "https://s3.test.invalid/combined.mp4?dl", download: COMBINED.filename }]));
    spy.mockRestore();
  });

  it("FAILED says the combined video is unavailable and keeps the originals", async () => {
    responders[BASE] = () => status("FAILED", { run: { id: "r", status: "FAILED", generation: 1, lastError: "combine:x" } });
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} onShowOriginalFiles={() => undefined} />);
    expect(await screen.findByText("Combined video unavailable — original segments remain available")).toBeTruthy();
    expect(screen.getByText("Original technical files")).toBeTruthy();
    expect(screen.queryByText("Download combined recording (derived)")).toBeNull();
  });

  it("UNSUPPORTED reads the same, never as an error", async () => {
    responders[BASE] = () => status("UNSUPPORTED");
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} />);
    expect(await screen.findByText("Combined video unavailable — original segments remain available")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a person the release gate refuses gets no video, no URL and no download", async () => {
    responders[BASE] = () => status("COMPLETED", { combined: COMBINED, release: { allowed: false, code: "DOWNLOAD_NOT_PERMITTED" } });
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} />);
    expect(await screen.findByText(/does not include downloading recordings/)).toBeTruthy();
    expect(screen.queryByTestId("recording-video")).toBeNull();
    expect(screen.queryByText("Download combined recording (derived)")).toBeNull();
    expect(calls.some((c) => c.path.includes("/playback"))).toBe(false);
  });

  it("NOT_STARTED offers Prepare and POSTs it with the workspace", async () => {
    let state = "NOT_STARTED";
    responders[BASE] = () => status(state);
    responders[`${BASE}/prepare`] = () => {
      state = "PENDING";
      return { queued: true };
    };
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} canPrepare />);
    fireEvent.click(await screen.findByText("Prepare combined video"));
    await waitFor(() => expect(screen.getByText("Preparing combined video")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${BASE}/prepare`);
    expect(post?.body).toEqual({ teamId: TEAM_ID });
  });

  it("a single-file recording (not applicable) shows only its own download and the originals", async () => {
    responders[BASE] = () => status("NOT_APPLICABLE");
    const onDl = vi.fn();
    render(<RecordingPlayer evidenceId={EVIDENCE_ID} teamId={TEAM_ID} onDownloadRecording={onDl} onShowOriginalFiles={() => undefined} />);
    fireEvent.click(await screen.findByText("Download recording"));
    expect(onDl).toHaveBeenCalled();
    expect(screen.queryByText(/Preparing|unavailable/)).toBeNull();
  });
});
