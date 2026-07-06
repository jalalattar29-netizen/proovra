"use client";

/**
 * Shared UI primitives for the /evidence-lifecycle/* subtree.
 *
 * This module is FILE-PRIVATE to the segment (underscore prefix means
 * Next.js does NOT treat it as a route). It exists to eliminate the
 * 6× duplicated `applyDenial()` helper and to standardize loading,
 * empty, error, and denial banner appearance across all 7 pages.
 *
 * Hard rules followed:
 *   - No new lifecycle system. No v2. No new routes.
 *   - No data fetches in this module.
 *   - No mutations.
 *   - Pure presentation + a single error-mapping helper.
 *
 * Why a single module:
 *   - Before: each of /retention, /legal-holds, /archive, /destruction,
 *     /webhooks, /chain-transfers reimplemented PermissionDenialState +
 *     applyDenial() inline (40 lines × 6 files = 240 lines of drift bait).
 *     Tiny copy diffs between pages produced inconsistent operator UX.
 *   - After: one resolver, one banner, one skeleton, one empty state,
 *     one ErrorBoundary. Every page reads the same.
 */

import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { ApiError } from "../../../lib/api";

// ---------------------------------------------------------------------------
// 1. Denial / error → resolved UI state
// ---------------------------------------------------------------------------

export interface LifecycleDenial {
  /** Canonical denial code. */
  denial:
    | "ENTITLEMENT_REQUIRED"
    | "DELEGATED_ADMIN_REQUIRED"
    | "FORBIDDEN"
    | "AUTHENTICATION_REQUIRED"
    | "VALIDATION_FAILED"
    | "UNKNOWN_ERROR";
  /** Human-readable title for the banner. */
  title: string;
  /** Optional supporting text. */
  detail?: string;
  /** Optional required-tier hint (DELEGATED_ADMIN, ORG_ADMIN, etc.). */
  requiredTier?: string;
  /** Optional missing entitlement key. */
  missingFeature?: string;
  /** True when this is a "no data yet" / non-fatal degraded state. */
  isDegraded?: boolean;
}

interface LooseErrorShape {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

function extractDenialDetails(
  details: Record<string, unknown> | undefined,
): { denial: string | null; tier: string | undefined; feature: string | undefined } {
  if (!details) return { denial: null, tier: undefined, feature: undefined };
  const denial = typeof details.denial === "string" ? details.denial : null;
  const tier =
    typeof details.requiredTier === "string" ? (details.requiredTier as string) : undefined;
  const feature =
    typeof details.entitlement === "string"
      ? (details.entitlement as string)
      : typeof details.requiredEntitlement === "string"
        ? (details.requiredEntitlement as string)
        : undefined;
  return { denial, tier, feature };
}

/**
 * Map ANY caught value into a non-throwing LifecycleDenial. Tolerates:
 *   - ApiError (the canonical client error type)
 *   - Plain objects with statusCode / details (some legacy fetches)
 *   - Plain Error instances
 *   - Strings, undefined, null (defensive — never throws)
 */
export function resolveLifecycleError(err: unknown): LifecycleDenial | null {
  if (err === null || err === undefined) return null;

  // Canonical client error.
  if (err instanceof ApiError) {
    const { denial, tier, feature } = extractDenialDetails(err.details);
    if (err.statusCode === 403 && denial === "ENTITLEMENT_REQUIRED") {
      return {
        denial: "ENTITLEMENT_REQUIRED",
        title: "Entitlement required",
        detail: feature
          ? `This section needs the ${feature} entitlement on the active workspace.`
          : "This section needs an additional entitlement on the active workspace.",
        missingFeature: feature,
      };
    }
    if (err.statusCode === 403 && denial === "DELEGATED_ADMIN_REQUIRED") {
      return {
        denial: "DELEGATED_ADMIN_REQUIRED",
        title: "Delegated admin required",
        detail:
          "A workspace administrator with the required delegated tier must grant access.",
        requiredTier: tier ?? "DELEGATED_ADMIN",
      };
    }
    if (err.statusCode === 401) {
      return {
        denial: "AUTHENTICATION_REQUIRED",
        title: "Please sign in",
        detail: "Your session expired. Reload to sign in again.",
      };
    }
    if (err.statusCode === 403) {
      return {
        denial: "FORBIDDEN",
        title: "Not available for this workspace",
        detail:
          "This lifecycle section is not enabled here, or your role doesn't have permission.",
      };
    }
    if (err.statusCode === 422 || err.statusCode === 400) {
      return {
        denial: "VALIDATION_FAILED",
        title: "Request was rejected",
        detail: "The request body did not pass validation.",
      };
    }
    // 503 SCHEMA_NOT_READY → degraded (admin-safe wording, no Prisma leak)
    if (err.statusCode === 503) {
      return {
        denial: "UNKNOWN_ERROR",
        title: "Lifecycle data is being prepared",
        detail:
          "A schema readiness check is still running on this environment. Try again in a moment.",
        isDegraded: true,
      };
    }
    return {
      denial: "UNKNOWN_ERROR",
      title: "Could not load this section",
      detail: "An unexpected backend response was returned.",
    };
  }

  // Loose shape (legacy fetch helpers, non-ApiError throws).
  if (typeof err === "object") {
    const e = err as LooseErrorShape;
    const { denial, tier, feature } = extractDenialDetails(e.details);
    if (e.statusCode === 403 && denial === "ENTITLEMENT_REQUIRED") {
      return {
        denial: "ENTITLEMENT_REQUIRED",
        title: "Entitlement required",
        missingFeature: feature,
        detail: feature
          ? `This section needs the ${feature} entitlement on the active workspace.`
          : undefined,
      };
    }
    if (e.statusCode === 403 && denial === "DELEGATED_ADMIN_REQUIRED") {
      return {
        denial: "DELEGATED_ADMIN_REQUIRED",
        title: "Delegated admin required",
        requiredTier: tier ?? "DELEGATED_ADMIN",
      };
    }
    if (e.statusCode === 401) {
      return {
        denial: "AUTHENTICATION_REQUIRED",
        title: "Please sign in",
      };
    }
    if (e.statusCode === 403) {
      return { denial: "FORBIDDEN", title: "Not available for this workspace" };
    }
  }

  // String / undefined / arbitrary throws.
  return {
    denial: "UNKNOWN_ERROR",
    title: "Could not load this section",
    detail: typeof err === "string" ? err : undefined,
  };
}

// ---------------------------------------------------------------------------
// 2. Denial banner
// ---------------------------------------------------------------------------

const DENIAL_PALETTE: Record<
  LifecycleDenial["denial"],
  { bg: string; border: string; text: string }
> = {
  ENTITLEMENT_REQUIRED: { bg: "#fef3c7", border: "#fcd34d", text: "#78350f" },
  DELEGATED_ADMIN_REQUIRED: { bg: "#fef3c7", border: "#fcd34d", text: "#78350f" },
  FORBIDDEN: { bg: "#fef3c7", border: "#fcd34d", text: "#78350f" },
  AUTHENTICATION_REQUIRED: { bg: "#eff6ff", border: "#bfdbfe", text: "#1e3a8a" },
  VALIDATION_FAILED: { bg: "#fef2f2", border: "#fecaca", text: "#7f1d1d" },
  UNKNOWN_ERROR: { bg: "#fef2f2", border: "#fecaca", text: "#7f1d1d" },
};

export function DenialBanner({ denial }: { denial: LifecycleDenial }) {
  const palette = DENIAL_PALETTE[denial.denial];
  return (
    <div
      role="alert"
      data-lifecycle-denial={denial.denial}
      data-permission-denied={denial.denial}
      style={{
        padding: 12,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        color: palette.text,
        fontSize: 13,
        marginBottom: 12,
      }}
    >
      <strong style={{ display: "block", marginBottom: 2 }}>{denial.title}</strong>
      {denial.detail ? <div style={{ fontSize: 12 }}>{denial.detail}</div> : null}
      {denial.requiredTier ? (
        <div style={{ fontSize: 11, marginTop: 4 }}>
          Required tier: <code>{denial.requiredTier}</code>
        </div>
      ) : null}
      {denial.missingFeature ? (
        <div style={{ fontSize: 11, marginTop: 4 }}>
          Missing entitlement: <code>{denial.missingFeature}</code>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Loading skeleton (inline — for in-page section refresh)
// ---------------------------------------------------------------------------

export function SectionLoadingSkeleton({ rows = 3 }: { rows?: number }) {
  const bar = {
    background: "linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 37%, #f1f5f9 63%)",
    backgroundSize: "400% 100%",
    animation: "lifecycle-shimmer 1.4s ease infinite",
    borderRadius: 6,
    height: 14,
  } as const;
  return (
    <div data-lifecycle-section-loading style={{ padding: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 80px",
            gap: 12,
            padding: "8px 0",
            borderBottom: "1px solid #f1f5f9",
          }}
        >
          <div style={{ ...bar, width: "80%" }} />
          <div style={{ ...bar, width: "60%" }} />
          <div style={{ ...bar, width: "70%" }} />
          <div style={{ ...bar, width: "100%" }} />
        </div>
      ))}
      <style>{`@keyframes lifecycle-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Empty state
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  hint,
  cta,
}: {
  title: string;
  hint?: string;
  cta?: ReactNode;
}) {
  return (
    <div
      data-lifecycle-empty-state
      style={{
        padding: "24px 16px",
        textAlign: "center",
        color: "#475569",
        background: "rgba(15,23,42,0.02)",
        border: "1px dashed rgba(15,23,42,0.12)",
        borderRadius: 10,
      }}
    >
      <strong style={{ display: "block", color: "#0f172a", fontSize: 14, marginBottom: 4 }}>
        {title}
      </strong>
      {hint ? <p style={{ fontSize: 12, margin: "0 auto 8px", maxWidth: 520 }}>{hint}</p> : null}
      {cta ? <div style={{ marginTop: 8 }}>{cta}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Inline ErrorBoundary — catches render-time throws inside a page
//
// Even though apps/web/app/(app)/evidence-lifecycle/error.tsx now catches
// segment-level errors, an INLINE boundary inside each page Shell prevents
// a single broken sub-section from blanking the whole section. Both layers
// matter: error.tsx is the last-resort fallback; this boundary keeps the
// surrounding page chrome (header, nav, refresh button) interactive.
// ---------------------------------------------------------------------------

interface LifecycleBoundaryProps {
  /** Short label used in the fallback. */
  label: string;
  children: ReactNode;
  /** Optional retry callback — when supplied, the fallback shows a retry button. */
  onRetry?: () => void;
}

interface LifecycleBoundaryState {
  error: Error | null;
}

export class LifecycleSectionBoundary extends Component<
  LifecycleBoundaryProps,
  LifecycleBoundaryState
> {
  constructor(props: LifecycleBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): LifecycleBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[LifecycleSectionBoundary] ${this.props.label} threw`,
      error,
      info.componentStack,
    );
  }

  override render() {
    if (this.state.error) {
      return (
        <div
          data-lifecycle-inline-error={this.props.label}
          style={{
            padding: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#7f1d1d",
            borderRadius: 10,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          <strong>{this.props.label} could not render.</strong>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            The surrounding page is still usable. You can{" "}
            {this.props.onRetry ? (
              <button
                type="button"
                onClick={() => {
                  this.setState({ error: null });
                  this.props.onRetry?.();
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  color: "#7f1d1d",
                  textDecoration: "underline",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                retry this section
              </button>
            ) : (
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  color: "#7f1d1d",
                  textDecoration: "underline",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                dismiss this banner
              </button>
            )}
            .
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// 6. useLifecycleFetch — small typed hook that NEVER throws to the renderer
//
// Centralises:
//   - loading state
//   - busy flag
//   - denial banner state (via resolveLifecycleError)
//   - last-load timestamp (for "Loaded N seconds ago" affordance)
//   - manual refresh callback
// ---------------------------------------------------------------------------

export interface LifecycleFetchState<T> {
  data: T | null;
  loading: boolean;
  busy: boolean;
  denial: LifecycleDenial | null;
  loadedAtMs: number | null;
  refresh: () => Promise<void>;
}

export function useLifecycleFetch<T>(
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
): LifecycleFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<LifecycleDenial | null>(null);
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const next = await loader();
      if (!mountedRef.current) return;
      setData(next);
      setLoadedAtMs(Date.now());
    } catch (err) {
      if (!mountedRef.current) return;
      const mapped = resolveLifecycleError(err);
      if (mapped) setDenial(mapped);
      // Do NOT clear `data` on error — keep the last successful render so
      // the page is informative instead of blank.
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, busy, denial, loadedAtMs, refresh };
}

// ---------------------------------------------------------------------------
// 7. Page header — shared chrome
// ---------------------------------------------------------------------------

export function LifecyclePageHeader({
  title,
  subtitle,
  back = true,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When true, shows "← Back to Evidence Lifecycle". */
  back?: boolean;
  /** Optional right-aligned action slot. */
  children?: ReactNode;
}) {
  return (
    <header style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, marginTop: 0, marginBottom: 4 }}>{title}</h1>
          {subtitle ? (
            <p style={{ color: "#475569", fontSize: 13, margin: 0 }}>{subtitle}</p>
          ) : null}
          {back ? (
            <p style={{ marginTop: 8, marginBottom: 0 }}>
              <a
                href="/evidence-lifecycle"
                style={{
                  fontSize: 12,
                  color: "#4338ca",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                ← Back to Lifecycle Operations
              </a>
            </p>
          ) : null}
        </div>
        {children ? <div>{children}</div> : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// 8. Refresh button
// ---------------------------------------------------------------------------

export function RefreshButton({
  busy,
  onClick,
  label = "Refresh",
}: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      data-lifecycle-refresh
      disabled={busy}
      onClick={onClick}
      style={{
        padding: "6px 12px",
        border: "1px solid #0f172a",
        background: busy ? "#475569" : "#0f172a",
        color: "#fafafa",
        fontWeight: 600,
        fontSize: 12,
        borderRadius: 8,
        cursor: busy ? "not-allowed" : "pointer",
      }}
    >
      {busy ? "Loading…" : label}
    </button>
  );
}
