"use client";

import { useEffect, useState } from "react";

import {
  browserLocationFailureMessage,
  requestBrowserCaptureLocation,
  type BrowserCaptureLocation,
  type BrowserLocationFailure,
} from "../_lib/browser-location";

/** What the capture screen states about location while the toggle is on. */
export type CaptureLocationCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; accuracyMeters: number | null }
  | { status: BrowserLocationFailure };

/** One Finish & Sign measurement. `stopMessage` set ⇒ do not create the record. */
export type FinishLocation = {
  gps?: NonNullable<BrowserCaptureLocation["gps"]>;
  outcome?: BrowserLocationFailure | "NOT_REQUESTED";
  stopMessage?: string;
};

/**
 * THE capture screen's location state (2026-10-29). A check runs as soon as
 * the user turns location on, so a denial is seen before anything is
 * uploaded; Finish re-measures. A failed Finish measurement stops BEFORE a
 * record is created and the user decides: retry, or — unless the plan requires
 * location — finish without it, in which case the record states the failed
 * request (never "recorded"). Location off is recorded as NOT_REQUESTED.
 */
export function useCaptureLocation({ useLocation, required }: { useLocation: boolean; required: boolean }) {
  const [check, setCheck] = useState<CaptureLocationCheck>({ status: "idle" });
  const [failure, setFailure] = useState<BrowserLocationFailure | null>(null);

  const checkNow = async () => {
    setCheck({ status: "checking" });
    const located = await requestBrowserCaptureLocation(required);
    if (located.gps) {
      setFailure(null);
      setCheck({ status: "ready", accuracyMeters: located.gps.accuracyMeters ?? null });
    } else {
      setCheck({ status: located.outcome });
    }
  };

  useEffect(() => {
    if (!useLocation) {
      setCheck({ status: "idle" });
      setFailure(null);
      return;
    }
    void checkNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure when the toggle or the plan's precision changes
  }, [useLocation, required]);

  const measureForFinish = async (acceptFailure: boolean): Promise<FinishLocation> => {
    if (!useLocation) {
      // A plan that requires location never finishes with location turned off.
      return required
        ? { outcome: "NOT_REQUESTED", stopMessage: "The selected plan requires location. Turn location on and allow it in your browser, then finish." }
        : { outcome: "NOT_REQUESTED" };
    }
    const located = await requestBrowserCaptureLocation(required);
    if (located.gps) {
      setFailure(null);
      setCheck({ status: "ready", accuracyMeters: located.gps.accuracyMeters ?? null });
      return { gps: located.gps };
    }
    setCheck({ status: located.outcome });
    if (required || !acceptFailure) {
      setFailure(located.outcome);
      return { outcome: located.outcome, stopMessage: browserLocationFailureMessage(located.outcome, required) };
    }
    setFailure(null);
    return { outcome: located.outcome };
  };

  return {
    check,
    failure,
    required,
    checkNow,
    measureForFinish,
    permissionDenied: check.status === "DENIED" || failure === "DENIED",
  };
}
