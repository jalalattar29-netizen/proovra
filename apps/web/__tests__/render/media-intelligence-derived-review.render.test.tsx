/**
 * UC-4 Derived Review + Technical Appendix derived strip — render behaviour.
 *
 *   UC-DER-001  every settled state has an action: DISMISSED → Retry (a new
 *               generation), not a dead end.
 *   UC-DER-002  a viewer the byte-release gate refuses is told why; no text.
 *   UC-DER-004  a labelled possible repeat is shown as such.
 *   UC-DER-008  "OCR engine unavailable" is never shown as "disabled by policy".
 *   UC-DER-010  a record with no workflow team is addressed through the active
 *               (personal) workspace instead of a disabled, unexplained button.
 *   UC-DER-011  keyframes / the reconstruction JSON are not rendered as
 *               "Derived preview" images in the Technical Appendix strip.
 *   UC-DER-012  keyframe thumbnails load WITH credentials.
 *
 * Drives the REAL components against a mocked transport.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let responders: Record<string, (body: unknown) => unknown> = {};
let activeWorkspaceId: string | null = null;

vi.mock("../../lib/api", () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? "GET", body });
    const key = Object.keys(responders).find((k) => path.includes(k));
    if (!key) return {};
    return responders[key](body);
  },
  readApiToken: () => null,
  apiBaseUrl: () => "https://api.test.invalid",
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../lib/platform-context/PlatformContextProvider", () => ({
  usePlatformContext: () => ({ activeWorkspaceId }),
}));

import { EvidenceDerivedReviewTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab";
import MediaIntelligencePanel from "../../components/media-intelligence/MediaIntelligencePanel";

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";

function ctx(teamId: string | null) {
  return {
    evidenceId: EVIDENCE_ID,
    workspace: { reviewWorkflow: teamId ? { available: true, teamId } : { available: false, teamId: null } },
  } as never;
}

const status = (s: string, over: Record<string, unknown> = {}) => ({
  requested: s !== "NOT_REQUESTED",
  status: s,
  lastError: null,
  updatedAtUtc: null,
  hasDescriptor: s === "COMPLETED",
  ...over,
});

function projection(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: "PROOVRA_SCREEN_INTELLIGENCE_V1",
    descriptorVersion: 2,
    provenance: { reconstructed: "DERIVED_RECONSTRUCTED", machineExtracted: "DERIVED_MACHINE_EXTRACTED" },
    ocrEnabled: true,
    ocrStatus: "ENABLED",
    ocrLanguage: "eng+ara",
    coverage: "COMPLETE",
    acquisitionComplete: true,
    limitations: [],
    transformationVersions: { keyframe: "video-keyframe/v1", ocr: "screen-ocr/v1", reconstruction: "screen-conversation-reconstruction/v1" },
    generatedAtUtc: "2026-09-30T00:00:00.000Z",
    stats: { sourcePartCount: 1, keyframeCount: 2, ocrRegionCount: 3, ocrFailedKeyframes: 0, observationCount: 3, blockCount: 2, derivedBytes: 10 },
    generation: {
      generation: 2,
      toolVersions: { ffmpeg: "6.1.1", tesseract: "5.3.4" },
      parametersSha256: "a".repeat(64),
      supersedesGeneration: 1,
      sourceTruncated: false,
    },
    blockTotal: 2,
    page: { offset: 0, limit: 100 },
    blocks: [
      {
        blockId: "obs-0",
        sequence: 0,
        kind: "TEXT",
        text: "Invoice 88213 is attached",
        confidence: "HIGH_OVERLAP",
        observedInFrames: 2,
        possibleDuplicateOf: null,
        sources: [{ evidencePartId: "44444444-4444-4444-8444-444444444444", keyframeIds: ["p0-kf-0000"], offsetMsRange: [0, 1500] }],
      },
      {
        blockId: "obs-5",
        sequence: 1,
        kind: "TEXT",
        text: "OK",
        confidence: "PARTIAL_OVERLAP",
        observedInFrames: 1,
        possibleDuplicateOf: "obs-2",
        sources: [{ evidencePartId: "44444444-4444-4444-8444-444444444444", keyframeIds: [], offsetMsRange: [1500, 1500] }],
      },
    ],
    ...over,
  };
}

function review(s: string, proj: unknown, extra: Record<string, unknown> = {}) {
  return {
    evidenceId: EVIDENCE_ID,
    status: status(s),
    projection: proj,
    keyframeBytesUrls: { "p0-kf-0000": `/v1/evidence/${EVIDENCE_ID}/derived-assets/kf/bytes?teamId=${TEAM_ID}&v=abc` },
    release: { allowed: true },
    ...extra,
  };
}

beforeEach(() => {
  calls = [];
  activeWorkspaceId = null;
  responders = {
    "/derived-review/generate": () => ({ queued: true, reason: null, generation: 3 }),
    "/derived-review?": () => review("COMPLETED", projection()),
  };
});

describe("Derived Review tab", () => {
  it("DER-001: a DISMISSED run offers Retry, which requests a NEW generation", async () => {
    responders["/derived-review?"] = () => review("DISMISSED", null);
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    await act(async () => {
      fireEvent.click(retry);
    });
    const gen = calls.find((c) => c.path.includes("/derived-review/generate"));
    expect(gen).toBeTruthy();
    expect(gen!.body).toMatchObject({ teamId: TEAM_ID, regenerate: true });
  });

  it("DER-008: OCR engine unavailable is shown as such — never as a workspace policy", async () => {
    responders["/derived-review?"] = () =>
      review("COMPLETED", projection({ ocrEnabled: false, ocrStatus: "RUNTIME_UNAVAILABLE", blocks: [], blockTotal: 0, limitations: ["RECONSTRUCTION_OCR_RUNTIME_UNAVAILABLE"] }));
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/engine unavailable/i));
    expect(document.body.textContent).not.toMatch(/disabled (for this workspace|by (workspace )?policy)/i);
  });

  it("DER-008: a policy decision is shown as a policy decision", async () => {
    responders["/derived-review?"] = () =>
      review("COMPLETED", projection({ ocrEnabled: false, ocrStatus: "DISABLED_BY_POLICY", blocks: [], blockTotal: 0 }));
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/disabled by (this )?workspace('s)? policy/i));
  });

  it("DER-012: keyframe thumbnails are requested WITH credentials", async () => {
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    const view = await screen.findAllByRole("button", { name: "View source" });
    await act(async () => {
      fireEvent.click(view[0]!);
    });
    const img = document.querySelector("img.uc4-derived-thumb") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("crossorigin")).toBe("use-credentials");
    expect(img.getAttribute("src")).toContain("&v=");
    // A failed load is reported, not a broken image.
    await act(async () => {
      fireEvent.error(img);
    });
    expect(document.body.textContent).toMatch(/Keyframe unavailable/);
  });

  it("DER-004: an unproven repeat of an adjacent block is labelled", async () => {
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/possible repeat of the block above/i));
  });

  it("DER-006: the generation and what it replaced are visible", async () => {
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/Generation 2 \(replaces generation 1, which is kept\)/));
  });

  it("DER-002: a viewer the release gate refuses is told why and sees no reconstructed text", async () => {
    responders["/derived-review?"] = () =>
      review("COMPLETED", null, { keyframeBytesUrls: {}, release: { allowed: false, code: "ACCESS_DENIED" } });
    render(<EvidenceDerivedReviewTab ctx={ctx(TEAM_ID)} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/not available to you/i));
    expect(document.body.textContent).not.toMatch(/Invoice 88213/);
  });

  it("DER-010: a record with no workflow team uses the active (personal) workspace", async () => {
    activeWorkspaceId = "99999999-9999-4999-8999-999999999999";
    responders["/derived-review?"] = () => review("NOT_REQUESTED", null);
    render(<EvidenceDerivedReviewTab ctx={ctx(null)} />);
    const button = await screen.findByRole("button", { name: "Generate Derived Review" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    const gen = calls.find((c) => c.path.includes("/derived-review/generate"));
    expect(gen!.body).toMatchObject({ teamId: activeWorkspaceId });
  });

  it("DER-010: with no resolvable workspace the tab explains instead of showing a dead button", async () => {
    render(<EvidenceDerivedReviewTab ctx={ctx(null)} />);
    expect(document.body.textContent).toMatch(/workspace a record belongs to/i);
    expect(screen.queryByRole("button", { name: "Generate Derived Review" })).toBeNull();
  });
});

describe("Technical Appendix derived strip (DER-011)", () => {
  it("keyframes and the reconstruction JSON are not rendered as 'Derived preview' images", async () => {
    const asset = (over: Record<string, unknown>) => ({
      id: String(over.id),
      evidenceId: EVIDENCE_ID,
      evidencePartId: "44444444-4444-4444-8444-444444444444",
      status: "COMPLETED",
      derivedSha256: "b".repeat(64),
      sizeBytes: 10,
      widthPx: null,
      heightPx: null,
      sourceSha256AtGeneration: null,
      lastError: null,
      engineVersion: "x",
      generatedAtUtc: null,
      createdAtUtc: "2026-09-30T00:00:00Z",
      updatedAtUtc: "2026-09-30T00:00:00Z",
      bytesUrl: `/v1/evidence/${EVIDENCE_ID}/derived-assets/${over.id}/bytes?teamId=${TEAM_ID}`,
      ...over,
    });
    responders = {
      "/media-intelligence?": () => ({ evidenceId: EVIDENCE_ID, signals: [], catalog: [], derivedAssets: [], analyzerAvailable: true, latestRun: null }),
      "/derived-assets": () => ({
        evidenceId: EVIDENCE_ID,
        assets: [
          asset({ id: "thumb", assetKind: "image_thumbnail", contentType: "image/webp" }),
          asset({ id: "kf0", assetKind: "video_keyframe", contentType: "image/webp" }),
          asset({ id: "kf1", assetKind: "video_keyframe", contentType: "image/webp" }),
          asset({ id: "recon", assetKind: "screen_reconstruction", contentType: "application/json" }),
          asset({ id: "proxy", assetKind: "low_res_proxy", contentType: "video/webm" }),
        ],
      }),
    };
    render(<MediaIntelligencePanel evidenceId={EVIDENCE_ID} teamId={TEAM_ID} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/Derived Review tab/));
    const imgs = [...document.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    expect(imgs.some((s) => s.includes("/thumb/"))).toBe(true);
    expect(imgs.some((s) => s.includes("/kf0/") || s.includes("/kf1/") || s.includes("/recon/"))).toBe(false);
    // The proxy video is never an <img>.
    expect(imgs.some((s) => s.includes("/proxy/"))).toBe(false);
    expect(document.body.textContent).not.toMatch(/Derived preview unavailable/);
    expect(document.body.textContent).toMatch(/3 Derived Review materials/);
  });
});
