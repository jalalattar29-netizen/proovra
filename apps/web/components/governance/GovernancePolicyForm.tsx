"use client";

/**
 * PHASE 13 — POST /v1/governance/policies.
 *
 * The registry console could ACTIVATE and DEPRECATE policies, resolve the
 * effective chain, and read the audit — but the DRAFT row those actions
 * operate on could only be authored through a REST client.
 *
 * Authorisation: SECURITY_OFFICER or COMPLIANCE_OFFICER (cross-cutting tiers;
 * the workspace owner does not implicitly hold either).
 *
 * `rule` is a `z.record(z.string(), z.unknown())` — a JSON object. It is
 * authored here as text and parsed CLIENT-SIDE before the request so a typo
 * is a field error, not a 400 round-trip. An array, a scalar, or unparseable
 * text is rejected locally with the reason.
 */

import { useCallback, useId, useState } from "react";

import {
  GOVERNANCE_POLICY_ENFORCEMENT_MODES,
  GOVERNANCE_POLICY_KINDS,
  type GovernancePolicyEnforcementMode,
  type GovernancePolicyKind,
} from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  GovernanceActionStatus,
  GovernanceSelectField,
  GovernanceTextArea,
  GovernanceTextField,
  governanceFieldGridStyle,
  governanceFieldRowStyle,
} from "./GovernanceFormField";
import {
  POLICY_SLUG_PATTERN,
  useDelegatedTierAccess,
  useGovernanceAction,
} from "./governance-action-state";

function parseRule(text: string): { ok: true; rule: Record<string, unknown> } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "A rule object is required. Use {} for a policy with no parameters." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "The rule must be valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "The rule must be a JSON object, not an array or a scalar." };
  }
  return { ok: true, rule: parsed as Record<string, unknown> };
}

export function GovernancePolicyForm({
  onCreated,
}: {
  onCreated: () => Promise<void> | void;
}) {
  const uid = useId();
  const { busy, outcome, reset, run } = useGovernanceAction();
  const tiers = useDelegatedTierAccess();

  const [kind, setKind] = useState<GovernancePolicyKind>(GOVERNANCE_POLICY_KINDS[0]);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [enforcementMode, setEnforcementMode] =
    useState<GovernancePolicyEnforcementMode>("AUDIT_ONLY");
  const [rule, setRule] = useState("{}");
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const permitted = tiers.hasAnyTier(["SECURITY_OFFICER", "COMPLIANCE_OFFICER"]);
  const canSubmit = permitted && !busy;

  const validate = useCallback((): Record<string, string | null> | null => {
    const next: Record<string, string | null> = {};
    const trimmedSlug = slug.trim();
    if (!trimmedSlug) {
      next[`${uid}-slug`] = "A slug is required.";
    } else if (!POLICY_SLUG_PATTERN.test(trimmedSlug)) {
      next[`${uid}-slug`] =
        "Use lower-case letters, digits and hyphens only, starting with a letter or digit (max 64 characters).";
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      next[`${uid}-name`] = "A policy name is required.";
    } else if (trimmedName.length > 200) {
      next[`${uid}-name`] = "The name must be 200 characters or fewer.";
    }
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      next[`${uid}-summary`] = "A one-paragraph summary is required.";
    } else if (trimmedSummary.length > 600) {
      next[`${uid}-summary`] = "The summary must be 600 characters or fewer.";
    }
    if (!(GOVERNANCE_POLICY_KINDS as ReadonlyArray<string>).includes(kind)) {
      next[`${uid}-kind`] = "Choose a policy kind.";
    }
    if (
      !(GOVERNANCE_POLICY_ENFORCEMENT_MODES as ReadonlyArray<string>).includes(
        enforcementMode,
      )
    ) {
      next[`${uid}-mode`] = "Choose an enforcement mode.";
    }
    const parsedRule = parseRule(rule);
    if (!parsedRule.ok) next[`${uid}-rule`] = parsedRule.reason;
    return Object.keys(next).length > 0 ? next : null;
  }, [slug, name, summary, kind, enforcementMode, rule, uid]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      const invalid = validate();
      setErrors(invalid ?? {});
      if (invalid) return;
      const parsedRule = parseRule(rule);
      if (!parsedRule.ok) return;
      await run(
        async () => {
          await apiFetch("/v1/governance/policies", {
            method: "POST",
            body: JSON.stringify({
              kind,
              slug: slug.trim(),
              name: name.trim(),
              summary: summary.trim(),
              enforcementMode,
              rule: parsedRule.rule,
            }),
          });
          setSlug("");
          setName("");
          setSummary("");
          setRule("{}");
          await onCreated();
        },
        {
          success:
            "Policy version created as DRAFT. Activate it from the table below to start enforcing it.",
          fallback: "Could not create that governance policy.",
        },
      );
    },
    [canSubmit, validate, rule, run, kind, slug, name, summary, enforcementMode, onCreated],
  );

  return (
    <Card
      variant="admin"
      title="Author a policy version"
      subtitle="Creates a DRAFT policy in this organization's registry. Nothing is enforced until it is activated and assigned."
      data-governance-policy-form
    >
      <form onSubmit={submit} noValidate>
        <div style={governanceFieldGridStyle}>
          <GovernanceTextField
            id={`${uid}-name`}
            label="Policy name"
            value={name}
            onChange={(v) => {
              setName(v);
              reset();
            }}
            error={errors[`${uid}-name`]}
            maxLength={200}
            disabled={!permitted || busy}
            testAttr="data-governance-policy-name"
          />
          <GovernanceTextField
            id={`${uid}-slug`}
            label="Slug"
            value={slug}
            onChange={(v) => {
              setSlug(v);
              reset();
            }}
            error={errors[`${uid}-slug`]}
            hint="Stable identifier used by the enforcement engine. Lower-case, digits and hyphens."
            placeholder="reviewer-two-person-rule"
            maxLength={64}
            disabled={!permitted || busy}
            testAttr="data-governance-policy-slug"
          />
          <GovernanceSelectField
            id={`${uid}-kind`}
            label="Kind"
            value={kind}
            onChange={(v) => {
              setKind(v as GovernancePolicyKind);
              reset();
            }}
            options={GOVERNANCE_POLICY_KINDS.map((k) => ({ value: k, label: k }))}
            error={errors[`${uid}-kind`]}
            disabled={!permitted || busy}
            testAttr="data-governance-policy-kind"
          />
          <GovernanceSelectField
            id={`${uid}-mode`}
            label="Enforcement mode"
            value={enforcementMode}
            onChange={(v) => {
              setEnforcementMode(v as GovernancePolicyEnforcementMode);
              reset();
            }}
            options={GOVERNANCE_POLICY_ENFORCEMENT_MODES.map((m) => ({
              value: m,
              label: m,
            }))}
            error={errors[`${uid}-mode`]}
            hint="BLOCK refuses the operation, WARN allows it with a warning, AUDIT_ONLY records it."
            disabled={!permitted || busy}
            testAttr="data-governance-policy-mode"
          />
          <GovernanceTextArea
            id={`${uid}-summary`}
            label="Summary"
            value={summary}
            onChange={(v) => {
              setSummary(v);
              reset();
            }}
            error={errors[`${uid}-summary`]}
            hint="What this policy requires, in operator-readable language. Max 600 characters."
            maxLength={600}
            disabled={!permitted || busy}
            testAttr="data-governance-policy-summary"
          />
          <GovernanceTextArea
            id={`${uid}-rule`}
            label="Rule (JSON object)"
            value={rule}
            onChange={(v) => {
              setRule(v);
              reset();
            }}
            error={errors[`${uid}-rule`]}
            hint="The parameters the enforcement engine reads. Use {} for a policy with no parameters."
            rows={5}
            disabled={!permitted || busy}
            testAttr="data-governance-policy-rule"
          />
        </div>

        <div style={governanceFieldRowStyle}>
          <Button
            type="submit"
            variant="enterprise"
            loading={busy}
            disabled={!canSubmit}
            data-governance-policy-submit
          >
            {busy ? "Creating…" : "Create policy version"}
          </Button>
          {!tiers.ready ? (
            <span style={noteStyle}>Checking your governance tier…</span>
          ) : !permitted ? (
            <span style={noteStyle} data-governance-policy-blocked="tier">
              Authoring a governance policy needs the SECURITY_OFFICER or
              COMPLIANCE_OFFICER delegated-admin tier. These are cross-cutting
              tiers — being the workspace owner does not grant them.
            </span>
          ) : null}
        </div>

        <GovernanceActionStatus
          busy={busy}
          outcome={outcome}
          busyLabel="Creating the policy version…"
          testAttr="data-governance-policy-status"
        />
      </form>
    </Card>
  );
}

const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#64748b",
  maxWidth: 520,
};
