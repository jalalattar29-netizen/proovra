/**
 * OPS-13 PHASE 3 — WHAT THE SECURITY BRIDGE ACTUALLY WRITES.
 *
 * The decision tables are pinned in operations-security-bridge.test.ts. This
 * suite drives `safeEmitSecurityEvent` end to end with the incident writer
 * replaced by a recorder, and proves the BEHAVIOUR the executed audit found
 * broken:
 *
 *   * an outsider's DENIED workspace switch wrote an unclosable condition
 *     into the target workspace — now no condition is written at all;
 *   * the read-only export-eligibility refusal, a legal-hold-blocked
 *     destruction and per-login SSO/SAML failures — no condition;
 *   * an event type nobody classified — persisted and counted, never a
 *     tenant row;
 *   * a classified tenant event with NO workspace — counted, never an
 *     invisible LEGACY_UNSCOPED row;
 *   * a classified event inside a workspace still opens its real source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded: Array<Record<string, unknown>> = [];
vi.mock("../src/services/observability/incident.service.js", () => ({
  recordIncident: vi.fn(async (input: Record<string, unknown>) => {
    recorded.push(input);
    return { created: true, incident: { id: "inc-1" } };
  }),
}));

const bumped: string[] = [];
vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: (name: string) => bumped.push(name),
}));

const { safeEmitSecurityEvent } = await import(
  "../src/services/security/security-event.service.js"
);

type Row = Record<string, unknown>;
function fakeClient(): { client: never; rows: Row[] } {
  const rows: Row[] = [];
  return {
    rows,
    client: {
      securityEvent: {
        create: async ({ data }: { data: Row }) => {
          const row = { id: `se-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        },
      },
    } as never,
  };
}

/** The bridge is fire-and-forget; let its promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 25));

const TARGET = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  recorded.length = 0;
  bumped.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("no condition is written for what is not an operational condition", () => {
  it("a DENIED workspace switch by an outsider writes the security log and NO incident", async () => {
    const { client, rows } = fakeClient();
    safeEmitSecurityEvent(
      {
        // The emitter now binds a refusal to the ACTOR's own context, but even
        // a row bound to the target (legacy shape) must not open a condition.
        teamId: TARGET,
        eventType: "workspace_context_switched",
        severity: "WARNING",
        details: { result: "denied", targetWorkspaceId: TARGET, reason: "workspace_membership_required" },
      },
      client,
    );
    await settle();
    expect(rows).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  for (const eventType of [
    "export_blocked_by_lifecycle",
    "destruction_blocked_by_hold",
    "destruction_blocked_by_immutable",
    "lifecycle_transition_blocked",
    "sso_login_failed",
    "saml_login_failed",
    "saml_assertion_rejected",
    "sso_jit_denied",
    "sso_callback_replay_detected",
    "saml_connection_test_failed",
    "sso_health_checked",
    "auth_login_failed",
    "mfa_verification_failed",
    "multipart_complete_failed",
    "multipart_hash_mismatch",
    "upload_part_hash_mismatch",
    "finalize_blocked_by_upload_session",
    "recovery_review_required",
    "privileged_session_blocked",
    "search_audit_log_write_failed",
    "mfa_recovery_digest_test_failed",
    "scim_drift_scan_completed",
  ] as const) {
    it(`${eventType} at WARNING/HIGH opens no condition`, async () => {
      const { client, rows } = fakeClient();
      safeEmitSecurityEvent({ teamId: TARGET, eventType, severity: "HIGH" }, client);
      await settle();
      expect(rows).toHaveLength(1);
      expect(recorded).toEqual([]);
      expect(bumped).not.toContain("security_event_unclassified_total");
    });
  }

  it("the webhook auto-disable event opens no GENERIC row (its dedicated source records it)", async () => {
    const { client } = fakeClient();
    safeEmitSecurityEvent(
      { teamId: TARGET, eventType: "automation_webhook_destination_auto_disabled", severity: "WARNING" },
      client,
    );
    await settle();
    expect(recorded).toEqual([]);
  });
});

describe("an unclassified event is counted, never written into a workspace", () => {
  it("a catalogue type no map claims writes the security log, bumps the counter, and opens nothing", async () => {
    const { client, rows } = fakeClient();
    // A real catalogue member (the writer refuses anything else) that no
    // bridge map claims.
    safeEmitSecurityEvent(
      { teamId: TARGET, eventType: "session_inventory_viewed", severity: "WARNING" },
      client,
    );
    await settle();
    expect(rows).toHaveLength(1);
    expect(recorded).toEqual([]);
    expect(bumped).toContain("security_event_unclassified_total");
  });
});

describe("a classified tenant condition needs a tenant", () => {
  it("an account-tier step_up_denied (no workspace) is counted and writes no LEGACY_UNSCOPED row", async () => {
    const { client, rows } = fakeClient();
    safeEmitSecurityEvent({ teamId: null, eventType: "step_up_denied", severity: "WARNING" }, client);
    await settle();
    expect(rows).toHaveLength(1);
    expect(recorded).toEqual([]);
    expect(bumped).toContain("security_event_condition_without_workspace_total");
  });

  it("a null-team high_risk_action_blocked writes no condition either", async () => {
    const { client } = fakeClient();
    safeEmitSecurityEvent({ eventType: "high_risk_action_blocked", severity: "WARNING" }, client);
    await settle();
    expect(recorded).toEqual([]);
  });

  it("a classified event INSIDE a workspace still opens its real source there", async () => {
    const { client } = fakeClient();
    safeEmitSecurityEvent(
      { teamId: TARGET, eventType: "scim_user_provisioning_conflict", severity: "HIGH" },
      client,
    );
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      sourceId: "identity.security_condition",
      teamId: TARGET,
      severity: "HIGH",
      fingerprint: "identity_security:security_event:scim_user_provisioning_conflict",
    });
  });

  it("an INFO event never reaches the bridge at all", async () => {
    const { client } = fakeClient();
    safeEmitSecurityEvent({ teamId: TARGET, eventType: "step_up_denied", severity: "INFO" }, client);
    await settle();
    expect(recorded).toEqual([]);
  });
});
