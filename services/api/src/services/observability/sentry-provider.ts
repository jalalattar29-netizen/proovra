/**
 * Phase 21 — Sentry observability provider.
 *
 * Thin wrap around the existing Sentry init from
 * `src/observability/sentry.ts`. The Sentry SDK is already installed
 * (`@sentry/node`); this module exposes the observability surface
 * uniformly so route + service code doesn't import Sentry directly.
 *
 * Hard invariants:
 *   - Every `captureException` payload runs through `redactMetadata`
 *     before being attached to the Sentry scope. The Sentry init
 *     already redacts the request envelope; we add a second layer
 *     for the operator-supplied `context` field.
 *   - We deliberately do NOT enable trace propagation here (Phase 21
 *     does not introduce distributed tracing). Spans returned by
 *     this provider are application-side breadcrumbs only —
 *     transactional tracing arrives when an OTEL provider is added.
 *   - The provider never throws. Any Sentry SDK error is swallowed
 *     and bumped as `observability_provider_capture` so operators
 *     see the failure rate.
 */

import * as Sentry from "@sentry/node";

import { bump } from "../ops/metrics.service.js";
import type {
  CaptureExceptionInput,
  ObservabilityProvider,
  ObservabilitySpan,
  SpanAttributes,
} from "./provider.js";
import { redactMetadata } from "./redact.js";

function severityToSentryLevel(
  severity: CaptureExceptionInput["severity"],
): "info" | "warning" | "error" | "fatal" {
  switch (severity) {
    case "INFO":
      return "info";
    case "WARNING":
      return "warning";
    case "HIGH":
      return "error";
    case "CRITICAL":
      return "fatal";
    default:
      return "error";
  }
}

class SentrySpan implements ObservabilitySpan {
  private breadcrumbs = 0;
  private readonly name: string;
  private readonly attributes: SpanAttributes;

  constructor(name: string, attributes?: SpanAttributes) {
    this.name = name;
    this.attributes = attributes ?? {};
    try {
      Sentry.addBreadcrumb({
        category: "observability.span.start",
        level: "info",
        message: name,
        data: redactMetadata(this.attributes) as Record<string, unknown>,
      });
    } catch {
      bump("observability_provider_capture");
    }
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.breadcrumbs >= 20) return;
    this.breadcrumbs += 1;
    try {
      Sentry.addBreadcrumb({
        category: "observability.event",
        level: "info",
        message: `${this.name}:${name}`,
        data: redactMetadata(attributes ?? {}) as Record<string, unknown>,
      });
    } catch {
      bump("observability_provider_capture");
    }
  }

  setAttribute(key: string, value: string | number | boolean | null): void {
    this.attributes[key] = value;
  }

  recordException(err: unknown, context?: SpanAttributes): void {
    try {
      Sentry.captureException(err, {
        contexts: {
          span: {
            name: this.name,
            attributes: redactMetadata({ ...this.attributes, ...(context ?? {}) }),
          },
        },
      });
    } catch {
      bump("observability_provider_capture");
    }
  }

  end(): void {
    try {
      Sentry.addBreadcrumb({
        category: "observability.span.end",
        level: "info",
        message: this.name,
      });
    } catch {
      bump("observability_provider_capture");
    }
  }
}

export class SentryObservabilityProvider implements ObservabilityProvider {
  readonly name = "sentry" as const;

  private readonly ready: boolean;

  constructor() {
    this.ready = Boolean((process.env.SENTRY_DSN ?? "").trim());
  }

  isReady(): boolean {
    return this.ready;
  }

  startSpan(name: string, attributes?: SpanAttributes): ObservabilitySpan {
    return new SentrySpan(name, attributes);
  }

  captureException(input: CaptureExceptionInput): void {
    try {
      const contexts: Record<string, Record<string, unknown>> = {};
      const merged: Record<string, unknown> = {
        ...(input.context ?? {}),
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        userId: input.userId ?? null,
        teamId: input.teamId ?? null,
      };
      contexts.proovra = redactMetadata(merged) as Record<string, unknown>;
      Sentry.captureException(input.err, {
        level: severityToSentryLevel(input.severity),
        contexts,
      });
    } catch {
      bump("observability_provider_capture");
    }
  }

  setUserContext(input: { userId?: string | null; teamId?: string | null }): void {
    try {
      Sentry.setUser(
        input.userId
          ? {
              id: input.userId,
              // Sentry's `User` shape accepts arbitrary string attributes;
              // we pass the teamId as `segment` so operators can filter
              // by workspace without us exposing the team name.
              segment: input.teamId ?? undefined,
            }
          : null,
      );
    } catch {
      bump("observability_provider_capture");
    }
  }
}
