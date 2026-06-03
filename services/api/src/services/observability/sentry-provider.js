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
import { redactMetadata } from "./redact.js";
function severityToSentryLevel(severity) {
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
class SentrySpan {
    breadcrumbs = 0;
    name;
    attributes;
    constructor(name, attributes) {
        this.name = name;
        this.attributes = attributes ?? {};
        try {
            Sentry.addBreadcrumb({
                category: "observability.span.start",
                level: "info",
                message: name,
                data: redactMetadata(this.attributes),
            });
        }
        catch {
            bump("observability_provider_capture");
        }
    }
    addEvent(name, attributes) {
        if (this.breadcrumbs >= 20)
            return;
        this.breadcrumbs += 1;
        try {
            Sentry.addBreadcrumb({
                category: "observability.event",
                level: "info",
                message: `${this.name}:${name}`,
                data: redactMetadata(attributes ?? {}),
            });
        }
        catch {
            bump("observability_provider_capture");
        }
    }
    setAttribute(key, value) {
        this.attributes[key] = value;
    }
    recordException(err, context) {
        try {
            Sentry.captureException(err, {
                contexts: {
                    span: {
                        name: this.name,
                        attributes: redactMetadata({ ...this.attributes, ...(context ?? {}) }),
                    },
                },
            });
        }
        catch {
            bump("observability_provider_capture");
        }
    }
    end() {
        try {
            Sentry.addBreadcrumb({
                category: "observability.span.end",
                level: "info",
                message: this.name,
            });
        }
        catch {
            bump("observability_provider_capture");
        }
    }
}
export class SentryObservabilityProvider {
    name = "sentry";
    ready;
    constructor() {
        this.ready = Boolean((process.env.SENTRY_DSN ?? "").trim());
    }
    isReady() {
        return this.ready;
    }
    startSpan(name, attributes) {
        return new SentrySpan(name, attributes);
    }
    captureException(input) {
        try {
            const contexts = {};
            const merged = {
                ...(input.context ?? {}),
                requestId: input.requestId ?? null,
                traceId: input.traceId ?? null,
                userId: input.userId ?? null,
                teamId: input.teamId ?? null,
            };
            contexts.proovra = redactMetadata(merged);
            Sentry.captureException(input.err, {
                level: severityToSentryLevel(input.severity),
                contexts,
            });
        }
        catch {
            bump("observability_provider_capture");
        }
    }
    setUserContext(input) {
        try {
            Sentry.setUser(input.userId
                ? {
                    id: input.userId,
                    // Sentry's `User` shape accepts arbitrary string attributes;
                    // we pass the teamId as `segment` so operators can filter
                    // by workspace without us exposing the team name.
                    segment: input.teamId ?? undefined,
                }
                : null);
        }
        catch {
            bump("observability_provider_capture");
        }
    }
}
