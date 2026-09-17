"use client";

/**
 * Policy details — where a governance policy is applied, how to apply it,
 * and what has happened to it.
 *
 *   GET  /v1/governance/policies/:id/assignments   (where it applies)
 *   POST /v1/governance/policies/:id/assignments   (ORG_ADMIN — apply it)
 *   GET  /v1/governance/policies/:id/audit         (its history, newest first)
 *
 * A policy is only ever enforced through an assignment: the effective-policy
 * resolver reads assignment rows and nothing else. Before this panel the
 * console could create, activate and deprecate a policy but never assign
 * one, so no policy authored here could take effect.
 *
 * The Organization and workspace targets are the ids the SERVER echoed on
 * the effective-policy read; departments come from the department listing.
 * The page never asks an operator to type a target id.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  identifierLabel,
  type DepartmentProjection,
  type GovernancePolicyAssignmentProjection,
  type GovernancePolicyAuditRow,
  type GovernancePolicyProjection,
  type GovernancePolicyScope,
} from "@proovra/shared";

import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { permissionDenialCopy } from "../../../../lib/labels/governanceReviewLabels";

export type ResolvedPolicyScope = { organizationId: string; workspaceId: string };

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; message: string };

const SCOPE_LABEL: Record<GovernancePolicyScope, string> = {
  ORGANIZATION: "Whole organization",
  DEPARTMENT: "One department",
  WORKSPACE: "This workspace",
};

function readFailure(err: unknown, fallback: string): string {
  const e = err as { statusCode?: number };
  if (e?.statusCode === 403 || e?.statusCode === 404) {
    return "You do not have the governance permission required to read this in the current workspace.";
  }
  return toSafeUserError(err, { message: fallback }).message;
}

function writeFailure(err: unknown): string {
  const e = err as {
    statusCode?: number;
    code?: string;
    details?: Record<string, unknown>;
  };
  const denial =
    typeof e?.details?.["denial"] === "string"
      ? (e.details["denial"] as string)
      : e?.code;
  if (e?.statusCode === 403 && denial === "DELEGATED_ADMIN_REQUIRED") {
    const tier = e.details?.["requiredTier"];
    const copy = permissionDenialCopy(denial, typeof tier === "string" ? tier : "ORG_ADMIN");
    return `${copy.title} ${copy.detail}`;
  }
  if (e?.statusCode === 403) {
    return "You do not have the governance permission required to assign policies in the current workspace.";
  }
  if (e?.statusCode === 404) {
    return denial === "SCOPE_TARGET_NOT_FOUND"
      ? "That target is not part of this workspace any more. Reload the page and choose again."
      : "This policy is no longer part of the current workspace. Reload the policy list.";
  }
  if (e?.statusCode === 409) {
    return "The server did not accept that assignment scope. Nothing was changed.";
  }
  return toSafeUserError(err, { message: "The policy could not be assigned." }).message;
}

export function PolicyDetailsPanel({
  policy,
  departments,
  departmentsFailed,
  scope,
  auditRevision,
  onAssigned,
  onClose,
}: {
  policy: GovernancePolicyProjection;
  departments: ReadonlyArray<DepartmentProjection>;
  departmentsFailed: boolean;
  scope: ResolvedPolicyScope | null;
  /** Bumped by the page after it activates or deprecates this policy. */
  auditRevision: number;
  onAssigned: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { confirm } = useConfirmAction();
  const base = `/v1/governance/policies/${encodeURIComponent(policy.id)}`;
  const headingId = useId();
  const formId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [assignments, setAssignments] = useState<
    Load<ReadonlyArray<GovernancePolicyAssignmentProjection>>
  >({ status: "loading" });
  const [assignmentsRevision, setAssignmentsRevision] = useState(0);
  const [audit, setAudit] = useState<Load<ReadonlyArray<GovernancePolicyAuditRow>>>({
    status: "loading",
  });
  const [auditLocalRevision, setAuditLocalRevision] = useState(0);

  useEffect(() => {
    let current = true;
    setAssignments({ status: "loading" });
    apiFetch(`${base}/assignments`, { method: "GET" })
      .then((res) => {
        if (!current) return;
        setAssignments({
          status: "ready",
          value: ((res as { assignments?: GovernancePolicyAssignmentProjection[] })
            ?.assignments ?? []),
        });
      })
      .catch((err) => {
        if (current) {
          setAssignments({
            status: "failed",
            message: readFailure(err, "Unable to load where this policy is assigned."),
          });
        }
      });
    return () => {
      current = false;
    };
  }, [base, assignmentsRevision]);

  useEffect(() => {
    let current = true;
    setAudit({ status: "loading" });
    apiFetch(`${base}/audit`, { method: "GET" })
      .then((res) => {
        if (!current) return;
        setAudit({
          status: "ready",
          value: ((res as { audit?: GovernancePolicyAuditRow[] })?.audit ?? []),
        });
      })
      .catch((err) => {
        if (current) {
          setAudit({
            status: "failed",
            message: readFailure(err, "Unable to load this policy's audit trail."),
          });
        }
      });
    return () => {
      current = false;
    };
  }, [base, auditRevision, auditLocalRevision]);

  // --- Assign form -------------------------------------------------------
  const [formOpen, setFormOpen] = useState(false);
  const [assignScope, setAssignScope] = useState<GovernancePolicyScope>("WORKSPACE");
  const [departmentId, setDepartmentId] = useState("");
  const [inherit, setInherit] = useState(true);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (formOpen) firstFieldRef.current?.focus();
  }, [formOpen]);

  const activeDepartments = departments.filter((d) => d.state === "ACTIVE");

  function targetFor(s: GovernancePolicyScope): string | null {
    if (s === "ORGANIZATION") return scope?.organizationId ?? null;
    if (s === "WORKSPACE") return scope?.workspaceId ?? null;
    return departmentId || null;
  }

  function targetLabel(s: GovernancePolicyScope, target: string): string {
    if (s === "ORGANIZATION") return "this organization";
    if (s === "WORKSPACE") return "this workspace";
    const d = departments.find((x) => x.id === target);
    return d ? `the ${d.name} department` : "a department not in the current list";
  }

  const disabledReason = busy
    ? undefined
    : assignScope !== "DEPARTMENT" && !scope
      ? "The organization and workspace for this session have not been resolved. Reload the effective policy section, then try again."
      : assignScope === "DEPARTMENT" && departmentsFailed
        ? "Departments could not be loaded. Reload the page to assign to a department."
        : assignScope === "DEPARTMENT" && activeDepartments.length === 0
          ? "There is no active department to assign to."
          : assignScope === "DEPARTMENT" && !departmentId
            ? "Choose the department to assign this policy to."
            : undefined;

  function closeForm() {
    setFormOpen(false);
    openerRef.current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabledReason) return;
    const target = targetFor(assignScope);
    if (!target) return;
    setNotice(null);
    setFailure(null);
    const where = targetLabel(assignScope, target);
    const confirmed = await confirm({
      title: `Assign ${policy.name}?`,
      description: `${policy.name} will apply to ${where}${
        policy.state === "ACTIVE"
          ? ""
          : ". It is not active yet, so nothing is enforced until it is activated"
      }. ${
        override
          ? "It overrides a broader policy of the same kind."
          : "It does not override a broader policy of the same kind."
      } ${inherit ? "Narrower scopes inherit it." : "Narrower scopes do not inherit it."}`,
      confirmLabel: "Assign policy",
      tone: "warning",
      testId: "governance-policy-assign",
    });
    if (!alive.current || !confirmed) return;
    setBusy(true);
    let written = false;
    try {
      await apiFetch(`${base}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: assignScope,
          scopeTargetId: target,
          inheritFromParent: inherit,
          isOverride: override,
        }),
      });
      written = true;
      const res = (await apiFetch(`${base}/assignments`, { method: "GET" })) as {
        assignments?: GovernancePolicyAssignmentProjection[];
      };
      if (!alive.current) return;
      const rows = res?.assignments ?? [];
      setAssignments({ status: "ready", value: rows });
      const saved = rows.find(
        (a) =>
          a.scope === assignScope &&
          a.scopeTargetId === target &&
          a.isOverride === override &&
          a.inheritFromParent === inherit,
      );
      if (saved) {
        setNotice(`${policy.name} is assigned to ${where}.`);
        setFormOpen(false);
        openerRef.current?.focus();
        setAuditLocalRevision((v) => v + 1);
        await onAssigned();
      } else {
        setFailure(
          "The assignment request was accepted, but the reloaded assignments do not show it. Reload before trying again.",
        );
      }
    } catch (err) {
      if (!alive.current) return;
      setFailure(
        written
          ? "The assignment request was accepted, but the assignments could not be reloaded to confirm it. Reload to see where this policy applies."
          : writeFailure(err),
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Card variant="admin" padding="compact" data-governance-policy-details={policy.id}>
      <section aria-labelledby={headingId} style={{ display: "grid", gap: 16, minWidth: 0, overflowWrap: "anywhere" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <h3 id={headingId} style={{ margin: 0 }}>
            {policy.name} — {identifierLabel(policy.state)}
          </h3>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close details
          </Button>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          <h4 style={{ margin: 0 }}>Where this policy applies</h4>
          {assignments.status === "loading" ? (
            <p role="status">Loading assignments…</p>
          ) : assignments.status === "failed" ? (
            <div role="alert" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span>{assignments.message}</span>
              <Button size="sm" variant="secondary" onClick={() => setAssignmentsRevision((v) => v + 1)}>
                Retry assignments
              </Button>
            </div>
          ) : assignments.value.length === 0 ? (
            <p data-governance-policy-unassigned>
              Not assigned. This policy is not enforced anywhere until it is assigned.
            </p>
          ) : (
            <ul aria-label="Policy assignments" style={{ display: "grid", gap: 8, margin: 0, paddingInlineStart: 20 }}>
              {assignments.value.map((a) => (
                <li key={a.id} data-governance-policy-assignment={a.id}>
                  <strong>{SCOPE_LABEL[a.scope] ?? identifierLabel(a.scope)}</strong>
                  {a.scope === "DEPARTMENT" ? ` — ${targetLabel(a.scope, a.scopeTargetId)}` : null}
                  {" · "}
                  {a.isOverride ? "Overrides broader policies" : "Adds to broader policies"}
                  {" · "}
                  {a.inheritFromParent ? "Inherited by narrower scopes" : "Not inherited"}
                  <br />
                  <small>
                    Assigned {formatUserDateTime(a.assignedAtUtc)}
                    {a.assignedByUserId ? (
                      <>
                        {" "}by user <code data-identifier>{a.assignedByUserId}</code>
                      </>
                    ) : null}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {notice ? <p role="status">{notice}</p> : null}
          {failure ? <p role="alert">{failure}</p> : null}

          <div>
            <Button
              ref={openerRef}
              variant="enterprise"
              size="sm"
              aria-expanded={formOpen}
              aria-controls={formId}
              onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
            >
              Assign policy
            </Button>
          </div>
          <form
            id={formId}
            hidden={!formOpen}
            onSubmit={(e) => void submit(e)}
            aria-label={`Assign ${policy.name}`}
            style={{ display: formOpen ? "grid" : "none", gap: 10 }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }}>
              <label style={{ display: "grid", gap: 4, flex: "1 1 180px", minWidth: 0 }}>
                Apply to
                <select
                  ref={firstFieldRef}
                  value={assignScope}
                  onChange={(e) => setAssignScope(e.target.value as GovernancePolicyScope)}
                >
                  <option value="ORGANIZATION">{SCOPE_LABEL.ORGANIZATION}</option>
                  <option value="DEPARTMENT">{SCOPE_LABEL.DEPARTMENT}</option>
                  <option value="WORKSPACE">{SCOPE_LABEL.WORKSPACE}</option>
                </select>
              </label>
              {assignScope === "DEPARTMENT" ? (
                <label style={{ display: "grid", gap: 4, flex: "1 1 180px", minWidth: 0 }}>
                  Target department
                  <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                    <option value="">Choose a department</option>
                    {activeDepartments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
              Narrower scopes inherit this assignment
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              Override a broader policy of the same kind
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Button
                type="submit"
                variant="enterprise"
                size="sm"
                loading={busy}
                disabled={Boolean(disabledReason)}
                disabledReason={disabledReason}
              >
                Save assignment
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={closeForm} disabled={busy}>
                Cancel
              </Button>
            </div>
            {disabledReason ? <p>{disabledReason}</p> : null}
          </form>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          <h4 style={{ margin: 0 }}>Audit trail</h4>
          {audit.status === "loading" ? (
            <p role="status">Loading audit trail…</p>
          ) : audit.status === "failed" ? (
            <div role="alert" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span>{audit.message}</span>
              <Button size="sm" variant="secondary" onClick={() => setAuditLocalRevision((v) => v + 1)}>
                Retry audit trail
              </Button>
            </div>
          ) : audit.value.length === 0 ? (
            <p>No audit events are recorded for this policy.</p>
          ) : (
            <ol aria-label="Policy audit trail" style={{ display: "grid", gap: 8, margin: 0, paddingInlineStart: 20 }}>
              {audit.value.map((row) => (
                <li key={row.id} data-governance-policy-audit={row.id}>
                  <strong>{identifierLabel(row.code)}</strong> · {formatUserDateTime(row.occurredAtUtc)}
                  <br />
                  <small>
                    {row.actorUserId ? (
                      <>
                        By user <code data-identifier>{row.actorUserId}</code>
                      </>
                    ) : (
                      "Actor not recorded"
                    )}
                    {row.reason ? (
                      <>
                        {" · Recorded detail: "}
                        <code data-identifier>{row.reason}</code>
                      </>
                    ) : null}
                  </small>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </Card>
  );
}
