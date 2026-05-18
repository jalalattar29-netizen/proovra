"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { logCaptureClientError } from "../_lib/capture-errors";
import { adaptWorkflowTemplatesListForCapture } from "../_lib/workflow-context";
import type { CollectionPlanTemplate } from "../_lib/types";
import { useIntakeTemplates } from "./useIntakeTemplates";

/*
 * Phase 3: feature-flagged workflow-aware template loader.
 *
 * Behavior:
 *   - When the feature flag is OFF (default), this hook is a transparent
 *     pass-through to `useIntakeTemplates`. The capture page receives the
 *     exact same templates list and source it would receive today.
 *
 *   - When the feature flag is ON, the hook attempts to call
 *     `/v1/workflow/templates` (Phase 2 endpoint). On success with a
 *     non-empty list, the workflow templates are returned (mapped to the
 *     legacy `CollectionPlanTemplate` shape that capture-v2 components
 *     already consume).
 *
 *   - On any failure path — network error, empty result, malformed payload,
 *     authentication issue — the hook falls back to the result of
 *     `useIntakeTemplates`, which itself falls back to the in-bundle seed
 *     list. This means a feature-flag-enabled deployment with a broken
 *     workflow endpoint still behaves exactly like today.
 *
 * Why we keep `useIntakeTemplates` around: it is the established source of
 * truth for the live capture page, and Phase 3 must not change that until a
 * later phase removes it. Until then, this hook is a superset.
 */

const FEATURE_FLAG_ENV = "NEXT_PUBLIC_FEATURE_WORKFLOW_ENGINE_CAPTURE";

export type WorkflowTemplatesSource =
  | "loading"
  | "workflow_api"
  | "intake_server"
  | "intake_fallback";

function isFeatureEnabled(): boolean {
  // Read explicitly through process.env so Next.js inlines this at build
  // time. Any value other than the literal string "true" disables the
  // feature, including undefined, null, and false.
  return process.env[FEATURE_FLAG_ENV] === "true";
}

export function useWorkflowTemplates(): {
  templates: CollectionPlanTemplate[];
  source: WorkflowTemplatesSource;
} {
  // Always run the legacy hook so its behavior is bit-for-bit preserved
  // when the feature flag is off, and so the hook order stays stable.
  const intake = useIntakeTemplates();

  const featureEnabled = isFeatureEnabled();

  const [workflowState, setWorkflowState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; templates: CollectionPlanTemplate[] }
    | { kind: "fallback" }
  >(() => (featureEnabled ? { kind: "loading" } : { kind: "idle" }));

  useEffect(() => {
    if (!featureEnabled) {
      // Make sure state never claims "loading" when the flag is off.
      setWorkflowState({ kind: "idle" });
      return;
    }

    let cancelled = false;

    apiFetch("/v1/workflow/templates", { method: "GET" })
      .then((res) => {
        if (cancelled) return;
        const adapt = adaptWorkflowTemplatesListForCapture(res?.templates);

        if (adapt.invalidCount > 0) {
          logCaptureClientError(
            "web_capture_workflow_template_dropped_invalid",
            new Error(
              `Dropped ${adapt.invalidCount} malformed workflow template(s)`,
            ),
            { invalidCount: adapt.invalidCount },
          );
        }

        if (adapt.templates.length === 0) {
          // No usable workflow templates — defer to the intake fallback.
          setWorkflowState({ kind: "fallback" });
          return;
        }

        setWorkflowState({ kind: "ready", templates: adapt.templates });
      })
      .catch((err) => {
        if (cancelled) return;
        logCaptureClientError(
          "web_capture_workflow_templates_fetch",
          err,
          {},
        );
        setWorkflowState({ kind: "fallback" });
      });

    return () => {
      cancelled = true;
    };
  }, [featureEnabled]);

  // Decision tree. When the feature is off, or workflow loading hasn't
  // completed yet, or workflow returned nothing usable: defer to the intake
  // hook entirely. The capture page sees `templates` of the same shape.
  if (!featureEnabled) {
    return {
      templates: intake.templates,
      source:
        intake.source === "loading"
          ? "loading"
          : intake.source === "server"
            ? "intake_server"
            : "intake_fallback",
    };
  }

  if (workflowState.kind === "ready") {
    return {
      templates: workflowState.templates,
      source: "workflow_api",
    };
  }

  if (workflowState.kind === "loading") {
    // Workflow path is still in flight. Surface the intake result so the
    // page does not flash an empty selector; if the workflow eventually
    // returns templates, the re-render will swap them in.
    return {
      templates: intake.templates,
      source: intake.source === "loading" ? "loading" : "intake_server",
    };
  }

  // workflowState.kind is "idle" or "fallback".
  return {
    templates: intake.templates,
    source:
      intake.source === "loading"
        ? "loading"
        : intake.source === "server"
          ? "intake_server"
          : "intake_fallback",
  };
}
