"use client";

/**
 * PHASE 12B (Evidence Operations) — Provenance chain section.
 *
 * Product consumer for `GET /v1/provenance/:evidenceId`
 * (services/api/src/routes/capture-trust.routes.ts), rendered inside the
 * canonical Evidence detail Integrity surface.
 *
 * Authorization / isolation contract (all server-side — this component
 * holds ZERO policy authority):
 *   * The route resolves the workspace from the SERVER-held
 *     `currentWorkspaceId` pointer and then re-checks ACTIVE membership
 *     at request time. It refuses personal workspaces with the bounded
 *     `WORKSPACE_NOT_FOUND` denial. The component sends no workspace id
 *     and cannot widen the scope.
 *   * The route anchors the evidence to that workspace before projecting
 *     (`evidence.findFirst({ id, teamId })`) and answers 404 otherwise.
 *   * Every trust state rendered here comes verbatim from the server
 *     projection. Nothing is derived, inferred, or recomputed client-side.
 *
 * Custody linkage: the projection's server-countersignature and
 * time-anchor rows are read from the CustodyEvent ledger
 * (SIGNATURE_APPLIED / TIMESTAMP_APPLIED / OTS_APPLIED /
 * ANCHOR_PUBLISHED), so this section and the Custody tab describe the
 * same events — the section links across to the Custody timeline rather
 * than restating it.
 *
 * The component is keyed on the active workspace and drops any response
 * that arrives after a workspace switch (§10.3 stale-context rejection).
 */

import { useCallback, useEffect, useState } from "react";
import { Link2, ShieldCheck } from "lucide-react";

import type { ProvenanceChain } from "@proovra/shared";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  useActiveWorkspaceId,
  useTenantGuard,
} from "../../../../../lib/platform-context";
import { KeyValueGrid, SectionHeading } from "./_lib";

type LoadState =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; chain: ProvenanceChain };

/** Bounded, plain-language copy for the standing limitation codes. */
const LIMITATION_COPY: Record<string, string> = {
  PROVENANCE_DOES_NOT_PROVE_CONTENT_TRUTH:
    "A provenance record shows how a file reached PROOVRA. It does not establish whether what the file shows is true.",
  PROVENANCE_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY:
    "A provenance record is not a ruling on admissibility. That decision belongs to the court or tribunal.",
  PROVENANCE_CLASS_C_HAS_NO_CAPTURE_SIDE_INTEGRITY:
    "Imported files carry no capture-device evidence, because PROOVRA was not present when they were recorded.",
  ATTESTATION_REVOCATION_IS_RETROACTIVE:
    "If a capture device is later found to be compromised, earlier device checks for that device stop being reliable.",
  "OFFLINE_CAPTURES_ARE_TIME-BOUNDED_BY_LOCAL_CLOCK":
    "Captures taken offline are timed by the device's own clock until PROOVRA can apply an independent timestamp.",
};

const CAPTURE_CLASS_COPY: Record<string, string> = {
  A: "Captured through a registered device with a verified device check",
  B: "Captured through PROOVRA, without a full device check",
  C: "Provided to PROOVRA after the fact (no capture-side record)",
};

export function EvidenceProvenanceChainSection({
  evidenceId,
}: {
  evidenceId: string;
}) {
  const workspaceId = useActiveWorkspaceId();
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    const captured = stamp();
    setState({ kind: "loading" });
    try {
      const res = await apiFetch(
        `/v1/provenance/${encodeURIComponent(evidenceId)}`,
        { method: "GET" },
      );
      // §10.3 — a workspace switch mid-flight makes this another
      // tenant's projection. Drop it.
      if (isStale(captured)) return;
      const chain = res?.chain as ProvenanceChain | undefined;
      if (!chain || chain.evidenceId !== evidenceId) {
        // Never render a projection that is not for THIS record.
        setState({
          kind: "denied",
          message:
            "A provenance record is not available for this evidence in the workspace you are in.",
        });
        return;
      }
      setState({ kind: "ready", chain });
    } catch (err) {
      if (isStale(captured)) return;
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 403 || status === 404) {
        setState({
          kind: "denied",
          message:
            status === 403
              ? "Provenance records are kept for organisation workspaces. Switch to the organisation that holds this evidence to view its provenance."
              : "A provenance record is not available for this evidence in the workspace you are in.",
        });
        return;
      }
      setState({
        kind: "error",
        message: toSafeUserError(err, {
          message: "We couldn't load the provenance record.",
        }).message,
      });
    }
  }, [evidenceId, isStale, stamp]);

  // Re-run on workspace change so the section never shows a stale
  // workspace's projection.
  useEffect(() => {
    void load();
  }, [load, workspaceId]);

  return (
    <section
      className="evidence-detail-section"
      data-evidence-provenance-section
      data-evidence-provenance-state={state.kind}
    >
      <div className="evidence-detail-section-header">
        <SectionHeading
          kicker="Provenance"
          title="How this record reached PROOVRA"
          icon={ShieldCheck}
        />
      </div>

      {state.kind === "loading" ? (
        <p data-evidence-provenance-loading className="evidence-detail-muted">
          Loading the provenance record…
        </p>
      ) : null}

      {state.kind === "denied" ? (
        <p data-evidence-provenance-denied className="evidence-detail-muted">
          {state.message}
        </p>
      ) : null}

      {state.kind === "error" ? (
        <div data-evidence-provenance-error className="evidence-detail-muted">
          <p className="evd-muted">{state.message}</p>
          <button
            type="button"
            data-evidence-provenance-retry
            onClick={() => void load()}
            className="app-secondary-action"
          >
            Try again
          </button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <ProvenanceChainBody chain={state.chain} />
      ) : null}
    </section>
  );
}

function ProvenanceChainBody({ chain }: { chain: ProvenanceChain }) {
  const captureItems: Array<{ label: string; value: string }> = [
    {
      label: "How it was acquired",
      value: humaniseCaptureMode(chain.capture.mode),
    },
    {
      label: "Capture record",
      value:
        CAPTURE_CLASS_COPY[chain.capture.provenanceClass] ??
        "Capture record not classified",
    },
    {
      label: "Device signature at source",
      value: chain.capture.deviceSignatureNote,
    },
  ];
  if (chain.capture.attestationVerdict !== "NOT_ATTEMPTED") {
    captureItems.push({
      label: "Device check",
      value: `${humaniseEnum(chain.capture.attestationVerdict)} (${humaniseEnum(
        chain.capture.attestationProvider,
      )})`,
    });
  }
  if (chain.capture.signedAtUtc) {
    captureItems.push({
      label: "Signed on device",
      value: formatUserDateTime(chain.capture.signedAtUtc),
    });
  }

  const preservationItems: Array<{ label: string; value: string }> = [
    {
      label: "PROOVRA countersignature",
      value: chain.server.countersigned
        ? `Applied${
            chain.server.countersignedAtUtc
              ? ` · ${formatUserDateTime(chain.server.countersignedAtUtc)}`
              : ""
          }`
        : "Not applied",
    },
    {
      label: "Independent timestamp",
      value: chain.time.rfc3161.applied
        ? `Applied${
            chain.time.rfc3161.appliedAtUtc
              ? ` · ${formatUserDateTime(chain.time.rfc3161.appliedAtUtc)}`
              : ""
          }`
        : "Not applied",
    },
    {
      label: "Public anchor",
      value: chain.time.ots.applied
        ? `Anchored${
            chain.time.ots.confirmations !== null
              ? ` · ${chain.time.ots.confirmations} confirmations`
              : ""
          }`
        : "Not anchored",
    },
  ];

  return (
    <div data-evidence-provenance-body>
      <KeyValueGrid items={captureItems} />

      <div className="evd-block">
        <strong className="evd-kicker">Preservation steps recorded</strong>
        <KeyValueGrid items={preservationItems} />
        <p className="evd-muted evd-block--tight">
          These steps are the same events listed on the Custody tab — open
          Custody for the full timeline, including who performed each step.
        </p>
      </div>

      {chain.derivations.length > 0 ? (
        <div className="evd-block" data-evidence-provenance-derivations>
          <strong className="evd-kicker">Files derived from this one</strong>
          <ul className="evd-list">
            {chain.derivations.map((d) => (
              <li key={`${d.derivedEvidenceId}:${d.derivedAtUtc}`}>
                <Link2 size={12} aria-hidden className="evd-inline-icon" />
                <code>{d.derivedEvidenceId.slice(0, 8)}…</code> ·{" "}
                {d.transformLabel || "derived copy"} ·{" "}
                {formatUserDateTime(d.derivedAtUtc)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="evd-block">
        <strong className="evd-kicker">What this does not tell you</strong>
        <ul className="evd-list" data-evidence-provenance-limitations>
          {chain.limitations.map((code) => (
            <li key={code}>{LIMITATION_COPY[code] ?? humaniseEnum(code)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function humaniseCaptureMode(mode: string): string {
  switch (mode) {
    case "SECURE_INTAKE_LINK":
      return "Uploaded through a secure intake link";
    case "PROOVRA_WEB_UPLOAD":
      return "Uploaded through PROOVRA in a browser";
    case "OPERATOR_NATIVE":
      return "Captured in the PROOVRA mobile app";
    case "OPERATOR_SDK_EMBED":
      return "Sent through the PROOVRA API";
    case "BULK_IMPORT":
      return "Imported into PROOVRA after the fact";
    default:
      return humaniseEnum(mode);
  }
}

function humaniseEnum(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
