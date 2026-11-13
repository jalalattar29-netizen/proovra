import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";

vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));
vi.mock("../../lib/api", () => ({ apiFetch: async () => ({}), ApiError: class extends Error {} }));

import { CaptureDropzone } from "../../components/capture-v2/CaptureDropzone";
import { CaptureRequirements } from "../../components/capture-v2/CaptureRequirements";
import { useCaptureScreenRecorder } from "../../app/(app)/capture/_hooks/useCaptureScreenRecorder";
import { shouldShowScreenRecorderCard } from "../../app/(app)/capture/_lib/CaptureScreenRecorderCard";
import { CaptureMaterialsList } from "../../app/(app)/capture/_lib/CaptureMaterialsList";
import { CaptureReadinessSignals } from "../../app/(app)/capture/_lib/CaptureReadinessSignals";
import { CaptureFinalReadiness } from "../../app/(app)/capture/_lib/CaptureFinalReadiness";
import { CaptureReviewDialog } from "../../app/(app)/capture/_lib/CaptureReviewDialog";
import { buildSessionReadiness } from "../../app/(app)/capture/_lib/session-readiness";
import { COLLECTION_PLAN_TEMPLATES } from "../../app/(app)/capture/_lib/templates";
import { formatEvidenceTypeLabel } from "../../app/(app)/capture/_lib/file-utils";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

/**
 * Capture redesign (2026-11-13) — regression checks for what the old page got
 * wrong: the intermediate "Ready" card in front of the browser's screen
 * chooser, duplicate chooser requests and duplicate staged recordings, an
 * empty draft shown as a red blocker, and Flexible-mode requirements labelled
 * as blocking. Geometry (the staged list fitting its card) is measured in the
 * real engine by e2e/capture-layout; jsdom has no layout.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plan = COLLECTION_PLAN_TEMPLATES.find((p) => p.id === "general-evidence-record")!;

function item(id: string, name: string, mimeType: string, checklistStepId: string | null = null): SessionItem {
  return {
    id,
    file: new File(["x"], name, { type: mimeType }),
    previewUrl: null,
    mimeType,
    relativePath: null,
    uploadProgress: 0,
    uploading: false,
    checklistStepId,
  };
}

const LONG_NAME = "insurance-claim-2026-11-13-front-door-damage-north-facade-close-up-photo-final-v3.png";

describe("Screen is one click to the browser's chooser", () => {
  const noop = () => {};
  const base = {
    busy: false,
    itemCount: 0,
    onOpenFilePicker: noop,
    onOpenFolderPicker: noop,
    onOpenCamera: noop,
    onOpenAudioRecorder: noop,
    onDropFiles: async () => {},
  };

  it("the Screen action calls the recorder's start directly; no 'Choose what to record' step exists", () => {
    const start = vi.fn();
    render(<CaptureDropzone {...base} onStartScreenRecording={start} />);
    fireEvent.click(screen.getByRole("button", { name: /^Screen/ }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Choose what to record/)).toBeNull();
  });

  it("Screen is disabled while a recording is live, and absent where the browser cannot record", () => {
    const { rerender } = render(<CaptureDropzone {...base} onStartScreenRecording={noop} screenRecordingActive />);
    expect((screen.getByRole("button", { name: /^Screen/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<CaptureDropzone {...base} />);
    expect(screen.queryByRole("button", { name: /^Screen/ })).toBeNull();
  });

  it("the card is not shown for an idle recorder: no Ready card", () => {
    expect(shouldShowScreenRecorderCard("idle", null)).toBe(false);
    expect(shouldShowScreenRecorderCard("unsupported", null)).toBe(false);
    expect(shouldShowScreenRecorderCard("idle", "cancelled")).toBe(true);
    for (const s of ["requesting", "recording", "paused", "stopped", "adding", "failed"] as const) {
      expect(shouldShowScreenRecorderCard(s, null)).toBe(true);
    }
  });

  it("two quick starts open ONE chooser", async () => {
    const getDisplayMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
    vi.stubGlobal("MediaRecorder", class {});
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession: vi.fn(async () => {}) }));
    act(() => {
      void result.current.start();
      void result.current.start();
    });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("requesting");
  });

  it("a cancelled chooser stages nothing and the next click opens it again", async () => {
    const getDisplayMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }))
      .mockImplementationOnce(() => new Promise(() => {}));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
    vi.stubGlobal("MediaRecorder", class {});
    const addFilesToSession = vi.fn(async () => {});
    const { result } = renderHook(() => useCaptureScreenRecorder({ addFilesToSession }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toMatch(/cancelled or not allowed/);
    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
    act(() => {
      void result.current.start();
    });
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    expect(addFilesToSession).not.toHaveBeenCalled();
  });
});

describe("staged evidence", () => {
  const props = {
    plan,
    planMode: "FLEXIBLE" as const,
    busy: false,
    totalBytes: 3,
    draftLabel: "Draft saved",
    draftTitle: "",
    openAssignmentId: null,
    setOpenAssignmentId: () => {},
    expandedId: null,
    setExpandedId: () => {},
    onUpdateItem: () => {},
    onRemoveItem: () => {},
    onClearAssignments: () => {},
    onRemovePending: () => {},
  };

  it("one row per item: evidence, assignment, status and named actions", () => {
    const onRemoveItem = vi.fn();
    const items = [item("a", LONG_NAME, "image/png"), item("b", "notes.pdf", "application/pdf", "primary_evidence")];
    render(<CaptureMaterialsList {...props} items={items} onRemoveItem={onRemoveItem} />);
    const rows = document.querySelectorAll("[data-capture-staged-item]");
    expect(rows).toHaveLength(2);
    // The full name is reachable even when the cell truncates it.
    expect(within(rows[0] as HTMLElement).getByText(LONG_NAME).getAttribute("title")).toBe(LONG_NAME);
    expect(within(rows[0] as HTMLElement).getByText("Not assigned", { selector: "strong" })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Primary evidence file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Remove ${LONG_NAME}` }));
    expect(onRemoveItem).toHaveBeenCalledWith("a");
    expect(screen.getByRole("button", { name: `Show notes and details for ${LONG_NAME}` })).toBeTruthy();
  });

  it("the assignment menu offers every template step with its tier in the active mode", () => {
    render(<CaptureMaterialsList {...props} items={[item("a", "x.png", "image/png")]} openAssignmentId="a" />);
    const menu = screen.getByRole("listbox");
    expect(within(menu).getAllByRole("option")).toHaveLength(plan.steps.length + 1);
    expect(menu.textContent).toMatch(/Recommended/);
  });

  it("an upload error is stated as Retry needed", () => {
    const failed = { ...item("a", "x.png", "image/png"), error: "Upload failed" };
    render(<CaptureMaterialsList {...props} items={[failed]} />);
    expect(screen.getByText("Retry needed")).toBeTruthy();
  });
});

describe("a new draft is calm; a real blocker is not", () => {
  it("empty: one calm sentence, no red blocker group, and the button stays disabled", () => {
    const readiness = buildSessionReadiness({ items: [], selectedPlan: plan, planMode: "FLEXIBLE", useLocation: false });
    expect(readiness.canFinalize).toBe(false);
    render(<CaptureReadinessSignals readiness={readiness} />);
    expect(document.querySelector('[data-capture-signals="empty"]')).not.toBeNull();
    expect(document.querySelector('[data-capture-signal-group="blockers"]')).toBeNull();
    cleanup();
    const onAddFirst = vi.fn();
    render(<CaptureFinalReadiness readiness={readiness} busy={false} onAddFirst={onAddFirst} />);
    const final = document.querySelector("[data-capture-final-readiness]")!;
    expect(final.getAttribute("data-capture-final-readiness")).toBe("not_ready");
    expect(final.getAttribute("data-capture-readiness-tone")).toBe("empty");
    expect(final.textContent).toMatch(/Add your first file to get started/);
    fireEvent.click(screen.getByRole("button", { name: "Add files" }));
    expect(onAddFirst).toHaveBeenCalled();
  });

  it("empty with a REQUIRED location still lists that blocker", () => {
    const required = { ...plan, locationRequirement: "required" as const };
    const readiness = buildSessionReadiness({ items: [], selectedPlan: required, planMode: "FLEXIBLE", useLocation: false });
    render(<CaptureReadinessSignals readiness={readiness} />);
    const group = document.querySelector('[data-capture-signal-group="blockers"]');
    expect(group?.textContent).toMatch(/Location metadata is required/);
  });

  it("an unassigned file is listed once, by name, and leads to its fix", () => {
    const items = [item("a", "door.png", "image/png")];
    const readiness = buildSessionReadiness({ items, selectedPlan: plan, planMode: "FLEXIBLE", useLocation: true });
    const onSelectIssue = vi.fn();
    render(
      <CaptureReadinessSignals readiness={readiness} onSelectIssue={onSelectIssue} itemLabel={(id) => (id === "a" ? "door.png" : undefined)} />,
    );
    const buttons = screen.getAllByRole("button").filter((b) => /Needs mapping/.test(b.textContent ?? ""));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/door\.png/);
    fireEvent.click(buttons[0]);
    expect(onSelectIssue.mock.calls[0][0].itemId).toBe("a");
  });
});

describe("requirements say what the active mode enforces", () => {
  const base = {
    selectedCollectionPlan: plan,
    busy: false,
    checklistStepItemMap: new Map<string, SessionItem[]>(),
    formatEvidenceTypeLabel,
    onAddForStep: () => {},
    onAssignForStep: () => {},
  };

  it("Flexible: required steps are Recommended and never 'Blocks Review & Sign'", () => {
    const readiness = buildSessionReadiness({ items: [], selectedPlan: plan, planMode: "FLEXIBLE", useLocation: false });
    render(<CaptureRequirements {...base} planMode="FLEXIBLE" sessionReadiness={readiness} />);
    const row = document.querySelector('[data-capture-requirement="primary_evidence"]')!;
    expect(row.getAttribute("data-capture-requirement-tier")).toBe("recommended");
    expect(document.body.textContent).not.toMatch(/Blocks Review & Sign/);
  });

  it("Guided: the same step is Required, and its action adds a file when none is staged", () => {
    const onAddForStep = vi.fn();
    const readiness = buildSessionReadiness({ items: [], selectedPlan: plan, planMode: "CHECKLIST_REQUIRED", useLocation: false });
    render(<CaptureRequirements {...base} planMode="CHECKLIST_REQUIRED" sessionReadiness={readiness} onAddForStep={onAddForStep} />);
    const row = document.querySelector('[data-capture-requirement="primary_evidence"]') as HTMLElement;
    expect(row.getAttribute("data-capture-requirement-tier")).toBe("required");
    fireEvent.click(within(row).getByRole("button", { name: /Add file for Primary evidence file/ }));
    expect(onAddForStep).toHaveBeenCalledWith("primary_evidence");
  });

  it("with an unassigned file staged, the primary step offers 'Mark a file as primary evidence'", () => {
    const onAssignForStep = vi.fn();
    const items = [item("a", "door.png", "image/png")];
    const readiness = buildSessionReadiness({ items, selectedPlan: plan, planMode: "FLEXIBLE", useLocation: false });
    render(<CaptureRequirements {...base} planMode="FLEXIBLE" sessionReadiness={readiness} onAssignForStep={onAssignForStep} />);
    fireEvent.click(screen.getByRole("button", { name: /Mark a file as primary evidence for Primary evidence file/ }));
    expect(onAssignForStep).toHaveBeenCalledWith("primary_evidence");
  });
});

describe("Review & Sign shows what will be sealed before it is", () => {
  it("lists the evidence, context, warnings and what signing does; confirm and Escape route correctly", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const items = [item("a", "door.png", "image/png", "primary_evidence"), item("b", "notes.pdf", "application/pdf")];
    const readiness = buildSessionReadiness({ items, selectedPlan: plan, planMode: "FLEXIBLE", useLocation: false });
    render(
      <CaptureReviewDialog
        open
        busy={false}
        items={items}
        plan={plan}
        planMode="FLEXIBLE"
        workspaceName="Meridian Legal"
        locationLabel="Not included"
        hasPrivateNote
        warnings={readiness.warnings}
        totalBytes={2}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Review before signing" });
    expect(dialog.textContent).toMatch(/door\.png/);
    expect(dialog.textContent).toMatch(/Primary · Primary evidence file/);
    expect(dialog.textContent).toMatch(/Meridian Legal/);
    expect(dialog.textContent).toMatch(/warning/);
    expect(dialog.textContent).toMatch(/recomputed by the server/);
    expect(dialog.textContent).toMatch(/does not establish that the content is\s+true/);
    expect(document.activeElement?.textContent).toBe("Sign and finalize");
    fireEvent.click(screen.getByRole("button", { name: "Sign and finalize" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
