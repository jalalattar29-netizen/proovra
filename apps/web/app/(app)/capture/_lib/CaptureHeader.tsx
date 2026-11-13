"use client";

/**
 * CAPTURE HEADER + SETUP — "where am I, and what am I capturing into?"
 *
 * Replaces the oversized hero, the five-stage intake rail and the always-open
 * "Collection setup" strip. Those put an introduction, a progress indicator
 * whose current step was often below the fold, and three setup tiles ahead of
 * the action the operator came for.
 *
 * The header is one compact band: the title, then a summary of the facts that
 * govern the session — workspace, template, collection mode, location, draft
 * state — each read from the state the page already owns. "Change setup"
 * opens the setup panel in place.
 *
 * WHAT THE SETUP OPTIONS MEAN (verified in code, not inferred from labels)
 *   * Guided = planMode "CHECKLIST_REQUIRED": every required template item
 *     must be assigned before Review & Sign (`buildSessionReadiness` blocks).
 *   * Flexible = planMode "FLEXIBLE": required template items are reported
 *     but do not block Review & Sign.
 *   * Location is NOT a third mode. It is a separate switch (`useLocation`)
 *     that coexists with either mode; the template's `locationRequirement`
 *     (optional / recommended / required) decides whether leaving it off is a
 *     warning or a blocker. It is presented as a context setting for that
 *     reason.
 * Template and mode lock once evidence is staged — the existing rule — and
 * the panel says so instead of silently disabling them.
 */

import { useId } from "react";
import { Camera, ChevronDown, MapPin, Settings2 } from "lucide-react";

import { AppListbox } from "../../../../components/app-primitives";
import type { CapturePlanMode } from "./session-readiness";
import type { CollectionPlanTemplate } from "./types";

export const LOCATION_REQUIREMENT_LABEL: Record<CollectionPlanTemplate["locationRequirement"], string> = {
  optional: "Optional for this template",
  recommended: "Recommended by this template",
  required: "Required by this template",
};

export function planModeLabel(mode: CapturePlanMode): string {
  return mode === "CHECKLIST_REQUIRED" ? "Guided" : "Flexible";
}

type HeaderProps = {
  workspaceName: string | null;
  plan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  useLocation: boolean;
  /** The location switch's live status line (e.g. "Ready", "Permission needed"). */
  locationLabel: string;
  draftLabel: string;
  setupOpen: boolean;
  onToggleSetup: () => void;
  setupPanelId: string;
};

export function CaptureHeader({
  workspaceName,
  plan,
  planMode,
  useLocation,
  locationLabel,
  draftLabel,
  setupOpen,
  onToggleSetup,
  setupPanelId,
}: HeaderProps) {
  const locationRequired = plan?.locationRequirement === "required";
  return (
    <header className="capture-head" data-capture-header>
      <div className="capture-head__title-row">
        <span className="capture-hero__mark" aria-hidden="true">
          <Camera size={20} strokeWidth={2} />
        </span>
        <div className="capture-head__titles">
          <h1 className="capture-head__title">Capture Evidence</h1>
          <p className="capture-head__lede">
            Drafts save metadata only — your setup, notes and file details. File contents are not stored until
            finalization, when you Review &amp; Sign.
          </p>
        </div>
        <button
          type="button"
          className="capture-head__setup-toggle"
          aria-expanded={setupOpen}
          aria-controls={setupPanelId}
          onClick={onToggleSetup}
          data-capture-setup-toggle
        >
          <Settings2 size={16} aria-hidden="true" />
          <span>{setupOpen ? "Hide setup" : "Change setup"}</span>
          <ChevronDown size={15} aria-hidden="true" className="capture-head__chevron" />
        </button>
      </div>

      <dl className="capture-head__facts" data-capture-setup-summary>
        <div>
          <dt>Workspace</dt>
          <dd data-capture-summary-workspace>{workspaceName ?? "Loading workspace…"}</dd>
        </div>
        <div>
          <dt>Template</dt>
          <dd data-capture-summary-template>{plan?.name ?? "General evidence"}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd data-capture-summary-mode>{planModeLabel(planMode)}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd data-capture-summary-location className={!useLocation && locationRequired ? "is-required" : ""}>
            <MapPin size={13} aria-hidden="true" />
            {/* On narrow screens the facts read as one sentence without their
                labels, so "Off" alone would be ambiguous there. */}
            <span className="capture-head__fact-prefix" aria-hidden="true">
              Location{" "}
            </span>
            {useLocation ? locationLabel : locationRequired ? "Off — required" : "Off"}
          </dd>
        </div>
        <div>
          <dt>Draft</dt>
          <dd data-capture-summary-draft>{draftLabel}</dd>
        </div>
      </dl>
    </header>
  );
}

type SetupProps = {
  id: string;
  plans: CollectionPlanTemplate[];
  planId: string;
  onPlanChange: (id: string) => void;
  plan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  onPlanModeChange: (mode: CapturePlanMode) => void;
  useLocation: boolean;
  onUseLocationChange: (next: boolean) => void;
  locationLabel: string;
  locationCheckStatus: string;
  /** Template and mode are fixed once evidence is staged (existing rule). */
  locked: boolean;
  busy: boolean;
  /** `CaptureLocationStatus`: retry / finish-without-location / disclosure. */
  locationStatus: React.ReactNode;
};

export function CaptureSetupPanel({
  id,
  plans,
  planId,
  onPlanChange,
  plan,
  planMode,
  onPlanModeChange,
  useLocation,
  onUseLocationChange,
  locationLabel,
  locationCheckStatus,
  locked,
  busy,
  locationStatus,
}: SetupProps) {
  const templateId = useId();
  const modeName = useId();
  const lockId = useId();
  const disabled = busy || locked;
  return (
    <section id={id} className="capture-setup" data-capture-setup aria-label="Capture setup">
      <div className="capture-setup__field">
        <span id={templateId} className="capture-setup__label">
          Template
        </span>
        {/* The product's one select control (RT-008), not a native <select>. */}
        <AppListbox
          value={planId}
          options={plans.map((p) => ({ value: p.id, label: p.name, description: p.description }))}
          onChange={(next) => onPlanChange(next)}
          ariaLabelledby={templateId}
          disabled={disabled}
          disabledReason={locked ? "Template and mode are fixed once evidence is staged." : undefined}
          className="capture-setup__select"
          triggerProps={{ "data-capture-template-select": "" }}
        />
        {plan?.description ? <p className="capture-setup__hint">{plan.description}</p> : null}
      </div>

      <fieldset className="capture-setup__field capture-setup__modes" disabled={disabled}>
        <legend className="capture-setup__label">Collection mode</legend>
        <label className={`capture-setup__mode ${planMode === "CHECKLIST_REQUIRED" ? "is-active" : ""}`}>
          <input
            type="radio"
            name={modeName}
            checked={planMode === "CHECKLIST_REQUIRED"}
            onChange={() => onPlanModeChange("CHECKLIST_REQUIRED")}
            aria-describedby={locked ? lockId : undefined}
          />
          <span>
            <strong>Guided</strong>
            <small>Every required item must be assigned before Review &amp; Sign.</small>
          </span>
        </label>
        <label className={`capture-setup__mode ${planMode === "FLEXIBLE" ? "is-active" : ""}`}>
          <input
            type="radio"
            name={modeName}
            checked={planMode === "FLEXIBLE"}
            onChange={() => onPlanModeChange("FLEXIBLE")}
            aria-describedby={locked ? lockId : undefined}
          />
          <span>
            <strong>Flexible</strong>
            <small>Start collecting right away. Required items are recommended, not enforced.</small>
          </span>
        </label>
      </fieldset>

      {locked ? (
        <p id={lockId} className="capture-setup__lock" data-capture-setup-locked>
          Template and mode are fixed once evidence is staged. Clear the session to change them.
        </p>
      ) : null}

      <div className="capture-setup__field capture-setup__location">
        <span className="capture-setup__label">Capture context</span>
        <label className={`capture-setup__switch ${useLocation ? "is-on" : ""}`}>
          <input
            type="checkbox"
            checked={useLocation}
            onChange={(event) => onUseLocationChange(event.target.checked)}
            disabled={busy}
            data-capture-location-toggle
          />
          <span>
            <strong>Include device location</strong>
            <small data-capture-location-check={useLocation ? locationCheckStatus : "off"}>
              {plan ? LOCATION_REQUIREMENT_LABEL[plan.locationRequirement] : "Optional"} ·{" "}
              {useLocation ? locationLabel : "Not included"}
            </small>
          </span>
        </label>
        {locationStatus}
      </div>
    </section>
  );
}
