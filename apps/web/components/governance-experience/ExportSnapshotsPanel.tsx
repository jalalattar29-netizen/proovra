"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { GOVERNANCE_EXPORT_SNAPSHOT_KINDS, identifierLabel, type GovernanceExportSnapshotKind } from "@proovra/shared";
import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { CursorPager, useCursorPager } from "../ui/CursorPager";
import { useConfirmAction } from "../ui/ConfirmActionModal";

type Snapshot = {
  id: string; evidenceId: string | null; createdAt: string; createdByUserId: string | null;
  snapshotKind: GovernanceExportSnapshotKind; lifecycleState: string; snapshotHash: string;
  exportEligibilityOutcome: string; exportEligibilityReason: string;
  activeHoldIds: string[]; governanceIncidentIds: string[]; retentionPolicyVersionId: string | null;
};
type SnapshotPage = { snapshots: Snapshot[]; nextCursor: string | null; creation: { allowed: boolean; reason: string | null } };
type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; message: string };
const root = "/v1/governance/export-snapshots";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rowStyle = { display: "flex", flexWrap: "wrap" as const, gap: 12, alignItems: "end" };
const fieldStyle = { display: "grid", gap: 4, flex: "1 1 180px", minWidth: 0 };

function read(path: string) { return apiFetch(path, { signal: AbortSignal.timeout(15_000) }); }
function errorMessage(error: unknown, message: string) { return toSafeUserError(error, { message }).message; }

export function ExportSnapshotsPanel({ teamId }: { teamId: string }) {
  return <SnapshotWorkspace key={teamId} teamId={teamId} />;
}

function SnapshotWorkspace({ teamId }: { teamId: string }) {
  const { confirm: confirmAction } = useConfirmAction();
  const [kind, setKind] = useState("");
  const [evidenceFilter, setEvidenceFilter] = useState("");
  const [appliedEvidence, setAppliedEvidence] = useState("");
  const [createKind, setCreateKind] = useState<GovernanceExportSnapshotKind>("AUDIT_EXPORT");
  const [evidenceId, setEvidenceId] = useState("");
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<Load<SnapshotPage>>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [unconfirmedWrite, setUnconfirmedWrite] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const pager = useCursorPager(JSON.stringify([teamId, kind, appliedEvidence, revision]));
  const query = new URLSearchParams({ teamId, limit: "25" });
  if (kind) query.set("snapshotKind", kind);
  if (appliedEvidence) query.set("evidenceId", appliedEvidence);
  if (pager.cursor) query.set("cursor", pager.cursor);
  const listUrl = root + "?" + query.toString();
  useEffect(() => {
    let current = true;
    setList({ status: "loading" });
    void read(listUrl).then(value => {
      if (current) setList({ status: "ready", value: value as SnapshotPage });
    }).catch(error => {
      if (current) setList({ status: "failed", message: errorMessage(error, "Unable to load export snapshots. Refresh to try again.") });
    });
    return () => { current = false; };
  }, [listUrl, revision]);

  const creation = list.status === "ready" ? list.value.creation : null;
  const invalidEvidence = evidenceId.trim() !== "" && !uuid.test(evidenceId.trim());
  const disabledReason = unconfirmedWrite ? "Refresh the saved snapshot before creating another."
    : !creation ? "Load the snapshot list to check your creation permissions."
    : !creation.allowed ? creation.reason ?? "Snapshot creation is unavailable for your workspace access."
    : invalidEvidence ? "Enter a valid evidence ID, or leave it blank for a workspace snapshot." : undefined;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || disabledReason) return;
    setBusy(true);
    setMutationError("");
    setNotice("");
    const confirmed = await confirmAction({
      title: "Record export snapshot?",
      description: "This records the current governance state permanently. It does not generate an export file or grant export permission.",
      confirmLabel: "Record snapshot",
    });
    if (!alive.current) return;
    if (!confirmed) { setBusy(false); return; }
    let savedId: string | null = null;
    try {
      const result = await apiFetch(root, {
        method: "POST", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ teamId, snapshotKind: createKind, evidenceId: evidenceId.trim() || null }),
      }) as { snapshot: Snapshot };
      savedId = result.snapshot.id;
      if (!alive.current) return;
      setSelected(savedId);
      await read(root + "/" + encodeURIComponent(savedId) + "?teamId=" + encodeURIComponent(teamId));
      if (!alive.current) return;
      setNotice("Snapshot recorded and reread from the saved record.");
      setRevision(value => value + 1);
    } catch (error) {
      if (!alive.current) return;
      if (savedId) {
        setUnconfirmedWrite(true);
        setMutationError("Snapshot recorded, but its saved details could not be reloaded. Refresh the snapshot before creating another.");
      } else {
        setMutationError(errorMessage(error, "The snapshot could not be confirmed. Refresh the list before trying again."));
      }
    } finally { if (alive.current) setBusy(false); }
  }

  return <section aria-label="Export snapshots" style={{ display: "grid", gap: 16, minWidth: 0 }}>
    <Card>
      <h2>Export snapshots</h2>
      <p>Review the governance state recorded for an export. A snapshot is an immutable record; it does not generate an export file or establish legal admissibility.</p>
      <form onSubmit={create} style={{ display: "grid", gap: 12 }}>
        <div style={rowStyle}>
          <label style={fieldStyle}>Snapshot purpose<select value={createKind} onChange={event => setCreateKind(event.target.value as GovernanceExportSnapshotKind)}>
            {GOVERNANCE_EXPORT_SNAPSHOT_KINDS.map(value => <option key={value} value={value}>{identifierLabel(value)}</option>)}
          </select></label>
          <label style={fieldStyle}>Evidence ID (optional)<input value={evidenceId} onChange={event => setEvidenceId(event.target.value)} aria-describedby="snapshot-evidence-help" /></label>
          <Button type="submit" variant="primary" loading={busy} disabled={Boolean(disabledReason)} disabledReason={disabledReason}>Record snapshot</Button>
        </div>
        <p id="snapshot-evidence-help">Leave the evidence ID blank to record workspace governance. A purpose label does not select a case or its records.</p>
        {disabledReason && <p>{disabledReason}</p>}
      </form>
      {notice && <p role="status">{notice}</p>}
      {mutationError && <p role="alert">{mutationError}</p>}
    </Card>
    <Card>
      <form style={rowStyle} onSubmit={event => { event.preventDefault(); setAppliedEvidence(evidenceFilter.trim()); }}>
        <label style={fieldStyle}>Filter by purpose<select value={kind} onChange={event => setKind(event.target.value)}>
          <option value="">All purposes</option>
          {GOVERNANCE_EXPORT_SNAPSHOT_KINDS.map(value => <option key={value} value={value}>{identifierLabel(value)}</option>)}
        </select></label>
        <label style={fieldStyle}>Filter by evidence ID<input value={evidenceFilter} onChange={event => setEvidenceFilter(event.target.value)} /></label>
        <Button type="submit" disabled={Boolean(evidenceFilter.trim()) && !uuid.test(evidenceFilter.trim())} disabledReason="Enter a valid evidence ID, or clear the field to show all evidence.">Apply filter</Button>
        <Button onClick={() => { setRevision(value => value + 1); }}>Refresh list</Button>
      </form>
      {list.status === "loading" && <p role="status">Loading snapshots…</p>}
      {list.status === "failed" && <p role="alert">{list.message}</p>}
      {list.status === "ready" && <>
        {list.value.snapshots.length === 0 ? <p>No snapshots match these filters.</p> : <>
          <p>{list.value.snapshots.length} snapshots on this page{list.value.nextCursor ? " — more available" : ""}.</p>
          <ul style={{ display: "grid", gap: 12, paddingInlineStart: 20 }}>
            {list.value.snapshots.map(snapshot => <li key={snapshot.id} style={{ overflowWrap: "anywhere" }}>
              <Button onClick={() => setSelected(snapshot.id)} aria-pressed={selected === snapshot.id} aria-label={"View snapshot " + snapshot.id}>View snapshot</Button>
              <p>{identifierLabel(snapshot.snapshotKind)} · {new Date(snapshot.createdAt).toLocaleString()}</p>
              <p>{snapshot.evidenceId ? "Evidence snapshot" : "Workspace snapshot"} · Export eligibility: {identifierLabel(snapshot.exportEligibilityOutcome)}</p>
              <small>Snapshot ID: <code data-identifier>{snapshot.id}</code></small>
            </li>)}
          </ul>
        </>}
        <CursorPager pager={pager} nextCursor={list.value.nextCursor} hasMore={list.value.nextCursor !== null} />
      </>}
    </Card>
    {selected && <SnapshotDetails key={selected} teamId={teamId} id={selected} onReread={() => { setUnconfirmedWrite(false); setMutationError(""); }} />}
  </section>;
}

function SnapshotDetails({ teamId, id, onReread }: { teamId: string; id: string; onReread: () => void }) {
  const [state, setState] = useState<Load<Snapshot>>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [verification, setVerification] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const alive = useRef(true);
  const reread = useRef(onReread);
  reread.current = onReread;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const url = root + "/" + encodeURIComponent(id) + "?teamId=" + encodeURIComponent(teamId);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    setVerification("");
    void read(url).then(result => {
      if (!current) return;
      setState({ status: "ready", value: (result as { snapshot: Snapshot }).snapshot });
      reread.current();
    }).catch(error => {
      if (current) setState({ status: "failed", message: errorMessage(error, "Unable to load this snapshot. Refresh the snapshot to try again.") });
    });
    return () => { current = false; };
  }, [url, revision]);
  async function verify() {
    setVerifying(true); setVerification(""); setVerifyError("");
    try {
      const result = await read(root + "/" + encodeURIComponent(id) + "/verify?teamId=" + encodeURIComponent(teamId)) as { valid: boolean };
      if (alive.current) setVerification(result.valid ? "Integrity verified: the saved payload matches its recorded hash." : "Integrity check failed: the saved payload does not match its recorded hash. Contact your workspace administrator.");
    } catch (error) { if (alive.current) setVerifyError(errorMessage(error, "Integrity verification is unavailable. Try again.")); }
    finally { if (alive.current) setVerifying(false); }
  }
  return <Card><section aria-label="Snapshot details" style={{ overflowWrap: "anywhere" }}>
    <h3>Snapshot details</h3>
    <Button onClick={() => setRevision(value => value + 1)}>Refresh snapshot</Button>
    {state.status === "loading" && <p role="status">Loading snapshot details…</p>}
    {state.status === "failed" && <p role="alert">{state.message}</p>}
    {state.status === "ready" && <>
      <dl>
        <dt>Snapshot ID</dt><dd><code data-identifier>{state.value.id}</code></dd>
        <dt>Purpose</dt><dd>{identifierLabel(state.value.snapshotKind)}</dd>
        <dt>Recorded</dt><dd>{new Date(state.value.createdAt).toLocaleString()}</dd>
        <dt>Scope</dt><dd>{state.value.evidenceId ? <>Evidence ID: <code data-identifier>{state.value.evidenceId}</code></> : "Workspace governance"}</dd>
        <dt>Recorded by</dt><dd>{state.value.createdByUserId ? <>User ID: <code data-identifier>{state.value.createdByUserId}</code></> : "Actor not recorded"}</dd>
        <dt>Lifecycle at recording</dt><dd>{identifierLabel(state.value.lifecycleState)}</dd>
        <dt>Export eligibility at recording</dt><dd>{identifierLabel(state.value.exportEligibilityOutcome)} — {identifierLabel(state.value.exportEligibilityReason)}</dd>
        <dt>Active preservation holds</dt><dd>{state.value.activeHoldIds.length}</dd>
        <dt>Governance incidents</dt><dd>{state.value.governanceIncidentIds.length}</dd>
        <dt>Retention policy version</dt><dd>{state.value.retentionPolicyVersionId ? <code data-identifier>{state.value.retentionPolicyVersionId}</code> : "No policy version recorded"}</dd>
        <dt>Snapshot hash</dt><dd><code data-identifier>{state.value.snapshotHash}</code></dd>
      </dl>
      <Button loading={verifying} onClick={() => { void verify(); }}>Verify integrity</Button>
    </>}
    {verification && <p role="status">{verification}</p>}
    {verifyError && <p role="alert">{verifyError}</p>}
  </section></Card>;
}
