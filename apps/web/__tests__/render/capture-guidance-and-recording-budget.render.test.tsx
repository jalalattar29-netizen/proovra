/**
 * WS-CAP — Capture guidance dismissals and recorder budgets.
 *
 *   PRO-C1C-04 — a dismissal is persisted only with preferences consent (the
 *                cookie policy's promise); without it the panel hides for this
 *                mount and nothing is written.
 *   PRO-C1C-03 — a dismissal is scoped to the account and workflow, not the
 *                whole browser origin.
 *   PRO-C1-07  — a recording's byte budget comes from the staging limits, a
 *                full session refuses to start, and the recorder stops just
 *                before the budget.
 *
 * Real consent store, real panel; RTL cleanup() between tests.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CONSENT_VERSION, saveConsentState } from "../../lib/consent";
import { CaptureReadinessPanel } from "../../app/(app)/capture/_lib/CaptureReadinessPanel";
import {
  RECORDING_STOP_MARGIN_BYTES,
  recordingByteBudget,
  recordingCanStart,
  recordingReachedBudget,
} from "../../app/(app)/capture/_lib/recording-budget";
import { MAX_SESSION_BYTES, MAX_SINGLE_FILE_BYTES } from "../../app/(app)/capture/_lib/templates";
import type { SessionItem } from "../../app/(app)/capture/_lib/types";

function consent(preferences: boolean) {
  saveConsentState({ necessary: true, preferences, analytics: false, marketing: false, consentVersion: CONSENT_VERSION });
}

const ITEM = {
  id: "1",
  file: new File(["x"], "a.png", { type: "image/png" }),
  previewUrl: null,
  mimeType: "image/png",
  relativePath: null,
  uploadProgress: 0,
  uploading: false,
  error: null,
  checklistStepId: null,
} as unknown as SessionItem;

function dismissedKeys(): string[] {
  return Object.keys(window.localStorage).filter((k) => k.startsWith("capture-readiness-dismissed:"));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("PRO-C1C-04 / PRO-C1C-03 — guidance dismissals", () => {
  it("without preferences consent the dismissal hides the panel and writes nothing", () => {
    consent(false);
    const view = render(<CaptureReadinessPanel items={[ITEM]} scopeKey="user-a:freeform" />);
    fireEvent.click(view.container.querySelector("[data-capture-readiness-dismiss]") as HTMLElement);
    expect(view.container.querySelector("[data-capture-readiness]")).toBeNull();
    expect(dismissedKeys()).toEqual([]);
  });

  it("with consent it persists, for that account and workflow only", () => {
    consent(true);
    const first = render(<CaptureReadinessPanel items={[ITEM]} scopeKey="user-a:freeform" />);
    fireEvent.click(first.container.querySelector("[data-capture-readiness-dismiss]") as HTMLElement);
    expect(dismissedKeys()).toEqual(["capture-readiness-dismissed:user-a:freeform"]);
    cleanup();
    // Same account and workflow: stays dismissed.
    const again = render(<CaptureReadinessPanel items={[ITEM]} scopeKey="user-a:freeform" />);
    expect(again.container.querySelector("[data-capture-readiness]")).toBeNull();
    cleanup();
    // Another account (or another template) on the same browser: shown.
    const other = render(<CaptureReadinessPanel items={[ITEM]} scopeKey="user-b:freeform" />);
    expect(other.container.querySelector("[data-capture-readiness]")).not.toBeNull();
  });
});

describe("PRO-C1-07 — recording budgets", () => {
  it("an empty session allows one file's limit; a full one refuses to start", () => {
    expect(recordingByteBudget(0)).toBe(Math.min(MAX_SINGLE_FILE_BYTES, MAX_SESSION_BYTES));
    expect(recordingCanStart(recordingByteBudget(0))).toBe(true);
    expect(recordingByteBudget(MAX_SESSION_BYTES)).toBe(0);
    expect(recordingCanStart(recordingByteBudget(MAX_SESSION_BYTES))).toBe(false);
  });

  it("the recorder stops before the budget, so the result always fits", () => {
    const budget = recordingByteBudget(MAX_SESSION_BYTES - 100 * 1024 * 1024);
    expect(budget).toBeLessThanOrEqual(100 * 1024 * 1024);
    expect(recordingReachedBudget(budget - RECORDING_STOP_MARGIN_BYTES - 1, budget)).toBe(false);
    expect(recordingReachedBudget(budget - RECORDING_STOP_MARGIN_BYTES, budget)).toBe(true);
  });
});
