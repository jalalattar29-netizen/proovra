"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { logCaptureClientError } from "../_lib/capture-errors";
import { COLLECTION_PLAN_TEMPLATES } from "../_lib/templates";
import type { CollectionPlanTemplate } from "../_lib/types";

/*
 * Server-driven intake templates with a safe local fallback.
 *
 * The server is the source of truth (versioned, snapshot-able). On a network
 * failure or auth bootstrap window, we fall back to the static seed list so
 * Capture stays usable. Records finalized while offline still snapshot the
 * template id; the server can reconcile against its versioned catalog.
 */

export interface ServerIntakeTemplate {
  templateId: string;
  templateVersion: number;
  templateName: string;
  description: string;
  locationRequirement: "required" | "recommended" | "optional";
  steps: Array<{
    id: string;
    title: string;
    description: string;
    purposeLabel: string;
    required: boolean;
    acceptedKinds: Array<"PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT">;
  }>;
}

function toClientTemplate(t: ServerIntakeTemplate): CollectionPlanTemplate {
  return {
    id: t.templateId,
    name: t.templateName,
    description: t.description,
    locationRequirement: t.locationRequirement,
    steps: t.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      purposeLabel: step.purposeLabel,
      required: step.required,
      acceptedKinds: step.acceptedKinds,
    })),
  };
}

export function useIntakeTemplates(): {
  templates: CollectionPlanTemplate[];
  source: "server" | "fallback" | "loading";
} {
  const [templates, setTemplates] = useState<CollectionPlanTemplate[]>(
    COLLECTION_PLAN_TEMPLATES
  );
  const [source, setSource] = useState<"server" | "fallback" | "loading">(
    "loading"
  );

  useEffect(() => {
    let cancelled = false;

    apiFetch("/v1/capture/intake-templates", { method: "GET" })
      .then((res) => {
        if (cancelled) return;
        const list: ServerIntakeTemplate[] = Array.isArray(res?.templates)
          ? res.templates
          : [];
        if (list.length === 0) {
          setSource("fallback");
          return;
        }
        setTemplates(list.map(toClientTemplate));
        setSource("server");
      })
      .catch((err) => {
        if (cancelled) return;
        logCaptureClientError("web_capture_intake_templates_fetch", err, {});
        setSource("fallback");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { templates, source };
}
