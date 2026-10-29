"use client";

import { browserLocationFailureMessage, isLocationCheckFailure, type BrowserLocationFailure } from "./browser-location";
import type { useCaptureLocation } from "../_hooks/useCaptureLocation";

type Props = {
  useLocation: boolean;
  location: ReturnType<typeof useCaptureLocation>;
  busy: boolean;
  onFinishWithoutLocation: () => void;
};

/**
 * What happened to the location request, stated where it was asked for, with
 * what the user can do: retry, or — unless the plan requires location — finish
 * without it. And, always, what inclusion means for each audience: the report
 * and full package carry it; the public page only by a separate choice.
 */
export function CaptureLocationStatus({ useLocation, location, busy, onFinishWithoutLocation }: Props) {
  const failed = location.failure ?? (isLocationCheckFailure(location.check) ? (location.check.status as BrowserLocationFailure) : null);
  return (
    <>
      {useLocation && failed ? (
        <div className="capture-location-failure" role="alert" data-capture-location-failure>
          <p>{browserLocationFailureMessage(failed, location.required)}</p>
          <div className="capture-location-failure__actions">
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void location.checkNow()}
              disabled={busy || location.check.status === "checking"}
            >
              Retry location
            </button>
            {location.failure && !location.required ? (
              <button type="button" className="app-secondary-action" onClick={onFinishWithoutLocation} disabled={busy}>
                Finish without location
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="capture-location-note">
        Included location appears in your report and full verification package. The public verification page shows it
        only if you choose to show it there.
      </p>
    </>
  );
}
